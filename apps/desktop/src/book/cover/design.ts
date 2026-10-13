/**
 * What a writer has made of the cover beyond its pictures: how each picture
 * sits in its part of the sheet, the colour of the paper behind it, and
 * the words on top (a title, an author, a line down the spine, the back's
 * blurb).
 *
 * Everything is placed in PARTS OF ITS PANEL (the front, the back or the
 * spine, as trimmed), never in inches of the sheet: the sheet's width
 * changes with the page count, and a design must come through that.
 *
 * In the book map each panel's look and each piece of text is ONE string of
 * its own ("cover.look.front", "cover.text.<id>"), so two people working on
 * different parts of a cover don't undo each other. Read through `parseLook`
 * and `parseText`: whatever isn't one is left out.
 *
 * Its fonts are the app's own and the online library's only: every one of
 * them is open-licensed, free to use on a book that is sold. A font
 * installed on someone's computer can't be named here.
 *
 * Nothing here needs a window (the layout engine's thread reads the book).
 */

import { BOOK_FONTS, isCatalogBookFont } from "../fonts/registry";

export type CoverPanel = "front" | "back" | "spine";

export const COVER_PANELS: readonly CoverPanel[] = ["back", "spine", "front"];

/** How a panel (or the whole sheet) looks under its words. */
export interface PanelLook {
  /** The paper's colour: behind a picture, and all there is without one. */
  color: string;
  /** The picture's size: 1 just covers its panel, more shows less of it. */
  zoom: number;
  /** Which part of an overhanging picture shows: 0 its left (top), 1 its
   *  right (bottom), 0.5 its middle. */
  fx: number;
  fy: number;
}

export const PLAIN_LOOK: PanelLook = { color: "#ffffff", zoom: 1, fx: 0.5, fy: 0.5 };

export type TextAlign = "left" | "center" | "right";

export interface CoverText {
  id: string;
  panel: CoverPanel;
  /**
   * Its box in parts of the panel as trimmed: the left edge, the top edge
   * and the width (its height is as much as its lines take). On the spine,
   * which is read from the top down, `x` and `w` run along it and the line
   * is centred across it.
   */
  x: number;
  y: number;
  w: number;
  text: string;
  /** A font of the app's or of the online library. */
  font: string;
  /** Points. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb`. */
  color: string;
  align: TextAlign;
  /** Line spacing, as a multiple of the size. */
  leading: number;
  /** Letter spacing, in thousandths of the size. */
  tracking: number;
  /** Set in capitals. */
  caps: boolean;
  /** A band of colour behind the words (to read them over a picture). */
  back: string | null;
  /** What is drawn over what: higher is on top. */
  z: number;
}

export const TEXT_MAX = 40;
export const TEXT_CHARS = 4000;
export const DEFAULT_COVER_FONT = "garamond";

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const color = (v: unknown, fallback: string): string => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fallback);
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/** A font a cover may be set in, or the default when it isn't one. */
export function coverFont(id: unknown): string {
  if (typeof id !== "string") return DEFAULT_COVER_FONT;
  return isCatalogBookFont(id) || BOOK_FONTS.some((f) => f.id === id) ? id : DEFAULT_COVER_FONT;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length > 20000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseLook(value: unknown): PanelLook {
  const r = record(value);
  if (!r) return PLAIN_LOOK;
  return { color: color(r.color, PLAIN_LOOK.color), zoom: num(r.zoom, 1, 6, 1), fx: num(r.fx, 0, 1, 0.5), fy: num(r.fy, 0, 1, 0.5) };
}

/** Null when the look is the plain one (nothing to keep). */
export function encodeLook(look: PanelLook): string | null {
  const clean = { color: color(look.color, PLAIN_LOOK.color), zoom: round(num(look.zoom, 1, 6, 1), 3), fx: round(num(look.fx, 0, 1, 0.5)), fy: round(num(look.fy, 0, 1, 0.5)) };
  return clean.color === PLAIN_LOOK.color && clean.zoom === 1 && clean.fx === 0.5 && clean.fy === 0.5 ? null : JSON.stringify(clean);
}

const TEXT_ID = /^[a-z0-9]{4,16}$/;

export function parseText(id: string, value: unknown): CoverText | null {
  const r = record(value);
  if (!r || !TEXT_ID.test(id)) return null;
  const panel = r.panel === "back" || r.panel === "spine" ? r.panel : r.panel === "front" ? "front" : null;
  if (!panel || typeof r.text !== "string") return null;
  return {
    id,
    panel,
    // (A little past the edge is allowed: into the bleed, never far off.)
    x: num(r.x, -0.2, 1.1, 0.1),
    y: num(r.y, -0.2, 1.1, 0.1),
    w: num(r.w, 0.05, 1.4, 0.8),
    text: r.text.slice(0, TEXT_CHARS),
    font: coverFont(r.font),
    size: num(r.size, 4, 400, 24),
    bold: r.bold === true,
    italic: r.italic === true,
    color: color(r.color, "#111111"),
    align: r.align === "left" || r.align === "right" ? r.align : "center",
    leading: num(r.leading, 0.7, 3, 1.15),
    tracking: num(r.tracking, -100, 600, 0),
    caps: r.caps === true,
    back: typeof r.back === "string" && HEX.test(r.back) ? r.back.toLowerCase() : null,
    z: num(r.z, 0, 100000, 0),
  };
}

export function encodeText(t: CoverText): string {
  return JSON.stringify({
    panel: t.panel,
    x: round(t.x),
    y: round(t.y),
    w: round(t.w),
    text: t.text.slice(0, TEXT_CHARS),
    font: coverFont(t.font),
    size: round(t.size, 2),
    ...(t.bold ? { bold: true } : {}),
    ...(t.italic ? { italic: true } : {}),
    color: color(t.color, "#111111"),
    align: t.align,
    leading: round(t.leading, 3),
    ...(t.tracking ? { tracking: Math.round(t.tracking) } : {}),
    ...(t.caps ? { caps: true } : {}),
    ...(t.back ? { back: t.back } : {}),
    z: Math.round(t.z),
  });
}

/** A name for a new piece of text (unique enough within one cover). */
export function newTextId(taken: readonly string[] = []): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 8; i += 1) id += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
    if (!taken.includes(id)) return id;
  }
}

export type TextKind = "title" | "subtitle" | "author" | "blurb" | "spine" | "plain";

/** What the book says of itself, for the words a cover starts with. */
export interface CoverWords {
  title: string;
  subtitle: string;
  author: string;
  description: string;
}

/**
 * A new piece of text of a kind, with its words taken from the book and a
 * place and size that suit it. `z` puts it on top of what is there.
 */
export function newText(kind: TextKind, panel: CoverPanel, words: CoverWords, texts: readonly CoverText[], font = DEFAULT_COVER_FONT): CoverText {
  const base: CoverText = {
    id: newTextId(texts.map((t) => t.id)),
    panel,
    x: 0.1,
    y: 0.4,
    w: 0.8,
    text: "Text",
    font: coverFont(font),
    size: 18,
    bold: false,
    italic: false,
    color: "#111111",
    align: "center",
    leading: 1.15,
    tracking: 0,
    caps: false,
    back: null,
    z: texts.reduce((top, t) => Math.max(top, t.z), 0) + 1,
  };
  if (panel === "spine" || kind === "spine") {
    const said = [words.title, words.author].filter(Boolean).join("   ");
    return { ...base, panel: "spine", x: 0.08, y: 0.5, w: 0.84, text: kind === "plain" ? "Text" : said || "Title", size: 12, align: "center" };
  }
  if (kind === "title") return { ...base, y: 0.14, text: words.title || "Title", size: 44, leading: 1.05 };
  if (kind === "subtitle") return { ...base, y: 0.34, text: words.subtitle || "A subtitle", size: 16, italic: true };
  if (kind === "author") return { ...base, y: 0.84, text: words.author || "Author", size: 20, tracking: 60, caps: true };
  if (kind === "blurb") return { ...base, x: 0.12, y: 0.12, w: 0.76, text: words.description || "What the book is about, in a paragraph or two.", size: 11, align: "left", leading: 1.4 };
  return base;
}

/** The words a bare cover starts with: the book's own, in their usual places. */
export function startingTexts(words: CoverWords, spineText: boolean): CoverText[] {
  const out: CoverText[] = [];
  const add = (kind: TextKind, panel: CoverPanel) => out.push(newText(kind, panel, words, out));
  add("title", "front");
  if (words.subtitle) add("subtitle", "front");
  add("author", "front");
  if (spineText) add("spine", "spine");
  if (words.description) add("blurb", "back");
  return out;
}
