/**
 * What a document's card shows in the lists beside its title, words and
 * date: a synopsis, a picture of the front cover and tags. All of it comes
 * from the document's own settings, so it travels with the document:
 *
 *   manuscript  the book's description, its front cover and its tags. The
 *               cover is a small picture the app draws of the front as
 *               designed (`cover.thumb`), or the front's own picture until
 *               that is made.
 *   Document    its subject and its keywords.
 *   others      nothing (the card shows the opening words).
 *
 * An editor of a server document sends it to the server (useDocCard.ts),
 * as the excerpt comes from snapshots. A document on this device keeps it
 * in the metadata beside it. Nothing here needs a window.
 */

import type * as Y from "yjs";

import type { DocumentCard } from "../../bindings/proto/DocumentCard";
import { COVER_SLOTS, encodeArt, parseArt, type CoverArt } from "../../book/cover/art";
import { ART_SLOTS, readBook, type Book } from "../../book/model/bookMap";
import { key53 } from "../../proof/engine/hash";
import { readDocSettings } from "./docSettings";
import { shorten } from "./docText";

/** The drawn picture of the front, and what it was drawn from. */
export const THUMB_KEY = "cover.thumb";
export const THUMB_OF_KEY = "cover.thumbOf";

export const SYNOPSIS_MAX = 600;
export const TAGS_MAX = 12;
export const TAG_MAX = 40;

export const EMPTY_CARD: DocumentCard = { synopsis: "", cover: null, tags: [] };

/** "dark romance, Female lead , dark Romance" gives two tags. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const piece of text.split(/[,\n]/)) {
    const tag = piece.split(/\s+/).filter(Boolean).join(" ").slice(0, TAG_MAX).trim();
    if (!tag || out.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    out.push(tag);
    if (out.length === TAGS_MAX) break;
  }
  return out;
}

/** What the drawn picture of the front is made from, as a short key (empty
 *  when there is no front to show). A whole cover's front depends on the
 *  spine's width, so its page count is part of it. */
export function frontSignature(book: Book): string {
  const c = book.cover;
  if (!c.front && !c.wrap) return "";
  const p = book.print;
  return key53(
    JSON.stringify([
      c.front && encodeArt(c.front),
      c.wrap && encodeArt(c.wrap),
      c.looks.front,
      c.looks.wrap,
      c.texts.filter((t) => t.panel === "front"),
      [p.trim, p.w, p.h],
      c.wrap ? [c.pages, p.paper] : 0,
    ]),
  );
}

/** The drawn picture of the front, and the signature it was drawn for. */
export function thumbOf(doc: Y.Doc): { thumb: CoverArt | null; of: string } {
  const m = doc.getMap("book");
  const of = m.get(THUMB_OF_KEY);
  return { thumb: parseArt(m.get(THUMB_KEY)), of: typeof of === "string" ? of.slice(0, 40) : "" };
}

/** The card's picture: the drawn front when it was drawn from the cover as
 *  it is now, else the front's own picture, else the whole cover (of which
 *  the card shows the right-hand part). */
export function cardCover(book: Book, thumb: CoverArt | null, of: string): string | null {
  const signature = frontSignature(book);
  if (!signature) return null;
  if (thumb && of === signature) return `front ${encodeArt(thumb)}`;
  if (book.cover.front) return `front ${encodeArt(book.cover.front)}`;
  if (book.cover.wrap) return `wrap ${encodeArt(book.cover.wrap)}`;
  return null;
}

/** A document's card, from its settings. */
export function cardOf(doc: Y.Doc, format: string): DocumentCard {
  if (format === "manuscript") {
    const book = readBook(doc);
    const { thumb, of } = thumbOf(doc);
    return { synopsis: shorten(book.meta.description, SYNOPSIS_MAX), cover: cardCover(book, thumb, of), tags: parseTags(book.meta.tags) };
  }
  if (format === "none") {
    const s = readDocSettings(doc);
    return { synopsis: shorten(s.subject, SYNOPSIS_MAX), cover: null, tags: parseTags(s.keywords) };
  }
  return EMPTY_CARD;
}

/** Every picture the document's settings name: the cover's pieces, its
 *  drawn front and the pictures of the book's pages. */
export function settingsMedia(doc: Y.Doc): string[] {
  const m = doc.getMap("book");
  const keys = [...COVER_SLOTS.map((slot) => `cover.${slot}`), THUMB_KEY, ...ART_SLOTS.map((slot) => `art.${slot}`)];
  const out: string[] = [];
  for (const key of keys) {
    const art = parseArt(m.get(key));
    if (art && !out.includes(art.src)) out.push(art.src);
  }
  return out;
}

const SERVER_PICTURE = /^(?:writform-att:\/\/attachment|https?:\/\/writform-att\.localhost\/attachment|\/api\/v1\/attachments)\/(\d{1,12})(?:\?s=[a-z0-9]*)?$/;

/** A server picture's address as the server reads it, whatever this
 *  platform stores (`writform-att://attachment/N`). Null for anything else. */
export function serverAddress(src: string): string | null {
  const m = SERVER_PICTURE.exec(src);
  return m ? `writform-att://attachment/${m[1]}` : null;
}

/** The card and the pictures as a server takes them: only its own pictures
 *  are named. */
export function forServer(card: DocumentCard, media: string[]): { card: DocumentCard; media: string[] } {
  const cover = parseCardCover(card.cover);
  const address = cover && serverAddress(cover.art.src);
  return {
    card: { ...card, cover: cover && address ? `${cover.kind} ${encodeArt({ ...cover.art, src: address })}` : null },
    media: media.map(serverAddress).filter((a): a is string => a !== null),
  };
}

/** A card's cover read back: which kind of picture, and the picture. */
export function parseCardCover(value: unknown): { kind: "front" | "wrap"; art: CoverArt } | null {
  if (typeof value !== "string") return null;
  const space = value.indexOf(" ");
  const kind = value.slice(0, space);
  if (kind !== "front" && kind !== "wrap") return null;
  const art = parseArt(value.slice(space + 1));
  return art ? { kind, art } : null;
}

/** A card as read from a list (a server's, or the metadata on this
 *  device): anything that isn't one reads as an empty card. */
export function cleanCard(value: unknown): DocumentCard {
  if (!value || typeof value !== "object") return EMPTY_CARD;
  const v = value as Record<string, unknown>;
  const synopsis = typeof v.synopsis === "string" ? v.synopsis.slice(0, SYNOPSIS_MAX + 1) : "";
  const cover = parseCardCover(v.cover) ? (v.cover as string) : null;
  const tags = Array.isArray(v.tags) ? parseTags(v.tags.filter((t): t is string => typeof t === "string").join(",")) : [];
  return { synopsis, cover, tags };
}

export const cardKey = (card: DocumentCard): string => JSON.stringify([card.synopsis, card.cover, card.tags]);
