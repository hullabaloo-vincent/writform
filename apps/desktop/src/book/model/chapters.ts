/**
 * Chapter and part numbering, shared by the editor's labels, the outline,
 * conversion, and every export. Writers often type the number into the
 * heading ("CHAPTER 3", "Chapter Three: The Storm", "III"); the book design
 * numbers chapters itself, so a literal number is recognized and never
 * printed twice. Pure: no DOM, no editor.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function cap(word: string): string {
  return word.replace(/(^|[\s-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** 1 → "One", 23 → "Twenty-Three", 105 → "One Hundred Five" (to 999). */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return String(n);
  const words = (x: number): string => {
    if (x < 20) return ONES[x];
    if (x < 100) return TENS[Math.floor(x / 10)] + (x % 10 ? `-${ONES[x % 10]}` : "");
    const rest = x % 100;
    return `${ONES[Math.floor(x / 100)]} hundred${rest ? ` ${words(rest)}` : ""}`;
  };
  return cap(words(n));
}

/** "Twenty-Three" / "one hundred and five" → number, else null. */
export function wordsToNumber(text: string): number | null {
  const parts = text
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 5) return null;
  let total = 0;
  let current = 0;
  for (const part of parts) {
    const one = ONES.indexOf(part);
    const ten = TENS.indexOf(part);
    if (one > 0 || (one === 0 && parts.length === 1)) current += one;
    else if (ten >= 2) current += ten * 10;
    else if (part === "hundred") current = (current || 1) * 100;
    else return null;
  }
  total += current;
  return total > 0 ? total : null;
}

const ROMAN: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 4000) return String(n);
  let out = "";
  let rest = n;
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/** Strict roman numeral (canonical form only) → number, else null. */
export function romanToNumber(text: string): number | null {
  const upper = text.toUpperCase();
  if (!/^[MDCLXVI]+$/.test(upper)) return null;
  let total = 0;
  let i = 0;
  for (const [value, glyph] of ROMAN) {
    while (upper.startsWith(glyph, i)) {
      total += value;
      i += glyph.length;
    }
  }
  return i === upper.length && toRoman(total) === upper ? total : null;
}

/** A number written any way a heading writes one, else null. */
export function parseNumber(token: string): number | null {
  const t = token.trim().replace(/\.$/, "");
  if (/^\d{1,3}$/.test(t)) return Number(t) || null;
  return romanToNumber(t) ?? wordsToNumber(t);
}

const CHAPTER_WORDS = "chapter|chap\\.?|ch\\.?|chapitre|kapitel|cap[ií]tulo|capitolo|hoofdstuk";
const PART_WORDS = "part|book|partie|teil|parte|volume|vol\\.?";
// A hyphen only separates when spaced ("3 - Title"): "Twenty-Three" is one number.
const SEP = "\\s*(?:[:.–—|]|\\s-\\s|\\s{2,})\\s*";

export interface HeadingParse {
  /** The number written into the heading, if any. */
  literal: number | null;
  /** What's left as the real title ("" when the heading is only a number). */
  title: string;
  /** True when a label word ("Chapter", "Part") was written. */
  labelled: boolean;
}

/**
 * Split a chapter/part heading into its literal number and its title.
 * "CHAPTER 3" → {3, ""}; "Chapter Three: The Storm" → {3, "The Storm"};
 * "III" → {3, ""}; "The Storm" → {null, "The Storm"}; "One Night in Paris"
 * stays a title (a bare number must stand alone or end at punctuation).
 */
export function parseHeading(text: string, kind: "chapter" | "part" = "chapter"): HeadingParse {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { literal: null, title: "", labelled: false };
  const words = kind === "part" ? PART_WORDS : CHAPTER_WORDS;
  const labelled = new RegExp(`^(?:${words})\\s+(.+?)(?:${SEP}(.*))?$`, "i").exec(clean);
  if (labelled) {
    // "Chapter Twenty-Three" vs "Chapter 3: Title": try the longest number.
    const head = labelled[1];
    const n = parseNumber(head);
    if (n !== null) return { literal: n, title: (labelled[2] ?? "").trim(), labelled: true };
    // "Chapter Three The Storm" (no separator): peel number words off the front.
    const tokens = head.split(" ");
    for (let take = Math.min(4, tokens.length - 1); take >= 1; take -= 1) {
      const m = parseNumber(tokens.slice(0, take).join(" "));
      if (m !== null) {
        const rest = [tokens.slice(take).join(" "), labelled[2] ?? ""].join(" ").trim();
        return { literal: m, title: rest, labelled: true };
      }
    }
  }
  const bare = new RegExp(`^(.+?)(?:${SEP}(.*))?$`).exec(clean);
  if (bare) {
    const n = parseNumber(bare[1]);
    if (n !== null && (bare[2] !== undefined || bare[1] === clean)) {
      return { literal: n, title: (bare[2] ?? "").trim(), labelled: false };
    }
  }
  return { literal: null, title: clean, labelled: false };
}

export type NumberStyle = "word" | "numeral" | "roman" | "none" | "as-written";

export function formatNumber(n: number, style: NumberStyle): string {
  switch (style) {
    case "word":
      return numberToWords(n);
    case "roman":
      return toRoman(n);
    case "numeral":
      return String(n);
    default:
      return "";
  }
}

/** "Chapter Three" / "Part II" / "7" — the printed label (empty for none). */
export function numberLabel(n: number, style: NumberStyle, label: string): string {
  const num = formatNumber(n, style);
  if (!num) return "";
  return label.trim() ? `${label.trim()} ${num}` : num;
}

/** Recognized names of unnumbered chapter-level sections, by placement. */
// Prologue, Interlude, Epilogue and Coda are story — always body matter.
export const FRONT_SECTIONS = /^(foreword|preface|introduction|author['’]s note|a note to the reader)$/i;
export const BACK_SECTIONS =
  /^(epilogue|afterword|acknowledg(e)?ments|about the author|also by.*|glossary|appendix.*|author['’]s note|notes|bibliography|reading group guide|coda|postscript)$/i;
export const UNNUMBERED_NAMES =
  /^(prologue|epilogue|interlude|coda|foreword|preface|introduction|afterword|acknowledg(e)?ments|about the author|author['’]s note|glossary|appendix.*|postscript|dedication|epigraph)$/i;

/** A line that is only a scene-break mark: "* * *", "***", "#", "⁂", "~ ~ ~"… */
export const SCENE_MARK = /^\s*(?:[*#~•·⁂✻❧❦§=_-]\s*){1,5}$/u;
