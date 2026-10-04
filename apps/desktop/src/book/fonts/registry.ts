/**
 * The book typefaces: one registry for the editor's manuscript view, the
 * book preview, and the PDF/EPUB exports, so all of them use the same faces.
 * Each family ships as unmodified OFL font files (see ./files.ts); the CSS
 * stacks here fall back to similar system faces until those load.
 *
 * The capability columns (small caps, old-style figures, ornaments) were
 * read from the font files themselves; the engine harness re-checks them.
 */

export type FontStyle = "regular" | "italic" | "bold" | "boldItalic";

export interface BookFont {
  id: string;
  label: string;
  /** CSS font-family stack (the bundled face first). */
  css: string;
  role: "body" | "display" | "mono";
  /** Bundled styles. Variable families ship their default instance only, so
   *  their bold is drawn by stroking. */
  styles: FontStyle[];
  /** Real small capitals (OpenType smcp + c2sc). */
  smallCaps: boolean;
  /** The lowercase letters ARE small capitals (Cinzel). */
  caseless?: boolean;
  /** Old-style figures (onum). */
  oldstyle: boolean;
  /** Ornament glyphs the face has. */
  ornaments: string;
  /** Average advance per character of English prose, em (page estimates). */
  avgChar: number;
}

const ALL: FontStyle[] = ["regular", "italic", "bold", "boldItalic"];

export const BOOK_FONTS: BookFont[] = [
  {
    id: "garamond",
    label: "EB Garamond",
    css: '"EB Garamond", Garamond, "Adobe Garamond Pro", Georgia, serif',
    role: "body",
    styles: ALL,
    smallCaps: true,
    oldstyle: true,
    ornaments: "❦❧☙◆◇•·†‡◊§~#*¶",
    avgChar: 0.375,
  },
  {
    id: "libertinus",
    label: "Libertinus Serif",
    css: '"Libertinus Serif", "Linux Libertine", Georgia, serif',
    role: "body",
    styles: ALL,
    smallCaps: true,
    oldstyle: true,
    ornaments: "⁂❧☙◆◇•·†‡◊※§~#*♦¶",
    avgChar: 0.407,
  },
  {
    id: "baskerville",
    label: "Libre Baskerville",
    css: '"Libre Baskerville", Baskerville, Georgia, serif',
    role: "body",
    styles: ["regular", "italic"],
    smallCaps: false,
    oldstyle: false,
    ornaments: "•·†‡§~#*¶",
    avgChar: 0.507,
  },
  {
    id: "literata",
    label: "Literata",
    css: "Literata, Georgia, serif",
    role: "body",
    styles: ["regular", "italic"],
    smallCaps: true,
    oldstyle: true,
    ornaments: "⁂◆◇•·†‡◊§~#*¶",
    avgChar: 0.468,
  },
  {
    id: "playfair",
    label: "Playfair Display",
    css: '"Playfair Display", Didot, Georgia, serif',
    role: "display",
    styles: ["regular", "italic"],
    smallCaps: true,
    oldstyle: true,
    ornaments: "•·†‡◊§~#*¶",
    avgChar: 0.444,
  },
  {
    id: "cinzel",
    label: "Cinzel",
    css: 'Cinzel, "Trajan Pro", Georgia, serif',
    role: "display",
    styles: ["regular"],
    smallCaps: false,
    caseless: true,
    oldstyle: true,
    ornaments: "•·†‡◊§~#*¶",
    avgChar: 0.541,
  },
  {
    id: "courier-prime",
    label: "Courier Prime",
    css: '"Courier Prime", "Courier New", Courier, monospace',
    role: "mono",
    styles: ALL,
    smallCaps: false,
    oldstyle: false,
    ornaments: "•·†‡◊§~#*¶",
    avgChar: 0.6,
  },
];

export function bookFont(id: string): BookFont {
  return BOOK_FONTS.find((f) => f.id === id) ?? BOOK_FONTS[0];
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
