/**
 * Keeps a document's card up to date while an editor of it has it open
 * (card.ts says what a card is):
 *
 *  - a book whose front cover changed gets a new drawn picture of it
 *    (`cover.thumb`), made on this device and kept with the book like its
 *    other pictures;
 *  - a server document's card, and the pictures its settings name, are
 *    sent to the server when they change (once on opening too, which also
 *    tells the server about books made before cards existed).
 *
 * A document on this device needs no sending: its list entry is written
 * with the card as it is saved (local.ts).
 */

import { useEffect, useRef } from "react";
import type * as Y from "yjs";

import type { DocumentCard } from "../../bindings/proto/DocumentCard";
import { encodeArt } from "../../book/cover/art";
import { readBook, updateBook } from "../../book/model/bookMap";
import type { ImageUploader } from "../../lib/upload";
import { cardKey, cardOf, forServer, frontSignature, settingsMedia, THUMB_KEY, THUMB_OF_KEY, thumbOf } from "./card";

/** After a change, how long to wait for the next before acting. */
export const CARD_QUIET_MS = 1500;

export interface DocCardOptions {
  doc: Y.Doc;
  format: string;
  /** Only an editor of the document changes it. */
  canWrite: boolean;
  /** Where the drawn front goes (null: no drawing, as in a harness). */
  upload: ImageUploader | null;
  /** Sends a server document's card (null for one on this device). */
  send: ((card: DocumentCard, media: string[]) => Promise<unknown>) | null;
  /** Draws the front (book/cover/files.ts `coverThumb`, given for tests). */
  draw?: (book: ReturnType<typeof readBook>) => Promise<{ file: File; w: number; h: number } | null>;
  /** How long to wait after a change (tests wait less). */
  quiet?: number;
}

export function useDocCard({ doc, format, canWrite, upload, send, draw, quiet = CARD_QUIET_MS }: DocCardOptions): void {
  const io = useRef({ upload, send, draw });
  useEffect(() => {
    io.current = { upload, send, draw };
  });

  useEffect(() => {
    if (!canWrite) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    let again = false;
    let sent = "";
    // A front that couldn't be drawn isn't tried again until it changes.
    const failed = new Set<string>();

    const drawThumb = async () => {
      const { upload: put, draw: drawIt } = io.current;
      if (format !== "manuscript" || !put) return;
      const book = readBook(doc);
      const signature = frontSignature(book);
      const { thumb, of } = thumbOf(doc);
      if (!signature) {
        if (thumb || of) updateBook(doc, { [THUMB_KEY]: null, [THUMB_OF_KEY]: null });
        return;
      }
      if ((thumb && of === signature) || failed.has(signature)) return;
      const made = await (drawIt ?? (await import("../../book/cover/files")).coverThumb)(book).catch(() => null);
      if (stopped) return;
      // The cover changed while it was drawn: the next pass draws it again.
      if (frontSignature(readBook(doc)) !== signature) return;
      if (!made) {
        failed.add(signature);
        return;
      }
      try {
        const src = await put(made.file);
        if (stopped || frontSignature(readBook(doc)) !== signature) return;
        updateBook(doc, { [THUMB_KEY]: encodeArt({ src, w: made.w, h: made.h }), [THUMB_OF_KEY]: signature });
      } catch {
        failed.add(signature);
      }
    };

    const sendCard = async () => {
      const post = io.current.send;
      if (!post) return;
      const { card, media } = forServer(cardOf(doc, format), settingsMedia(doc));
      const key = `${cardKey(card)}${JSON.stringify(media)}`;
      if (key === sent) return;
      sent = key;
      await post(card, media).catch(() => {
        sent = "";
      });
    };

    const run = async () => {
      timer = null;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        await drawThumb();
        if (!stopped) await sendCard();
      } finally {
        busy = false;
      }
      if (again && !stopped) {
        again = false;
        schedule();
      }
    };
    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), quiet);
    };

    const book = doc.getMap("book");
    const settings = doc.getMap("settings");
    book.observe(schedule);
    settings.observe(schedule);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      book.unobserve(schedule);
      settings.unobserve(schedule);
    };
  }, [doc, format, canWrite, quiet]);
}
