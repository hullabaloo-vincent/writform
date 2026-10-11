/**
 * Values the newer vocabulary carries, read defensively. A document is
 * shared data: a colour, a size or a border in it may have been written by
 * another version of the app, another program's paste, or a hand-edited
 * file. Nothing here throws — a value that isn't what it should be is
 * simply "not set" (`null`), at render time, in the page layout and in the
 * Word export alike. (ProseMirror's own `validate` would throw instead, and
 * break restoring an old version.)
 *
 * Lengths and sizes are points; colours are `#rrggbb`, lower case.
 */

const HEX6 = /^#[0-9a-f]{6}$/;

/** A stored colour, exactly as the vocabulary writes it — or null. */
export function colorAttr(v: unknown): string | null {
  return typeof v === "string" && HEX6.test(v) ? v : null;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  navy: "#000080",
  purple: "#800080",
  teal: "#008080",
  lime: "#00ff00",
  orange: "#ffa500",
  pink: "#ffc0cb",
  brown: "#a52a2a",
};

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/**
 * Any colour a stylesheet or another program might state — `#abc`,
 * `#AABBCC`, `rgb(…)`, a few names — as `#rrggbb`; null for anything else,
 * and for a fully transparent one.
 */
export function toHexColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v || v === "transparent" || v === "inherit" || v === "initial" || v === "auto" || v === "windowtext") return null;
  if (HEX6.test(v)) return v;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  m = /^#([0-9a-f]{6})[0-9a-f]{2}$/.exec(v);
  if (m) return v.endsWith("00") ? null : `#${m[1]}`;
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const channel = (s: string) => (s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * 255 : Number(s));
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    const [r, g, b] = [channel(m[1]), channel(m[2]), channel(m[3])];
    if (![r, g, b, alpha].every(Number.isFinite) || alpha <= 0) return null;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  return NAMED[v] ?? null;
}

/** A number within bounds, or null. */
export function numberAttr(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** A CSS length as points: `12pt`, `16px`, `1.5em` (of `em` points), `0.5in`. */
export function cssLengthToPt(raw: unknown, em = 12): number | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*(-?[\d.]+)\s*(pt|px|em|rem|in|cm|mm|pc)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "px").toLowerCase()) {
    case "pt":
      return n;
    case "px":
      return n * 0.75;
    case "em":
    case "rem":
      return n * em;
    case "in":
      return n * 72;
    case "cm":
      return (n * 72) / 2.54;
    case "mm":
      return (n * 72) / 25.4;
    case "pc":
      return n * 12;
    default:
      return null;
  }
}

/** Rounded the way stored lengths are (a tenth of a point). */
export const roundPt = (v: number) => Math.round(v * 10) / 10;

// ---- text size, indents, line height

export const RUN_SIZE_MIN = 4;
export const RUN_SIZE_MAX = 200;
export const sizeAttr = (v: unknown) => numberAttr(v, RUN_SIZE_MIN, RUN_SIZE_MAX);

export const INDENT_MAX = 720;
/** Left and right indents: from the text's edge inwards. */
export const indentAttr = (v: unknown) => numberAttr(v, 0, INDENT_MAX);
/** First line: positive sets it in, negative hangs it out. */
export const firstIndentAttr = (v: unknown) => numberAttr(v, -INDENT_MAX, INDENT_MAX);

export type LineRule = "exact" | "atLeast";
export const lineRuleAttr = (v: unknown): LineRule | null => (v === "exact" || v === "atLeast" ? v : null);
export const lineAtAttr = (v: unknown) => numberAttr(v, 4, 400);

export type VScript = "sub" | "super";
export const vscriptAttr = (v: unknown): VScript | null => (v === "sub" || v === "super" ? v : null);

// ---- paragraph borders

export interface Border {
  /** Which sides are drawn: any of `t`, `b`, `l`, `r`, in that order. */
  sides: string;
  /** Line weight, points. */
  width: number;
  color: string;
}

const SIDE_ORDER = "tblr";

/** A border attribute is one string, `"<sides> <weight> <colour>"`
 *  (`"tblr 0.75 #000000"`): the binding compares attribute values with
 *  `!==`, so an object would be rewritten on every keystroke. */
export function parseBorder(v: unknown): Border | null {
  if (typeof v !== "string") return null;
  const [rawSides, rawWidth, rawColor] = v.trim().split(/\s+/);
  const sides = [...SIDE_ORDER].filter((s) => (rawSides ?? "").includes(s)).join("");
  if (!sides) return null;
  const width = numberAttr(Number(rawWidth ?? 0.75), 0.25, 6) ?? 0.75;
  return { sides, width, color: colorAttr(rawColor) ?? "#000000" };
}

export function encodeBorder(b: Border | null): string | null {
  if (!b) return null;
  const sides = [...SIDE_ORDER].filter((s) => b.sides.includes(s)).join("");
  if (!sides) return null;
  return `${sides} ${numberAttr(b.width, 0.25, 6) ?? 0.75} ${colorAttr(b.color) ?? "#000000"}`;
}

/** How far a border stands off the text, points: at the sides, and above
 *  and below (Word's own defaults). */
export const BORDER_PAD_X = 4;
export const BORDER_PAD_Y = 1;

// ---- list markers

export const BULLET_MARKERS = ["disc", "circle", "square", "dash", "arrow", "check"] as const;
export type BulletMarker = (typeof BULLET_MARKERS)[number];
export const markerAttr = (v: unknown): BulletMarker | null =>
  typeof v === "string" && (BULLET_MARKERS as readonly string[]).includes(v) ? (v as BulletMarker) : null;

/** The character each marker prints. */
export const MARKER_GLYPH: Record<BulletMarker, string> = {
  disc: "•",
  circle: "◦",
  square: "▪",
  dash: "–",
  arrow: "→",
  check: "✓",
};

// ---- sections

/** What a section sets for itself; anything absent is as the document. */
export interface SectionProps {
  /** A paper size id (see docSettings.ts). */
  size?: string;
  landscape?: boolean;
  /** Margins, inches. */
  mt?: number;
  mr?: number;
  mb?: number;
  ml?: number;
  cols?: number;
  /** Restart page numbering at this number. */
  pn?: number;
}

/**
 * A paragraph that starts a section says so in one string: `sect`, then any
 * of `size:a4 land:1 cols:2 pn:1 mt:1 mr:1 mb:1 ml:1`. (One string, like a
 * border: see `parseBorder`.) Null when the value doesn't start a section.
 */
export function parseSection(v: unknown): SectionProps | null {
  if (typeof v !== "string") return null;
  const [head, ...tokens] = v.trim().split(/\s+/);
  if (head !== "sect") return null;
  const out: SectionProps = {};
  for (const token of tokens) {
    const at = token.indexOf(":");
    if (at < 1) continue;
    const key = token.slice(0, at);
    const raw = token.slice(at + 1);
    const n = Number(raw);
    if (key === "size" && /^[a-z0-9-]{1,24}$/.test(raw)) out.size = raw;
    else if (key === "land") out.landscape = raw === "1";
    else if (key === "cols" && Number.isInteger(n) && n >= 1 && n <= 3) out.cols = n;
    else if (key === "pn" && Number.isInteger(n) && n >= 0 && n <= 99999) out.pn = n;
    else if ((key === "mt" || key === "mr" || key === "mb" || key === "ml") && Number.isFinite(n) && n >= 0 && n <= 3) out[key] = n;
  }
  return out;
}

export function encodeSection(p: SectionProps | null): string | null {
  if (!p) return null;
  const tokens = ["sect"];
  if (p.size && /^[a-z0-9-]{1,24}$/.test(p.size)) tokens.push(`size:${p.size}`);
  if (p.landscape !== undefined) tokens.push(`land:${p.landscape ? 1 : 0}`);
  if (p.cols !== undefined && Number.isInteger(p.cols) && p.cols >= 1 && p.cols <= 3) tokens.push(`cols:${p.cols}`);
  if (p.pn !== undefined && Number.isInteger(p.pn) && p.pn >= 0) tokens.push(`pn:${p.pn}`);
  for (const key of ["mt", "mr", "mb", "ml"] as const) {
    const v = p[key];
    if (v !== undefined && Number.isFinite(v) && v >= 0 && v <= 3) tokens.push(`${key}:${Math.round(v * 1000) / 1000}`);
  }
  return tokens.join(" ");
}

// ---------------------------------------------------------------- pictures, notes, contents, tables
//
// These belong to nodes whose own modules build views in the page (and
// reach the app's backend). The page layout reads the same attributes in a
// worker, where there is no page — so the readers live here, with nothing
// imported, and the node modules re-export them.

export type ImageAlign = "left" | "center" | "right";
export const imageAlign = (v: unknown): ImageAlign | null => (v === "left" || v === "center" || v === "right" ? v : null);
export const CAPTION_MAX = 500;
export const imageCaption = (v: unknown): string | null => {
  const text = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX) : "";
  return text || null;
};

export type NoteKind = "foot" | "end";
export const noteKind = (v: unknown): NoteKind => (v === "end" ? "end" : "foot");

/** How a note's number is written: 1, 2, 3 for footnotes; i, ii, iii for
 *  endnotes (Word's own defaults). */
export function noteNumber(n: number, kind: NoteKind): string {
  if (kind === "foot") return String(n);
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let rest = Math.max(1, Math.min(3999, n));
  let out = "";
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

export const TOC_DEPTH = 3;
export const tocDepth = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6 ? v : TOC_DEPTH);

/** Which lines a table draws. */
export const TABLE_LINES = ["all", "rows", "box", "none"] as const;
export type TableLines = (typeof TABLE_LINES)[number];
export const linesAttr = (v: unknown): TableLines =>
  typeof v === "string" && (TABLE_LINES as readonly string[]).includes(v) ? (v as TableLines) : "all";

export const COL_MIN = 18;
export const COL_MAX = 1440;

/** A table's column widths in points — or null when it has none of its
 *  own, or they don't match its columns (a concurrent edit added one):
 *  then the columns share the width equally. */
export function parseCols(v: unknown, count: number): number[] | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const widths = v.trim().split(/\s+/).map(Number);
  if (widths.length !== count || !widths.every((w) => Number.isFinite(w) && w > 0)) return null;
  return widths.map((w) => Math.min(COL_MAX, Math.max(COL_MIN, w)));
}

export const encodeCols = (widths: number[] | null): string | null =>
  widths && widths.length ? widths.map((w) => roundPt(Math.min(COL_MAX, Math.max(COL_MIN, w)))).join(" ") : null;
