/**
 * Typographic punctuation for whole texts (imports, and the book exports):
 * straight quotes → curly by context, `--` → em dash, `...` → ellipsis,
 * runs of spaces collapsed. Works across a paragraph's text runs (a quote
 * can open in one italic run and close in the next). Pure.
 */

import { quoteStyleFor, type QuoteStyle } from "../../editor/SmartPunctuation";

const OPENING_CONTEXT = /[\s([{—–“‘„«-]/;

export interface PunctuationOptions {
  quotes?: QuoteStyle;
  dashes?: boolean;
  ellipses?: boolean;
  /** Collapse runs of spaces (two spaces after a period, etc.). */
  spaces?: boolean;
}

/**
 * Normalize a paragraph given as consecutive text runs; returns the runs
 * with the same boundaries (empty runs stay empty).
 */
export function normalizeRuns(runs: string[], options: PunctuationOptions = {}): string[] {
  const q = options.quotes ?? quoteStyleFor("en");
  let prev = ""; // last character emitted, across runs
  return runs.map((run) => {
    let out = "";
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i];
      const next = run[i + 1] ?? "";
      if (ch === '"') {
        out += !prev || OPENING_CONTEXT.test(prev) ? q.open2 : q.close2;
      } else if (ch === "'") {
        // Apostrophes inside words are always ’; otherwise open or close.
        if (/[\p{L}\p{N}]/u.test(prev) && /[\p{L}]/u.test(next)) out += "’";
        else if (/[\p{L}\p{N}]/u.test(prev)) out += "’";
        else out += !prev || OPENING_CONTEXT.test(prev) ? q.open1 : q.close1;
      } else if (options.dashes !== false && ch === "-" && next === "-") {
        out += "—";
        i += 1;
        while (run[i + 1] === "-") i += 1;
      } else if (options.ellipses !== false && ch === "." && run.startsWith("..", i + 1)) {
        out += "…";
        i += 2;
      } else if (options.spaces !== false && ch === " " && prev === " ") {
        continue;
      } else {
        out += ch;
      }
      prev = out[out.length - 1] ?? prev;
    }
    return out;
  });
}
