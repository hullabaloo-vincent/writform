/**
 * Font ids → CSS and labels. The one place a font id (which may come from a
 * collaborator or a file) becomes a `font-family` value: names are checked
 * and quoted here, and nothing else may build CSS from an id.
 */

import { catalogNow } from "./catalog";
import { isFamilyName, parseFontId, type FontId } from "./ids";
import { knownFont, type FontCategory } from "./registry";
import { standInFor } from "./twins";

/** What a document remembers about a font it uses that the app may not
 *  know by itself (its font table), enough to show and substitute it. */
export interface FontInfo {
  name: string;
  category?: FontCategory;
}

/** Look-alikes by kind, for the tail of a stack. */
const FALLBACK: Record<FontCategory, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  "sans-serif": "-apple-system, 'Segoe UI', Arial, sans-serif",
  monospace: "'Courier Prime', 'Courier New', Courier, monospace",
  display: "Georgia, serif",
  handwriting: "'Comic Sans MS', 'Chalkboard SE', cursive",
};

/** "open-sans" → "Open Sans": a catalog id read as a name when nothing
 *  better is known. */
function nameFromCatalogId(key: string): string {
  return key
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/**
 * The name a catalog family's downloaded files are registered under on
 * this page. Built from the id alone, so a `font-family` written before
 * the files (or the catalog's index) arrive starts working the moment they
 * do, and so it can never collide with a font installed on the device —
 * the preview must draw with the very file the layout measured.
 */
export function catalogAlias(key: string, weight?: number): string {
  return `wf-gf-${key}${weight ? `-w${weight}` : ""}`;
}

/** The family's display name. */
export function fontLabel(id: FontId, info?: FontInfo): string {
  const known = knownFont(id);
  if (known) return known.name;
  const parsed = parseFontId(id);
  if (!parsed) return "Unknown font";
  if (parsed.source === "gf") {
    const listed = catalogNow()?.byId.get(parsed.key)?.family;
    if (listed) return listed;
    if (info && isFamilyName(info.name)) return info.name;
    return nameFromCatalogId(parsed.key);
  }
  return parsed.key;
}

/**
 * A complete, safe `font-family` value for the id — or null for an id that
 * isn't well-formed (the caller falls back to the surrounding face).
 */
export function fontCssFamily(id: FontId, info?: FontInfo): string | null {
  const known = knownFont(id);
  if (known) return known.css;
  const parsed = parseFontId(id);
  if (!parsed) return null;
  const name = fontLabel(id, info);
  // isFamilyName excludes quotes, backslashes and declaration punctuation,
  // so the name can't leave the string it's quoted in.
  if (!isFamilyName(name)) return null;
  if (parsed.source === "gf") {
    const category = info?.category ?? catalogNow()?.byId.get(parsed.key)?.category ?? "serif";
    return `"${catalogAlias(parsed.key, parsed.weight)}", "${name}", ${FALLBACK[category]}`;
  }
  // A device without the font shows what it will print in: a same-metrics
  // catalog family if that has been downloaded, else the bundled look-alike.
  const twin = standInFor(name);
  const tail = (twin ? knownFont(twin.bundled)?.css : undefined) ?? FALLBACK[info?.category ?? "serif"];
  return `"${name}", ${twin?.catalog ? `"${catalogAlias(twin.catalog)}", ` : ""}${tail}`;
}
