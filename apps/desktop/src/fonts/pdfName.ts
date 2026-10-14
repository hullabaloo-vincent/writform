/** A font's name in a PDF as a font this app has. */

import { fontIdForWordName, type FontLookup } from "./docx";
import { parseFontId, type FontId } from "./ids";
import { knownFont } from "./registry";

/**
 * The family a PDF's font belongs to. A PDF names a face the way its file
 * does: a tag for the part of it that was embedded, the family with its
 * words run together, then the style ("ABCDEF+TimesNewRomanPS-BoldMT").
 */
export function pdfFontFamily(raw: string): string {
  let name = raw.replace(/^[A-Z]{6}\+/, "").trim();
  name = name.split(/[-,]/)[0].replace(/(?:PS)?MT$|PS$/, "");
  if (!/\s/.test(name)) name = name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return name.trim();
}

/**
 * The font to set text in that a PDF had in `raw`: one of the app's own,
 * the font itself where it is installed, or the same family from the online
 * library. Null for anything else (a PDF's fonts are mostly ones nobody
 * else has, and a name alone would only be a notice that it is missing).
 */
export function fontIdForPdfName(raw: string | null | undefined, lookup: FontLookup = {}): FontId | null {
  const family = pdfFontFamily(raw ?? "");
  if (!family) return null;
  const id = fontIdForWordName(family, lookup);
  if (!id) return null;
  if (knownFont(id)) return id;
  const parsed = parseFontId(id);
  if (!parsed) return null;
  if (id.startsWith("gf:")) return id;
  return lookup.installed?.get(family.toLowerCase()) ? id : null;
}
