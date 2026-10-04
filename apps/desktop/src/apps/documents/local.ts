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
 */

import { create } from "zustand";
import * as Y from "yjs";

import { backend, isCmdError, type LocalTrashListing } from "../../lib/backend";
import { onFlush } from "../../platform/lifecycle";
import { useSession } from "../../stores/session";
import { b64decode, b64encode } from "./collab";
import { stateStats, ydocStats } from "./docText";

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
}

export interface LocalDocMeta {
  id: string;
  title: string;
  format: string;
  updated_at: number;
  words?: number;
  excerpt?: string;
}

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

  constructor(readonly id: string) {}

  async open(): Promise<LocalDocFile> {
    const raw = await backend.localdocRead(this.id);
    const file = JSON.parse(raw) as LocalDocFile;
    this.created_at = file.created_at ?? Date.now();
    if (file.state_b64) Y.applyUpdate(this.doc, b64decode(file.state_b64));
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
    try {
      file = {
        id: this.id,
        title: meta?.title ?? "Untitled",
        format: meta?.format ?? "none",
        state_b64: b64encode(Y.encodeStateAsUpdate(this.doc)),
        created_at: this.created_at,
      };
      if (!this.stats || this.closing || Date.now() - this.stats.at > STATS_MS) {
        this.stats = { ...ydocStats(this.doc), at: Date.now() };
      }
    } catch {
      return; // the doc was destroyed under us
    }
    try {
      await backend.localdocWrite(this.id, JSON.stringify(file), metaJson({ ...file, ...this.stats }));
      this.retryDelay = 1000;
      if (!this.dirty) this.setStatus({ kind: "synced" });
    } catch (e) {
      // Keep the changes and keep trying — even without new edits.
      this.dirty = true;
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
  /** Recently Deleted (on this device). */
  trash: LocalTrashListing[];
  activeLocalId: string | null;
  /** Panel the editor should open with, set by the list before opening. */
  pendingPanel: "history" | null;
  load: () => Promise<void>;
  create: (title: string, format: string, state_b64?: string) => Promise<string>;
  rename: (id: string, title: string) => Promise<void>;
  setFormat: (id: string, format: string) => Promise<void>;
  /** Move to Recently Deleted (restorable for 30 days). */
  remove: (id: string) => Promise<void>;
  loadTrash: () => Promise<void>;
  restore: (id: string) => Promise<void>;
  /** Delete one document from Recently Deleted for good. */
  purge: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
}

export const useLocalDocs = create<LocalDocsState>((set, get) => ({
  items: [],
  loaded: false,
  trash: [],
  activeLocalId: null,
  pendingPanel: null,

  load: async () => {
    const items = await backend.localdocList();
    set({ items, loaded: true });
  },

  create: async (title, format, state_b64 = "") => {
    const id = crypto.randomUUID();
    const file: LocalDocFile = {
      id,
      title: title.trim() || "Untitled",
      format,
      state_b64,
      created_at: Date.now(),
    };
    const stats = state_b64 ? stateStats(b64decode(state_b64)) : { words: 0, excerpt: "" };
    await backend.localdocWrite(id, JSON.stringify(file), metaJson({ ...file, ...stats }));
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
  },

  emptyTrash: async () => {
    await backend.localdocTrashEmpty();
    set({ trash: [] });
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
    await next.open();
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

// Leaving offline mode (or logging out) drops to the connect screen: flush
// and close any open local doc so the next visit starts at the list.
useSession.subscribe((s) => {
  if (s.phase === "disconnected" && useLocalDocs.getState().activeLocalId !== null) {
    useLocalDocs.getState().close();
  }
});

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
  await backend.localdocWrite(id, JSON.stringify(file), metaJson(meta));
}
