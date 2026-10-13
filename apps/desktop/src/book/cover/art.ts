/**
 * A book's cover artwork, as the manuscript keeps it: up to four pictures,
 * each stored with the document like any picture in its text (an attachment
 * on its server, or a file beside it on this device) and named here by its
 * address and its size in pixels.
 *
 *   front  the front cover. The ebook's cover, and the front of a paperback.
 *   back   the back of a paperback.
 *   spine  its spine.
 *   wrap   the whole paperback cover in one piece (back, spine, front): what
 *          a designer delivers. When there is one it is what prints, and the
 *          three pieces are not used for print.
 *
 * In the book map each is ONE string, "<width>x<height> <address>", so a
 * picture and its size can never come apart when two people change the
 * cover at once. Read through `parseArt`: anything else is no artwork.
 *
 * What is made of them (how each sits, the paper's colour, the words on
 * top) is in design.ts.
 *
 * Nothing here needs a window (the layout engine's thread reads the book).
 */

import { encodeLook, encodeText, PLAIN_LOOK, type CoverText, type PanelLook } from "./design";

export type CoverSlot = "front" | "back" | "spine" | "wrap";

export const COVER_SLOTS: readonly CoverSlot[] = ["front", "back", "spine", "wrap"];

export interface CoverArt {
  /** Where the picture is kept (as a document stores a picture's address). */
  src: string;
  /** Its size, pixels. */
  w: number;
  h: number;
}

export interface BookCover {
  front: CoverArt | null;
  back: CoverArt | null;
  spine: CoverArt | null;
  wrap: CoverArt | null;
  /** How many pages the book had when the spine's width last mattered to
   *  what was put in (a spine or a whole cover). 0: not known. */
  pages: number;
  /** How each picture sits, and the paper's colour there (design.ts). */
  looks: Record<CoverSlot, PanelLook>;
  /** The words on the cover, the lowest first. */
  texts: CoverText[];
}

export const noCover = (): BookCover => ({
  front: null,
  back: null,
  spine: null,
  wrap: null,
  pages: 0,
  looks: { front: PLAIN_LOOK, back: PLAIN_LOOK, spine: PLAIN_LOOK, wrap: PLAIN_LOOK },
  texts: [],
});

// A picture kept by a server, or beside a document on this device: nothing
// else is ever fetched for a cover.
const KEPT = String.raw`(?:attachment/\d{1,12}|localdoc/[0-9a-fA-F-]{1,64}/[0-9a-fA-F-]{1,64})`;
const ADDRESS = new RegExp(String.raw`^(?:(?:writform-att://|https?://writform-att\.localhost/)${KEPT}|/api/v1/attachments/\d{1,12})$`);

export function encodeArt(art: CoverArt): string {
  return `${Math.round(art.w)}x${Math.round(art.h)} ${art.src}`;
}

export function parseArt(value: unknown): CoverArt | null {
  if (typeof value !== "string" || value.length > 400) return null;
  const m = /^(\d{1,5})x(\d{1,5}) (\S+)$/.exec(value);
  if (!m || !ADDRESS.test(m[3])) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { src: m[3], w, h } : null;
}

/** The pictures a paperback's cover is printed from: the whole cover when
 *  there is one, otherwise whichever of the three there are. */
export function printPieces(cover: BookCover): CoverSlot[] {
  if (cover.wrap) return ["wrap"];
  return (["back", "spine", "front"] as const).filter((slot) => cover[slot] !== null);
}

/** Whether there is anything to print at all: a picture, a colour, a word. */
export function hasCover(cover: BookCover): boolean {
  if (printPieces(cover).length > 0 || cover.texts.some((t) => t.text.trim() !== "")) return true;
  return (["front", "back", "spine"] as const).some((slot) => cover.looks[slot].color !== PLAIN_LOOK.color);
}

/** The cover as the book map keeps it: every key of it that says something. */
export function coverKeys(cover: BookCover): Record<string, string | number> {
  const keys: Record<string, string | number> = {};
  for (const slot of COVER_SLOTS) {
    const art = cover[slot];
    if (art) keys[`cover.${slot}`] = encodeArt(art);
    const look = encodeLook(cover.looks[slot]);
    if (look) keys[`cover.look.${slot}`] = look;
  }
  if (cover.pages) keys["cover.pages"] = cover.pages;
  for (const text of cover.texts) keys[`cover.text.${text.id}`] = encodeText(text);
  return keys;
}

/** What to write to the book map to turn one cover into another (null:
 *  take the key out). Empty when they are the same. */
export function coverPatch(from: Record<string, string | number>, to: Record<string, string | number>): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = {};
  for (const key of Object.keys(from)) if (!(key in to)) patch[key] = null;
  for (const [key, value] of Object.entries(to)) if (from[key] !== value) patch[key] = value;
  return patch;
}
