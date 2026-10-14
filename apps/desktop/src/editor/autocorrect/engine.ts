/**
 * AutoCorrect, the part that thinks: given what stands before the caret
 * and the key just typed, the one change to make, if any. No editor here,
 * so it can be tested as a table.
 *
 * It acts when a word is finished (a space, a mark of punctuation or Enter
 * after it), and for symbols when their last key is typed. It is careful
 * in one direction only: when in doubt it does nothing.
 */

import { ABBREVIATIONS } from "../../proof/data/abbreviations";
import { KEEP_INVERTED, KEEP_TWO_CAPITALS } from "./data/capitals";
import { FRACTIONS } from "./data/symbols";

export interface Kinds {
  /** Slips and contractions from the list (and the writer's own entries). */
  list: boolean;
  /** A capital at the start of a sentence. */
  capitals: boolean;
  /** TWo capitals at the start of a word. */
  twoCaps: boolean;
  /** A word typed with the caps lock on by mistake (wORD). */
  capsLock: boolean;
  /** (c), ->, and the like. */
  symbols: boolean;
  /** 1/2 as one character. */
  fractions: boolean;
  /** 1st with its letters raised. */
  ordinals: boolean;
}

export const KINDS: (keyof Kinds)[] = ["list", "capitals", "twoCaps", "capsLock", "symbols", "fractions", "ordinals"];

export interface Lists {
  /** What is typed (lowercase) and what it becomes. */
  words: ReadonlyMap<string, string>;
  symbols: readonly (readonly [string, string])[];
  /** Shortenings a sentence does not end after (lowercase, no full stop). */
  noCapAfter: ReadonlySet<string>;
  /** Words left as typed whatever their capitals. */
  keepCaps: ReadonlySet<string>;
}

export interface Fix {
  kind: keyof Kinds;
  /** What to replace, as offsets in the text before the caret (with the key
   *  just typed at its end, when it was a character). */
  from: number;
  to: number;
  text: string;
  /** A part of `text` to raise (an ordinal's letters). */
  raise?: [number, number];
}

/** The keys that say a word is finished and left. */
const ENDS = new Set([" ", "\n"]);
/** What a word may stand straight after and still be a word of its own. */
const LEADS = /[\s"'“‘([«—–-]/;
/** Punctuation that may close a word before them. */
const TAIL = /[.,;:!?…"'”’)\]»]*$/;
const LETTER = /[\p{L}\p{M}]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
/** What may stand between the end of a sentence and the space after it. */
const CLOSERS = /["'”’)\]»]+$/;

/** The run of letters and apostrophes that ends where `text` does. */
function lastWord(text: string): { start: number; word: string } {
  let start = text.length;
  while (start > 0 && (LETTER.test(text[start - 1]) || ((text[start - 1] === "'" || text[start - 1] === "’") && start > 1 && LETTER.test(text[start - 2])))) start -= 1;
  return { start, word: text.slice(start) };
}

/** The run of anything but spaces that ends where `text` does. */
function lastToken(text: string): { start: number; token: string } {
  let start = text.length;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return { start, token: text.slice(start) };
}

/**
 * Does a sentence begin where `before` ends? At the start of a paragraph,
 * and after a full stop, a question mark or an exclamation mark and a
 * space. Not after a shortening ("Dr. ", "etc. "), a single letter ("J. "),
 * two full stops or an ellipsis ("So… well").
 */
export function opensSentence(before: string, noCapAfter: ReadonlySet<string>): boolean {
  if (!before.trim()) return true;
  if (!/\s$/.test(before)) return false;
  const said = before.replace(/\s+$/, "").replace(CLOSERS, "");
  const mark = said[said.length - 1];
  if (mark === "!" || mark === "?") return true;
  if (mark !== ".") return false;
  if (said.endsWith("..")) return false;
  const { word } = lastWord(said.slice(0, -1));
  if (!word) return /\d$/.test(said.slice(0, -1));
  const lower = word.toLowerCase();
  if (word.length === 1) return false;
  return !ABBREVIATIONS.has(lower) && !noCapAfter.has(lower);
}

/** `to` with the capitals of `typed` (teh → the, Teh → The). */
function inCaseOf(typed: string, to: string): string {
  if (UPPER.test(typed[0]) && LOWER.test(to[0])) return to[0].toUpperCase() + to.slice(1);
  return to;
}

const ORDINAL = /^(\d+)(st|nd|rd|th)$/;
/** The letters a number takes: 1st, 2nd, 3rd, 4th, 11th, 112th. */
function ordinalEnding(n: string): string {
  const last2 = Number(n.slice(-2));
  if (last2 >= 11 && last2 <= 13) return "th";
  const last = n[n.length - 1];
  return last === "1" ? "st" : last === "2" ? "nd" : last === "3" ? "rd" : "th";
}

export interface FixOptions {
  kinds: Kinds;
  lists: Lists;
  /** Capitals may be set right here (not in a script's lines of capitals, not in verse). */
  capitalsHere: boolean;
  /** An ordinal's letters can be raised here. */
  raiseHere: boolean;
}

/**
 * The change to make now that `typed` has been typed after `before` (the
 * paragraph's text up to the caret, without it). `typed` is "\n" for Enter.
 */
export function fixFor(before: string, typed: string, opts: FixOptions): Fix | null {
  const { kinds, lists } = opts;

  // Symbols, on their last key.
  if (kinds.symbols && typed !== "\n") {
    const now = before + typed;
    for (const [keys, sign] of lists.symbols) {
      if (!now.endsWith(keys)) continue;
      const lead = now[now.length - keys.length - 1] ?? "";
      // (Part of a longer run of the same marks is something else: "-->".)
      if (keys.length <= 2 && (lead === "-" || lead === "<" || lead === "=")) continue;
      return { kind: "symbols", from: now.length - keys.length, to: now.length, text: sign };
    }
  }

  // Everything else waits for the word to be finished and left: a space or
  // Enter, with any punctuation that closed it ("teh, " and "yes. "). Not
  // the punctuation's own key: a full stop typed after a word may be the
  // middle of an address or a file's name, and that is only known by what
  // comes next.
  if (!ENDS.has(typed)) return null;
  const tail = TAIL.exec(before)?.[0] ?? "";
  const body = before.slice(0, before.length - tail.length);

  // A fraction or an ordinal: the last run of anything but spaces.
  const { start: tokenStart, token } = lastToken(body);
  if (kinds.fractions && FRACTIONS.has(token)) return { kind: "fractions", from: tokenStart, to: body.length, text: FRACTIONS.get(token)! };
  const ordinal = ORDINAL.exec(token);
  if (kinds.ordinals && opts.raiseHere && ordinal && ordinalEnding(ordinal[1]) === ordinal[2]) {
    return { kind: "ordinals", from: tokenStart, to: body.length, text: token, raise: [ordinal[1].length, token.length] };
  }

  const { start, word } = lastWord(body);
  if (!word || !LETTER.test(word[0])) return null;
  // A word that is part of something longer (an address, a file's name, a
  // number with letters) is left alone.
  const lead = body[start - 1] ?? "";
  if (lead && !LEADS.test(lead)) return null;
  if (lists.keepCaps.has(word)) return null;
  const fix = (kind: keyof Kinds, text: string): Fix | null => (text === word ? null : { kind, from: start, to: body.length, text });

  // TWo capitals, then small letters.
  if (kinds.twoCaps && word.length >= 3 && UPPER.test(word[0]) && UPPER.test(word[1]) && [...word.slice(2)].every((ch) => LOWER.test(ch)) && !(word.length === 3 && word[2] === "s") && !KEEP_TWO_CAPITALS.has(word)) {
    return fix("twoCaps", word[0] + word[1].toLowerCase() + word.slice(2));
  }
  // A small letter, then capitals: the caps lock was on.
  if (kinds.capsLock && word.length >= 3 && LOWER.test(word[0]) && [...word.slice(1)].every((ch) => UPPER.test(ch)) && !KEEP_INVERTED.has(word)) {
    return fix("capsLock", word[0].toUpperCase() + word.slice(1).toLowerCase());
  }

  const lower = word.toLowerCase();
  const starts = opts.capitalsHere && kinds.capitals && opensSentence(body.slice(0, start), lists.noCapAfter);
  const cap = (text: string) => (starts && LOWER.test(text[0]) ? text[0].toUpperCase() + text.slice(1) : text);

  // The list. A word in capitals all through was meant, whatever it is.
  // And a capital in the middle of a sentence is a name (Hsi, Andone): what
  // looks like a slip there is someone's name spelled as it is.
  const aName = UPPER.test(word[0]) && !opensSentence(body.slice(0, start), lists.noCapAfter);
  const listed = kinds.list && !aName && !(word.length > 1 && word === word.toUpperCase()) ? lists.words.get(lower) : undefined;
  if (listed !== undefined) return fix("list", cap(inCaseOf(word, listed)));

  // A capital to begin a sentence: plain small letters only (not iPhone,
  // not a lone letter before a full stop, which is a label: "a.").
  if (starts && [...word].every((ch) => LOWER.test(ch) || ch === "'" || ch === "’") && !(word.length === 1 && tail.startsWith("."))) {
    return fix("capitals", cap(word));
  }
  return null;
}
