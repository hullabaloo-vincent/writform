/**
 * The Document format's built-in look, in one table: what a heading, a
 * quote, a list or a code block looks like. The screen (styles.css), the
 * page layout (PDF, print, preview) and the Word export all read from
 * here, so they agree.
 *
 * Sizes are multiples of the document's body size; spaces are multiples of
 * the body size too (so they survive a change of body size); indents are
 * points.
 */

export interface HeadingStyle {
  /** × body size. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** Space above and below, × body size. */
  before: number;
  after: number;
}

/** Heading 1–6. The first two are what browsers have always drawn (so
 *  existing documents look the same); the rest step down to body size. */
export const HEADINGS: Record<number, HeadingStyle> = {
  1: { size: 2, bold: true, italic: false, before: 1.34, after: 1.34 },
  2: { size: 1.5, bold: true, italic: false, before: 1.25, after: 1.25 },
  3: { size: 1.25, bold: true, italic: false, before: 1.2, after: 0.6 },
  4: { size: 1.1, bold: true, italic: false, before: 1.1, after: 0.5 },
  5: { size: 1, bold: true, italic: false, before: 1, after: 0.4 },
  6: { size: 1, bold: true, italic: true, before: 1, after: 0.4 },
};

export function headingStyle(level: unknown): HeadingStyle {
  return HEADINGS[typeof level === "number" && level >= 1 && level <= 6 ? Math.round(level) : 1];
}

/** A block quote: set in from both sides. Points. */
export const QUOTE_INDENT = 30;
/** Space above and below a quote, a list or a code block, × body size. */
export const BLOCK_GAP = 1;

/** Each list level's indent, and how far the marker hangs back. Points. */
export const LIST_INDENT = 30;
export const LIST_HANG = 18;

/** Bullets by depth. */
export const BULLETS = ["•", "◦", "▪"] as const;

/** Numbering by depth when a list doesn't say (Word's own cycle). */
export const NUMBER_CYCLE = ["decimal", "lowerLetter", "lowerRoman"] as const;

/** Code: the typewriter face, a touch smaller. × body size. */
export const CODE_SIZE = 0.9;
export const CODE_FONT = "courier-prime";

/** Body defaults when the document's settings say nothing. */
export const BODY_FONT_CSS = 'Georgia, "Times New Roman", serif';
export const BODY_SIZE = 12;
/** "Single" line spacing as a multiple of the type size. */
export const SINGLE = 1.2;
/** Line spacing as a multiple of single — the print equivalent of the
 *  sheet's on-screen leading (1.65 × the type size). */
export const BODY_LINE = 1.375;
/** Space after a paragraph, × body size (the sheet's 0.85em). */
export const BODY_AFTER = 0.85;

// ---- named styles
//
// A paragraph style is a named look: Normal, Title, Heading 1, your own.
// Each has a built-in definition (below) which a document may change — the
// changes live with the document (`Y.Map("styles")`, see docStyles.ts) and
// every reader of this table sees them: the screen (styles/css.ts), the
// page layout and the Word export.
//
// A paragraph names its style in the `element` attribute it has always had
// (a level-1 attribute: an older app keeps the name and draws body text);
// headings and quotes are their own nodes and take theirs from what they
// are.

export type StyleAlign = "left" | "center" | "right" | "justify";

/** What a style says. Absent: as the style it is based on. */
export interface StyleProps {
  /** A font id; null is the document's body font. */
  font?: string | null;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** `#rrggbb`; null is the ordinary text colour. */
  color?: string | null;
  align?: StyleAlign;
  /** Line spacing as a multiple of single. */
  line?: number;
  /** Space above and below, points. */
  before?: number;
  after?: number;
  /** Indents, points (first line: negative hangs). */
  indL?: number;
  indR?: number;
  indF?: number;
  keepNext?: boolean;
  /** Its tab stops, encoded (sanitize.ts `parseTabs`); null: none. */
  tabs?: string | null;
}

/** A style with nothing left to look up. */
export interface StyleLook {
  font: string | null;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  align: StyleAlign;
  line: number;
  before: number;
  after: number;
  indL: number;
  indR: number;
  indF: number;
  keepNext: boolean;
  /** Never split across pages (headings). */
  keepLines: boolean;
  /** Outline level 1–6 (headings). */
  outline?: number;
  /** Its tab stops, encoded, or none. */
  tabs: string | null;
}

/** What a document says about one style: a built-in's changes, or a style
 *  of its own. */
export interface StyleEntry {
  /** A style of the document's own has a name; a built-in keeps its own. */
  name?: string;
  /** The style a custom one starts from (default: Normal). */
  base?: string;
  props: StyleProps;
}

export type StyleOverrides = Record<string, StyleEntry>;

/** Body text, as the document's settings give it. */
export interface BodyLook {
  font: string | null;
  size: number;
  /** Multiple of single. */
  line: number;
  /** Space after a paragraph, points. */
  after: number;
  /** First-line indent, points. */
  firstIndent: number;
}

export interface StyleInfo {
  id: string;
  name: string;
  builtin: boolean;
  /** The document has changed it (or it is the document's own). */
  changed: boolean;
}

export const NORMAL_STYLE = "normal";
export const QUOTE_STYLE = "quote";
/** A document's own styles are `u-` and six characters. */
export const CUSTOM_STYLE = /^u-[a-z0-9]{4,12}$/;
export const STYLE_NAME_MAX = 60;
export const CUSTOM_STYLE_MAX = 60;

const GREY = "#595959";

const BUILTIN: { id: string; name: string; props: (body: BodyLook) => StyleProps; outline?: number }[] = [
  { id: "normal", name: "Normal", props: () => ({}) },
  { id: "nospace", name: "No Spacing", props: () => ({ line: 1, after: 0, indF: 0 }) },
  {
    id: "title",
    name: "Title",
    props: (b) => ({ size: round1(b.size * 2.2), bold: true, after: round1(b.size * 0.4), indF: 0, keepNext: true }),
  },
  {
    id: "subtitle",
    name: "Subtitle",
    props: (b) => ({ size: round1(b.size * 1.3), color: GREY, after: round1(b.size), indF: 0, keepNext: true }),
  },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({
    id: `h${level}`,
    name: `Heading ${level}`,
    outline: level,
    props: (b: BodyLook): StyleProps => {
      const h = HEADINGS[level];
      return {
        size: round1(h.size * b.size),
        bold: h.bold,
        italic: h.italic,
        before: round1(h.before * b.size),
        after: round1(h.after * b.size),
        indF: 0,
        keepNext: true,
      };
    },
  })),
  { id: "quote", name: "Quote", props: () => ({ indL: QUOTE_INDENT, indR: QUOTE_INDENT }) },
  {
    id: "caption",
    name: "Caption",
    props: (b) => ({ size: round1(b.size * 0.85), italic: true, color: GREY, indF: 0 }),
  },
];

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

const BUILTIN_BY_ID = new Map(BUILTIN.map((s) => [s.id, s]));

/** The paragraph styles a paragraph can name in its `element` attribute
 *  (headings and quotes are nodes of their own). */
export const ELEMENT_STYLES = ["nospace", "title", "subtitle", "caption"] as const;

/** Whether a paragraph's `element` names a style (rather than a scripted
 *  format's kind of line). */
export const isStyleElement = (element: string) =>
  (ELEMENT_STYLES as readonly string[]).includes(element) || CUSTOM_STYLE.test(element);

/** Styles after which Enter goes back to body text. */
const NEXT_IS_NORMAL = new Set(["title", "subtitle", "caption"]);
export const nextStyleIsNormal = (id: string | null | undefined) => !!id && NEXT_IS_NORMAL.has(id);

export const isBuiltinStyle = (id: string) => BUILTIN_BY_ID.has(id);
export const headingStyleId = (level: unknown) =>
  `h${typeof level === "number" && level >= 1 && level <= 6 ? Math.round(level) : 1}`;

export interface ResolvedStyles {
  /** Every style, in the order the gallery shows them. */
  list: StyleInfo[];
  /** A style's look; an id nobody knows is Normal. */
  look(id: string | null | undefined): StyleLook;
  has(id: string | null | undefined): boolean;
  /** What a style itself says (before its base), for the editing form. */
  entry(id: string): StyleEntry | undefined;
}

/**
 * The document's styles, worked out: the built-ins as its body text makes
 * them, with the document's changes on top, and the document's own.
 */
export function resolveStyles(body: BodyLook, overrides: StyleOverrides = {}): ResolvedStyles {
  const normal: StyleLook = {
    font: body.font,
    size: body.size,
    bold: false,
    italic: false,
    underline: false,
    color: null,
    align: "left",
    line: body.line,
    before: 0,
    after: body.after,
    indL: 0,
    indR: 0,
    indF: body.firstIndent,
    keepNext: false,
    keepLines: false,
    tabs: null,
  };
  const looks = new Map<string, StyleLook>();
  const merge = (base: StyleLook, props: StyleProps): StyleLook => {
    const out = { ...base };
    for (const [key, value] of Object.entries(props) as [keyof StyleProps, unknown][]) {
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
    return out;
  };
  const resolving = new Set<string>();
  const look = (id: string | null | undefined): StyleLook => {
    if (!id) return looks.get(NORMAL_STYLE)!;
    const hit = looks.get(id);
    if (hit) return hit;
    const custom = overrides[id];
    if (!custom?.name || !CUSTOM_STYLE.test(id) || resolving.has(id)) return looks.get(NORMAL_STYLE)!;
    resolving.add(id);
    // A custom style starts from a built-in or another custom style.
    const base = custom.base && custom.base !== id ? look(custom.base) : looks.get(NORMAL_STYLE)!;
    resolving.delete(id);
    // What made the base a heading doesn't carry over to a style of yours.
    const made = merge({ ...base, keepLines: false, outline: undefined }, custom.props);
    looks.set(id, made);
    return made;
  };
  for (const def of BUILTIN) {
    let made = merge(normal, def.props(body));
    if (def.outline) made = { ...made, keepLines: true, outline: def.outline };
    // Normal itself is the document's body text: its settings are how it changes.
    if (def.id !== NORMAL_STYLE && overrides[def.id]) made = merge(made, overrides[def.id].props);
    looks.set(def.id, made);
  }
  const customIds = Object.keys(overrides)
    .filter((id) => CUSTOM_STYLE.test(id) && overrides[id].name)
    .slice(0, CUSTOM_STYLE_MAX);
  for (const id of customIds) look(id);
  const list: StyleInfo[] = [
    ...BUILTIN.map((def) => ({
      id: def.id,
      name: def.name,
      builtin: true,
      changed: def.id !== NORMAL_STYLE && !!overrides[def.id] && Object.keys(overrides[def.id].props).length > 0,
    })),
    ...customIds
      .map((id) => ({ id, name: overrides[id].name!, builtin: false, changed: true }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
  return {
    list,
    look,
    has: (id) => !!id && looks.has(id),
    entry: (id) => overrides[id],
  };
}

/** An ordered list's marker for item `n` (1-based). `path` is the numbers
 *  of the items it is nested in, for legal numbering. */
export function listMarker(n: number, type: string | null | undefined, path: number[] = []): string {
  const alpha = (upper: boolean) => {
    let v = n;
    let out = "";
    while (v > 0) {
      v -= 1;
      out = String.fromCharCode((upper ? 65 : 97) + (v % 26)) + out;
      v = Math.floor(v / 26);
    }
    return out || String(n);
  };
  const roman = (upper: boolean) => {
    if (n < 1 || n > 3999) return String(n);
    const table: [number, string][] = [
      [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
      [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
    ];
    let rest = n;
    let out = "";
    for (const [value, glyph] of table) {
      while (rest >= value) {
        out += glyph;
        rest -= value;
      }
    }
    return upper ? out.toUpperCase() : out;
  };
  switch (type) {
    case "a":
      return `${alpha(false)}.`;
    case "A":
      return `${alpha(true)}.`;
    case "i":
      return `${roman(false)}.`;
    case "I":
      return `${roman(true)}.`;
    case "legal":
      return `${[...path, n].join(".")}.`;
    default:
      return `${n}.`;
  }
}

/** Legal numbering ("1.1.1."): an ordered list of type `legal`, and the
 *  untyped ordered lists nested inside one. */
export const LEGAL = "legal";

/** How each line-spacing multiple renders on screen. The sheet's default
 *  leading (1.65) is airier than print, so "single" is not 1.0 line-height
 *  but the visual equivalent of single-spaced print text. */
export const LINE_CSS: Record<string, number> = {
  "1": 1.2,
  "1.15": 1.4,
  "1.3": 1.55,
  "1.5": 1.8,
  "2": 2.4,
};

/** The on-screen line-height for a line-spacing multiple. */
export function lineCss(multiple: number): number {
  return LINE_CSS[String(multiple)] ?? Math.round(multiple * SINGLE * 100) / 100;
}

/** The fonts a document's styles name (for loading and for the picker). */
export function styleFonts(styles: ResolvedStyles): string[] {
  return [...new Set(styles.list.map((info) => styles.look(info.id).font).filter((f): f is string => !!f))];
}
