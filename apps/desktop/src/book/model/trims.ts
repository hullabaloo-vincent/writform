/**
 * Print geometry: trim sizes, margins that satisfy KDP and IngramSpark,
 * spine width, and a page-count estimate for the inspector (the engine
 * knows the real count). Inches throughout. Pure.
 */

import { bookFont } from "../fonts/registry";
import { trimSize, type BookPrint } from "./bookMap";
import type { BookDesign } from "./presets";

export interface PageGeometry {
  w: number;
  h: number;
  top: number;
  bottom: number;
  /** Gutter side (left on rectos, right on versos). */
  inside: number;
  outside: number;
}

/** KDP's minimum inside margin for a page count (no bleed). */
export function kdpMinInside(pages: number): number {
  if (pages <= 150) return 0.375;
  if (pages <= 300) return 0.5;
  if (pages <= 500) return 0.625;
  if (pages <= 700) return 0.75;
  return 0.875;
}

/** KDP's minimum outside / top / bottom margin without bleed. */
export const KDP_MIN_OUTSIDE = 0.25;

/**
 * Margins that read well AND pass preflight: comfortable bases for the trim
 * (running heads and folios sit well inside the 0.5″ safety zone), and an
 * inside margin that grows with the page count — KDP's minimum plus a
 * quarter inch so text never dives into the binding.
 */
export function autoMargins(trim: { w: number; h: number }, pages: number) {
  const large = trim.w >= 6;
  const top = large ? 0.8 : 0.75;
  const bottom = large ? 0.8 : 0.75;
  const outside = large ? 0.65 : 0.6;
  const baseInside = large ? 0.8 : 0.75;
  const inside = Math.max(baseInside, kdpMinInside(pages) + 0.25);
  return { top, bottom, inside, outside };
}

export function geometryFor(print: BookPrint, pages: number): PageGeometry {
  const trim = trimSize(print);
  if (print.margins === "auto") return { ...trim, ...autoMargins(trim, pages) };
  return {
    ...trim,
    top: Math.max(KDP_MIN_OUTSIDE, print.mt),
    bottom: Math.max(KDP_MIN_OUTSIDE, print.mb),
    inside: Math.max(kdpMinInside(pages), print.mi),
    outside: Math.max(KDP_MIN_OUTSIDE, print.mo),
  };
}

/** Spine width for the cover designer: KDP's paper thickness per page. */
export function spineWidth(pages: number, paper: BookPrint["paper"]): number {
  return pages * (paper === "white" ? 0.002252 : 0.0025);
}

/** A page count before the engine has run (the inspector, and the
 *  engine's first guess at the gutter): words per page from the body font's
 *  average character width, the text block and the leading, plus what
 *  chapter openers, right-hand starts and front and back matter add.
 *  Within a few percent of the real count for typical fiction. */
export function estimatePages(
  words: number,
  chapters: number,
  print: BookPrint,
  design: Pick<BookDesign, "bodySize" | "leading" | "bodyFont">,
): number {
  const em = bookFont(design.bodyFont).avgChar;
  let pages = 250;
  // The gutter depends on the page count: settle it once.
  for (let pass = 0; pass < 2; pass += 1) {
    const g = geometryFor(print, pages);
    const textW = (g.w - g.inside - g.outside) * 72;
    const textH = (g.h - g.top - g.bottom) * 72;
    const wordsPerLine = textW / (design.bodySize * em) / 5.9;
    const linesPerPage = Math.floor((textH - design.bodySize * 0.7) / design.leading) + 1;
    const body = words / Math.max(50, wordsPerLine * linesPerPage * 0.94);
    pages = Math.ceil(body + chapters * (0.8 + (print.recto ? 0.5 : 0)) + 14);
  }
  return pages + (pages % 2);
}
