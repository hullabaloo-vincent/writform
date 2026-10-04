/**
 * The book's details and design, kept in the document's own Y.Map("book")
 * beside the text: it syncs to collaborators through the ordinary update
 * stream, saves with on-device documents, and travels with publish /
 * duplicate / combine (docMaps.ts). No server involvement.
 *
 * Stored as FLAT dotted keys ("meta.title", "design.dropCap") with plain
 * values: concurrent edits of different fields merge, and there are no
 * nested Y types to race. Every read validates — a collaborator on a newer
 * build may have written values this build doesn't know; they fall back to
 * defaults rather than break anything.
 */

import * as Y from "yjs";

import type { NumberStyle } from "./chapters";
import { presetDesign, PRESETS, type BookDesign } from "./presets";

export interface BookMeta {
  title: string;
  subtitle: string;
  author: string;
  series: string;
  seriesNumber: number | null;
  publisher: string;
  edition: string;
  isbnPrint: string;
  isbnEbook: string;
  /** BCP-47 language tag: hyphenation, quotes, EPUB metadata. */
  language: string;
  description: string;
  copyrightYear: number | null;
  copyrightHolder: string;
  copyrightNotice: "standard" | "fiction" | "custom";
  copyrightText: string;
  dedication: string;
  epigraph: string;
  epigraphSource: string;
  alsoBy: string[];
  aboutAuthor: string;
}

/** Submission contact block (Standard Manuscript Format title page). */
export interface BookContact {
  legalName: string;
  address: string;
  email: string;
  phone: string;
  agent: string;
}

export interface BookPrint {
  trim: string;
  /** Custom trim, inches. */
  w: number;
  h: number;
  margins: "auto" | "custom";
  /** Custom margins, inches: top, bottom, inside (gutter), outside. */
  mt: number;
  mb: number;
  mi: number;
  mo: number;
  recto: boolean;
  paper: "cream" | "white";
  halfTitle: boolean;
  titlePage: boolean;
  copyright: boolean;
  dedication: boolean;
  epigraph: boolean;
  toc: "auto" | "on" | "off";
  alsoBy: "front" | "back" | "off";
  aboutAuthor: boolean;
  arabicStart: "first-section" | "first-chapter";
}

export interface BookEbook {
  toc: boolean;
  embedFonts: boolean;
  dropCaps: boolean;
  copyrightAtBack: boolean;
  uuid: string;
}

export interface BookSmf {
  shortTitle: string;
  font: "courier" | "times";
  paper: "letter" | "a4";
  italics: "italic" | "underline";
}

export interface Book {
  meta: BookMeta;
  contact: BookContact;
  /** The preset merged with the writer's overrides. */
  design: BookDesign;
  /** Which design fields the writer overrode ("Customized" badge, Reset). */
  overridden: (keyof BookDesign)[];
  print: BookPrint;
  ebook: BookEbook;
  smf: BookSmf;
}

type Validator = (v: unknown) => unknown;

const str =
  (max: number): Validator =>
  (v) =>
    typeof v === "string" ? v.slice(0, max) : undefined;
const oneOf =
  (...values: readonly unknown[]): Validator =>
  (v) =>
    values.includes(v) ? v : undefined;
const num =
  (min: number, max: number): Validator =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const int =
  (min: number, max: number): Validator =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : undefined;
const bool: Validator = (v) => (typeof v === "boolean" ? v : undefined);
const strings =
  (maxItems: number, maxLen: number): Validator =>
  (v) =>
    Array.isArray(v)
      ? v
          .filter((s): s is string => typeof s === "string")
          .slice(0, maxItems)
          .map((s) => s.slice(0, maxLen))
      : undefined;
const fontId: Validator = (v) =>
  typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v) ? v : undefined;

const NUMBER_STYLES: NumberStyle[] = ["word", "numeral", "roman", "none", "as-written"];

export const TRIMS = [
  { id: "5x8", label: "5 × 8 in", w: 5, h: 8 },
  { id: "5.06x7.81", label: "5.06 × 7.81 in", w: 5.06, h: 7.81 },
  { id: "5.25x8", label: "5.25 × 8 in", w: 5.25, h: 8 },
  { id: "5.5x8.5", label: "5.5 × 8.5 in", w: 5.5, h: 8.5 },
  { id: "6x9", label: "6 × 9 in (US Trade)", w: 6, h: 9 },
  { id: "a5", label: "A5 (5.83 × 8.27 in)", w: 5.83, h: 8.27 },
  { id: "custom", label: "Custom…", w: 0, h: 0 },
] as const;

const META: Record<keyof BookMeta, [Validator, unknown]> = {
  title: [str(300), ""],
  subtitle: [str(300), ""],
  author: [str(200), ""],
  series: [str(200), ""],
  seriesNumber: [int(0, 999), null],
  publisher: [str(200), ""],
  edition: [str(100), ""],
  isbnPrint: [str(20), ""],
  isbnEbook: [str(20), ""],
  language: [(v) => (typeof v === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(v) ? v : undefined), "en-US"],
  description: [str(4000), ""],
  copyrightYear: [int(1000, 9999), null],
  copyrightHolder: [str(200), ""],
  copyrightNotice: [oneOf("standard", "fiction", "custom"), "standard"],
  copyrightText: [str(4000), ""],
  dedication: [str(2000), ""],
  epigraph: [str(4000), ""],
  epigraphSource: [str(300), ""],
  alsoBy: [strings(60, 200), []],
  aboutAuthor: [str(6000), ""],
};

const CONTACT: Record<keyof BookContact, [Validator, unknown]> = {
  legalName: [str(200), ""],
  address: [str(600), ""],
  email: [str(200), ""],
  phone: [str(60), ""],
  agent: [str(600), ""],
};

const DESIGN: Record<keyof BookDesign, Validator> = {
  preset: oneOf(...PRESETS.map((p) => p.id)),
  bodyFont: fontId,
  bodySize: num(8, 16),
  leading: num(9, 30),
  headingFont: fontId,
  chapterNumber: oneOf(...NUMBER_STYLES),
  chapterLabel: str(40),
  labelCase: oneOf("upper", "title", "smallcaps"),
  chapterTitle: oneOf("show", "hide"),
  titleCase: oneOf("as-typed", "upper", "smallcaps"),
  titleItalic: bool,
  headingAlign: oneOf("center", "left"),
  sink: num(0, 0.6),
  headingOrnament: str(12),
  dropCap: oneOf(0, 2, 3, 4),
  leadIn: oneOf("none", "first-line", "first-words"),
  indent: num(0, 4),
  sceneBreak: oneOf("ornament", "blank"),
  ornament: str(12),
  blockquote: oneOf("indent", "indent-italic", "smaller"),
  justify: bool,
  hyphenate: bool,
  runningHeads: oneOf("author-title", "title-chapter", "none"),
  headStyle: oneOf("smallcaps", "italic"),
  folio: oneOf("top-outside", "bottom-center", "bottom-outside"),
  folioOnOpeners: bool,
  figures: oneOf("default", "oldstyle", "lining"),
  quotes: oneOf("auto", "curly", "straight"),
  restartNumbersInParts: bool,
};

const PRINT: Record<keyof BookPrint, [Validator, unknown]> = {
  trim: [oneOf(...TRIMS.map((t) => t.id)), "5.5x8.5"],
  w: [num(3, 12), 5.5],
  h: [num(4, 14), 8.5],
  margins: [oneOf("auto", "custom"), "auto"],
  mt: [num(0.25, 2), 0.75],
  mb: [num(0.25, 2), 0.75],
  mi: [num(0.375, 2), 0.75],
  mo: [num(0.25, 2), 0.6],
  recto: [bool, true],
  paper: [oneOf("cream", "white"), "cream"],
  halfTitle: [bool, true],
  titlePage: [bool, true],
  copyright: [bool, true],
  dedication: [bool, true],
  epigraph: [bool, true],
  toc: [oneOf("auto", "on", "off"), "auto"],
  alsoBy: [oneOf("front", "back", "off"), "front"],
  aboutAuthor: [bool, true],
  arabicStart: [oneOf("first-section", "first-chapter"), "first-section"],
};

const EBOOK: Record<keyof BookEbook, [Validator, unknown]> = {
  toc: [bool, true],
  embedFonts: [bool, false],
  dropCaps: [bool, false],
  copyrightAtBack: [bool, false],
  uuid: [(v) => (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? v : undefined), ""],
};

const SMF: Record<keyof BookSmf, [Validator, unknown]> = {
  shortTitle: [str(60), ""],
  font: [oneOf("courier", "times"), "times"],
  paper: [oneOf("letter", "a4"), "letter"],
  italics: [oneOf("italic", "underline"), "italic"],
};

function bookMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("book");
}

function readGroup<T>(
  m: Y.Map<unknown>,
  prefix: string,
  fields: Record<string, [Validator, unknown]>,
): T {
  const out: Record<string, unknown> = {};
  for (const [key, [validate, fallback]] of Object.entries(fields)) {
    const value = validate(m.get(`${prefix}.${key}`));
    out[key] = value === undefined ? fallback : value;
  }
  return out as T;
}

/** The whole book, defaulted and validated. `fallbacks` fill the title and
 *  author until the writer sets them (the document title, the account's
 *  display name). */
export function readBook(doc: Y.Doc, fallbacks: { title?: string; author?: string } = {}): Book {
  const m = bookMap(doc);
  const meta = readGroup<BookMeta>(m, "meta", META);
  if (!meta.title && fallbacks.title) meta.title = fallbacks.title;
  if (!meta.author && fallbacks.author) meta.author = fallbacks.author;

  const presetId = (DESIGN.preset(m.get("design.preset")) as string | undefined) ?? "classic";
  const design: BookDesign = { ...presetDesign(presetId), preset: presetId };
  const overridden: (keyof BookDesign)[] = [];
  for (const key of Object.keys(DESIGN) as (keyof BookDesign)[]) {
    if (key === "preset") continue;
    const value = DESIGN[key](m.get(`design.${key}`));
    if (value !== undefined) {
      (design as unknown as Record<string, unknown>)[key] = value;
      overridden.push(key);
    }
  }
  return {
    meta,
    contact: readGroup<BookContact>(m, "contact", CONTACT),
    design,
    overridden,
    print: readGroup<BookPrint>(m, "print", PRINT),
    ebook: readGroup<BookEbook>(m, "ebook", EBOOK),
    smf: readGroup<BookSmf>(m, "smf", SMF),
  };
}

/** Write dotted keys in one transaction; `null` removes a key (back to the
 *  default / the preset's value). */
export function updateBook(doc: Y.Doc, patch: Record<string, unknown>): void {
  const m = bookMap(doc);
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) m.delete(key);
      else m.set(key, value);
    }
  });
}

/** Choose a preset: clears every design override so nothing stale lingers. */
export function choosePreset(doc: Y.Doc, presetId: string): void {
  const m = bookMap(doc);
  doc.transact(() => {
    for (const key of [...m.keys()]) {
      if (key.startsWith("design.")) m.delete(key);
    }
    m.set("design.preset", presetId);
  });
}

export function onBookChange(doc: Y.Doc, cb: () => void): () => void {
  const m = bookMap(doc);
  m.observe(cb);
  return () => m.unobserve(cb);
}

/** Trim size in inches for the print settings. */
export function trimSize(print: BookPrint): { w: number; h: number } {
  const t = TRIMS.find((x) => x.id === print.trim);
  if (!t || t.id === "custom") return { w: print.w, h: print.h };
  return { w: t.w, h: t.h };
}
