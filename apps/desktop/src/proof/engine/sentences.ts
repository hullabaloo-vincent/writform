/**
 * Where sentences begin. Our own rules and not the platform's segmenter:
 * the answer must be the same on every device, and it leans one way on
 * purpose. A word is said to open a sentence whenever it might, because
 * the checks use a capital in the MIDDLE of a sentence as evidence, and a
 * doubtful word is better left out of the evidence than counted wrongly.
 */

import { ABBREVIATIONS, TITLES } from "../data/abbreviations";
import type { QuoteFacts } from "./quotes";
import { BREAK, F_CAP, F_START, F_UNSURE, isWordy, PUNCT, SPACE, type Tokens, WORD } from "./tokens";

const ENDERS = ".!?…";

/** Sets F_START and F_UNSURE on the block's words. Returns the tokens that
 *  open a sentence, in order. */
export function markSentences(text: string, tk: Tokens, quotes: QuoteFacts): number[] {
  const starts: number[] = [];
  /** What the next word is taken for. */
  let pending: "start" | "unsure" | null = "start";
  /** The pending start needs a space before the word (after a full stop). */
  let needsSpace = false;
  /** A lowercase word after it is no new sentence (after a full stop). */
  let soft = false;
  let spaced = false;
  let mark = 0;

  for (let i = 0; i < tk.n; i += 1) {
    const kind = tk.kind[i];
    if (kind === SPACE) {
      spaced = true;
    } else if (kind === BREAK) {
      pending = "start";
      needsSpace = false;
      soft = false;
    } else if (kind === PUNCT) {
      const at = tk.start[i];
      const ch = text[at];
      while (mark < quotes.marks.length && quotes.marks[mark].at < at) mark += 1;
      const quote = mark < quotes.marks.length && quotes.marks[mark].at === at ? quotes.marks[mark] : null;
      if (quote) {
        if (quote.role === "open") {
          pending = "start";
          needsSpace = false;
          soft = false;
        }
      } else if (ENDERS.includes(ch)) {
        const next = i + 1 < tk.n ? tk.kind[i + 1] : 0;
        if (ch === "." && isWordy(next)) {
          // file.txt, U.S.A: no sentence ends inside a word.
        } else {
          const before = i > 0 && tk.kind[i - 1] === WORD ? text.slice(tk.start[i - 1], tk.end[i - 1]) : "";
          const short = ch === "." && before !== "" && (before.length === 1 || ABBREVIATIONS.has(before.toLowerCase()));
          // Mr. Ashworth: no sentence ends at a title, and what follows is a name.
          if (ch === "." && TITLES.has(before.toLowerCase())) continue;
          if (pending !== "start") pending = short ? "unsure" : "start";
          needsSpace = true;
          soft = true;
          spaced = false;
        }
      } else if (ch === ":") {
        pending = "start";
        needsSpace = true;
        soft = false;
        spaced = false;
      } else if (ch === "," || ch === ";") {
        pending = null;
      }
    } else if (isWordy(kind)) {
      if (pending && (!needsSpace || spaced)) {
        const lower = kind === WORD && !(tk.flag[i] & F_CAP);
        if (pending === "start" && !(soft && lower)) {
          tk.flag[i] |= F_START;
          starts.push(i);
        } else if (pending === "unsure" && !lower) {
          tk.flag[i] |= F_UNSURE;
        }
      }
      pending = null;
      needsSpace = false;
      soft = false;
      spaced = false;
    } else {
      // A picture or an address stands where a word would.
      pending = null;
    }
  }
  return starts;
}
