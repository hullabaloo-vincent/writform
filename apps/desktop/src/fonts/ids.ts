/**
 * Font ids — how a document names a typeface.
 *
 *  - `garamond`, `times`, …          a font the app knows by itself (the
 *                                     registry: bundled faces and the
 *                                     classic system stacks)
 *  - `gf:<id>` or `gf:<id>@<weight>`  a family from the online catalog
 *  - `sys:<Family Name>`              a font installed on a device — or a
 *                                     name from a Word file we couldn't
 *                                     place; a device without it shows a
 *                                     substitute
 *
 * Ids arrive from collaborators and files, so the grammar is strict: an id
 * is safe to store, compare and show, but only `css.ts` may turn one into
 * CSS.
 */

export type FontId = string;

export interface ParsedFontId {
  source: "known" | "gf" | "sys";
  /** The registry id, the catalog id, or the family name. */
  key: string;
  /** A catalog weight other than regular/bold (100–900). */
  weight?: number;
}

const KNOWN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CATALOG = /^gf:([a-z0-9][a-z0-9-]{0,63})(?:@([1-9]00))?$/;
/** A family name: no control characters, and nothing that could end a CSS
 *  string or a declaration. */
// eslint-disable-next-line no-control-regex
const FAMILY = /^[^\u0000-\u001f\u007f"\\;{}<>]{1,80}$/;

export function parseFontId(id: unknown): ParsedFontId | null {
  if (typeof id !== "string") return null;
  if (id.startsWith("sys:")) {
    const name = id.slice(4);
    return FAMILY.test(name) && name.trim() === name ? { source: "sys", key: name } : null;
  }
  const catalog = CATALOG.exec(id);
  if (catalog) {
    return { source: "gf", key: catalog[1], ...(catalog[2] ? { weight: Number(catalog[2]) } : {}) };
  }
  return KNOWN.test(id) ? { source: "known", key: id } : null;
}

/** Well-formed (not necessarily available here). */
export function isFontId(value: unknown): value is FontId {
  return parseFontId(value) !== null;
}

/** A family name that may appear inside a quoted CSS string. */
export function isFamilyName(name: unknown): name is string {
  return typeof name === "string" && FAMILY.test(name);
}
