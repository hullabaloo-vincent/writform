/**
 * The fonts the app knows by itself, in one table: the document font menu,
 * the book typefaces (bundled OFL files, see book/fonts/files.ts) and the
 * names Word knows them by all read from here. Catalog and system fonts
 * come later through the same ids (see ./ids.ts).
 */

export type FontCategory = "serif" | "sans-serif" | "monospace" | "display" | "handwriting";

export type FontStyle = "regular" | "italic" | "bold" | "boldItalic";

/** What the typesetting engine knows about a bundled face. The columns
 *  were read from the font files themselves. */
export interface BookFace {
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

export interface FontEntry {
  id: string;
  /** The family's real name. */
  name: string;
  /** Its short label in the document font menu (absent: not offered there). */
  menu?: string;
  /** CSS font-family stack: the face itself, then look-alikes. */
  css: string;
  category: FontCategory;
  /** What Word calls it. */
  word: string;
  /** The bundled family whose files draw it in print (a book face names
   *  itself). Absent: a system font — nothing to embed. */
  face?: string;
  book?: BookFace;
}

const ALL: FontStyle[] = ["regular", "italic", "bold", "boldItalic"];

/** Document-menu order first; the book faces keep their own order within. */
export const FONTS: FontEntry[] = [
  {
    id: "times",
    name: "Times New Roman",
    menu: "Times",
    css: "'Times New Roman', Times, serif",
    category: "serif",
    word: "Times New Roman",
  },
  {
    id: "palatino",
    name: "Palatino",
    menu: "Palatino",
    css: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
    category: "serif",
    word: "Palatino",
  },
  // Bundled with the app (book faces): they look the same everywhere, and
  // Word uses them when installed (they're free) and substitutes otherwise.
  {
    id: "garamond",
    name: "EB Garamond",
    menu: "Garamond",
    css: '"EB Garamond", Garamond, "Adobe Garamond Pro", Georgia, serif',
    category: "serif",
    word: "EB Garamond",
    face: "garamond",
    book: {
      role: "body",
      styles: ALL,
      smallCaps: true,
      oldstyle: true,
      ornaments: "❦❧☙◆◇•·†‡◊§~#*¶",
      avgChar: 0.375,
    },
  },
  {
    id: "libertinus",
    name: "Libertinus Serif",
    menu: "Libertinus",
    css: '"Libertinus Serif", "Linux Libertine", Georgia, serif',
    category: "serif",
    word: "Libertinus Serif",
    face: "libertinus",
    book: {
      role: "body",
      styles: ALL,
      smallCaps: true,
      oldstyle: true,
      ornaments: "⁂❧☙◆◇•·†‡◊※§~#*♦¶",
      avgChar: 0.407,
    },
  },
  {
    id: "baskerville",
    name: "Libre Baskerville",
    menu: "Baskerville",
    css: '"Libre Baskerville", Baskerville, Georgia, serif',
    category: "serif",
    word: "Libre Baskerville",
    face: "baskerville",
    book: {
      role: "body",
      styles: ["regular", "italic"],
      smallCaps: false,
      oldstyle: false,
      ornaments: "•·†‡§~#*¶",
      avgChar: 0.507,
    },
  },
  {
    id: "literata",
    name: "Literata",
    menu: "Literata",
    css: "Literata, Georgia, serif",
    category: "serif",
    word: "Literata",
    face: "literata",
    book: {
      role: "body",
      styles: ["regular", "italic"],
      smallCaps: true,
      oldstyle: true,
      ornaments: "⁂◆◇•·†‡◊§~#*¶",
      avgChar: 0.468,
    },
  },
  {
    id: "sans",
    name: "Sans",
    menu: "Sans",
    css: "-apple-system, 'Segoe UI', Arial, sans-serif",
    category: "sans-serif",
    word: "Arial",
  },
  // Bundled, metric-compatible with Calibri: what a sans-serif prints in,
  // and what stands in for Calibri where it isn't installed.
  {
    id: "carlito",
    name: "Carlito",
    css: "Carlito, Calibri, 'Segoe UI', Arial, sans-serif",
    category: "sans-serif",
    word: "Carlito",
    face: "carlito",
  },
  {
    id: "mono",
    name: "Courier Prime",
    menu: "Typewriter",
    css: "'Courier Prime', 'Courier New', Courier, monospace",
    category: "monospace",
    word: "Courier New",
    face: "courier-prime",
  },
  {
    id: "comic",
    name: "Comic Sans MS",
    menu: "Comic Sans",
    css: "'Comic Sans MS', 'Comic Sans', 'Chalkboard SE', 'Comic Neue', cursive",
    category: "handwriting",
    word: "Comic Sans MS",
  },
  {
    id: "playfair",
    name: "Playfair Display",
    css: '"Playfair Display", Didot, Georgia, serif',
    category: "display",
    word: "Playfair Display",
    face: "playfair",
    book: {
      role: "display",
      styles: ["regular", "italic"],
      smallCaps: true,
      oldstyle: true,
      ornaments: "•·†‡◊§~#*¶",
      avgChar: 0.444,
    },
  },
  {
    id: "cinzel",
    name: "Cinzel",
    css: 'Cinzel, "Trajan Pro", Georgia, serif',
    category: "display",
    word: "Cinzel",
    face: "cinzel",
    book: {
      role: "display",
      styles: ["regular"],
      smallCaps: false,
      caseless: true,
      oldstyle: true,
      ornaments: "•·†‡◊§~#*¶",
      avgChar: 0.541,
    },
  },
  {
    id: "courier-prime",
    name: "Courier Prime",
    css: '"Courier Prime", "Courier New", Courier, monospace',
    category: "monospace",
    word: "Courier Prime",
    face: "courier-prime",
    book: {
      role: "mono",
      styles: ALL,
      smallCaps: false,
      oldstyle: false,
      ornaments: "•·†‡◊§~#*¶",
      avgChar: 0.6,
    },
  },
];

const BY_ID = new Map(FONTS.map((f) => [f.id, f]));

/** A font the app knows by itself, or undefined (a catalog or system font,
 *  or an id from a newer build). */
export function knownFont(id: string | null | undefined): FontEntry | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** The document font menu, in order. */
export const MENU_FONTS = FONTS.filter((f) => f.menu);
