/**
 * The online font catalog: every family of the Google Fonts library, as
 * mirrored by Fontsource. Its index ships with the app (src/fonts/
 * catalog.json — names, kinds, weights, scripts; no font files), so
 * searching it is instant and works with no connection. A family's files
 * are fetched only when a document uses it (see ./store.ts).
 */

import type { FontCategory } from "./registry";

export interface CatalogFont {
  /** The catalog's id (`gf:<id>` is the font id). */
  id: string;
  family: string;
  category: FontCategory;
  /** 100…900. */
  weights: number[];
  italic: boolean;
  /** The scripts it's split into; the first is the one always fetched. */
  subsets: string[];
  /** SPDX-style: OFL-1.1, Apache-2.0, UFL-1.0. */
  license: string;
}

export interface Catalog {
  fonts: CatalogFont[];
  byId: Map<string, CatalogFont>;
  /** By family name, lower case. */
  byName: Map<string, CatalogFont>;
  source: string;
  fetched: string;
}

type Row = [id: string, family: string, cat: string, weights: string, italic: number, subsets: string, license: string];

const CATEGORY: Record<string, FontCategory> = {
  s: "serif",
  n: "sans-serif",
  m: "monospace",
  d: "display",
  h: "handwriting",
};
const LICENSE: Record<string, string> = { O: "OFL-1.1", A: "Apache-2.0", U: "UFL-1.0" };

let loading: Promise<Catalog> | null = null;
let ready: Catalog | null = null;

export function decodeCatalog(raw: { source: string; fetched: string; fonts: Row[] }): Catalog {
  const fonts = raw.fonts.map(
    ([id, family, cat, weights, italic, subsets, license]): CatalogFont => ({
      id,
      family,
      category: CATEGORY[cat] ?? "display",
      weights: [...weights].map((d) => Number(d) * 100),
      italic: italic === 1,
      subsets: subsets.split(" "),
      license: LICENSE[license] ?? license,
    }),
  );
  return {
    fonts,
    byId: new Map(fonts.map((f) => [f.id, f])),
    byName: new Map(fonts.map((f) => [f.family.toLowerCase(), f])),
    source: raw.source,
    fetched: raw.fetched,
  };
}

/** The index (its own chunk of the app, loaded the first time it's wanted). */
export function loadCatalog(): Promise<Catalog> {
  loading ??= import("./catalog.json").then((mod) => {
    ready = decodeCatalog((mod.default ?? mod) as unknown as { source: string; fetched: string; fonts: Row[] });
    return ready;
  });
  return loading;
}

/** The index if it has been loaded — for code that can't wait. */
export function catalogNow(): Catalog | null {
  return ready;
}

/**
 * Families matching what was typed: names starting with it first, then
 * names with a word starting with it, then names containing it.
 */
export function searchCatalog(catalog: Catalog, query: string, category?: FontCategory | null, limit = 60): CatalogFont[] {
  const q = query.trim().toLowerCase();
  const pool = category ? catalog.fonts.filter((f) => f.category === category) : catalog.fonts;
  if (!q) return pool.slice(0, limit);
  const starts: CatalogFont[] = [];
  const words: CatalogFont[] = [];
  const contains: CatalogFont[] = [];
  for (const f of pool) {
    const name = f.family.toLowerCase();
    if (name.startsWith(q)) starts.push(f);
    else if (name.includes(` ${q}`)) words.push(f);
    else if (name.includes(q)) contains.push(f);
  }
  return [...starts, ...words, ...contains].slice(0, limit);
}

/** A catalog file's name: `latin-400-normal.ttf`. */
export function fontFile(subset: string, weight: number, italic: boolean): string {
  return `${subset}-${weight}-${italic ? "italic" : "normal"}.ttf`;
}

/** The weight a family's regular text is set in: the one asked for when it
 *  has it, else the nearest to it (to 400 by default). */
export function regularWeight(font: CatalogFont, wanted = 400): number {
  return font.weights.reduce((best, w) => (Math.abs(w - wanted) < Math.abs(best - wanted) ? w : best), font.weights[0] ?? 400);
}

/** The weight its bold is set in — 700 when it has one heavier than the
 *  regular, else the next step up it does have; null when there is none
 *  (the layout then thickens the regular itself). */
export function boldWeight(font: CatalogFont, regular: number): number | null {
  const heavier = font.weights.filter((w) => w >= regular + 200);
  if (!heavier.length) return null;
  return heavier.includes(700) ? 700 : heavier.reduce((best, w) => (Math.abs(w - 700) < Math.abs(best - 700) ? w : best));
}
