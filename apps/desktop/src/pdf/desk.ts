/**
 * Which PDF is open for editing, if any.
 *
 * A PDF is not a document of this app (it has no place in the organizer
 * until it is kept on the device). It is a file somebody picked: its name
 * and its bytes, held here while the editor is open on it.
 */

import { create } from "zustand";

import { chooseDialog, confirmDialog } from "../platform/confirm";

export interface OpenPdf {
  name: string;
  bytes: Uint8Array;
  /** The one kept on this device under this id (see shelf.ts). */
  shelfId?: string;
}

export const usePdfDesk = create<{
  open: OpenPdf | null;
  /** It has changes no file holds yet. */
  dirty: boolean;
  show: (pdf: OpenPdf) => void;
  /** It is kept on this device now, under this id. */
  kept: (shelfId: string) => void;
  setDirty: (dirty: boolean) => void;
  close: () => void;
}>((set) => ({
  open: null,
  dirty: false,
  show: (pdf) => set({ open: pdf, dirty: false }),
  kept: (shelfId) => set((state) => (state.open ? { open: { ...state.open, shelfId } } : state)),
  setDirty: (dirty) => set({ dirty }),
  close: () => set({ open: null, dirty: false }),
}));

/**
 * Put the open PDF away, to show something else in its place. One with
 * changes no file holds asks first. False: the person chose to stay.
 */
export async function leavePdf(): Promise<boolean> {
  const { open, dirty, close } = usePdfDesk.getState();
  if (!open) return true;
  if (dirty && !(await confirmDialog("Your changes to this PDF are not in any file yet. Save a copy first to keep them.", { title: "Close the PDF without saving?", confirmLabel: "Close", danger: true }))) return false;
  close();
  return true;
}

/**
 * What to do with a PDF somebody picked: change the PDF itself, or make a
 * document of what it says. Null: neither (the asking was called off).
 */
export function pdfIntent(): Promise<"edit" | "convert" | null> {
  return chooseDialog("You can change the PDF itself: move its pages, mark it up, fill it in. Or you can turn what it says into a document to go on writing.", [
    { id: "edit", label: "Edit this PDF" },
    { id: "convert", label: "Convert to a document" },
  ], { title: "What would you like to do with this PDF?" }) as Promise<"edit" | "convert" | null>;
}

/** Whether a picked file is a PDF (by its name, or by how it begins). */
export function looksLikePdf(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === "application/pdf";
}
