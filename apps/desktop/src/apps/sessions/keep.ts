/**
 * Keeping a piece written in a session: as a document of the writer's own,
 * where the rest of the app's tools can be used on it. In the apps it goes
 * on this device (theirs alone until they publish it). In a browser, which
 * has nowhere of its own to keep it, it goes on the server.
 */

import type { JSONContent } from "@tiptap/react";

import { isWeb } from "../../lib/backend";
import { toast } from "../../platform/toast";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** A name for the document a piece becomes. */
export function pieceTitle(sessionTitle: string, promptNumber: number): string {
  const name = sessionTitle.trim() || "Writing session";
  return `${name} (prompt ${promptNumber})`.slice(0, 200);
}

/** Make the document, and say where it went (with a way to open it). */
export async function keepAsDocument(title: string, doc: unknown): Promise<void> {
  const content = typeof doc === "object" && doc !== null && (doc as JSONContent).type === "doc" ? (doc as JSONContent) : EMPTY_DOC;
  // (Asked for only now: the documents' own machinery is no part of a sprint.)
  const [{ createLocalDocument, createServerDocument }, { openLocalDoc, openServerDoc }] = await Promise.all([import("../documents/import/importFile"), import("../documents/navigation")]);
  if (isWeb) {
    const made = await createServerDocument(title, "none", content, {}, "From a writing session");
    toast("Saved to your documents.", "success", { action: { label: "Open", run: () => void openServerDoc(made.id) } });
  } else {
    const id = await createLocalDocument(title, "none", content, {});
    toast("Saved to your documents on this device.", "success", { action: { label: "Open", run: () => void openLocalDoc(id) } });
  }
}
