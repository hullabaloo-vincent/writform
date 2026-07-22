/**
 * Documents stored on this device: a single-user Y.Doc persisted as one
 * JSON file (full encoded state, base64) via the `localdoc_*` commands.
 * No update log, no seq, no WS — one writer makes debounced full-state
 * saves both simpler and lossless. Sharing to a server is a one-way
 * publish handled by ShareLocalDialog.
 */

import { create } from "zustand";
import * as Y from "yjs";

import { backend } from "../../lib/backend";
import { useSession } from "../../stores/session";
import { b64decode, b64encode } from "./collab";

const SAVE_MS = 800;

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
}

export class LocalDocProvider {
  readonly doc = new Y.Doc();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  private created_at = Date.now();
  private onUnload = () => void this.flush();

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

  private onUpdate = () => {
    if (this.closed) return;
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_MS);
  };

  /** Persist now. Title/format come from the store so a rename mid-debounce
   *  can't be lost to a stale copy. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const meta = useLocalDocs.getState().items.find((d) => d.id === this.id);
    const file: LocalDocFile = {
      id: this.id,
      title: meta?.title ?? "Untitled",
      format: meta?.format ?? "default",
      state_b64: b64encode(Y.encodeStateAsUpdate(this.doc)),
      created_at: this.created_at,
    };
    await backend.localdocWrite(this.id, JSON.stringify(file)).catch(() => {
      // Retry on the next edit rather than dropping the dirty flag silently.
      this.dirty = true;
    });
  }

  async destroy(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.flush();
    this.closed = true;
    window.removeEventListener("beforeunload", this.onUnload);
    this.doc.off("update", this.onUpdate);
    this.doc.destroy();
  }
}

let provider: LocalDocProvider | null = null;
export const activeLocalProvider = () => provider;

interface LocalDocsState {
  items: LocalDocMeta[];
  loaded: boolean;
  activeLocalId: string | null;
  load: () => Promise<void>;
  create: (title: string, format: string, state_b64?: string) => Promise<string>;
  rename: (id: string, title: string) => Promise<void>;
  setFormat: (id: string, format: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
}

export const useLocalDocs = create<LocalDocsState>((set, get) => ({
  items: [],
  loaded: false,
  activeLocalId: null,

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
    await backend.localdocWrite(id, JSON.stringify(file));
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
    if (get().activeLocalId === id) get().close();
    await backend.localdocDelete(id);
    set((s) => ({ items: s.items.filter((d) => d.id !== id) }));
  },

  open: async (id) => {
    get().close();
    const next = new LocalDocProvider(id);
    provider = next;
    await next.open();
    if (provider === next) set({ activeLocalId: id });
  },

  close: () => {
    const old = provider;
    provider = null;
    if (old) void old.destroy();
    set({ activeLocalId: null });
  },
}));

// Leaving offline mode (or logging out) drops to the connect screen: flush
// and close any open local doc so the next visit starts at the list.
useSession.subscribe((s) => {
  if (s.phase === "disconnected" && useLocalDocs.getState().activeLocalId !== null) {
    useLocalDocs.getState().close();
  }
});

/** Rewrite one doc's file with current store meta (open or not). */
async function persistMeta(id: string): Promise<void> {
  const meta = useLocalDocs.getState().items.find((d) => d.id === id);
  if (!meta) return;
  const raw = await backend.localdocRead(id).catch(() => null);
  if (raw === null) return;
  const file = JSON.parse(raw) as LocalDocFile;
  file.title = meta.title;
  file.format = meta.format;
  await backend.localdocWrite(id, JSON.stringify(file)).catch(() => {});
}
