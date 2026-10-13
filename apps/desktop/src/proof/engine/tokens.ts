/**
 * A block's text cut into words, numbers, punctuation and spaces. Written
 * by hand (no lookbehind: the app runs on Safari 15) and the same on every
 * device, since what is remembered about a place is keyed by its words.
 */

export const WORD = 1;
export const NUMBER = 2;
/** Letters and digits together: 10th, A4, x86. */
export const ALNUM = 3;
/** One mark of punctuation. */
export const PUNCT = 4;
/** A run of spaces. */
export const SPACE = 5;
/** A line break inside the block. */
export const BREAK = 6;
/** Not text: a picture, a run of code, a web address. */
export const OBJECT = 7;

/** A hyphen with a letter or a digit on each side. */
export const F_JOINED = 1;
/** Begins with a capital. */
export const F_CAP = 2;
/** All capitals (two letters or more). */
export const F_UPPER = 4;
/** Opens a sentence. */
export const F_START = 8;
/** Inside quote marks. */
export const F_SPEECH = 16;
/** Might open a sentence: evidence of nothing. */
export const F_UNSURE = 32;

export interface Tokens {
  n: number;
  kind: Uint8Array;
  start: Int32Array;
  end: Int32Array;
  flag: Uint8Array;
}

export const OBJ = String.fromCharCode(0xfffc);

const LETTER = /[\p{L}\p{M}]/u;
const SPACES = new Set([0x20, 0x09, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
const HYPHENS = new Set([0x2d, 0x2010, 0x2011]);
const APOSTROPHES = new Set([0x27, 0x2019]);

export const isDigit = (c: number): boolean => c >= 48 && c <= 57;
export function isLetter(c: number): boolean {
  if (c < 128) return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  if (c < 0xc0) return c === 0xaa || c === 0xb5 || c === 0xba;
  return LETTER.test(String.fromCodePoint(c));
}
export const isSpace = (c: number): boolean => SPACES.has(c);
export const isHyphen = (c: number): boolean => HYPHENS.has(c);

/** Web and mail addresses: read as one thing that isn't text. */
const ADDRESS = new RegExp(`(?:https?://|www\\.)[^\\s${OBJ}]+|[^\\s${OBJ}@]+@[^\\s${OBJ}@]+\\.[^\\s${OBJ}@.,!?)]+`, "g");

const width = (c: number): number => (c > 0xffff ? 2 : 1);

export function tokenize(text: string): Tokens {
  const kind: number[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const flag: number[] = [];
  const push = (k: number, s: number, e: number, f = 0) => {
    kind.push(k);
    start.push(s);
    end.push(e);
    flag.push(f);
  };

  // Addresses first, so their dots and slashes are never read as prose.
  const skip: number[] = [];
  if (text.includes("@") || text.includes("://") || text.includes("www.")) {
    ADDRESS.lastIndex = 0;
    for (let m = ADDRESS.exec(text); m; m = ADDRESS.exec(text)) {
      let to = m.index + m[0].length;
      // The full stop that ends the sentence isn't part of the address.
      while (to > m.index && ".,!?)".includes(text[to - 1])) to -= 1;
      skip.push(m.index, to);
    }
  }
  let nextSkip = 0;

  const len = text.length;
  let i = 0;
  while (i < len) {
    if (nextSkip < skip.length && i === skip[nextSkip]) {
      push(OBJECT, i, skip[nextSkip + 1]);
      i = skip[nextSkip + 1];
      nextSkip += 2;
      continue;
    }
    const stop = nextSkip < skip.length ? skip[nextSkip] : len;
    const c = text.codePointAt(i) as number;
    if (c === 10) {
      push(BREAK, i, i + 1);
      i += 1;
    } else if (c === 0xfffc) {
      push(OBJECT, i, i + 1);
      i += 1;
    } else if (isSpace(c)) {
      let j = i + 1;
      while (j < stop && isSpace(text.charCodeAt(j))) j += 1;
      push(SPACE, i, j);
      i = j;
    } else if (isDigit(c)) {
      let j = i + 1;
      for (;;) {
        while (j < stop && isDigit(text.charCodeAt(j))) j += 1;
        // 1,000 and 3.14: a separator with a digit after it.
        const sep = text.charCodeAt(j);
        if (j + 1 < stop && (sep === 0x2c || sep === 0x2e) && isDigit(text.charCodeAt(j + 1))) j += 1;
        else break;
      }
      let k = j;
      while (k < stop) {
        const d = text.codePointAt(k) as number;
        if (!isLetter(d) && !isDigit(d)) break;
        k += width(d);
      }
      push(k > j ? ALNUM : NUMBER, i, k);
      i = k;
    } else if (isLetter(c)) {
      let j = i + width(c);
      let digits = false;
      while (j < stop) {
        const d = text.codePointAt(j) as number;
        if (isLetter(d)) j += width(d);
        else if (isDigit(d)) {
          digits = true;
          j += 1;
        } else if (APOSTROPHES.has(d) && j + 1 < stop && isLetter(text.codePointAt(j + 1) as number)) j += 1;
        else break;
      }
      const word = text.slice(i, j);
      let f = 0;
      const first = String.fromCodePoint(c);
      if (first !== first.toLowerCase()) f |= F_CAP;
      if (j - i >= 2 && word === word.toUpperCase() && word !== word.toLowerCase()) f |= F_UPPER;
      push(digits ? ALNUM : WORD, i, j, f);
      i = j;
    } else {
      const w = width(c);
      let f = 0;
      if (isHyphen(c) && i > 0 && i + 1 < len) {
        const before = text.charCodeAt(i - 1);
        const after = text.codePointAt(i + 1) as number;
        if ((isLetter(before) || isDigit(before)) && (isLetter(after) || isDigit(after))) f |= F_JOINED;
      }
      push(PUNCT, i, i + w, f);
      i += w;
    }
  }
  return { n: kind.length, kind: Uint8Array.from(kind), start: Int32Array.from(start), end: Int32Array.from(end), flag: Uint8Array.from(flag) };
}

/** A token's text. */
export const tokenText = (text: string, tk: Tokens, i: number): string => text.slice(tk.start[i], tk.end[i]);

/** Whether a token is a word of some kind (letters, digits or both). */
export const isWordy = (kind: number): boolean => kind === WORD || kind === NUMBER || kind === ALNUM;

/** The punctuation mark at a token, or "" when it is not one. */
export const punctAt = (text: string, tk: Tokens, i: number): string => (i >= 0 && i < tk.n && tk.kind[i] === PUNCT ? text.slice(tk.start[i], tk.end[i]) : "");

/** How many words (not numbers) a stretch of tokens holds. */
export function countWords(tk: Tokens, from = 0, to = tk.n): number {
  let n = 0;
  for (let i = from; i < to; i += 1) if (tk.kind[i] === WORD || tk.kind[i] === ALNUM) n += 1;
  return n;
}

/** Lowercase, with the apostrophe a keyboard types. A word's key. */
export const fold = (word: string): string => word.toLowerCase().replace(/’/g, "'");
