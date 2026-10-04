/**
 * Names and counts for the submission manuscript (shared by the Word and
 * PDF versions): the rounded word count for the title page, the running
 * header's surname and short title, and the file name agents expect.
 */

import type { BookModel } from "../model/types";

/** "About 85,000 words": nearest 100 under 10k, nearest 1,000 above. */
export function roundedWordCount(words: number): string {
  const step = words < 10_000 ? 100 : 1_000;
  const rounded = Math.max(step, Math.round(words / step) * step);
  return `About ${rounded.toLocaleString("en-US")} words`;
}

export function smfNames(model: BookModel): { surname: string; shortTitle: string; fileName: string } {
  const { meta, contact, smf } = model.book;
  const fullName = (contact.legalName || meta.author || "Author").trim();
  const penName = (meta.author || fullName).trim();
  const surname = penName.split(/\s+/).pop() || "Author";
  const title = meta.title || "Untitled";
  const shortTitle = (smf.shortTitle || title.split(/\s+/).slice(0, 3).join(" ")).toUpperCase();
  const safe = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");
  return { surname, shortTitle, fileName: `${safe(surname)}_${safe(shortTitle)}_manuscript.docx` };
}

