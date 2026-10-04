/**
 * What the organizer does to documents, for either kind: read one's text,
 * duplicate, move to Recently Deleted (with Undo) and back, and combine
 * several into one book manuscript.
 */

import type { JSONContent } from "@tiptap/core";
import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { backend } from "../../../lib/backend";
import { toast } from "../../../platform/toast";
import { documentsApi } from "../api";
import { b64decode } from "../collab";
import { snapshotDocMaps, type DocMapsSnapshot } from "../docMaps";
import { useLocalDocs } from "../local";
import { useDocuments } from "../store";
import type { OrgItem } from "./model";

export type ItemRef = { kind: "server"; id: number } | { kind: "local"; id: string };

/** A document's text and per-document maps (page settings, book details).
 *  Server reads are quiet: no "opened" entry in its activity. */
export async function readContent(item: OrgItem): Promise<{ content: JSONContent; maps: DocMapsSnapshot }> {
  const state =
    item.kind === "server"
      ? (await documentsApi.detailQuiet(item.id as number)).state_b64
      : ((JSON.parse(await backend.localdocRead(item.id as string)) as { state_b64?: string }).state_b64 ?? "");
  const ydoc = new Y.Doc();
  try {
    if (state) Y.applyUpdate(ydoc, b64decode(state));
    let content = yDocToProsemirrorJSON(ydoc, "default") as JSONContent;
    if (!content.content?.length) content = { type: "doc", content: [{ type: "paragraph" }] };
    return { content, maps: snapshotDocMaps(ydoc) };
  } finally {
    ydoc.destroy();
  }
}

function refreshServer() {
  const s = useDocuments.getState();
  void s.load().catch(() => {});
  void s.loadFolders().catch(() => {});
  if (s.trashSupported !== false) void s.loadTrash().catch(() => {});
}

/** A copy beside the original ("Title (copy)", same folder). */
export async function duplicate(item: OrgItem): Promise<ItemRef> {
  const title = `${item.title} (copy)`;
  if (item.kind === "local") {
    // On this device the stored state is copied exactly.
    const file = JSON.parse(await backend.localdocRead(item.id as string)) as { state_b64?: string };
    const id = await useLocalDocs.getState().create(title, item.format, file.state_b64 ?? "");
    return { kind: "local", id };
  }
  const { content, maps } = await readContent(item);
  const { createServerDocument } = await import("../import/importFile");
  const doc = await createServerDocument(title, item.format, content, maps, `Duplicated from “${item.title}”`);
  if (item.folderId !== null && item.access === "owner") {
    await documentsApi.moveDocument(doc.id, item.folderId).catch(() => {});
  }
  refreshServer();
  return { kind: "server", id: doc.id };
}

/** Move documents to Recently Deleted, with an Undo in the toast. */
export async function deleteItems(items: OrgItem[]): Promise<void> {
  for (const item of items) {
    if (item.kind === "server") await documentsApi.remove(item.id as number);
    else await useLocalDocs.getState().remove(item.id as string);
  }
  if (items.some((i) => i.kind === "server")) refreshServer();
  const what = items.length === 1 ? `“${items[0].title}”` : `${items.length} documents`;
  toast(`Moved ${what} to Recently Deleted.`, "info", {
    action: { label: "Undo", run: () => void restoreItems(items).catch(() => {}) },
    durationMs: 8000,
  });
}

export async function restoreItems(items: { kind: "server" | "local"; id: number | string }[]): Promise<void> {
  for (const item of items) {
    if (item.kind === "server") await documentsApi.restore(item.id as number);
    else await useLocalDocs.getState().restore(item.id as string);
  }
  if (items.some((i) => i.kind === "server")) refreshServer();
}

export interface CombineOptions {
  title: string;
  /** Start each source with its title as a chapter heading (unless it
   *  opens with one). */
  titleHeadings: boolean;
  dest: "server" | "local";
  /** Server folder for the result. */
  folderId: number | null;
}

/** Combine documents, in this order, into a new book manuscript. The
 *  sources are left as they are. */
export async function combineInto(
  sources: OrgItem[],
  opts: CombineOptions,
  progress: (message: string) => void,
): Promise<ItemRef> {
  const parts = [];
  for (let i = 0; i < sources.length; i += 1) {
    progress(`Reading ${i + 1} of ${sources.length}…`);
    const { content, maps } = await readContent(sources[i]);
    parts.push({ title: sources[i].title, json: content, book: maps.book ?? null });
  }
  progress("Combining…");
  const { combineDocuments } = await import("../../../book/convert/combine");
  const { content, bookSeed } = combineDocuments(parts, { titleHeadings: opts.titleHeadings });
  // Book details carry over from the first source that has them — except
  // its title: the new manuscript is named for itself.
  const book = { ...(bookSeed ?? {}) };
  delete book["meta.title"];
  const maps: DocMapsSnapshot = Object.keys(book).length ? { book } : {};
  progress("Creating the manuscript…");
  const { createLocalDocument, createServerDocument } = await import("../import/importFile");
  if (opts.dest === "local") {
    const id = await createLocalDocument(opts.title, "manuscript", content, maps);
    return { kind: "local", id };
  }
  const doc = await createServerDocument(opts.title, "manuscript", content, maps, `Combined from ${sources.length} documents`);
  if (opts.folderId !== null) await documentsApi.moveDocument(doc.id, opts.folderId).catch(() => {});
  refreshServer();
  return { kind: "server", id: doc.id };
}
