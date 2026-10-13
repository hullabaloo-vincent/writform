/**
 * What a font may be used for.
 *
 * The app offers fonts from three places. Its own files and the online
 * library are all under one of three open licences, and each of those
 * allows commercial use: a book set in the font may be sold, and the font
 * may be embedded in its PDF or its ebook. A font installed on someone's
 * device is under whatever licence its maker gave it, which the app can't
 * read, so nothing here vouches for one.
 *
 * A book's design and its cover take only the first two (book/fonts and
 * book/cover/design.ts hold them to that). The library's index is held to
 * the three licences too: a family under any other never reaches a list.
 */

import { catalogNow } from "./catalog";
import { parseFontId } from "./ids";
import { knownFont } from "./registry";

/** The open licences, by their short names. Every one allows commercial use
 *  and embedding. */
export const OPEN_LICENCES: Record<string, string> = {
  "OFL-1.1": "SIL Open Font License 1.1",
  "Apache-2.0": "Apache License 2.0",
  "UFL-1.0": "Ubuntu Font Licence 1.0",
};

export const isOpenLicence = (code: string): boolean => Object.prototype.hasOwnProperty.call(OPEN_LICENCES, code);

/** The licence the app's own font files are under (it sits beside each
 *  family, in assets/fonts). */
export const BUNDLED_LICENCE = "OFL-1.1";

/**
 * The licence of a font the app vouches for, by its short name: one of its
 * own, or one of the online library's. Null for anything else (a font of
 * the device's, a name out of a Word file): its licence is its maker's.
 */
export function fontLicence(id: string): string | null {
  const known = knownFont(id);
  // (One of the app's own files. A name like "Georgia" is the device's font
  // on screen, whatever stands in for it in print.)
  if (known) return known.face === known.id ? BUNDLED_LICENCE : null;
  const parsed = parseFontId(id);
  if (parsed?.source !== "gf") return null;
  const code = catalogNow()?.byId.get(parsed.key)?.license;
  return code && isOpenLicence(code) ? code : null;
}
