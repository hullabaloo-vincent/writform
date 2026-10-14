/**
 * The only ways to open a document. The documents view shows an on-device
 * document in preference to a server one, so opening one kind must close the
 * other — before this, ⌘K, chat cards and canvas cards could open a server
 * document invisibly behind an open on-device one (live sync and all).
 */

import { leavePdf, usePdfDesk } from "../../pdf/desk";
import { usePlatform } from "../../platform";
import { useLocalDocs } from "./local";
import { useDocuments } from "./store";

const APP_ID = "writform.documents";

export async function openServerDoc(id: number): Promise<void> {
  // (A PDF open for editing is shown before either: it is put away first.)
  if (!(await leavePdf())) return;
  if (useLocalDocs.getState().activeLocalId !== null) useLocalDocs.getState().close();
  usePlatform.getState().setActiveApp(APP_ID);
  await useDocuments.getState().openDocument(id);
}

export async function openLocalDoc(id: string): Promise<void> {
  if (!(await leavePdf())) return;
  if (useDocuments.getState().activeDocId !== null) useDocuments.getState().closeDocument();
  usePlatform.getState().setActiveApp(APP_ID);
  await useLocalDocs.getState().open(id);
}

/** Open a PDF somebody picked, to edit the PDF itself (see src/pdf). */
export async function openPdfFile(file: File): Promise<void> {
  if (!(await leavePdf())) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (useLocalDocs.getState().activeLocalId !== null) useLocalDocs.getState().close();
  if (useDocuments.getState().activeDocId !== null) useDocuments.getState().closeDocument();
  usePlatform.getState().setActiveApp(APP_ID);
  usePdfDesk.getState().show({ name: file.name || "Document.pdf", bytes });
}

/** Open a PDF kept on this device (see src/pdf/shelf.ts). */
export async function openKeptPdf(id: string): Promise<void> {
  if (!(await leavePdf())) return;
  const { usePdfShelf } = await import("../../pdf/shelf");
  const shelf = usePdfShelf.getState();
  const bytes = await shelf.read(id);
  const name = shelf.items.find((item) => item.id === id)?.name ?? "Document.pdf";
  if (useLocalDocs.getState().activeLocalId !== null) useLocalDocs.getState().close();
  if (useDocuments.getState().activeDocId !== null) useDocuments.getState().closeDocument();
  usePlatform.getState().setActiveApp(APP_ID);
  usePdfDesk.getState().show({ name, bytes, shelfId: id });
}
