/**
 * Finding words in a PDF.
 *
 * pdf.js gives a page's text as strings, each with its place. They are put
 * end to end (with a space where one string does not run on from the last)
 * and searched as one text, so words that the file drew as separate pieces
 * are still found. A match is given back as boxes on its page, measured as
 * parts of the page, so they sit right at any size the page is shown.
 */

import type { PdfPageProxy, PdfProxy } from "./session";

export interface Hit {
  /** From 0. */
  page: number;
  /** Left, top, width and height, each as a part of the page (0 to 1). */
  rects: { x: number; y: number; w: number; h: number }[];
}

interface Piece {
  /** Where its text starts in the page's text. */
  at: number;
  text: string;
  /** Its box as shown, in points from the page's top left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageText {
  text: string;
  pieces: Piece[];
  w: number;
  h: number;
}

/** A page's text with where each piece of it is. */
export async function pageText(page: PdfPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 });
  const m = viewport.transform as number[];
  const content = await page.getTextContent();
  const pieces: Piece[] = [];
  let text = "";
  for (const raw of content.items) {
    const item = raw as { str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean };
    if (typeof item.str !== "string" || !item.transform) continue;
    if (item.str) {
      const t = item.transform;
      // The piece's baseline start, as the page is shown.
      const x = m[0] * t[4] + m[2] * t[5] + m[4];
      const y = m[1] * t[4] + m[3] * t[5] + m[5];
      const tall = Math.hypot(t[2], t[3]) || item.height || 10;
      const prev = pieces[pieces.length - 1];
      // (Not one word with the piece before it unless it runs straight on.)
      if (prev && text && !/\s$/.test(text) && !/^\s/.test(item.str) && (Math.abs(prev.y + prev.h - y) > tall * 0.5 || x - (prev.x + prev.w) > tall * 0.2)) text += " ";
      pieces.push({ at: text.length, text: item.str, x, y: y - tall, w: Math.abs(item.width ?? 0), h: tall * 1.15 });
      text += item.str;
    }
    if (item.hasEOL && text && !/\s$/.test(text)) text += " ";
  }
  return { text, pieces, w: viewport.width, h: viewport.height };
}

/** Where `query` is in a page's text: each place as boxes. */
export function findInPage(page: PageText, query: string, index: number): Hit[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const hay = page.text.toLowerCase();
  const hits: Hit[] = [];
  for (let from = hay.indexOf(wanted); from >= 0; from = hay.indexOf(wanted, from + Math.max(1, wanted.length))) {
    const to = from + wanted.length;
    const rects: Hit["rects"] = [];
    for (const piece of page.pieces) {
      const start = Math.max(from, piece.at);
      const end = Math.min(to, piece.at + piece.text.length);
      if (end <= start || !piece.text.length) continue;
      // (Each letter taken as wide as the next: near enough to mark a word.)
      const each = piece.w / piece.text.length;
      rects.push({ x: (piece.x + (start - piece.at) * each) / page.w, y: piece.y / page.h, w: ((end - start) * each) / page.w, h: piece.h / page.h });
    }
    if (rects.length) hits.push({ page: index, rects });
  }
  return hits;
}

/** Every place `query` is in the document, in reading order. `texts` keeps
 *  what was read of each page (the same search typed further reads none of
 *  them again). */
export async function findInPdf(pdf: PdfProxy, query: string, texts: Map<number, PageText>, signal?: AbortSignal): Promise<Hit[]> {
  const hits: Hit[] = [];
  if (!query.trim()) return hits;
  for (let n = 0; n < pdf.numPages; n += 1) {
    if (signal?.aborted) return hits;
    let text = texts.get(n);
    if (!text) {
      const page = await pdf.getPage(n + 1);
      text = await pageText(page);
      texts.set(n, text);
    }
    hits.push(...findInPage(text, query, n));
  }
  return hits;
}
