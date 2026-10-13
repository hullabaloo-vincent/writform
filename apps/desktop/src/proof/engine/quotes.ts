/**
 * The quote marks in a block: which open, which close, and which are
 * apostrophes or the marks for feet and inches. Then the stretches of text
 * they enclose.
 *
 * Direction comes from the mark itself where it has one (“ and ”), from the
 * language (in German “ closes), and from what stands either side where
 * neither settles it (the straight marks a keyboard types).
 */

import { ELISIONS } from "../data/en/elisions";
import { CLOSES_BEFORE, OPENS_AFTER } from "../data/marks";
import type { QuoteChars } from "../types";
import { F_SPEECH, isDigit, isLetter, isSpace, type Tokens } from "./tokens";

export interface QuoteMark {
  at: number;
  ch: string;
  /** 2: double marks. 1: single marks. */
  level: 1 | 2;
  shape: "straight" | "curly" | "angle";
  role: "open" | "close" | "apostrophe" | "prime";
}

export interface QuoteSpan {
  /** Indexes into `marks`. `close` is -1 when the block ends first. */
  open: number;
  close: number;
  level: 1 | 2;
  /** 0 for a quotation, 1 for one inside it. */
  depth: number;
}

export interface QuoteFacts {
  marks: QuoteMark[];
  spans: QuoteSpan[];
  /** The block begins with an opening mark of this level (0: it doesn't). */
  opens: 0 | 1 | 2;
  /** Marks still open when the block ends, the outermost first. */
  open: number[];
  /** Closing double marks with nothing open. */
  stray: number[];
}

const DOUBLES = "\"“”„‟«»";
const SINGLES = "'‘’‚‛‹›";
const SHAPE: Record<string, QuoteMark["shape"]> = { '"': "straight", "'": "straight", "«": "angle", "»": "angle", "‹": "angle", "›": "angle" };
/** Which way a mark faces when the language doesn't say. */
const FACES: Record<string, "open" | "close"> = { "“": "open", "”": "close", "„": "open", "‟": "open", "«": "open", "»": "close", "‘": "open", "’": "close", "‚": "open", "‛": "open", "‹": "open", "›": "close" };

function faces(ch: string, q: QuoteChars, level: 1 | 2): "open" | "close" {
  const open = level === 2 ? q.open2 : q.open1;
  const close = level === 2 ? q.close2 : q.close1;
  if (ch === open && ch !== close) return "open";
  if (ch === close && ch !== open) return "close";
  return FACES[ch] ?? "open";
}

export function readQuotes(text: string, q: QuoteChars, english: boolean): QuoteFacts {
  const marks: QuoteMark[] = [];
  const spans: QuoteSpan[] = [];
  const stray: number[] = [];
  /** Indexes of the marks now open. */
  const stack: number[] = [];
  const has = (level: 1 | 2) => stack.some((m) => marks[m].level === level);
  let opens: 0 | 1 | 2 = 0;
  let ink = false;

  const len = text.length;
  for (let i = 0; i < len; i += 1) {
    const ch = text[i];
    const double = DOUBLES.includes(ch);
    if (!double && !SINGLES.includes(ch)) {
      if (!ink && !isSpace(text.charCodeAt(i))) ink = true;
      continue;
    }
    const level: 1 | 2 = double ? 2 : 1;
    const shape = SHAPE[ch] ?? "curly";
    const prev = i > 0 ? text[i - 1] : "";
    const next = i + 1 < len ? text[i + 1] : "";
    const prevCode = prev ? prev.charCodeAt(0) : 0;
    const nextCode = next ? (text.codePointAt(i + 1) as number) : 0;
    // A quote mark is no better than a space for telling: “‘Go,’ she said.”
    const opening = (!prev || isSpace(prevCode) || OPENS_AFTER.includes(prev) || (marks.length > 0 && marks[marks.length - 1].at === i - 1 && marks[marks.length - 1].role === "open")) && !!next && !isSpace(nextCode);
    const closing = !!prev && !isSpace(prevCode) && (!next || isSpace(nextCode) || CLOSES_BEFORE.includes(next) || DOUBLES.includes(next) || SINGLES.includes(next));

    let role: QuoteMark["role"];
    if (level === 2) {
      if (shape === "straight") {
        if (isDigit(prevCode) && !has(2)) role = "prime";
        else if (opening && !closing) role = "open";
        else if (closing && !opening) role = "close";
        else role = has(2) ? "close" : "open";
      } else {
        role = faces(ch, q, 2);
        // The other convention (English marks in a German text, »these«).
        if (role === "open" && closing && !opening && has(2)) role = "close";
        else if (role === "close" && opening && !closing && !has(2)) role = "open";
      }
    } else {
      const inWord = isLetter(prevCode) && isLetter(nextCode);
      if (inWord) role = "apostrophe";
      else if (shape === "straight" && isDigit(prevCode) && !has(1)) role = "prime";
      else {
        const face = shape === "straight" ? (opening && !closing ? "open" : "close") : faces(ch, q, 1);
        if ((face === "open" || opening) && !closing && elided(text, i + 1, english)) role = "apostrophe";
        else if (face === "open" && !(closing && !opening && has(1))) role = "open";
        else if (!has(1)) role = "apostrophe";
        else if (isLetter(prevCode) && dropsLetters(text, i) && closerAhead(text, i + 1)) role = "apostrophe";
        else role = "close";
      }
    }

    const index = marks.length;
    marks.push({ at: i, ch, level, shape, role });
    if (role === "open") {
      if (!ink) opens = level;
      stack.push(index);
    } else if (role === "close") {
      let at = stack.length - 1;
      while (at >= 0 && marks[stack[at]].level !== level) at -= 1;
      if (at < 0) {
        if (level === 2) stray.push(index);
        else marks[index].role = "apostrophe";
      } else {
        // (A mark opened inside and never closed ends here with it.)
        spans.push({ open: stack[at], close: index, level, depth: at });
        stack.length = at;
      }
    }
    ink = true;
  }
  const open = [...stack];
  stack.forEach((m, depth) => spans.push({ open: m, close: -1, level: marks[m].level, depth }));
  return { marks, spans, opens, open, stray };
}

/** The word after an opening mark is one that drops its first letters
 *  (’tis, ’em), or a year (’90s). */
function elided(text: string, from: number, english: boolean): boolean {
  let j = from;
  if (isDigit(text.charCodeAt(j))) return true;
  if (!english) return false;
  while (j < text.length && isLetter(text.codePointAt(j) as number)) j += 1;
  const word = text.slice(from, j);
  return word.length > 0 && word === word.toLowerCase() && ELISIONS.has(word);
}

/** The word before a mark may have dropped its end (dogs’, goin’). */
function dropsLetters(text: string, at: number): boolean {
  const two = text.slice(Math.max(0, at - 2), at).toLowerCase();
  return two.endsWith("s") || two === "in" || two.endsWith("o");
}

/** There is another mark later in the block that could close instead. */
function closerAhead(text: string, from: number): boolean {
  for (let j = from; j < text.length; j += 1) {
    const ch = text[j];
    if (ch !== "'" && ch !== "’") continue;
    const prev = text.charCodeAt(j - 1);
    const next = j + 1 < text.length ? (text.codePointAt(j + 1) as number) : 0;
    if (isLetter(prev) && isLetter(next)) continue;
    if (!isSpace(prev)) return true;
  }
  return false;
}

/** Mark the tokens that stand inside a quotation. */
export function flagSpeech(text: string, tk: Tokens, q: QuoteFacts): void {
  for (const span of q.spans) {
    if (span.depth !== 0) continue;
    const from = q.marks[span.open].at + 1;
    const to = span.close >= 0 ? q.marks[span.close].at : text.length;
    for (let i = firstAt(tk, from); i < tk.n && tk.end[i] <= to; i += 1) tk.flag[i] |= F_SPEECH;
  }
}

/** The first token that starts at or after an offset. */
export function firstAt(tk: Tokens, offset: number): number {
  let lo = 0;
  let hi = tk.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tk.start[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The token an offset falls in, or -1. */
export function tokenAt(tk: Tokens, offset: number): number {
  const i = firstAt(tk, offset + 1) - 1;
  return i >= 0 && tk.start[i] <= offset && offset < tk.end[i] ? i : -1;
}
