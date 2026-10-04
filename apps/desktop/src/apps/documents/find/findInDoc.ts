/**
 * Find and replace over a ProseMirror document. Matching runs per paragraph
 * over its whole text, so a phrase is found even when part of it is italic;
 * a hard break or an image ends a run. By default curly and straight quotes
 * match each other, as do the space characters (no-break, thin…) — a
 * writer searching for don't finds don’t. Replacing keeps the formatting
 * where the match starts; replacing all is one transaction (one undo).
 */

import type { Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Quotes and spaces must match exactly. */
  exact?: boolean;
}

export interface Match {
  from: number;
  to: number;
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

export function findInDoc(
  doc: PmNode,
  query: string,
  opts: FindOptions = {},
  limit = MAX_MATCHES,
): { matches: Match[]; capped: boolean } {
  const matches: Match[] = [];
  const needle = normalizeQuery(query, opts);
  if (!needle) return { matches, capped: false };
  let capped = false;
  doc.descendants((node, pos) => {
    if (capped) return false;
    if (!node.isTextblock) return true;
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? "";
        for (let i = 0; i < t.length; i += 1) {
          text += normalizeChar(t[i], opts);
          at.push(start + i);
        }
      } else {
        text += STOP;
        at.push(start);
      }
    });
    let i = text.indexOf(needle);
    while (i !== -1) {
      const end = i + needle.length;
      if (!opts.wholeWord || (boundary(text, i - 1) && boundary(text, end))) {
        matches.push({ from: at[i], to: at[end - 1] + 1 });
        if (matches.length >= limit) {
          capped = true;
          return false;
        }
      }
      i = text.indexOf(needle, end);
    }
    return false;
  });
  return { matches, capped };
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
