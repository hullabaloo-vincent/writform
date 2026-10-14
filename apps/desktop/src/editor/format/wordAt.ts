/**
 * The word the caret is inside: what bold, italic and underline act on when
 * nothing is selected (as a word processor does it), and where growing the
 * selection begins.
 *
 * "Inside" is strict: a letter or digit on both sides of the caret. At a
 * word's edge, in a space or in an empty paragraph there is no word, and
 * the caller does what it always did (sets what is typed next).
 *
 * The paragraph is read child by child: a note in the middle of a sentence
 * holds text of its own, which is no part of the word beside it.
 */

import type { ResolvedPos } from "@tiptap/pm/model";

const LETTER = /[\p{L}\p{N}\p{M}]/u;
const APOSTROPHE = /['’]/;
/** What stands in for anything in a line that is not text (a note, a line break). */
const OTHER = String.fromCharCode(0xfffc);

/** The textblock's own text, with one unit for anything that is not text. */
function lineOf($pos: ResolvedPos): { text: string; at: number } | null {
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  let text = "";
  parent.forEach((child) => {
    // (A unit per position, so an offset in this string is one in the node.)
    text += child.isText ? (child.text ?? "") : OTHER.repeat(child.nodeSize);
  });
  return { text, at: $pos.parentOffset };
}

/** A letter or digit, or an apostrophe with a letter on both sides ("don't"). */
function inWord(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === undefined) return false;
  if (LETTER.test(ch)) return true;
  return APOSTROPHE.test(ch) && LETTER.test(text[i - 1] ?? "") && LETTER.test(text[i + 1] ?? "");
}

/** The word around `$pos` as document positions, or null when the caret is
 *  not strictly inside one. */
export function wordRangeAt($pos: ResolvedPos): { from: number; to: number } | null {
  const line = lineOf($pos);
  if (!line) return null;
  const { text, at } = line;
  if (!inWord(text, at - 1) || !inWord(text, at)) return null;
  let start = at;
  while (start > 0 && inWord(text, start - 1)) start -= 1;
  let end = at;
  while (end < text.length && inWord(text, end)) end += 1;
  const base = $pos.start();
  return { from: base + start, to: base + end };
}

/** The word at or beside `$pos` (also from its edge): for growing a
 *  selection, which begins with the nearest word. */
export function wordNear($pos: ResolvedPos): { from: number; to: number } | null {
  const line = lineOf($pos);
  if (!line) return null;
  const { text, at } = line;
  const seed = inWord(text, at) ? at : inWord(text, at - 1) ? at - 1 : -1;
  if (seed < 0) return null;
  let start = seed;
  while (start > 0 && inWord(text, start - 1)) start -= 1;
  let end = seed + 1;
  while (end < text.length && inWord(text, end)) end += 1;
  const base = $pos.start();
  return { from: base + start, to: base + end };
}
