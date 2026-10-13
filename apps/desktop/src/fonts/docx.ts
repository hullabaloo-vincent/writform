/** Font ids ↔ the names Word files use. */

import { fontLabel, type FontInfo } from "./css";
import { isFontId, parseFontId, type FontId } from "./ids";
import { FONTS, knownFont, type FontCategory } from "./registry";
import { WORD_ALT_NAMES } from "./twins";

/** The family name to write for a font (`w:rFonts`), or null for an id
 *  that isn't well-formed. Word substitutes when it doesn't have the font. */
export function docxFontName(id: FontId | null | undefined, info?: FontInfo): string | null {
  if (!id) return null;
  const known = knownFont(id);
  if (known) return known.word;
  return parseFontId(id) ? fontLabel(id, info) : null;
}

/** What a document's body is set in when it names no font. */
export const DEFAULT_WORD_FONT = "Georgia";

const BY_WORD = new Map<string, string>();
for (const f of FONTS) {
  // The document menu's entry wins where two ids share a Word name.
  for (const name of [f.word, f.name]) {
    const key = name.toLowerCase();
    if (!BY_WORD.has(key) || f.menu) BY_WORD.set(key, f.id);
  }
}
// Old names and near-twins of the app's own fonts.
for (const [name, id] of [
  ["times", "times"],
  ["palatino linotype", "palatino"],
  ["book antiqua", "palatino"],
  ["garamond", "garamond"],
  ["courier", "mono"],
  ["helvetica", "sans"],
  ["comic sans", "comic"],
] as const) {
  BY_WORD.set(name, id);
}

/** What's known beyond the app's own fonts when reading a Word file. */
export interface FontLookup {
  /** Families installed on this computer, by lower-case name. */
  installed?: { get(name: string): { family: string } | undefined };
  /** The online catalog, by lower-case family name. */
  catalog?: { get(name: string): { id: string; weights?: number[] } | undefined };
}

/**
 * The font id for a family named in a Word file, best first: one of the
 * app's own; the font itself where it's installed; the same family from
 * the online catalog; else the family kept by name (shown and printed in
 * a stand-in until some device has it). Null for the default body face
 * and for a name that can't be kept.
 */
export function fontIdForWordName(name: string | null | undefined, lookup: FontLookup = {}): FontId | null {
  const clean = (name ?? "").trim();
  const lower = clean.toLowerCase();
  if (!clean || lower === DEFAULT_WORD_FONT.toLowerCase()) return null;
  const known = BY_WORD.get(lower);
  if (known) return known;
  const byName = `sys:${clean}`;
  if (!isFontId(byName)) return null;
  // Under the name the system has it by (a file may spell it otherwise).
  const here = lookup.installed?.get(lower);
  if (here) return isFontId(`sys:${here.family}`) ? `sys:${here.family}` : byName;
  const listed = lookup.catalog?.get(lower);
  if (listed) return `gf:${listed.id}`;
  // A weight of a family, named as Word names it ("Open Sans Light"): the
  // family from the catalog, at that weight.
  const weighted = WEIGHT_WORD.exec(clean);
  const family = weighted ? lookup.catalog?.get(weighted[1].trim().toLowerCase()) : undefined;
  if (weighted && family) {
    const asked = WEIGHTS[weighted[2].toLowerCase().replace(/[\s-]/g, "")] ?? 400;
    // (The nearest it comes in. Regular and bold are the family itself.)
    const had = family.weights ?? [];
    const weight = had.length ? had.reduce((best, w) => (Math.abs(w - asked) < Math.abs(best - asked) ? w : best)) : 400;
    const id = weight === 400 || weight === 700 ? `gf:${family.id}` : `gf:${family.id}@${weight}`;
    if (isFontId(id)) return id;
  }
  return byName;
}

const WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};
const WEIGHT_WORD = /^(.+?)\s+(thin|hairline|extra[\s-]?light|ultra[\s-]?light|light|regular|book|medium|semi[\s-]?bold|demi[\s-]?bold|bold|extra[\s-]?bold|ultra[\s-]?bold|black|heavy)$/i;

/** Word's `w:family` for a kind of font, and back. */
const WORD_FAMILY: Record<FontCategory, string> = {
  serif: "roman",
  "sans-serif": "swiss",
  monospace: "modern",
  handwriting: "script",
  display: "decorative",
};

export function wordFamilyOf(category: FontCategory | undefined): string {
  return category ? WORD_FAMILY[category] : "auto";
}

export function categoryOfWordFamily(family: string | undefined): FontCategory | undefined {
  return (Object.entries(WORD_FAMILY).find(([, word]) => word === family)?.[0] as FontCategory | undefined) ?? undefined;
}

/** What Word should use when it lacks a font this app wrote: for a
 *  stand-in family, the font it stands in for. */
export function wordAltName(name: string): string | null {
  return WORD_ALT_NAMES[name.trim().toLowerCase()] ?? null;
}
