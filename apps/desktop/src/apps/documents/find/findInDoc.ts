/**
 * Find and replace over a ProseMirror document. Matching runs per paragraph
 * over its whole text, so a phrase is found even when part of it is italic;
 * a hard break or an image ends a run. A footnote or an endnote is searched
 * too, as a run of its own: its words are found (and replaced), and nothing
 * matches from the sentence into the note. By default curly and straight quotes
 * match each other, as do the space characters (no-break, thin…) — a
 * writer searching for don't finds don’t. Replacing keeps the formatting
 * where the match starts; replacing all is one transaction (one undo).
 *
 * With `pattern` the query is a regular expression, matched against each
 * paragraph's text exactly as written, and the replacement may use $1, $2
 * and $& for what was found. A pattern this browser cannot read (Safari
 * 15 has no lookbehind) finds nothing and says so.
 */

import type { Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Quotes and spaces must match exactly. */
  exact?: boolean;
  /** The query is a regular expression. */
  pattern?: boolean;
}

export interface Match {
  from: number;
  to: number;
  /** What was found (a pattern's match, for $1 in the replacement). */
  text?: string;
  /** The match is inside a note: where that note is in the text. (A note's
   *  words are not on the page itself: the Find bar marks the note's number
   *  and puts the caret beside it.) */
  note?: number;
}

/** The pattern a query is, or null when it is not one this browser reads. */
export function patternOf(query: string, opts: FindOptions): RegExp | null {
  try {
    return new RegExp(query, `gu${opts.caseSensitive ? "" : "i"}`);
  } catch {
    return null;
  }
}

/** Counting stops here ("10,000+"). */
export const MAX_MATCHES = 10_000;

const QUOTES: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u2032": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u201f": '"',
  "\u2033": '"',
};
const SPACES = new Set(["\u00a0", "\u2007", "\u202f", "\u2009", "\u200a", "\u2002", "\u2003", "\u2004", "\u2005"]);
/** Stands in for a hard break or an image: nothing matches across it. */
const STOP = "\u0000";
const WORD = /[\p{L}\p{N}_]/u;

function normalizeChar(ch: string, opts: FindOptions): string {
  let c = ch;
  if (!opts.exact) {
    c = QUOTES[c] ?? c;
    if (SPACES.has(c)) c = " ";
  }
  if (!opts.caseSensitive) {
    // Only same-length lowercasing, so offsets keep lining up.
    const lower = c.toLowerCase();
    if (lower.length === 1) c = lower;
  }
  return c;
}

export function normalizeQuery(query: string, opts: FindOptions): string {
  let out = "";
  for (let i = 0; i < query.length; i += 1) out += normalizeChar(query[i], opts);
  return out;
}

const boundary = (text: string, i: number) => i < 0 || i >= text.length || !WORD.test(text[i]);

/** A stretch of text to match in, with where each of its characters is. */
interface Run {
  text: string;
  at: number[];
  note?: number;
}

/**
 * A paragraph as runs: its own text, where anything that is not text (a
 * line break, a picture, a note) stands as a stop nothing matches across,
 * and after it one run for each note in it, holding the note's words.
 */
function runsOf(node: PmNode, pos: number, fold: (ch: string) => string): Run[] {
  const main: Run = { text: "", at: [] };
  const runs: Run[] = [main];
  const put = (run: Run, text: string, start: number) => {
    for (let i = 0; i < text.length; i += 1) {
      run.text += fold(text[i]);
      run.at.push(start + i);
    }
  };
  node.forEach((child, offset) => {
    const start = pos + 1 + offset;
    if (child.isText) {
      put(main, child.text ?? "", start);
      return;
    }
    main.text += STOP;
    main.at.push(start);
    // Something in the line with words of its own (a footnote, an endnote).
    if (child.isLeaf || !child.inlineContent) return;
    const inner: Run = { text: "", at: [], note: start };
    child.forEach((part, into) => {
      if (part.isText) put(inner, part.text ?? "", start + 1 + into);
      else {
        inner.text += STOP;
        inner.at.push(start + 1 + into);
      }
    });
    if (inner.text) runs.push(inner);
  });
  return runs;
}

/** A paragraph's matches in the order they stand in the text (a note's
 *  come where the note is, not after the whole sentence). */
const inOrder = (matches: Match[], since: number): void => {
  if (matches.length - since < 2) return;
  const tail = matches.splice(since).sort((a, b) => a.from - b.from);
  matches.push(...tail);
};

export function findInDoc(
  doc: PmNode,
  query: string,
  opts: FindOptions = {},
  limit = MAX_MATCHES,
): { matches: Match[]; capped: boolean; bad?: boolean } {
  const matches: Match[] = [];
  if (opts.pattern) return findPattern(doc, query, opts, limit);
  const needle = normalizeQuery(query, opts);
  if (!needle) return { matches, capped: false };
  let capped = false;
  const fold = (ch: string) => normalizeChar(ch, opts);
  doc.descendants((node, pos) => {
    if (capped) return false;
    if (!node.isTextblock) return true;
    const since = matches.length;
    for (const { text, at, note } of runsOf(node, pos, fold)) {
      let i = text.indexOf(needle);
      while (i !== -1 && !capped) {
        const end = i + needle.length;
        if (!opts.wholeWord || (boundary(text, i - 1) && boundary(text, end))) {
          matches.push({ from: at[i], to: at[end - 1] + 1, ...(note === undefined ? {} : { note }) });
          if (matches.length >= limit) capped = true;
        }
        i = text.indexOf(needle, end);
      }
      if (capped) break;
    }
    inOrder(matches, since);
    return false;
  });
  return { matches, capped };
}

function findPattern(doc: PmNode, query: string, opts: FindOptions, limit: number): { matches: Match[]; capped: boolean; bad?: boolean } {
  const matches: Match[] = [];
  if (!query) return { matches, capped: false };
  const pattern = patternOf(query, opts);
  if (!pattern) return { matches, capped: false, bad: true };
  let capped = false;
  // (Matched against the text exactly as written.)
  const asWritten = (ch: string) => ch;
  doc.descendants((node, pos) => {
    if (capped) return false;
    if (!node.isTextblock) return true;
    const since = matches.length;
    for (const { text, at, note } of runsOf(node, pos, asWritten)) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m && !capped; m = pattern.exec(text)) {
        // (A pattern that can match nothing would never move on.)
        if (m[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        if (m[0].includes(STOP)) continue;
        matches.push({ from: at[m.index], to: at[m.index + m[0].length - 1] + 1, text: m[0], ...(note === undefined ? {} : { note }) });
        if (matches.length >= limit) capped = true;
      }
      if (capped) break;
    }
    inOrder(matches, since);
    return false;
  });
  return { matches, capped };
}

/** What a match is replaced with: the words given, or for a pattern the
 *  words with $1, $2 and $& filled in from what was found. */
export function replacementFor(match: Match, replacement: string, query: string, opts: FindOptions): string {
  if (!opts.pattern || match.text === undefined) return replacement;
  try {
    return match.text.replace(new RegExp(query, `u${opts.caseSensitive ? "" : "i"}`), replacement);
  } catch {
    return replacement;
  }
}

/** Replace one match (keeping the formatting where it starts). */
export function replaceOne(tr: Transaction, match: Match, replacement: string): Transaction {
  return replacement ? tr.insertText(replacement, match.from, match.to) : tr.delete(match.from, match.to);
}

/** Replace every match, last first so earlier positions hold — one
 *  transaction, so one undo. */
export function replaceAll(tr: Transaction, matches: Match[], replacement: string): Transaction {
  for (let k = matches.length - 1; k >= 0; k -= 1) replaceOne(tr, matches[k], replacement);
  return tr;
}
