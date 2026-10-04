/**
 * The only ways to open a document. The documents view shows an on-device
 * document in preference to a server one, so opening one kind must close the
 * other — before this, ⌘K, chat cards and canvas cards could open a server
 * document invisibly behind an open on-device one (live sync and all).
 */

import { usePlatform } from "../../platform";
import { useLocalDocs } from "./local";
import { useDocuments } from "./store";

const APP_ID = "writform.documents";

export async function openServerDoc(id: number): Promise<void> {
  if (useLocalDocs.getState().activeLocalId !== null) useLocalDocs.getState().close();
  usePlatform.getState().setActiveApp(APP_ID);
  await useDocuments.getState().openDocument(id);
}

export async function openLocalDoc(id: string): Promise<void> {
  if (useDocuments.getState().activeDocId !== null) useDocuments.getState().closeDocument();
  usePlatform.getState().setActiveApp(APP_ID);
  await useLocalDocs.getState().open(id);
}
