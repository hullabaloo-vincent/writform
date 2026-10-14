/**
 * Documents stored on this device: a single-user Y.Doc persisted as one
 * JSON file (full encoded state, base64) via the `localdoc_*` commands.
 * No update log, no seq, no WS — one writer makes debounced full-state
 * saves both simpler and lossless. Sharing to a server is a one-way
 * publish handled by ShareLocalDialog.
 *
 * Saving is never silent about failure: the provider reports its state to
 * the save indicator, retries on its own (1s → 30s), and a document that
 * still can't be written when it's closed stays alive — listed in the
 * organizer — until a save succeeds.
 *
 * Beside the documents live their folders (one small file: the folders, and
 * which document is in which) and each document's plain text, written with
 * it now and then so a search can read it.
 */

import { create } from "zustand";
import * as Y from "yjs";

import { backend, isCmdError, type CmdError, type LocalTrashListing } from "../../lib/backend";
import { onFlush } from "../../platform/lifecycle";
import { DOC_SCHEMA_LEVEL, levels, UNKNOWN_LEVEL } from "../../editor/schema/levels";
import { STYLES_MAP, styleLevel } from "../../editor/styles/docStyles";
import { b64decode, b64encode } from "./collab";
import { stateDigest, ydocDigest } from "./docText";

const SAVE_MS = 800;
const RETRY_MAX_MS = 30_000;
/** The list's word count and excerpt are refreshed at most this often
 *  while writing (and always when the document closes). */
const STATS_MS = 15_000;

interface LocalDocFile {
  id: string;
  title: string;
  format: string;
  state_b64: string;
  created_at: number;
  /** The newest schema level the content has used (absent: 1). An app
   *  below it must not open the file — see editor/schema/levels.ts. */
  schema?: number;
}

/** The Yjs fragment the editor binds to (TipTap Collaboration's default). */
const CONTENT = "default";

export interface LocalDocMeta {
  id: string;
  title: string;
  format: string;
  updated_at: number;
  words?: number;
  excerpt?: string;
}

/** A folder of documents on this device. */
export interface LocalFolder {
  id: string;
  name: string;
  created_at: number;
}

/** The folders file: the folders, and which document is in which. A
 *  document in none is simply absent; one in Recently Deleted keeps its
 *  place, so restoring puts it back where it was. */
interface FoldersFile {
  folders: LocalFolder[];
  docs: Record<string, string>;
}

const FOLDER_NAME_MAX = 80;

/** The list metadata saved beside a document. */
function metaJson(m: { title: string; format: string; words?: number; excerpt?: string }): string {
  return JSON.stringify({ title: m.title, format: m.format, words: m.words ?? 0, excerpt: m.excerpt ?? "" });
}

export type LocalSaveState =
  | { kind: "synced" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

export class LocalDocProvider {
  readonly doc = new Y.Doc();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private dirty = false;
  private closed = false;
  private created_at = Date.now();
  /** Saves run one at a time, in order. */
  private chain: Promise<void> = Promise.resolve();
  private status: LocalSaveState = { kind: "synced" };
  private listeners = new Set<(s: LocalSaveState) => void>();
  private onUnload = () => void this.flush();
  private stats: { words: number; excerpt: string; at: number } | null = null;
  private closing = false;
  private schema = 1;

  constructor(readonly id: string) {}

  async open(): Promise<LocalDocFile> {
    const raw = await backend.localdocRead(this.id);
    const file = JSON.parse(raw) as LocalDocFile;
    if ((file.schema ?? 1) > DOC_SCHEMA_LEVEL) {
      // This app's editor would delete the formatting it doesn't know.
      throw {
        code: "newer_document",
        message: "This document was saved by a newer version of subScribe. Update the app to open it.",
      } satisfies CmdError;
    }
    this.schema = file.schema ?? 1;
    this.created_at = file.created_at ?? Date.now();
    if (file.state_b64) Y.applyUpdate(this.doc, b64decode(file.state_b64));
    this.doc.getXmlFragment(CONTENT).observeDeep(this.onContent);
    // (A style with tab stops needs level 4 too.)
    this.doc.getMap(STYLES_MAP).observe(this.onStyles);
    this.doc.on("update", this.onUpdate);
    window.addEventListener("beforeunload", this.onUnload);
    return file;
  }

  getStatus(): LocalSaveState {
    return this.status;
  }

  subscribe(fn: (s: LocalSaveState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** True while something hasn't reached the disk. */
  hasUnsaved(): boolean {
    return this.dirty || this.status.kind === "error";
  }

  private setStatus(next: LocalSaveState) {
    this.status = next;
    for (const fn of [...this.listeners]) fn(next);
  }

  private onUpdate = () => {
    if (this.closed) return;
    this.markDirty();
  };

  private onStyles = () => {
    this.schema = Math.max(this.schema, styleLevel(this.doc));
  };

  /** The level of what was just written, kept with the file. */
  private onContent = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const level = levels.ofYEvents(events);
    // Our own editor's content is at most this build's level.
    this.schema = Math.max(this.schema, level === UNKNOWN_LEVEL ? DOC_SCHEMA_LEVEL : level);
  };

  /** Something about the file changed (text, or the title/format in the
   *  store): save after the usual pause. */
  markDirty() {
    this.dirty = true;
    if (this.status.kind !== "error") this.setStatus({ kind: "pending" });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_MS);
  }

  /** Persist now. Title/format come from the store so a rename mid-debounce
   *  can't be lost to a stale copy. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.chain = this.chain.then(() => this.writeOnce());
    return this.chain;
  }

  /** Try again right away (the indicator's "Try Again"). */
  retry(): Promise<void> {
    this.retryDelay = 1000;
    this.dirty = true;
    return this.flush();
  }

  private async writeOnce(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const meta = useLocalDocs.getState().items.find((d) => d.id === this.id);
    let file: LocalDocFile;
    let text: string | undefined;
    try {
      file = {
        id: this.id,
        title: meta?.title ?? "Untitled",
        format: meta?.format ?? "none",
        state_b64: b64encode(Y.encodeStateAsUpdate(this.doc)),
        created_at: this.created_at,
        ...(this.schema > 1 ? { schema: this.schema } : {}),
      };
      if (!this.stats || this.closing || Date.now() - this.stats.at > STATS_MS) {
        // The text a search reads is brought up to date with them.
        const digest = ydocDigest(this.doc);
        this.stats = { words: digest.words, excerpt: digest.excerpt, at: Date.now() };
        text = digest.text;
      }
    } catch {
      return; // the doc was destroyed under us
    }
    try {
      await backend.localdocWrite(this.id, JSON.stringify(file), metaJson({ ...file, ...this.stats }), text);
      this.retryDelay = 1000;
      if (!this.dirty) this.setStatus({ kind: "synced" });
    } catch (e) {
      // Keep the changes and keep trying — even without new edits.
      this.dirty = true;
      // The text didn't land either: work it out again next time.
      if (text !== undefined && this.stats) this.stats.at = 0;
      const message = isCmdError(e) ? e.message : String(e);
      this.setStatus({
        kind: "error",
        message: `Couldn't save to this device (${message}). Retrying…`,
      });
      this.retryTimer = setTimeout(() => void this.flush(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    }
  }

  /** Close the document. Resolves true when everything reached the disk;
   *  false leaves it alive (still retrying) — see `stuckLocalDocs`. */
  async destroy(): Promise<boolean> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // The last save refreshes the list's count and excerpt.
    this.closing = true;
    this.dirty = true;
    await this.flush();
    if (this.hasUnsaved()) return false;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    window.removeEventListener("beforeunload", this.onUnload);
    this.doc.off("update", this.onUpdate);
    this.listeners.clear();
    this.doc.destroy();
    return true;
  }
}

let provider: LocalDocProvider | null = null;
export const activeLocalProvider = () => provider;

/** Closed documents whose save keeps failing: kept in memory (and retrying)
 *  so closing can never throw away text. The organizer lists them. */
const stuck = new Map<string, LocalDocProvider>();
const stuckListeners = new Set<() => void>();

export function stuckLocalDocs(): LocalDocProvider[] {
  return [...stuck.values()];
}

export function onStuckLocalDocsChange(fn: () => void): () => void {
  stuckListeners.add(fn);
  return () => {
    stuckListeners.delete(fn);
  };
}

function setStuck(p: LocalDocProvider, isStuck: boolean) {
  if (isStuck) stuck.set(p.id, p);
  else stuck.delete(p.id);
  for (const fn of [...stuckListeners]) fn();
}

/** Close a provider; if it can't save, park it and keep retrying. */
function retireLocal(old: LocalDocProvider) {
  void old.destroy().then((done) => {
    if (done) {
      setStuck(old, false);
      return;
    }
    setStuck(old, true);
    const off = old.subscribe((s) => {
      if (s.kind !== "synced") return;
      off();
      void old.destroy().then((ok) => {
        if (ok) setStuck(old, false);
      });
    });
  });
}

interface LocalDocsState {
  items: LocalDocMeta[];
  loaded: boolean;
  /** Folders on this device, and the folder each document is in. */
  folders: LocalFolder[];
  folderOf: Record<string, string>;
  /** Recently Deleted (on this device). */
  trash: LocalTrashListing[];
  activeLocalId: string | null;
  /** Panel the editor should open with, set by the list before opening. */
  pendingPanel: "history" | null;
  load: () => Promise<void>;
  /** `schema`: the schema level of `state_b64` (a copy of newer content). */
  /** `withId`: an id chosen beforehand (its pictures are already stored). */
  create: (title: string, format: string, state_b64?: string, schema?: number, withId?: string) => Promise<string>;
  rename: (id: string, title: string) => Promise<void>;
  setFormat: (id: string, format: string) => Promise<void>;
  /** Move to Recently Deleted (restorable for 30 days). */
  remove: (id: string) => Promise<void>;
  loadTrash: () => Promise<void>;
  restore: (id: string) => Promise<void>;
  /** Delete one document from Recently Deleted for good. */
  purge: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<string>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** The folder goes; its documents stay, out of any folder. */
  deleteFolder: (id: string) => Promise<void>;
  /** Put documents in a folder, or (null) take them out of theirs. */
  moveTo: (ids: string[], folderId: string | null) => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
}

/** The folder a document is in, if that folder still exists. */
export function folderOfLocal(id: string): string | null {
  const { folderOf, folders } = useLocalDocs.getState();
  const folder = folderOf[id];
  return folder && folders.some((f) => f.id === folder) ? folder : null;
}

function cleanFolderName(raw: string): string {
  const name = raw.trim().slice(0, FOLDER_NAME_MAX);
  if (!name) throw { code: "bad_name", message: "Give the folder a name." } satisfies CmdError;
  return name;
}

/** Folder writes run one at a time, in order; a read waits for them. */
let folderChain: Promise<void> = Promise.resolve();

function saveFolders(): Promise<void> {
  const run = folderChain.then(() => {
    const { folders, folderOf } = useLocalDocs.getState();
    const file: FoldersFile = { folders, docs: folderOf };
    return backend.localdocFoldersWrite(JSON.stringify(file));
  });
  folderChain = run.catch(() => {});
  return run;
}

function parseFolders(raw: string): FoldersFile {
  const empty: FoldersFile = { folders: [], docs: {} };
  if (!raw) return empty;
  try {
    const file = JSON.parse(raw) as Partial<FoldersFile>;
    const folders = (Array.isArray(file.folders) ? file.folders : []).filter(
      (f): f is LocalFolder => !!f && typeof f.id === "string" && typeof f.name === "string",
    );
    const docs: Record<string, string> = {};
    for (const [doc, folder] of Object.entries(file.docs ?? {})) {
      if (typeof folder === "string" && folders.some((f) => f.id === folder)) docs[doc] = folder;
    }
    return { folders: folders.map((f) => ({ id: f.id, name: f.name, created_at: Number(f.created_at) || 0 })), docs };
  } catch {
    return empty;
  }
}

export const useLocalDocs = create<LocalDocsState>((set, get) => ({
  items: [],
  loaded: false,
  folders: [],
  folderOf: {},
  trash: [],
  activeLocalId: null,
  pendingPanel: null,

  load: async () => {
    const [items] = await Promise.all([backend.localdocList(), get().loadFolders().catch(() => {})]);
    set({ items, loaded: true });
  },

  loadFolders: async () => {
    await folderChain;
    const file = parseFolders(await backend.localdocFoldersRead());
    set({ folders: file.folders, folderOf: file.docs });
  },

  createFolder: async (raw) => {
    const folder: LocalFolder = { id: crypto.randomUUID(), name: cleanFolderName(raw), created_at: Date.now() };
    set((s) => ({ folders: [...s.folders, folder] }));
    await saveFolders();
    return folder.id;
  },

  renameFolder: async (id, raw) => {
    const name = cleanFolderName(raw);
    set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)) }));
    await saveFolders();
  },

  deleteFolder: async (id) => {
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      folderOf: Object.fromEntries(Object.entries(s.folderOf).filter(([, folder]) => folder !== id)),
    }));
    await saveFolders();
  },

  moveTo: async (ids, folderId) => {
    if (folderId !== null && !get().folders.some((f) => f.id === folderId)) {
      throw { code: "not_found", message: "That folder is gone." } satisfies CmdError;
    }
    set((s) => {
      const folderOf = { ...s.folderOf };
      for (const id of ids) {
        if (folderId === null) delete folderOf[id];
        else folderOf[id] = folderId;
      }
      return { folderOf };
    });
    await saveFolders();
  },

  create: async (title, format, state_b64 = "", schema = 1, withId) => {
    const id = withId ?? crypto.randomUUID();
    const file: LocalDocFile = {
      id,
      title: title.trim() || "Untitled",
      format,
      state_b64,
      created_at: Date.now(),
      ...(schema > 1 ? { schema } : {}),
    };
    const digest = state_b64 ? stateDigest(b64decode(state_b64)) : { words: 0, excerpt: "", text: "" };
    await backend.localdocWrite(id, JSON.stringify(file), metaJson({ ...file, ...digest }), digest.text);
    await get().load();
    return id;
  },

  rename: async (id, title) => {
    set((s) => ({
      items: s.items.map((d) => (d.id === id ? { ...d, title } : d)),
    }));
    await persistMeta(id);
  },

  setFormat: async (id, format) => {
    set((s) => ({
      items: s.items.map((d) => (d.id === id ? { ...d, format } : d)),
    }));
    await persistMeta(id);
  },

  remove: async (id) => {
    if (get().activeLocalId === id) {
      // Deleting: nothing left to save.
      const old = provider;
      provider = null;
      set({ activeLocalId: null });
      if (old) void old.destroy();
    }
    const parked = stuck.get(id);
    if (parked) {
      // Its newest text goes to Recently Deleted with it.
      await parked.flush().catch(() => {});
      setStuck(parked, false);
    }
    await backend.localdocTrash(id);
    set((s) => ({ items: s.items.filter((d) => d.id !== id) }));
    void get().loadTrash().catch(() => {});
  },

  loadTrash: async () => {
    set({ trash: await backend.localdocTrashList() });
  },

  restore: async (id) => {
    await backend.localdocRestore(id);
    set((s) => ({ trash: s.trash.filter((t) => t.id !== id) }));
    await get().load();
  },

  purge: async (id) => {
    await backend.localdocPurge(id);
    set((s) => ({ trash: s.trash.filter((t) => t.id !== id) }));
    await forgetPlaces([id]);
  },

  emptyTrash: async () => {
    const gone = get().trash.map((t) => t.id);
    await backend.localdocTrashEmpty();
    set({ trash: [] });
    await forgetPlaces(gone);
  },

  open: async (id) => {
    get().close();
    // A parked (unsaved) copy of this document is the newest text there is.
    const parked = stuck.get(id);
    if (parked) {
      setStuck(parked, false);
      provider = parked;
      set({ activeLocalId: id });
      return;
    }
    const next = new LocalDocProvider(id);
    provider = next;
    try {
      await next.open();
    } catch (e) {
      if (provider === next) provider = null;
      throw e;
    }
    if (provider === next) set({ activeLocalId: id });
  },

  close: () => {
    const old = provider;
    provider = null;
    if (old) retireLocal(old);
    set({ activeLocalId: null });
    // Its title, order and date may have changed while it was open.
    if (get().loaded) void get().load().catch(() => {});
  },
}));

// Backgrounding or quitting saves the open document first.
onFlush({
  pending: () => (provider?.hasUnsaved() ?? false) || stuck.size > 0,
  flush: async () => {
    await provider?.flush();
  },
});

/**
 * Persist a title/format change. An OPEN document saves through its own
 * provider (whose writes are serialized) — reading and rewriting the file
 * here could land on top of a newer save with older text.
 */
async function persistMeta(id: string): Promise<void> {
  const open = provider?.id === id ? provider : (stuck.get(id) ?? null);
  if (open) {
    open.markDirty();
    await open.flush();
    return;
  }
  const meta = useLocalDocs.getState().items.find((d) => d.id === id);
  if (!meta) return;
  const raw = await backend.localdocRead(id).catch(() => null);
  if (raw === null) return;
  const file = JSON.parse(raw) as LocalDocFile;
  file.title = meta.title;
  file.format = meta.format;
  // The file is written again, so its text is too: a search must not take
  // it for out of date.
  const text = file.state_b64 ? stateDigest(b64decode(file.state_b64)).text : "";
  await backend.localdocWrite(id, JSON.stringify(file), metaJson(meta), text);
}

/** Documents deleted for good no longer have a place in a folder. */
async function forgetPlaces(ids: string[]): Promise<void> {
  const { folderOf } = useLocalDocs.getState();
  if (!ids.some((id) => id in folderOf)) return;
  useLocalDocs.setState({ folderOf: Object.fromEntries(Object.entries(folderOf).filter(([id]) => !ids.includes(id))) });
  await saveFolders().catch(() => {});
}

/** When each document's text was last brought up to date for searching in
 *  this session — so one that can't be (too long to keep) isn't retried on
 *  every keystroke of a search. */
const indexedAt = new Map<string, number>();
let indexing: Promise<unknown> = Promise.resolve();

/** Write the search text of documents that don't have it yet (made before
 *  search read text, or closed by a crash). Resolves true if any was. */
function indexLocalDocs(ids: string[]): Promise<boolean> {
  const run = indexing.then(async () => {
    let wrote = false;
    for (const id of ids) {
      const updated = useLocalDocs.getState().items.find((d) => d.id === id)?.updated_at ?? 0;
      if ((indexedAt.get(id) ?? -1) >= updated) continue;
      indexedAt.set(id, Date.now());
      try {
        const file = JSON.parse(await backend.localdocRead(id)) as LocalDocFile;
        const text = file.state_b64 ? stateDigest(b64decode(file.state_b64)).text : "";
        await backend.localdocTextWrite(id, text);
        wrote = true;
      } catch {
        // Unreadable: it stays findable by its title.
      }
    }
    return wrote;
  });
  indexing = run.catch(() => {});
  return run;
}

/**
 * Search the text of the documents on this device: each one found, with the
 * words around the match. (Titles are matched by the caller, from the list.)
 * The open document is searched as its text was last written — up to a
 * quarter of a minute behind what's on screen.
 */
export async function searchLocalDocs(query: string): Promise<Map<string, string>> {
  let found = await backend.localdocSearch(query);
  const stale = found.stale.filter((id) => provider?.id !== id && !stuck.has(id));
  if (stale.length && (await indexLocalDocs(stale))) found = await backend.localdocSearch(query);
  return new Map(found.hits.map((hit) => [hit.id, hit.snippet]));
}
