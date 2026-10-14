import type * as Y from "yjs";

import type { PageSpec } from "../../editor/Paginate";
import type { SectionProps } from "../../editor/schema/sanitize";
import { BODY_AFTER, BODY_LINE, BODY_SIZE, lineCss, type BodyLook } from "../../editor/styles/sheet";
import { fontCssFamily } from "../../fonts/css";
import { isFontId } from "../../fonts/ids";
import { cleanLanguage } from "../../lib/languages";

/**
 * Per-document settings (paper, margins, headers and footers, body-text
 * defaults) for the Document format, stored in a `Y.Map("settings")` on the
 * document's own Y.Doc. That placement is the whole design: shared docs
 * sync it to every collaborator through the ordinary update stream (no
 * server changes), local docs persist it inside the full-state save, and
 * publishing a local doc replays it to the server copy. Nothing here
 * touches the ProseMirror schema.
 *
 * Every value is a primitive, one key per setting, so two people changing
 * different settings at once both win. An app that doesn't know a key (or
 * a value) falls back to its default rather than breaking.
 */

export interface PageSizeDef {
  id: string;
  label: string;
  /** Inches, portrait. */
  w: number;
  h: number;
}

export const PAGE_SIZES: PageSizeDef[] = [
  { id: "letter", label: "US Letter", w: 8.5, h: 11 },
  { id: "legal", label: "US Legal", w: 8.5, h: 14 },
  { id: "tabloid", label: "Tabloid", w: 11, h: 17 },
  { id: "executive", label: "Executive", w: 7.25, h: 10.5 },
  { id: "halfletter", label: "Half Letter", w: 5.5, h: 8.5 },
  { id: "trade", label: "US Trade", w: 6, h: 9 },
  { id: "a3", label: "A3", w: 11.69, h: 16.54 },
  { id: "a4", label: "A4", w: 8.27, h: 11.69 },
  { id: "a5", label: "A5", w: 5.83, h: 8.27 },
  { id: "b5", label: "B5", w: 6.93, h: 9.84 },
];

/** A paper size typed in by hand (`pw` × `ph`). */
export const CUSTOM_PAGE = "custom";

/** First-line indent choices in inches (book body text). */
export const DOC_INDENTS = [0.25, 0.3, 0.5] as const;

/** Document-default space after paragraphs, in points. */
export const DOC_PARA_DEFAULTS = [0, 4, 8, 12, 16, 24] as const;

/** Page-number styles: 1 2 3, i ii iii, I II III, a b c, A B C. */
export const PAGE_NUMBER_FORMATS = ["1", "i", "I", "a", "A"] as const;
export type PageNumberFormat = (typeof PAGE_NUMBER_FORMATS)[number];

/**
 * Header and footer slots: `h`/`f`, then which pages (`""` every page, `1`
 * the first page, `e` even pages), then left/centre/right. Each holds a
 * line of text with fields: `{page}`, `{pages}`, `{title}`, `{author}`,
 * `{date}`.
 */
export const SLOT_KEYS = [
  "hL", "hC", "hR", "fL", "fC", "fR",
  "h1L", "h1C", "h1R", "f1L", "f1C", "f1R",
  "heL", "heC", "heR", "feL", "feC", "feR",
] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

export const SLOT_MAX = 200;

export interface DocSettings extends Record<SlotKey, string> {
  /** A `PAGE_SIZES` id, or `custom`. */
  pageSize: string;
  /** The custom paper, inches (used when `pageSize` is `custom`). */
  pw: number;
  ph: number;
  landscape: boolean;
  /** Margins in inches. Defaults mirror the sheet's original CSS padding. */
  mt: number;
  mr: number;
  mb: number;
  ml: number;
  /** Extra binding margin on the inside edge, inches. */
  gutter: number;
  /** Facing pages: left and right margins swap on even pages. */
  mirror: boolean;
  /** Text columns. */
  cols: number;
  /** Space between columns, inches. */
  colGap: number;
  /** Body-text defaults; null = the built-in Georgia 12pt look. */
  bodyFont: string | null;
  bodySize: number | null;
  bodyLine: number | null;
  paraSpacing: number | null;
  firstIndent: number | null;
  hyphenate: boolean;
  /** Number the lines down the left margin (restarting on each page). */
  lineNumbers: boolean;
  /** A different header and footer on the first page / on even pages. */
  hfFirst: boolean;
  hfEven: boolean;
  /** Header and footer distance from the paper's edge, inches. */
  hd: number;
  fd: number;
  pnFormat: PageNumberFormat;
  /** The number the first page carries. */
  pnStart: number;
  /** The file's properties, as a PDF or a Word file carries them: what it
   *  is about, words to find it by (commas between), and the language it
   *  is written in ("en-GB", or "" when that has not been said). The
   *  language also chooses how words are hyphenated. */
  subject: string;
  keywords: string;
  lang: string;
}

const EMPTY_SLOTS = Object.fromEntries(SLOT_KEYS.map((k) => [k, ""])) as Record<SlotKey, string>;

export const DEFAULT_SETTINGS: DocSettings = {
  ...EMPTY_SLOTS,
  // What documents have always printed: the page number, bottom right.
  fR: "{page}",
  feL: "{page}",
  pageSize: "letter",
  pw: 8.5,
  ph: 11,
  landscape: false,
  mt: 0.86,
  mr: 1,
  mb: 1,
  ml: 1.5,
  gutter: 0,
  mirror: false,
  cols: 1,
  colGap: 0.5,
  bodyFont: null,
  bodySize: null,
  bodyLine: null,
  paraSpacing: null,
  firstIndent: null,
  hyphenate: false,
  lineNumbers: false,
  hfFirst: false,
  hfEven: false,
  hd: 0.5,
  fd: 0.5,
  pnFormat: "1",
  pnStart: 1,
  subject: "",
  keywords: "",
  lang: "",
};

export const SUBJECT_MAX = 300;
export const KEYWORDS_MAX = 500;

export const MARGIN_MIN = 0;
export const MARGIN_MAX = 3;
export const PAPER_MIN = 2;
export const PAPER_MAX = 24;
export const BODY_SIZE_MIN = 6;
export const BODY_SIZE_MAX = 96;

export function pageSizeDef(id: string): PageSizeDef {
  return PAGE_SIZES.find((p) => p.id === id) ?? PAGE_SIZES[0];
}

/** The sheet as it lies, in inches: a named paper turns with the
 *  orientation switch; a custom one is taken as typed. */
export function pageDims(s: Pick<DocSettings, "pageSize" | "pw" | "ph" | "landscape">): { w: number; h: number } {
  if (s.pageSize === CUSTOM_PAGE) return { w: s.pw, h: s.ph };
  const p = pageSizeDef(s.pageSize);
  return s.landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** The paper a sheet of `w` × `h` inches is, if it has a name. */
export function matchPageSize(w: number, h: number): { pageSize: string; landscape: boolean } | null {
  for (const p of PAGE_SIZES) {
    if (Math.abs(p.w - w) < 0.02 && Math.abs(p.h - h) < 0.02) return { pageSize: p.id, landscape: false };
    if (Math.abs(p.h - w) < 0.02 && Math.abs(p.w - h) < 0.02) return { pageSize: p.id, landscape: true };
  }
  return null;
}

const num = (v: unknown, min: number, max: number, fallback: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
};

const numOrNull = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** One line of text, bounded, with no control characters. */
function cleanLine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c !== 0x7f) out += ch;
  }
  return out.slice(0, max);
}

/** A header/footer line. */
export const cleanSlot = (v: unknown): string | null => cleanLine(v, SLOT_MAX);

function settingsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("settings");
}

/** Validate a plain settings object (a map's JSON, an imported file). */
export function settingsFrom(get: (key: string) => unknown): DocSettings {
  const d = DEFAULT_SETTINGS;
  const rawFont = get("bodyFont");
  const rawSize = get("pageSize");
  const slots = {} as Record<SlotKey, string>;
  for (const key of SLOT_KEYS) slots[key] = cleanSlot(get(key)) ?? d[key];
  const pn = get("pnFormat");
  return {
    ...slots,
    pageSize:
      rawSize === CUSTOM_PAGE || PAGE_SIZES.some((p) => p.id === rawSize) ? (rawSize as string) : d.pageSize,
    pw: num(get("pw"), PAPER_MIN, PAPER_MAX, d.pw),
    ph: num(get("ph"), PAPER_MIN, PAPER_MAX, d.ph),
    landscape: bool(get("landscape"), d.landscape),
    mt: num(get("mt"), MARGIN_MIN, MARGIN_MAX, d.mt),
    mr: num(get("mr"), MARGIN_MIN, MARGIN_MAX, d.mr),
    mb: num(get("mb"), MARGIN_MIN, MARGIN_MAX, d.mb),
    ml: num(get("ml"), MARGIN_MIN, MARGIN_MAX, d.ml),
    gutter: num(get("gutter"), 0, 2, d.gutter),
    mirror: bool(get("mirror"), d.mirror),
    cols: Math.round(num(get("cols"), 1, 3, d.cols)),
    colGap: num(get("colGap"), 0.1, 2, d.colGap),
    bodyFont: isFontId(rawFont) ? rawFont : null,
    bodySize: numOrNull(get("bodySize"), BODY_SIZE_MIN, BODY_SIZE_MAX),
    bodyLine: numOrNull(get("bodyLine"), 0.8, 4),
    paraSpacing: numOrNull(get("paraSpacing"), 0, 72),
    firstIndent: numOrNull(get("firstIndent"), 0.05, 2),
    hyphenate: bool(get("hyphenate"), d.hyphenate),
    lineNumbers: bool(get("lineNumbers"), d.lineNumbers),
    hfFirst: bool(get("hfFirst"), d.hfFirst),
    hfEven: bool(get("hfEven"), d.hfEven),
    hd: num(get("hd"), 0.1, 2, d.hd),
    fd: num(get("fd"), 0.1, 2, d.fd),
    pnFormat: PAGE_NUMBER_FORMATS.includes(pn as PageNumberFormat) ? (pn as PageNumberFormat) : d.pnFormat,
    pnStart: Math.round(num(get("pnStart"), 0, 99999, d.pnStart)),
    subject: cleanLine(get("subject"), SUBJECT_MAX) ?? "",
    keywords: cleanLine(get("keywords"), KEYWORDS_MAX) ?? "",
    lang: cleanLanguage(get("lang")),
  };
}

/** Read with full validation — a peer on another build may have written
 *  values this build doesn't know; they fall back rather than break. */
export function readDocSettings(doc: Y.Doc): DocSettings {
  const m = settingsMap(doc);
  return settingsFrom((key) => m.get(key));
}

export function updateDocSettings(doc: Y.Doc, patch: Partial<DocSettings>): void {
  const m = settingsMap(doc);
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) m.delete(k);
      else m.set(k, v);
    }
  });
}

export function onDocSettingsChange(doc: Y.Doc, cb: () => void): () => void {
  const m = settingsMap(doc);
  m.observe(cb);
  return () => m.unobserve(cb);
}

/** The side margins of a page: with mirrored margins (or a gutter) the
 *  binding edge alternates, so even pages swap. Inches. */
export function sideMargins(s: DocSettings, pageNumber: number): { left: number; right: number } {
  const even = pageNumber % 2 === 0;
  const facing = s.mirror;
  if (facing && even) return { left: s.mr, right: s.ml + s.gutter };
  return { left: s.ml + s.gutter, right: s.mr };
}

/** The paginator's page geometry: settings-driven for Document, the fixed
 *  letter sheet (matching the CSS defaults) for every scripted format. */
export function pageSpecFor(format: string, s: DocSettings): PageSpec {
  if (format !== "none") {
    return { w: 8.5, h: 11, mt: 0.86, mr: 1, mb: 1, ml: 1.5 };
  }
  const page = pageDims(s);
  return { w: page.w, h: page.h, mt: s.mt, mr: s.mr, mb: s.mb, ml: s.ml + s.gutter };
}

/** Inline CSS custom properties for `.wf-page` — only ever applied to the
 *  Document format; the scripted formats keep their fixed conventions. */
export function settingsVars(s: DocSettings): Record<string, string> {
  const page = pageDims(s);
  const vars: Record<string, string> = {
    "--wfd-w": `${page.w}in`,
    "--wfd-h": `${page.h}in`,
    "--wfd-mt": `${s.mt}in`,
    "--wfd-mr": `${s.mr}in`,
    "--wfd-mb": `${s.mb}in`,
    "--wfd-ml": `${s.ml + s.gutter}in`,
  };
  const font = s.bodyFont ? fontCssFamily(s.bodyFont) : null;
  if (font) vars["--wfd-font"] = font;
  if (s.bodySize) vars["--wfd-size"] = `${s.bodySize}pt`;
  if (s.bodyLine) vars["--wfd-line"] = String(lineCss(s.bodyLine));
  if (s.paraSpacing !== null) vars["--wfd-psp"] = `${s.paraSpacing}pt`;
  if (s.firstIndent) vars["--wfd-ind"] = `${s.firstIndent}in`;
  if (s.hyphenate) vars["--wfd-hyph"] = "auto";
  return vars;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** A page number in the chosen style. */
export function formatPageNumber(n: number, format: PageNumberFormat): string {
  if (format === "1" || n < 1) return String(n);
  if (format === "i" || format === "I") {
    let rest = Math.min(n, 3999);
    let out = "";
    for (const [value, glyph] of ROMAN) {
      while (rest >= value) {
        out += glyph;
        rest -= value;
      }
    }
    return format === "I" ? out.toUpperCase() : out;
  }
  // a…z, aa…zz (Word repeats the letter).
  const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
  return format === "A" ? letter.toUpperCase() : letter;
}

export interface SlotFields {
  page: number;
  pages: number;
  title: string;
  author: string;
  date: string;
  format: PageNumberFormat;
}

/** Fill a header/footer line's fields. Unknown `{fields}` stay as typed. */
export function fillSlot(text: string, f: SlotFields): string {
  return text.replace(/\{(page|pages|title|author|date)\}/g, (_, key: string) => {
    if (key === "page") return formatPageNumber(f.page, f.format);
    if (key === "pages") return formatPageNumber(f.pages, f.format);
    if (key === "title") return f.title;
    if (key === "author") return f.author;
    return f.date;
  });
}

/** Which three slots a page uses: [left, centre, right] for header and footer. */
export function slotsForPage(
  s: DocSettings,
  index: number,
  pageNumber: number,
): { header: [string, string, string]; footer: [string, string, string] } {
  const variant = s.hfFirst && index === 0 ? "1" : s.hfEven && pageNumber % 2 === 0 ? "e" : "";
  const pick = (band: "h" | "f"): [string, string, string] => [
    s[`${band}${variant}L` as SlotKey],
    s[`${band}${variant}C` as SlotKey],
    s[`${band}${variant}R` as SlotKey],
  ];
  return { header: pick("h"), footer: pick("f") };
}

export { LINE_CSS, lineCss } from "../../editor/styles/sheet";

/** The page setup one section is set on: the document's, with what the
 *  section sets for itself on top. */
export function sectionSettings(base: DocSettings, props: SectionProps | null): DocSettings {
  const s: DocSettings = { ...base };
  if (!props) return s;
  if (props.size && PAGE_SIZES.some((p) => p.id === props.size)) s.pageSize = props.size;
  if (props.landscape !== undefined) {
    // A custom sheet is turned by swapping its sides.
    if (s.pageSize === CUSTOM_PAGE) {
      if (props.landscape !== s.pw > s.ph) [s.pw, s.ph] = [s.ph, s.pw];
    } else s.landscape = props.landscape;
  }
  for (const key of ["mt", "mr", "mb", "ml"] as const) {
    const v = props[key];
    if (v !== undefined) s[key] = v;
  }
  if (props.cols !== undefined) s.cols = props.cols;
  return s;
}

/** Body text as the settings give it — what the Normal style is. */
export function bodyLook(s: Pick<DocSettings, "bodyFont" | "bodySize" | "bodyLine" | "paraSpacing" | "firstIndent">): BodyLook {
  const size = s.bodySize ?? BODY_SIZE;
  return {
    font: s.bodyFont,
    size,
    line: s.bodyLine ?? BODY_LINE,
    after: s.paraSpacing ?? Math.round(BODY_AFTER * size * 10) / 10,
    firstIndent: s.firstIndent ? s.firstIndent * 72 : 0,
  };
}

/** The parts of the inspector (DocSettingsPanel) something else can ask for
 *  by name: "Custom margins…" in the ribbon opens it at Margins. */
export type SetupSection = "paper" | "margins" | "header" | "body" | "indents" | "details";
