/**
 * The look of the pages, as the document's own settings.
 *
 * A PDF says what size its paper is. The rest is measured from where the
 * text stands on it: the margins, how many columns, the font and size most
 * of it is set in, how far apart its lines and its paragraphs are, whether
 * first lines start in. What was printed on every page (furniture.ts) is
 * the header and the footer.
 *
 * These are said once, for the whole document. A paragraph then only says
 * how it differs (assemble.ts).
 */

import { matchPageSize } from "../../docSettings";
import type { Furniture } from "./furniture";
import type { Line, ParaBlock } from "./model";
import type { Metrics } from "./paras";

export interface LookPage {
  w: number;
  h: number;
  /** Its text (what is printed on every page left out). */
  lines: Line[];
  /** How many columns it is read in, and the space between them. */
  columns: number;
  gap: number;
}

export interface Look {
  settings: Record<string, unknown>;
  /** Entries for the document's font table. */
  fonts: Record<string, string>;
  /** First lines start in by the document's setting. */
  indentSet: boolean;
}

const at = (values: number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * share)))];
};
const inches = (points: number, least: number, most: number): number => Math.round(Math.min(most, Math.max(least, points / 72)) * 100) / 100;

function mostOften<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let top = 0;
  for (const [v, count] of counts) {
    if (count > top) {
      top = count;
      best = v;
    }
  }
  return best;
}

export function lookOf(
  pages: LookPage[],
  body: Metrics,
  furniture: Furniture,
  paras: ParaBlock[],
  info: Record<string, unknown>,
  fontId: ((name: string) => string | null) | undefined,
  familyOf: (name: string) => string,
): Look {
  const settings: Record<string, unknown> = {};
  const fonts: Record<string, string> = {};

  // The paper most pages are.
  const size = mostOften(pages.map((p) => `${Math.round(p.w)}x${Math.round(p.h)}`));
  const usual = pages.filter((p) => `${Math.round(p.w)}x${Math.round(p.h)}` === size);
  const sheet = usual[0];
  if (sheet) {
    const w = Math.round((sheet.w / 72) * 100) / 100;
    const h = Math.round((sheet.h / 72) * 100) / 100;
    const named = matchPageSize(w, h);
    if (named) Object.assign(settings, named);
    else if (w >= 2 && h >= 2 && w <= 24 && h <= 24) Object.assign(settings, { pageSize: "custom", pw: w, ph: h, landscape: w > h });

    // The margins: where the text stops short of the paper's edges, on the
    // pages that have enough text to say.
    const full = usual.filter((p) => p.lines.length >= 5);
    if (full.length) {
      const left = full.map((p) => at(p.lines.map((l) => l.x0), 0.05));
      const right = full.map((p) => p.w - at(p.lines.map((l) => l.x1), 0.95));
      const top = full.map((p) => Math.min(...p.lines.map((l) => l.top)));
      const foot = full.map((p) => p.h - Math.max(...p.lines.map((l) => l.bottom)));
      settings.ml = inches(at(left, 0.5), 0.25, 3);
      // (Lines stop where their words do: the fullest pages say where the
      // edge is.)
      settings.mr = inches(at(right, 0.1), 0.25, 3);
      settings.mt = inches(at(top, 0.1), 0.25, 3);
      settings.mb = inches(at(foot, 0.1), 0.25, 3);
    }
    const counts = usual.filter((p) => p.lines.length >= 8).map((p) => p.columns);
    const cols = mostOften(counts) ?? 1;
    if (cols >= 2) {
      settings.cols = Math.min(3, cols);
      const gaps = usual.filter((p) => p.columns === cols && p.gap > 0).map((p) => p.gap);
      if (gaps.length) settings.colGap = inches(at(gaps, 0.5), 0.1, 2);
    }
  }

  // The text: its font, its size, how its lines and paragraphs are spaced.
  const font = fontId?.(body.font) ?? null;
  if (font) {
    settings.bodyFont = font;
    if (font.includes(":")) fonts[font] = JSON.stringify({ n: familyOf(body.font) });
  }
  if (body.size >= 6 && body.size <= 96) settings.bodySize = body.size;
  // (Line spacing is counted in single lines, one of which is 1.2 of the size.)
  settings.bodyLine = Math.min(4, Math.max(0.8, Math.round((body.leading / (body.size * 1.2)) * 100) / 100));
  const prose = paras.filter((p) => !p.heading && !p.align && !p.element && p.lines >= 2);
  const indented = prose.filter((p) => p.indent);
  const indentSet = prose.length >= 3 && indented.length >= prose.length * 0.5;
  if (indentSet) settings.firstIndent = inches(at(indented.map((p) => p.inset ?? 18), 0.5), 0.05, 2);
  settings.paraSpacing = Math.round(Math.min(72, Math.max(0, body.gap)));

  // What was printed on every page.
  Object.assign(settings, furniture.slots);
  if (furniture.start !== null && furniture.start !== 1) settings.pnStart = furniture.start;

  // What the file says of itself.
  const said = (key: string, most: number): string | null => (typeof info[key] === "string" && (info[key] as string).trim() ? (info[key] as string).trim().slice(0, most) : null);
  const subject = said("Subject", 300);
  const keywords = said("Keywords", 500);
  const language = said("Language", 35);
  if (subject) settings.subject = subject;
  if (keywords) settings.keywords = keywords;
  if (language && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) settings.lang = language;
  return { settings, fonts, indentSet };
}
