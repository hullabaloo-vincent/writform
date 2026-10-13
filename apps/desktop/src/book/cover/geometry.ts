/**
 * What a paperback's cover file must measure, and how artwork sits in it.
 *
 * A paperback cover is ONE sheet: the back cover, the spine and the front
 * cover side by side (in that order, for a book read left to right), with a
 * bleed all the way round that the printer trims off. Its width therefore
 * depends on how thick the book is: on the page count and the paper.
 *
 * The figures are Amazon KDP's (the trim sizes and the spine's width per
 * page are already theirs, in trims.ts): a bleed of 0.125 in on every
 * outside edge, nothing that matters within 0.25 in of the file's edge,
 * 0.0625 in clear on each side of anything on the spine, spine text from 80
 * pages up, and a barcode 2 by 1.2 in on the back, 0.25 in from the spine
 * and from the foot. Another printer's figures would be another table.
 *
 * Inches throughout, from the sheet's top left. Pure.
 */

import { trimSize, type BookPrint } from "../model/bookMap";
import { spineWidth } from "../model/trims";
import type { BookCover, CoverArt, CoverSlot } from "./art";
import { PLAIN_LOOK, type CoverPanel, type CoverText, type PanelLook } from "./design";

/** Trimmed off every outside edge: artwork must reach the file's edge. */
export const BLEED = 0.125;
/** Inside the trimmed edge, where nothing that matters should be. */
export const SAFE = 0.125;
/** Clear on each side of what is printed on the spine. */
export const SPINE_SAFE = 0.0625;
/** Fewer pages than this and the spine is too narrow to print words on. */
export const SPINE_TEXT_PAGES = 80;
export const BARCODE = { w: 2, h: 1.2, inset: 0.25 };
/** What printers ask of artwork, pixels per inch. */
export const PRINT_PPI = 300;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoverGeometry {
  trim: { w: number; h: number };
  /** The pages as printed: an even count (a leaf has two sides). */
  pages: number;
  paper: BookPrint["paper"];
  spine: number;
  /** The whole sheet, bleed included. */
  w: number;
  h: number;
  /** The three panels, each with the bleed on its outside edges. */
  back: Box;
  spineBox: Box;
  front: Box;
  /** Where the printer puts the barcode (on the back, by the spine). */
  barcode: Box;
  /** Whether the spine is wide enough for words. */
  spineText: boolean;
}

export function printedPages(pages: number): number {
  return Math.max(2, Math.ceil(Math.max(0, pages) / 2) * 2);
}

export function coverGeometry(print: BookPrint, pages: number): CoverGeometry {
  const trim = trimSize(print);
  const count = printedPages(pages);
  const spine = spineWidth(count, print.paper);
  const h = trim.h + BLEED * 2;
  const backW = BLEED + trim.w;
  const w = backW + spine + trim.w + BLEED;
  return {
    trim,
    pages: count,
    paper: print.paper,
    spine,
    w,
    h,
    back: { x: 0, y: 0, w: backW, h },
    spineBox: { x: backW, y: 0, w: spine, h },
    front: { x: backW + spine, y: 0, w: trim.w + BLEED, h },
    barcode: { x: backW - BARCODE.inset - BARCODE.w, y: h - BLEED - BARCODE.inset - BARCODE.h, w: BARCODE.w, h: BARCODE.h },
    spineText: count >= SPINE_TEXT_PAGES,
  };
}

/** The part of the sheet a piece of artwork fills. */
export function slotBox(g: CoverGeometry, slot: CoverSlot): Box {
  if (slot === "wrap") return { x: 0, y: 0, w: g.w, h: g.h };
  return slot === "front" ? g.front : slot === "back" ? g.back : g.spineBox;
}

/** A panel as it is trimmed (what a design's places are parts of). */
export function panelTrim(g: CoverGeometry, panel: CoverPanel): Box {
  if (panel === "spine") return { x: g.spineBox.x, y: BLEED, w: g.spine, h: g.trim.h };
  return { x: panel === "front" ? g.front.x : BLEED, y: BLEED, w: g.trim.w, h: g.trim.h };
}

/**
 * Where a picture is drawn so that it fills a box: scaled until it covers
 * it (and by `look.zoom` more), whatever hangs over cut off, showing the
 * part of it the look asks for (its middle, to begin with: as a printer's
 * own fitting does). `ppi` is how many of its pixels then print to the
 * inch.
 */
export function fill(
  art: { w: number; h: number },
  box: Box,
  look: Pick<PanelLook, "zoom" | "fx" | "fy"> = PLAIN_LOOK,
): Box & { ppi: number; lost: number; over: "sides" | "ends" | null } {
  const scale = Math.max(box.w / art.w, box.h / art.h) * Math.max(1, look.zoom);
  const w = art.w * scale;
  const h = art.h * scale;
  const lost = 1 - (box.w * box.h) / (w * h);
  return {
    x: box.x - (w - box.w) * look.fx,
    y: box.y - (h - box.h) * look.fy,
    w,
    h,
    ppi: 1 / scale,
    lost,
    over: lost < 0.0005 ? null : w - box.w > h - box.h ? "sides" : "ends",
  };
}

const keep = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The length a text's `x` and `w` are parts of (points): the panel's
 *  width, or for the spine its length. */
export function textRun(g: CoverGeometry, panel: CoverPanel): number {
  return (panel === "spine" ? g.trim.h : g.trim.w) * 72;
}

/** A piece of text moved by so much of the sheet (points across and down).
 *  On the spine, which reads from the top down, only along it. */
export function movedText(t: CoverText, dx: number, dy: number, g: CoverGeometry): CoverText {
  if (t.panel === "spine") return { ...t, x: keep(t.x + dy / textRun(g, "spine"), -0.2, 1.1) };
  return { ...t, x: keep(t.x + dx / (g.trim.w * 72), -0.2, 1.1), y: keep(t.y + dy / (g.trim.h * 72), -0.2, 1.1) };
}

/** A piece of text made wider or narrower from one side, by so many points
 *  along its own line. The other side stays where it is. */
export function resizedText(t: CoverText, side: "start" | "end", by: number, g: CoverGeometry): CoverText {
  const part = by / textRun(g, t.panel);
  if (side === "end") return { ...t, w: keep(t.w + part, 0.05, 1.4) };
  const w = keep(t.w - part, 0.05, 1.4);
  return { ...t, x: keep(t.x + (t.w - w), -0.2, 1.1), w };
}

/** A picture shown from somewhere else: dragged by so many points, in a box
 *  it overhangs. (Dragging it right shows more of its left.) */
export function pannedLook(look: PanelLook, art: { w: number; h: number }, box: Box, dx: number, dy: number): PanelLook {
  const at = fill(art, box, look);
  const overX = (at.w - box.w) * 72;
  const overY = (at.h - box.h) * 72;
  return {
    ...look,
    fx: overX > 0.5 ? keep(look.fx - dx / overX, 0, 1) : look.fx,
    fy: overY > 0.5 ? keep(look.fy - dy / overY, 0, 1) : look.fy,
  };
}

const inches = (n: number) => `${n.toFixed(3).replace(/\.?0+$/, "")} in`;

/** The sheet's size said three ways: what a designer sets a canvas to. */
export function sizeWords(g: CoverGeometry): { inches: string; mm: string; pixels: string; spine: string } {
  return {
    inches: `${g.w.toFixed(3)} × ${g.h.toFixed(3)} in`,
    mm: `${(g.w * 25.4).toFixed(2)} × ${(g.h * 25.4).toFixed(2)} mm`,
    pixels: `${Math.round(g.w * PRINT_PPI).toLocaleString("en-US")} × ${Math.round(g.h * PRINT_PPI).toLocaleString("en-US")} pixels`,
    spine: inches(g.spine),
  };
}

const SLOT_WORDS: Record<CoverSlot, string> = { front: "front cover", back: "back cover", spine: "spine", wrap: "whole cover" };

/** What a writer should know about a piece of artwork before it prints. */
export function printNotes(slot: CoverSlot, art: CoverArt, g: CoverGeometry, look: PanelLook = PLAIN_LOOK): string[] {
  const notes: string[] = [];
  const fit = fill(art, slotBox(g, slot), look);
  // (A little under is rounding: a designer's 300 is rarely 300.000.)
  if (fit.ppi < PRINT_PPI - 6) {
    notes.push(`This prints at about ${Math.round(fit.ppi)} pixels to the inch. Printers ask for ${PRINT_PPI}, so it may look soft.`);
  }
  // (Zoomed in on purpose: the writer knows some of it is out of sight.)
  if (fit.lost > 0.03 && fit.over && look.zoom <= 1.001) {
    const share = Math.round(fit.lost * 100);
    notes.push(
      fit.over === "sides"
        ? `It is wider than the ${SLOT_WORDS[slot]}, so about ${share}% is cut off at the sides.`
        : `It is taller than the ${SLOT_WORDS[slot]}, so about ${share}% is cut off at the top and bottom.`,
    );
  }
  return notes;
}

/** The same, for the front cover as an ebook's cover (the stores' rules:
 *  tall, about 1.6 to 1, and Kindle's sizes). */
export function ebookNotes(art: CoverArt): string[] {
  const notes: string[] = [];
  if (art.h < 1000 || art.w < 625) {
    notes.push("Kindle asks for at least 625 × 1,000 pixels. This is smaller.");
  } else if (art.h < 2500) {
    notes.push("It will do, though Kindle's ideal is 1,600 × 2,560 pixels.");
  }
  const shape = art.h / art.w;
  if (shape < 1.3) notes.push("Ebook stores expect a tall cover, about 1.6 times as tall as it is wide.");
  if (art.w > 10000 || art.h > 10000) notes.push("Stores turn away covers over 10,000 pixels on a side.");
  return notes;
}

/** The spine has changed width since the artwork that depends on it was put
 *  in: by how much (inches, more or less than nothing), or null. */
export function spineDrift(cover: BookCover, g: CoverGeometry): { was: number; now: number; by: number } | null {
  if (!cover.pages || cover.pages === g.pages) return null;
  if (!cover.wrap && !cover.spine) return null;
  return { was: cover.pages, now: g.pages, by: spineWidth(g.pages, g.paper) - spineWidth(cover.pages, g.paper) };
}
