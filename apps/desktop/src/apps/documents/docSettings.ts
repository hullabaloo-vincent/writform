import type * as Y from "yjs";

import type { PageSpec } from "../../editor/Paginate";
import { DOC_FONTS, DOC_FONT_SIZES, DOC_LINE_SPACINGS } from "../../editor/TextFormat";

/**
 * Per-document settings (paper, margins, body-text defaults) for the Plain
 * format, stored in a `Y.Map("settings")` on the document's own Y.Doc. That
 * placement is the whole design: shared docs sync it to every collaborator
 * through the ordinary update stream (no server changes), local docs persist
 * it inside the full-state save, and publishing a local doc replays it to
 * the server copy. Older clients ignore the map entirely — nothing touches
 * the ProseMirror schema.
 */

export interface PageSizeDef {
  id: string;
  label: string;
  /** Inches. */
  w: number;
  h: number;
}

export const PAGE_SIZES: PageSizeDef[] = [
  { id: "letter", label: "US Letter", w: 8.5, h: 11 },
  { id: "halfletter", label: "Half Letter", w: 5.5, h: 8.5 },
  { id: "trade", label: "US Trade", w: 6, h: 9 },
  { id: "a4", label: "A4", w: 8.27, h: 11.69 },
  { id: "a5", label: "A5", w: 5.83, h: 8.27 },
];

/** First-line indent choices in inches (book body text). */
export const DOC_INDENTS = [0.25, 0.3, 0.5] as const;

/** Document-default space after paragraphs, in points. */
export const DOC_PARA_DEFAULTS = [0, 4, 8, 12, 16, 24] as const;

export interface DocSettings {
  pageSize: string;
  /** Margins in inches. Defaults mirror the sheet's original CSS padding. */
  mt: number;
  mr: number;
  mb: number;
  ml: number;
  /** Body-text defaults; null = the built-in Georgia 12pt look. */
  bodyFont: string | null;
  bodySize: number | null;
  bodyLine: number | null;
  paraSpacing: number | null;
  firstIndent: number | null;
}

export const DEFAULT_SETTINGS: DocSettings = {
  pageSize: "letter",
  mt: 0.86,
  mr: 1,
  mb: 1,
  ml: 1.5,
  bodyFont: null,
  bodySize: null,
  bodyLine: null,
  paraSpacing: null,
  firstIndent: null,
};

export const MARGIN_MIN = 0.25;
export const MARGIN_MAX = 2;

export function pageSizeDef(id: string): PageSizeDef {
  return PAGE_SIZES.find((p) => p.id === id) ?? PAGE_SIZES[0];
}

const clampMargin = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, n));
};

const pickNum = (v: unknown, allowed: readonly number[]): number | null => {
  const n = Number(v);
  return allowed.includes(n) ? n : null;
};

function settingsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("settings");
}

/** Read with full validation — a peer on a future build may have written
 *  values this build doesn't know; they fall back rather than break. */
export function readDocSettings(doc: Y.Doc): DocSettings {
  const m = settingsMap(doc);
  const fonts = new Set<string>(DOC_FONTS.map((f) => f.id));
  const rawFont = m.get("bodyFont");
  return {
    pageSize: PAGE_SIZES.some((p) => p.id === m.get("pageSize"))
      ? (m.get("pageSize") as string)
      : DEFAULT_SETTINGS.pageSize,
    mt: clampMargin(m.get("mt"), DEFAULT_SETTINGS.mt),
    mr: clampMargin(m.get("mr"), DEFAULT_SETTINGS.mr),
    mb: clampMargin(m.get("mb"), DEFAULT_SETTINGS.mb),
    ml: clampMargin(m.get("ml"), DEFAULT_SETTINGS.ml),
    bodyFont: typeof rawFont === "string" && fonts.has(rawFont) ? rawFont : null,
    bodySize: pickNum(m.get("bodySize"), DOC_FONT_SIZES),
    bodyLine: pickNum(m.get("bodyLine"), DOC_LINE_SPACINGS),
    paraSpacing: pickNum(m.get("paraSpacing"), DOC_PARA_DEFAULTS),
    firstIndent: pickNum(m.get("firstIndent"), DOC_INDENTS),
  };
}

export function updateDocSettings(doc: Y.Doc, patch: Partial<DocSettings>): void {
  const m = settingsMap(doc);
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) m.delete(k);
      else m.set(k, v);
    }
  });
}

export function onDocSettingsChange(doc: Y.Doc, cb: () => void): () => void {
  const m = settingsMap(doc);
  m.observe(cb);
  return () => m.unobserve(cb);
}

/** How each line-spacing multiple renders on screen. The sheet's default
 *  leading (1.65) is airier than print, so "single" is not 1.0 line-height
 *  but the visual equivalent of single-spaced print text. */
export const LINE_CSS: Record<string, number> = {
  "1": 1.2,
  "1.15": 1.4,
  "1.3": 1.55,
  "1.5": 1.8,
  "2": 2.4,
};

/** The paginator's page geometry: settings-driven for Plain, the fixed
 *  letter sheet (matching the CSS defaults) for every scripted format. */
export function pageSpecFor(format: string, s: DocSettings): PageSpec {
  if (format !== "none") {
    return { w: 8.5, h: 11, mt: 0.86, mr: 1, mb: 1, ml: 1.5 };
  }
  const page = pageSizeDef(s.pageSize);
  return { w: page.w, h: page.h, mt: s.mt, mr: s.mr, mb: s.mb, ml: s.ml };
}

/** Inline CSS custom properties for `.wf-page` — only ever applied to the
 *  Plain format; the scripted formats keep their fixed conventions. */
export function settingsVars(s: DocSettings): Record<string, string> {
  const page = pageSizeDef(s.pageSize);
  const vars: Record<string, string> = {
    "--wfd-w": `${page.w}in`,
    "--wfd-h": `${page.h}in`,
    "--wfd-mt": `${s.mt}in`,
    "--wfd-mr": `${s.mr}in`,
    "--wfd-mb": `${s.mb}in`,
    "--wfd-ml": `${s.ml}in`,
  };
  if (s.bodyFont) {
    const font = DOC_FONTS.find((f) => f.id === s.bodyFont);
    if (font) vars["--wfd-font"] = font.css;
  }
  if (s.bodySize) vars["--wfd-size"] = `${s.bodySize}pt`;
  if (s.bodyLine) vars["--wfd-line"] = String(LINE_CSS[String(s.bodyLine)] ?? 1.65);
  if (s.paraSpacing !== null) vars["--wfd-psp"] = `${s.paraSpacing}pt`;
  if (s.firstIndent) vars["--wfd-ind"] = `${s.firstIndent}in`;
  return vars;
}
