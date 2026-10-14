/**
 * The PDFs kept on this device.
 *
 * A PDF picked to be edited is somebody's file, changed in memory and saved
 * where they say. Kept here, it is the app's to come back to: it is listed
 * in Documents and in Home, opens where it was left, and is saved in place.
 * (The desktop and phone apps only. A browser has nowhere to keep it.)
 */

import { create } from "zustand";

import { backend, isWeb, type LocalPdfMeta } from "../lib/backend";

export type { LocalPdfMeta };

let keeping = !isWeb;
/** Whether PDFs can be kept here at all. */
export const canKeepPdfs = (): boolean => keeping;
/** For tests (which run as the browser client does, with nowhere to keep). */
export function setPdfKeeping(can: boolean): void {
  keeping = can;
}

interface Shelf {
  items: LocalPdfMeta[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Keep a PDF: a new one (no id), or the one kept under `id` written
   *  over. Resolves to how it is kept. */
  keep: (id: string | null, name: string, bytes: Uint8Array) => Promise<LocalPdfMeta>;
  read: (id: string) => Promise<Uint8Array>;
  rename: (id: string, name: string) => Promise<void>;
  /** Take one off the shelf. It can be put back (`restore`) for thirty days. */
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
}

export const usePdfShelf = create<Shelf>((set, get) => ({
  items: [],
  loaded: false,
  load: async () => {
    const items = canKeepPdfs() ? await backend.localpdfList() : [];
    set({ items, loaded: true });
  },
  keep: async (id, name, bytes) => {
    const meta = await backend.localpdfWrite(id ?? crypto.randomUUID(), name, bytes);
    set({ items: [meta, ...get().items.filter((item) => item.id !== meta.id)] });
    return meta;
  },
  read: (id) => backend.localpdfRead(id),
  rename: async (id, name) => {
    await backend.localpdfRename(id, name);
    await get().load();
  },
  remove: async (id) => {
    await backend.localpdfTrash(id);
    set({ items: get().items.filter((item) => item.id !== id) });
  },
  restore: async (id) => {
    await backend.localpdfRestore(id);
    await get().load();
  },
}));

/** A size as people say one: "340 KB", "2.1 MB". */
export function sizeLabel(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}
