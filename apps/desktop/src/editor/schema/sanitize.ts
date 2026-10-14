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

/** A line round a picture, or one side of a cell: how thick (points) and
 *  what colour (`#rrggbb`). */
export interface Edge {
  w: number;
  color: string;
}
export const EDGE_MAX = 12;
const edgeWidth = (v: unknown): number | null => {
  const w = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(w) && w >= 0 ? Math.min(EDGE_MAX, Math.round(w * 100) / 100) : null;
};

/** A picture's outline, kept as ONE string, `"<points> <#rrggbb>"` (schema
 *  level 3). Null: none. */
export function imageBorder(v: unknown): Edge | null {
  if (typeof v !== "string") return null;
  const [width, color] = v.trim().split(/\s+/);
  const w = edgeWidth(width);
  const c = colorAttr(color);
  return w && c ? { w, color: c } : null;
}
export const encodeImageBorder = (edge: Edge | null): string | null => {
  const w = edge ? edgeWidth(edge.w) : null;
  const c = edge ? colorAttr(edge.color) : null;
  return w && c ? `${w} ${c}` : null;
};

/** How round a picture's corners are: a percentage of its shorter side,
 *  up to 50 (a circle, or an oval for a picture that isn't square). Schema
 *  level 3. Null: square. */
export function imageRound(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.round(n * 10) / 10) : null;
}

// ---- a picture's crop and quarter turns (schema level 4)
//
// A picture's `width` and `height` are the box it shows in: its kept part,
// turned. The crop is what is taken off each side of the picture as it
// stands upright (before it is turned), as parts of its width and height.

/** What is taken off the left, top, right and bottom, as parts (0 to 1). */
export type Crop = [number, number, number, number];
/** The most taken off one side, and off two facing sides together. */
export const CROP_SIDE_MAX = 0.9;
export const CROP_PAIR_MAX = 0.95;

const cropOk = (c: number[]): boolean =>
  c.length === 4 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= CROP_SIDE_MAX) && c[0] + c[2] <= CROP_PAIR_MAX + 1e-9 && c[1] + c[3] <= CROP_PAIR_MAX + 1e-9;
const part = (v: number) => Math.round(v * 10000) / 10000;

/** A crop: `"l t r b"`, or null for none (or one that makes no sense). */
export function parseCrop(v: unknown): Crop | null {
  if (typeof v !== "string") return null;
  const parts = v.trim().split(/\s+/).map(Number);
  if (!cropOk(parts) || parts.every((x) => x === 0)) return null;
  return parts.map(part) as Crop;
}

export function encodeCrop(c: readonly number[] | null | undefined): string | null {
  if (!c) return null;
  const parts = c.map((x) => part(Math.max(0, x)));
  if (!cropOk(parts) || parts.every((x) => x === 0)) return null;
  return parts.join(" ");
}

export type QuarterTurn = 90 | 180 | 270;
/** A picture turned clockwise by a quarter, a half or three quarters. */
export const imageRot = (v: unknown): QuarterTurn | null => (v === 90 || v === 180 || v === 270 ? v : null);

/** How a picture is shown: the part kept and how it is turned. */
export interface PictureView {
  crop?: Crop;
  rot?: QuarterTurn;
}

/** A picture's view from its attributes, or null when it is shown whole and upright. */
export function viewOf(attrs: { crop?: unknown; rot?: unknown } | undefined | null): PictureView | null {
  const crop = parseCrop(attrs?.crop);
  const rot = imageRot(attrs?.rot);
  return crop || rot ? { ...(crop ? { crop } : {}), ...(rot ? { rot } : {}) } : null;
}

const sideways = (view: PictureView | null | undefined) => view?.rot === 90 || view?.rot === 270;

/** The size a picture shows at (its kept part, turned), from its size upright. */
export function shownSize(w: number, h: number, view: PictureView | null | undefined): { w: number; h: number } {
  const c = view?.crop ?? [0, 0, 0, 0];
  const kw = w * (1 - c[0] - c[2]);
  const kh = h * (1 - c[1] - c[3]);
  return sideways(view) ? { w: kh, h: kw } : { w: kw, h: kh };
}

/** A name for a picture as it is shown, apart from the same picture shown
 *  otherwise (the address alone when it is shown whole and upright). */
export function viewKey(url: string, view: PictureView | null | undefined): string {
  if (!view || (!view.crop && !view.rot)) return url;
  return `${url}#view=${view.crop ? view.crop.join(",") : "0,0,0,0"}@${view.rot ?? 0}`;
}

/**
 * A crop as it looks on the turned picture (what is taken off the left,
 * top, right and bottom of what is seen), and back again.
 */
export function cropToShown(c: Crop, rot: QuarterTurn | null | undefined): Crop {
  const [l, t, r, b] = c;
  if (rot === 90) return [b, l, t, r];
  if (rot === 180) return [r, b, l, t];
  if (rot === 270) return [t, r, b, l];
  return [l, t, r, b];
}
export function shownToCrop(s: Crop, rot: QuarterTurn | null | undefined): Crop {
  const [L, T, R, B] = s;
  if (rot === 90) return [T, R, B, L];
  if (rot === 180) return [R, B, L, T];
  if (rot === 270) return [B, L, T, R];
  return [L, T, R, B];
}

/** A 2D affine matrix: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number];
/** `a` after `b`. */
export function mulMatrix(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/**
 * How to draw a picture into a box `w` by `h` (the size it shows at) so that
 * the box holds its kept part, turned: the whole upright picture is drawn
 * `fw` by `fh` at (`x`, `y`), and `m` takes that onto the box.
 */
export function viewMatrix(view: PictureView | null | undefined, w: number, h: number): { fw: number; fh: number; x: number; y: number; m: Matrix } {
  const c = view?.crop ?? [0, 0, 0, 0];
  const side = sideways(view);
  // The kept part, upright.
  const kw = side ? h : w;
  const kh = side ? w : h;
  const fw = kw / (1 - c[0] - c[2]);
  const fh = kh / (1 - c[1] - c[3]);
  const rot = view?.rot ?? 0;
  const m: Matrix = rot === 90 ? [0, 1, -1, 0, kh, 0] : rot === 180 ? [-1, 0, 0, -1, kw, kh] : rot === 270 ? [0, -1, 1, 0, 0, kw] : [1, 0, 0, 1, 0, 0];
  return { fw, fh, x: -c[0] * fw, y: -c[1] * fh, m };
}

export type CellSide = "t" | "r" | "b" | "l";
export const CELL_SIDES: readonly CellSide[] = ["t", "r", "b", "l"];
/** A cell's own lines, by side. A side with no thickness has no line there,
 *  whatever the table draws. */
export type CellEdges = Partial<Record<CellSide, Edge>>;

/**
 * A table cell's own lines, kept as ONE string of `<side>:<points>:<#rrggbb>`
 * parts, as `"r:2.25:#f38d88 t:0:#000000"` (schema level 3). Null: the
 * table's lines, as they are.
 */
export function cellEdges(v: unknown): CellEdges | null {
  if (typeof v !== "string" || v.length > 200) return null;
  const out: CellEdges = {};
  for (const part of v.trim().split(/\s+/)) {
    const [side, width, color] = part.split(":");
    const w = edgeWidth(width);
    const c = colorAttr(color);
    if ((side === "t" || side === "r" || side === "b" || side === "l") && w !== null && c) out[side] = { w, color: c };
  }
  return Object.keys(out).length ? out : null;
}
export function encodeCellEdges(edges: CellEdges | null): string | null {
  const parts: string[] = [];
  for (const side of CELL_SIDES) {
    const edge = edges?.[side];
    const w = edge ? edgeWidth(edge.w) : null;
    const c = edge ? colorAttr(edge.color) : null;
    if (w !== null && c) parts.push(`${side}:${w}:${c}`);
  }
  return parts.length ? parts.join(" ") : null;
}
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
  return noteLabel(n, kind === "foot" ? "1" : "i");
}

/** How notes are numbered (document settings `fnFormat`, `enFormat`):
 *  1 2 3, i ii iii, I II III, a b c, A B C, or * † ‡. */
export const NOTE_FORMATS = ["1", "i", "I", "a", "A", "*"] as const;
export type NoteFormat = (typeof NOTE_FORMATS)[number];
export const noteFormat = (v: unknown, fallback: NoteFormat): NoteFormat =>
  typeof v === "string" && (NOTE_FORMATS as readonly string[]).includes(v) ? (v as NoteFormat) : fallback;
/** Where footnotes start again at 1 (setting `fnRestart`): never, at each
 *  section, or on each page. */
export const NOTE_RESTARTS = ["doc", "section", "page"] as const;
export type NoteRestart = (typeof NOTE_RESTARTS)[number];
export const noteRestart = (v: unknown): NoteRestart => (typeof v === "string" && (NOTE_RESTARTS as readonly string[]).includes(v) ? (v as NoteRestart) : "doc");

/** The marks of the `*` numbering, each used once, then twice, and so on. */
export const NOTE_SYMBOLS = ["*", "\u2020", "\u2021", "\u00a7", "\u2016", "\u00b6"];

/** The `n`th note's label in a format. */
export function noteLabel(n: number, format: NoteFormat): string {
  const k = Math.max(1, Math.floor(n));
  switch (format) {
    case "i":
    case "I": {
      const table: [number, string][] = [
        [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
        [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
      ];
      let rest = Math.min(3999, k);
      let out = "";
      for (const [value, glyph] of table) {
        while (rest >= value) {
          out += glyph;
          rest -= value;
        }
      }
      return format === "I" ? out.toUpperCase() : out;
    }
    case "a":
    case "A": {
      // a to z, then aa to zz, as Word counts.
      const letter = String.fromCharCode(97 + ((k - 1) % 26)).repeat(Math.floor((k - 1) / 26) + 1);
      return format === "A" ? letter.toUpperCase() : letter;
    }
    case "*":
      return NOTE_SYMBOLS[(k - 1) % NOTE_SYMBOLS.length].repeat(Math.floor((k - 1) / NOTE_SYMBOLS.length) + 1);
    default:
      return String(k);
  }
}

export const TOC_DEPTH = 3;
export const tocDepth = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6 ? v : TOC_DEPTH);

/** Which lines a table draws. */
export const TABLE_LINES = ["all", "rows", "box", "none"] as const;
export type TableLines = (typeof TABLE_LINES)[number];
export const linesAttr = (v: unknown): TableLines =>
  typeof v === "string" && (TABLE_LINES as readonly string[]).includes(v) ? (v as TableLines) : "all";

// ---- a table's rows, cells and place (schema level 4)

/** The least a row is tall, points: a row is as tall as its tallest cell
 *  needs, and at least this. */
export const ROW_H_MIN = 4;
export const ROW_H_MAX = 1584;
export const rowHeight = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= ROW_H_MIN ? Math.round(Math.min(ROW_H_MAX, v) * 10) / 10 : null;
/** A row kept whole: it goes to the next page rather than being cut. */
export const rowKeep = (v: unknown): true | null => (v === true ? true : null);

export const CELL_VALIGNS = ["middle", "bottom"] as const;
export type CellVAlign = (typeof CELL_VALIGNS)[number];
/** Where a cell's words sit when the row is taller than they are (absent: at the top). */
export const cellVAlign = (v: unknown): CellVAlign | null =>
  typeof v === "string" && (CELL_VALIGNS as readonly string[]).includes(v) ? (v as CellVAlign) : null;

export const TABLE_ALIGNS = ["center", "right"] as const;
export type TableAlign = (typeof TABLE_ALIGNS)[number];
/** Where a table narrower than the text sits (absent: at the left). */
export const tableAlign = (v: unknown): TableAlign | null =>
  typeof v === "string" && (TABLE_ALIGNS as readonly string[]).includes(v) ? (v as TableAlign) : null;
export const TABLE_IND_MAX = 720;
/** How far in from the left a table at the left starts, points. */
export const tableIndent = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(Math.min(TABLE_IND_MAX, v) * 10) / 10 : null;

/** The narrowest a column is made by hand (dragging its edge, the buttons). */
export const COL_MIN = 18;
/** The narrowest a column may be at all: a table brought in from Word may
 *  have slivers of columns that are only there to space the others. */
export const COL_FLOOR = 4;
export const COL_MAX = 1440;

/** A table's column widths in points — or null when it has none of its
 *  own, or they don't match its columns (a concurrent edit added one):
 *  then the columns share the width equally. */
export function parseCols(v: unknown, count: number): number[] | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const widths = v.trim().split(/\s+/).map(Number);
  if (widths.length !== count || !widths.every((w) => Number.isFinite(w) && w > 0)) return null;
  return widths.map((w) => Math.min(COL_MAX, Math.max(COL_FLOOR, w)));
}

export const encodeCols = (widths: number[] | null): string | null =>
  widths && widths.length ? widths.map((w) => roundPt(Math.min(COL_MAX, Math.max(COL_FLOOR, w)))).join(" ") : null;

// ---- tab stops (level 4)

/** Left, centre, right, or on the decimal mark. */
export type TabKind = "l" | "c" | "r" | "d";
/** What fills the gap before the stop's text. */
export type TabLeader = "dot" | "dash" | "line";
export interface TabStop {
  /** From the paragraph's left indent, points. */
  pt: number;
  kind: TabKind;
  leader: TabLeader | null;
}
export const TAB_STOPS_MAX = 32;
/** The furthest a stop may be (22 in), points. */
export const TAB_POS_MAX = 1584;
/** Stops every half inch where a paragraph sets none of its own, points. */
export const TAB_EVERY = 36;

/**
 * A paragraph's `tabs`: "none" (none at all, whatever its style says), or
 * up to 32 stops in rising order, `<pt>:<kind>[:<leader>]` each and spaces
 * between ("72:l 216:r:dot 468:d"). Anything else is null (the style's).
 */
export function parseTabs(v: unknown): TabStop[] | "none" | null {
  if (v === "none") return "none";
  if (typeof v !== "string" || v.length > 800) return null;
  const out: TabStop[] = [];
  for (const token of v.trim().split(/\s+/)) {
    const m = /^(\d{1,4}(?:\.\d{1,2})?):([lcrd])(?::(dot|dash|line))?$/.exec(token);
    if (!m) continue;
    const pt = roundPt(Number(m[1]));
    if (!(pt > 0 && pt <= TAB_POS_MAX) || (out.length && pt <= out[out.length - 1].pt)) continue;
    out.push({ pt, kind: m[2] as TabKind, leader: (m[3] as TabLeader | undefined) ?? null });
    if (out.length === TAB_STOPS_MAX) break;
  }
  return out.length ? out : null;
}

export function encodeTabs(stops: readonly TabStop[] | "none" | null): string | null {
  if (stops === "none") return "none";
  if (!stops?.length) return null;
  const byPlace = new Map<number, TabStop>();
  for (const s of stops) {
    const pt = roundPt(s.pt);
    if (pt > 0 && pt <= TAB_POS_MAX && "lcrd".includes(s.kind)) byPlace.set(pt, { ...s, pt });
  }
  const sorted = [...byPlace.values()].sort((a, b) => a.pt - b.pt).slice(0, TAB_STOPS_MAX);
  return sorted.length ? sorted.map((s) => `${s.pt}:${s.kind}${s.leader ? `:${s.leader}` : ""}`).join(" ") : null;
}

/**
 * The stop a tab typed at `x` goes to (points from the left indent), as
 * Word has it: the first stop of the paragraph's own past `x` (a hanging
 * indent counts as one), else the next of the stops every `every` points
 * past the last of its own. `minAdvance` is how far a tab must move at
 * the least.
 */
export function nextTab(stops: readonly TabStop[], every: number, x: number, hang: number | null = null, minAdvance = 0): TabStop {
  const from = x + minAdvance;
  const own = stops.find((s) => s.pt > from + 0.01);
  if (hang !== null && hang > from + 0.01 && (!own || hang < own.pt)) return { pt: hang, kind: "l", leader: null };
  if (own) return own;
  const step = every > 0 ? every : TAB_EVERY;
  const past = Math.max(from, stops.length ? stops[stops.length - 1].pt : 0);
  return { pt: (Math.floor(past / step + 1e-6) + 1) * step, kind: "l", leader: null };
}

/** The decimal mark of a language ("." or ","), for decimal stops. */
export function decimalMark(lang: string | null | undefined): string {
  try {
    return new Intl.NumberFormat(lang || "en-US").formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  } catch {
    return ".";
  }
}

// ---- capitals and letter spacing (level 4)

/** Capitals as formatting: every letter a capital, or the small letters
 *  as small capitals. The letters typed stay as typed. */
export type Caps = "all" | "small";
export const capsAttr = (v: unknown): Caps | null => (v === "all" || v === "small" ? v : null);
/** Space added between letters (negative: taken away), points. */
export const LETTER_SPACING_MIN = -5;
export const LETTER_SPACING_MAX = 20;
export const letterSpacingAttr = (v: unknown): number | null => {
  const n = numberAttr(v, LETTER_SPACING_MIN, LETTER_SPACING_MAX);
  return n === null || n === 0 ? null : roundPt(n);
};

// ---- underline styles, double strikethrough (level 4)

/** An underline other than a single line (null: a single line). */
export type UnderlineKind = "double" | "dotted" | "dashed" | "wavy";
export const UNDERLINE_KINDS: readonly UnderlineKind[] = ["double", "dotted", "dashed", "wavy"];
export const underlineKindAttr = (v: unknown): UnderlineKind | null => (UNDERLINE_KINDS.includes(v as UnderlineKind) ? (v as UnderlineKind) : null);
