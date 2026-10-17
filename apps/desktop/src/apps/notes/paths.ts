/**
 * Notes live in folders, which are real folders in the vault, as in
 * Obsidian. A note is named by its path without `.md`, folders joined by
 * `/`: "Ideas", "Victoria Falls/Characters". These are the rules for those
 * names, the same as the vault's own (src-tauri/src/vault.rs). Nothing
 * here needs a window.
 */

/** The folder a note or folder is in ("" for the top of the vault). */
export function parentOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i);
}

/** A note's or folder's own name, without the folders it is in. */
export function baseOf(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** A name as the vault writes it, or null when the vault would refuse it:
 *  no empty part, none starting with a dot, no `\` or `:`. */
export function cleanName(name: string, root = false): string | null {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return root ? "" : null;
  const parts = trimmed.split("/").map((p) => p.trim());
  if (parts.length > 10) return null;
  for (const part of parts) {
    // (Control characters are refused too.)
    if (!part || part.length > 200 || part.startsWith(".") || /[\\:]/.test(part) || [...part].some((c) => c.charCodeAt(0) < 32)) return null;
  }
  return parts.join("/");
}

/**
 * The note a `[[link]]` leads to, as Obsidian finds it. A link with a `/`
 * names a path. A bare name finds the note of that name in the linking
 * note's own folder, else the one with the shortest path (then the first
 * by name). Case is not minded. Null when there is none.
 */
export function resolveLink(names: readonly string[], link: string, from: string): string | null {
  let target = link.trim().replace(/^\/+|\/+$/g, "");
  if (target.toLowerCase().endsWith(".md")) target = target.slice(0, -3);
  target = target.toLowerCase();
  if (!target) return null;
  if (target.includes("/")) return names.find((n) => n.toLowerCase() === target) ?? null;
  const here = parentOf(from).toLowerCase();
  let best: string | null = null;
  for (const name of names) {
    if (baseOf(name).toLowerCase() !== target) continue;
    if (parentOf(name).toLowerCase() === here) return name;
    if (best === null) {
      best = name;
      continue;
    }
    const depth = name.split("/").length;
    const bestDepth = best.split("/").length;
    if (depth < bestDepth || (depth === bestDepth && name.toLowerCase() < best.toLowerCase())) best = name;
  }
  return best;
}

/** Where a link to a note that isn't there makes it: at its path, or for a
 *  bare name beside the note it was written in. */
export function newNoteFor(link: string, from: string): string | null {
  const target = link.trim();
  return cleanName(target.includes("/") ? target : joinPath(parentOf(from), target));
}

export interface FolderNode {
  /** Its path ("" for the top of the vault). */
  path: string;
  name: string;
  folders: FolderNode[];
  notes: { name: string; modified_at: number }[];
}

/** The vault as a tree: folders first (by name), then notes (by name),
 *  at every level. Folders are known from `folders` and from the paths of
 *  the notes in them. */
export function buildTree(notes: readonly { name: string; modified_at: number }[], folders: readonly string[]): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], notes: [] };
  const byPath = new Map<string, FolderNode>([["", root]]);
  const folderAt = (path: string): FolderNode => {
    const known = byPath.get(path);
    if (known) return known;
    const node: FolderNode = { path, name: baseOf(path), folders: [], notes: [] };
    byPath.set(path, node);
    folderAt(parentOf(path)).folders.push(node);
    return node;
  };
  for (const folder of folders) folderAt(folder);
  for (const note of notes) folderAt(parentOf(note.name)).notes.push(note);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => collator.compare(a.name, b.name));
    node.notes.sort((a, b) => collator.compare(baseOf(a.name), baseOf(b.name)));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Every folder that holds `name`, from the top down ("A", "A/B" for
 *  "A/B/Note"): the ones to open to show it. */
export function foldersAbove(name: string): string[] {
  const parts = name.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
