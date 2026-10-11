/**
 * The book typefaces: one registry for the editor's manuscript view, the
 * book preview, and the PDF/EPUB exports, so all of them use the same faces.
 * Each family ships as unmodified OFL font files (see ./files.ts); the CSS
 * stacks here fall back to similar system faces until those load.
 *
 * The capability columns (small caps, old-style figures, ornaments) were
 * read from the font files themselves; the engine harness re-checks them.
 */

import { catalogNow } from "../../fonts/catalog";
import { fontCssFamily } from "../../fonts/css";
import { FONTS, type BookFace, type FontStyle } from "../../fonts/registry";

export type { FontStyle };

export interface BookFont extends BookFace {
  id: string;
  label: string;
  /** CSS font-family stack (the bundled face first). */
  css: string;
}

/** The bundled faces of the app's font table (fonts/registry.ts). */
export const BOOK_FONTS: BookFont[] = FONTS.flatMap((f) =>
  f.book ? [{ id: f.id, label: f.name, css: f.css, ...f.book }] : [],
);

/** Whether a book font is one from the online catalog (`gf:<id>`), as
 *  opposed to one of the app's own. */
export const isCatalogBookFont = (id: string): boolean => /^gf:[a-z0-9]/.test(id);

/**
 * What the engine knows about a book font. A catalog family is taken as a
 * plain text face: no small capitals or old-style figures of its own (the
 * engine reduces capitals instead), no ornaments (a bundled face draws
 * those), and an average character for the page estimate.
 */
export function bookFont(id: string): BookFont {
  const own = BOOK_FONTS.find((f) => f.id === id);
  if (own) return own;
  if (isCatalogBookFont(id)) {
    // (As the layout names it, it may carry a script: "gf:lora~cyrillic".)
    const font = id.split("~")[0];
    const key = font.slice(3).split("@")[0];
    return {
      id: font,
      label: catalogNow()?.byId.get(key)?.family ?? key,
      css: fontCssFamily(font) ?? "serif",
      role: "body",
      styles: ["regular", "italic", "bold", "boldItalic"],
      smallCaps: false,
      oldstyle: false,
      ornaments: "",
      avgChar: 0.47,
    };
  }
  return BOOK_FONTS[0];
}

/** Ornaments offered in the book design (each is in at least one family). */
export const ORNAMENTS = ["⁂", "* * *", "❦", "❧", "☙", "◊", "~", "#", "§"];

/**
 * The family that draws an ornament: the preferred families first (the
 * book's own fonts), then any bundled family that has every glyph. Null
 * when none does (the engine falls back to asterisks).
 */
export function ornamentFamily(ornament: string, preferred: string[]): string | null {
  const glyphs = [...ornament].filter((ch) => ch.trim());
  if (!glyphs.length) return preferred[0] ?? null;
  const covers = (f: BookFont) => glyphs.every((g) => f.ornaments.includes(g));
  for (const id of preferred) {
    const f = BOOK_FONTS.find((x) => x.id === id);
    if (f && covers(f)) return f.id;
  }
  return BOOK_FONTS.find(covers)?.id ?? null;
}
