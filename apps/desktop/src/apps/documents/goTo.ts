import type { JSONContent } from "@tiptap/core";

import type { PageMapFor } from "../../editor/Paginate";

/**
 * Go to: a page by its number ("12"), by how far from this one ("+2",
 * "-1"), or a heading by some of its words. The pages are the printed
 * ones, as page view and the PDF have them.
 */

export type GoToWish = { kind: "page"; page: number } | { kind: "heading"; words: string } | null;

/** What was asked for. `current` and the answer count pages from 1. */
export function parseGoTo(text: string, current: number, pages: number | null): GoToWish {
  const said = text.trim();
  if (!said) return null;
  const rel = /^([+-])\s*(\d{1,5})$/.exec(said);
  const abs = /^(?:p(?:age)?\.?\s*)?(\d{1,6})$/i.exec(said);
  if (rel || abs) {
    if (!pages) return null;
    const wanted = rel ? current + (rel[1] === "-" ? -1 : 1) * Number(rel[2]) : Number(abs![1]);
    return { kind: "page", page: Math.max(1, Math.min(pages, wanted)) };
  }
  return { kind: "heading", words: said.toLowerCase() };
}

type Starts = PageMapFor["starts"];

/** The page (from 1) a place in the text is on. */
export function pageOf(starts: Starts, pos: number): number {
  let page = 1;
  starts.forEach((start, i) => {
    if (start && start.pos <= pos) page = i + 1;
  });
  return page;
}

/** Where a page (from 1) begins in the text. A page whose start cannot be
 *  pointed at gives the nearest one before it that can. */
export function pagePos(starts: Starts, page: number): number | null {
  for (let i = Math.min(starts.length, page) - 1; i >= 0; i -= 1) {
    const start = starts[i];
    if (start) return start.pos;
  }
  return null;
}

/** The headings whose words hold every word asked for, in text order. */
export function matchHeadings<T extends { title: string }>(headings: readonly T[], words: string): T[] {
  const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
  if (!wanted.length) return [];
  return headings.filter((h) => {
    const title = h.title.toLowerCase();
    return wanted.every((w) => title.includes(w));
  });
}

/** How a document's pages are found when page view is not showing them. */
export type PageSource = (doc: JSONContent) => Promise<{ pages: number; starts: Starts } | null>;
