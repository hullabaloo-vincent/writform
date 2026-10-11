/**
 * Word paragraphs → editor content: headings, nested lists and checklists,
 * quotes, code, dividers, pictures; the formatting on the words (bold,
 * typeface, size, colour, highlight, sub/superscript, links) and on the
 * paragraphs (alignment, spacing, indents, borders, shading).
 *
 * Three layers, as in the editor. What the document treats as "body text"
 * becomes its settings. The styles its paragraphs use — Title, Heading 1,
 * the writer's own — become the document's styles. And each paragraph and
 * run carries only how it differs from those.
 */

import type { JSONContent } from "@tiptap/core";

import { encodeRevs } from "../../editor/review/TrackMarks";
import { encodeBorder, encodeSection, type BulletMarker, type SectionProps } from "../../editor/schema/sanitize";
import { encodeCols } from "../../editor/tables/Table";
import { encodeStyleEntry } from "../../editor/styles/docStyles";
import { CUSTOM_STYLE_MAX, LEGAL, resolveStyles, type StyleAlign, type StyleProps } from "../../editor/styles/sheet";
import { fontIdForWordName, type FontLookup } from "../../fonts/docx";
import { isFontId } from "../../fonts/ids";
import type { Block, FileRevs, Inline, Para, TableBlock } from "./body";
import { sectionDiff, sectionProps } from "./section";
import type { Numbering, NumLevel, PProps, ResolvedStyle, RProps, Styles } from "./styles";

export const MEDIA_PREFIX = "docx-media:";

type Mark = { type: string; attrs?: Record<string, unknown> };

const QUOTE_STYLES = /^(quote|intense quote|block text|quotation|quotations|extract|block quote)$/;
const CODE_STYLES = /^(code|source code|html preformatted|preformatted text|plain text|macro text)$/;
/** Word's own styles that are just body text (or furniture), not a look
 *  the writer chose. */
const PLAIN_STYLES =
  /^(normal|default|standard|body|body text.*|text body|first paragraph|compact|list.*|normal \(web\)|normal indent|toc \d|toc heading|header|footer|footnote text|endnote text|table.*|balloon text|annotation text|comment text|bibliography|index \d|salutation|closing|signature|date)$/;
const STYLE_ELEMENTS: Record<string, string> = {
  title: "title",
  subtitle: "subtitle",
  caption: "caption",
  "no spacing": "nospace",
};

/** A bullet's kind, from the character Word draws it with (and the font:
 *  Symbol and Wingdings keep theirs in the private-use block). */
function bulletKind(level: NumLevel): { marker: BulletMarker | null; task?: "on" | "off" } {
  const ch = (level.text ?? "").trim();
  const font = (level.font ?? "").toLowerCase();
  if (/^[\u2610\u25a1\u274f\u2751\u2752]$/.test(ch)) return { marker: null, task: "off" };
  if (/^[\u2611\u2612]$/.test(ch)) return { marker: null, task: "on" };
  if (font.includes("wingdings")) {
    // Wingdings: boxes at A8/6F, ticked boxes at FE/FD, tick at FC, arrow D8/E0.
    const code = (ch.codePointAt(0) ?? 0) & 0xff;
    if (code === 0xa8 || code === 0x6f || code === 0x71) return { marker: null, task: "off" };
    if (code === 0xfe || code === 0xfd) return { marker: null, task: "on" };
    if (code === 0xfc) return { marker: "check" };
    if (code === 0xd8 || code === 0xe0 || code === 0xe8) return { marker: "arrow" };
    if (code === 0xa7) return { marker: "square" };
    return { marker: null };
  }
  if (/^[\u2713\u2714]$/.test(ch)) return { marker: "check" };
  if (/^[\u2192\u27a2\u27a4\u25b6\u25b8\u2794]$/.test(ch)) return { marker: "arrow" };
  if (/^[\u2013\u2014\u2212-]$/.test(ch)) return { marker: "dash" };
  if (/^[\u25aa\u25a0\u25fc\u25fe]$/.test(ch)) return { marker: "square" };
  // "o" is Word's hollow bullet (Courier New).
  if (/^[o\u25e6\u25cb]$/.test(ch)) return { marker: "circle" };
  return { marker: null };
}

/** How many levels a numbering pattern shows ("%1.%2." is two). */
const placeholders = (text: string | undefined) => (text ?? "").match(/%\d/g)?.length ?? 0;

/** A stable id for a style of the document's own, from Word's id for it. */
function customId(wordId: string): string {
  // One this app wrote goes back to the id it had.
  const own = /^Uu([a-z0-9]{4,12})$/.exec(wordId);
  if (own) return `u-${own[1]}`;
  let h = 2166136261;
  for (let i = 0; i < wordId.length; i += 1) {
    h ^= wordId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `u-${(h >>> 0).toString(36).padStart(6, "0").slice(0, 7)}`;
}
const round = (v: number, places = 2) => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

const ORDERED_TYPE: Record<string, string | null> = {
  decimal: null,
  decimalZero: null,
  lowerLetter: "a",
  upperLetter: "A",
  lowerRoman: "i",
  upperRoman: "I",
};

/** The font and size most of a paragraph's text is set in. */
function dominant(inlines: Inline[], mark: RProps): { font?: string; size?: number } {
  const fonts = new Map<string, number>();
  const sizes = new Map<number, number>();
  for (const n of inlines) {
    if (n.t !== "text" || n.props.code) continue;
    const weight = n.text.trim().length;
    if (!weight) continue;
    if (n.props.font) fonts.set(n.props.font, (fonts.get(n.props.font) ?? 0) + weight);
    if (n.props.size) sizes.set(n.props.size, (sizes.get(n.props.size) ?? 0) + weight);
  }
  const top = <T,>(m: Map<T, number>): T | undefined => {
    let best: T | undefined;
    let n = 0;
    for (const [k, v] of m) if (v > n) [best, n] = [k, v];
    return best;
  };
  // An empty line is as tall as its paragraph mark.
  return { font: top(fonts) ?? mark.font, size: top(sizes) ?? mark.size };
}

/** Line spacing as a multiple, whichever way Word stated it. */
function lineMultiple(p: PProps, size: number): number | undefined {
  if (p.line) return round(p.line, 3);
  if (p.lineAt && p.lineRule === "exact") return round(p.lineAt / (size * 1.2));
  return undefined;
}

/** The value most of the text has. */
class Tally<T> {
  private counts = new Map<T, number>();
  add(value: T, weight: number): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + weight);
  }
  top(): T | undefined {
    let best: T | undefined;
    let n = 0;
    for (const [k, v] of this.counts) if (v > n) [best, n] = [k, v];
    return best;
  }
}

/** A typed-out list marker ("•⇥", "3.⇥") at the start of a paragraph —
 *  how programs without Word's numbering write a list. */
const TYPED_BULLET = /^[•◦▪‣⁃●○■▸–]\t/;
const TYPED_NUMBER = /^(\d{1,4})[.)]\t/;

/** Drop `n` characters from the front of a run of inline nodes. */
function dropLeading(content: JSONContent[], n: number): void {
  let left = n;
  while (left > 0 && content[0]?.type === "text") {
    const text = content[0].text ?? "";
    if (text.length <= left) {
      left -= text.length;
      content.shift();
    } else {
      content[0] = { ...content[0], text: text.slice(left) };
      left = 0;
    }
  }
}

export interface Converted {
  content: JSONContent;
  /** A patch for the document's settings: its body-text defaults. */
  settings: Record<string, unknown>;
  /** Entries for the document's style table (see editor/styles/docStyles.ts):
   *  what the file's styles change about the built-in ones, and its own. */
  styles: Record<string, string>;
  /** The font ids the content uses, with the family name Word had for each. */
  fontNames: Map<string, string>;
}

const hex = (rrggbb: string) => `#${rrggbb}`;

const ALIGN: Record<string, StyleAlign> = { center: "center", right: "right", end: "right", both: "justify", distribute: "justify", justify: "justify" };

export interface ContentOptions {
  /** The content as a tree (tables hold their cells' paragraphs); absent:
   *  the paragraphs are the content. */
  tree?: Block[];
  /** The document's own page setup, which sections are measured against. */
  base?: SectionProps;
}

export function toContent(paras: Para[], styles: Styles, numbering: Numbering, lookup: FontLookup = {}, opts: ContentOptions = {}): Converted {
  /** Font ids given out, with the Word name each came from. */
  const fontNames = new Map<string, string>();
  const note = (id: string | null, name: string | null | undefined): string | null => {
    if (id && name) fontNames.set(id, name.trim());
    return id;
  };
  /** The document's body font, or one of the app's own. */
  const fontId = (name: string | null | undefined): string | null => note(fontIdForWordName(name, lookup), name);
  /** A font that differs from the text around it: the default face has no
   *  id of its own (it is "no font set"), so there it is named outright. */
  const otherFontId = (name: string | null | undefined): string | null => {
    const id = fontIdForWordName(name, lookup);
    if (id) return note(id, name);
    const byName = `sys:${(name ?? "").trim()}`;
    return isFontId(byName) ? note(byName, name) : null;
  };
  const normal = styles.para();

  const headingOf = (para: Para): string | null => {
    const name = para.style.name.toLowerCase();
    return (
      /^heading ([1-6])$/.exec(name)?.[1] ??
      (para.props.outlineLvl !== undefined && para.props.outlineLvl < 6 && !STYLE_ELEMENTS[name]
        ? String(para.props.outlineLvl + 1)
        : null)
    );
  };

  // "Body text" is what most of the text looks like — which is the default
  // style only when the writer set it up that way. Selecting everything and
  // changing the font is at least as common, so the text itself decides.
  const fonts = new Tally<string>();
  const sizes = new Tally<number>();
  const lines = new Tally<number>();
  const afters = new Tally<number>();
  const firsts = new Tally<number>();
  for (const para of paras) {
    if (headingOf(para) || para.props.dropCap) continue;
    const weight = para.inlines.reduce((n, x) => n + (x.t === "text" ? x.text.trim().length : 0), 0);
    if (!weight) continue;
    const used = dominant(para.inlines, para.mark);
    const size = used.size ?? normal.rPr.size ?? 10;
    if (used.font) fonts.add(used.font, weight);
    sizes.add(size, weight);
    lines.add(lineMultiple(para.props, size) ?? 1, weight);
    afters.add(para.props.after ?? 0, weight);
    // A first-line indent counts for running prose only.
    const jc = para.props.jc ?? "";
    if (!ALIGN[jc] || ALIGN[jc] === "justify") {
      if (!para.props.numId) firsts.add(Math.max(0, round(para.props.indFirst ?? 0, 1)), weight);
    }
  }
  const baseFont = fonts.top() ?? normal.rPr.font;
  const baseSize = sizes.top() ?? normal.rPr.size ?? 10;
  const baseLine = lines.top() ?? lineMultiple(normal.pPr, baseSize) ?? 1;
  const baseAfter = afters.top() ?? normal.pPr.after ?? 0;
  const baseFirst = firsts.top() ?? Math.max(0, normal.pPr.indFirst ?? 0);
  const base: ResolvedStyle = {
    id: "",
    name: "Normal",
    rPr: { ...normal.rPr, font: baseFont, size: baseSize },
    pPr: { ...normal.pPr, after: baseAfter, before: 0, indFirst: baseFirst, indL: 0, indR: 0 },
  };
  delete base.pPr.line;
  delete base.pPr.lineAt;
  delete base.pPr.lineRule;

  // Body text, as the document's settings.
  const settings: Record<string, unknown> = {};
  const bodyFont = fontId(baseFont);
  if (bodyFont) settings.bodyFont = bodyFont;
  settings.bodySize = round(Math.min(96, Math.max(6, baseSize)), 1);
  settings.bodyLine = Math.min(4, Math.max(0.8, baseLine));
  settings.paraSpacing = round(Math.min(72, Math.max(0, baseAfter)), 1);
  if (baseFirst > 3) settings.firstIndent = round(Math.min(2, baseFirst / 72));

  // ---- styles

  /** What a Word style says, in this app's terms. */
  const propsOf = (style: ResolvedStyle): StyleProps => {
    const size = style.rPr.size ?? baseSize;
    const props: StyleProps = {
      size: round(size, 1),
      bold: !!style.rPr.b,
      italic: !!style.rPr.i,
      underline: !!style.rPr.u,
      color: style.rPr.color && style.rPr.color !== "000000" ? hex(style.rPr.color) : null,
      align: ALIGN[style.pPr.jc ?? ""] ?? "left",
      line: Math.min(5, Math.max(0.5, lineMultiple(style.pPr, size) ?? baseLine)),
      before: round(Math.min(200, Math.max(0, style.pPr.before ?? 0)), 1),
      after: round(Math.min(200, Math.max(0, style.pPr.after ?? 0)), 1),
      indL: round(Math.min(720, Math.max(0, style.pPr.indL ?? 0)), 1),
      indR: round(Math.min(720, Math.max(0, style.pPr.indR ?? 0)), 1),
      indF: round(Math.min(720, Math.max(-720, style.pPr.indFirst ?? 0)), 1),
      keepNext: !!style.pPr.keepNext,
    };
    // A style in the body's own face says nothing about its font: it
    // follows the body's, whatever that becomes.
    if (style.rPr.font && style.rPr.font !== baseFont) props.font = otherFontId(style.rPr.font);
    return props;
  };

  const bodyLook = {
    font: bodyFont,
    size: settings.bodySize as number,
    line: settings.bodyLine as number,
    after: settings.paraSpacing as number,
    firstIndent: baseFirst > 3 ? (settings.firstIndent as number) * 72 : 0,
  };
  const builtin = resolveStyles(bodyLook);
  const styleTable: Record<string, string> = {};
  const custom = new Map<string, string>();
  /** Record a built-in style as the file has it — only where it differs
   *  from how it comes. */
  const noteBuiltin = (id: string, style: ResolvedStyle) => {
    if (id in styleTable) return;
    const want = propsOf(style);
    const have = builtin.look(id) as unknown as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    // (A Word file keeps sizes to the half point and lengths to the
    // twentieth; a difference smaller than that isn't one.)
    const same = (a: unknown, b: unknown) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.26);
    for (const [key, value] of Object.entries(want)) if (!same(have[key], value)) changed[key] = value;
    styleTable[id] = Object.keys(changed).length ? encodeStyleEntry({ props: changed as StyleProps }) : "";
  };
  /** The id of the document's own style for a Word style of the writer's. */
  const noteCustom = (style: ResolvedStyle): string | null => {
    const hit = custom.get(style.id);
    if (hit) return hit;
    if (custom.size >= CUSTOM_STYLE_MAX) return null;
    const id = customId(style.id);
    if ([...custom.values()].includes(id)) return null;
    custom.set(style.id, id);
    styleTable[id] = encodeStyleEntry({ name: style.name.trim().slice(0, 60) || style.id, props: propsOf(style) });
    return id;
  };

  type Kind = "p" | "quote" | "list" | "code" | "rule" | "raw";
  interface ListInfo {
    numId: number;
    ilvl: number;
    kind: "bullet" | "ordered" | "task";
    type: string | null;
    start: number;
    marker: BulletMarker | null;
    checked: boolean;
    legal: boolean;
  }
  interface Item {
    kind: Kind;
    node: JSONContent;
    extra: JSONContent[];
    list?: ListInfo;
  }
  /** The first section's setup is the first paragraph's to say — if it
   *  differs from the document's own. */
  let firstSection = true;

  /** A tracked change on some text, as the marks that say so. */
  const tracked = (rev: FileRevs | undefined): Mark[] => {
    const marks: Mark[] = [];
    if (rev?.ins) marks.push({ type: "insertion", attrs: { a: rev.ins.a || null, t: rev.ins.t || null } });
    if (rev?.del) marks.push({ type: "deletion", attrs: { a: rev.del.a || null, t: rev.del.t || null } });
    return marks;
  };
  /** …and on anything else, as its `tc`. */
  const tcOf = (rev: FileRevs | undefined): string | null => (rev ? encodeRevs(rev) : null);

  /** A note's text, with the emphasis it carries. */
  const noteContent = (inlines: Inline[]): JSONContent[] => {
    const out: JSONContent[] = [];
    for (const n of inlines) {
      if (n.t !== "text" || !n.text) continue;
      const marks: Mark[] = tracked(n.rev);
      if (n.props.b) marks.push({ type: "bold" });
      if (n.props.i) marks.push({ type: "italic" });
      if (n.props.strike) marks.push({ type: "strike" });
      if (n.props.u) marks.push({ type: "underline" });
      const prev = out[out.length - 1];
      if (prev && JSON.stringify(prev.marks ?? []) === JSON.stringify(marks)) prev.text = (prev.text ?? "") + n.text;
      else out.push({ type: "text", text: n.text, ...(marks.length ? { marks } : {}) });
    }
    return out;
  };

  /** A table: each cell's blocks converted in their turn, cells that run
   *  down rows joined into one. */
  const tableNode = (block: TableBlock): JSONContent => {
    const count = Math.max(block.grid.length, ...block.rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
    const open: (JSONContent | null)[] = Array.from({ length: count }, () => null);
    const rows: JSONContent[] = [];
    for (const row of block.rows) {
      const cells: JSONContent[] = [];
      let col = 0;
      for (const cell of row.cells) {
        const above = open[col];
        if (cell.merge === "continue" && above) {
          above.attrs = { ...above.attrs, rowspan: Number(above.attrs?.rowspan ?? 1) + 1 };
          col += cell.span;
          continue;
        }
        const content = convert(cell.blocks);
        const node: JSONContent = {
          type: "tableCell",
          attrs: { colspan: cell.span, rowspan: 1, ...(cell.bg ? { bg: hex(cell.bg) } : {}) },
          content: content.length ? content : [{ type: "paragraph" }],
        };
        for (let i = 0; i < cell.span && col + i < count; i += 1) open[col + i] = cell.merge === "start" ? node : null;
        cells.push(node);
        col += cell.span;
      }
      rows.push({ type: "tableRow", content: cells });
    }
    // Widths of its own — unless it is simply as wide as the text, shared
    // out equally (which is what a table without widths is here).
    const even = block.grid.length > 0 && block.grid.every((w) => Math.abs(w - block.grid[0]) < 0.2);
    const cols = block.grid.length === count && !(block.full && even) ? encodeCols(block.grid) : null;
    return {
      type: "table",
      attrs: { cols, head: block.head ? true : null, lines: block.lines === "all" ? null : block.lines, ...(block.rev ? { tc: tcOf(block.rev) } : {}) },
      content: rows,
    };
  };

  function convert(list: Block[]): JSONContent[] {
  const items: Item[] = [];
  /** A drop-cap frame's letter, waiting for the paragraph it belongs to. */
  let cap: { text: string; breakBefore: boolean } | null = null;

  /** The paragraph before's mark, when it is a tracked change: here it is
   *  said of the paragraph that follows the break. */
  let carried: FileRevs | undefined;

  for (const para of list) {
    if (para.t === "table") {
      carried = undefined;
      items.push({ kind: "raw", node: tableNode(para), extra: [] });
      continue;
    }
    if (para.t === "toc") {
      carried = undefined;
      items.push({ kind: "raw", node: { type: "toc", ...(para.depth !== 3 ? { attrs: { depth: para.depth } } : {}) }, extra: [] });
      continue;
    }
    const breakRev = carried;
    carried = para.endRev;
    const { props, style } = para;
    const styleName = style.name.toLowerCase();
    const headingLevel = headingOf(para);
    const isCode = !headingLevel && CODE_STYLES.test(styleName);
    const isQuote = !headingLevel && !isCode && QUOTE_STYLES.test(styleName);
    const level = props.numId && props.numId > 0 ? numbering.level(props.numId, props.ilvl ?? 0) : undefined;
    const listed = !!level && level.fmt !== "none";

    // The style the paragraph is in here, and what that style looks like —
    // which is what its own formatting is measured against.
    let element: string | null = null;
    let ref: ResolvedStyle = base;
    if (headingLevel) {
      ref = style;
      noteBuiltin(`h${headingLevel}`, style);
    } else if (isQuote) {
      ref = style;
      noteBuiltin("quote", style);
    } else if (!isCode && !listed) {
      const known = STYLE_ELEMENTS[styleName];
      if (known) {
        element = known;
        ref = style;
        noteBuiltin(known, style);
      } else if (style.id && !PLAIN_STYLES.test(styleName)) {
        element = noteCustom(style);
        if (element) ref = style;
      }
    }
    const styled = ref !== base;
    const refSize = ref.rPr.size ?? baseSize;

    if (props.dropCap) {
      const text = para.inlines.map((n) => (n.t === "text" ? n.text : "")).join("");
      if (text.trim()) {
        cap = { text: text.trim(), breakBefore: para.breakBefore };
        continue;
      }
    }

    // What most of the paragraph is set in is the paragraph's; the rest is
    // marked on the words that differ.
    const used = dominant(para.inlines, para.mark);
    const paraFont = used.font ?? ref.rPr.font;
    const paraSize = used.size ?? refSize;
    const refColor = ref.rPr.color || "000000";

    const content: JSONContent[] = [];
    const images: JSONContent[] = [];
    for (const n of para.inlines) {
      if (n.t === "break") {
        content.push({ type: "hardBreak" });
      } else if (n.t === "image") {
        images.push({
          type: "image",
          attrs: {
            src: `${MEDIA_PREFIX}${n.media}`,
            ...(n.alt ? { alt: n.alt.slice(0, 500) } : {}),
            ...(n.w > 0 && n.h > 0 ? { width: n.w, height: n.h } : {}),
          },
        });
      } else if (n.t === "note") {
        const said = noteContent(n.inlines);
        const noteAttrs = { ...(n.kind === "end" ? { kind: "end" } : {}), ...(n.rev ? { tc: tcOf(n.rev) } : {}) };
        content.push({ type: "footnote", ...(Object.keys(noteAttrs).length ? { attrs: noteAttrs } : {}), ...(said.length ? { content: said } : {}) });
      } else if (n.t === "text") {
        // Code can't carry marks: there a change is read as accepted.
        if (isCode && n.rev?.del) continue;
        const marks: Mark[] = isCode ? [] : tracked(n.rev);
        const rp = n.props;
        // Code stands alone: the editor's code mark excludes the others.
        if (rp.code) marks.push({ type: "code" });
        else if (!isCode) {
          if (rp.b && !(styled && ref.rPr.b)) marks.push({ type: "bold" });
          if (rp.i && !(styled && ref.rPr.i)) marks.push({ type: "italic" });
          if (rp.strike) marks.push({ type: "strike" });
          // A link is underlined by its style; that underline isn't the writer's.
          if (rp.u && !n.href && !(styled && ref.rPr.u)) marks.push({ type: "underline" });
          if (n.href && /^(https?:|mailto:|tel:)/i.test(n.href)) marks.push({ type: "link", attrs: { href: n.href } });
          if (rp.font && rp.font !== paraFont) {
            const id = otherFontId(rp.font);
            if (id) marks.push({ type: "fontFamily", attrs: { f: id } });
          }
          if (rp.size && rp.size !== paraSize && rp.size >= 4 && rp.size <= 200) marks.push({ type: "fontSize", attrs: { pt: round(rp.size, 1) } });
          // A link's blue is its style's, like its underline.
          const color = rp.color || "000000";
          if (color !== refColor && !n.href) marks.push({ type: "textColor", attrs: { c: hex(color) } });
          if (rp.highlight) marks.push({ type: "highlight", attrs: { c: hex(rp.highlight) } });
          if (rp.vert) marks.push({ type: "vscript", attrs: { v: rp.vert === "sup" ? "super" : "sub" } });
        }
        const text = rp.caps ? n.text.toUpperCase() : n.text;
        const prev = content[content.length - 1];
        if (prev?.type === "text" && JSON.stringify(prev.marks ?? []) === JSON.stringify(marks)) {
          prev.text = (prev.text ?? "") + text;
        } else {
          content.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
        }
      }
    }

    let typed: ListInfo | undefined;
    if (!isCode) {
      // Leading tabs and spaces were indentation, not text.
      while (content[0]?.type === "text" && /^[\t ]*$/.test(content[0].text ?? "")) content.shift();
      if (content[0]?.type === "text") content[0] = { ...content[0], text: content[0].text!.replace(/^[\t ]+/, "") };
      // A list typed out by hand.
      if (!headingLevel && !props.numId) {
        let lead = "";
        for (const c of content) {
          if (c.type !== "text" || lead.length > 8) break;
          lead += c.text ?? "";
        }
        const number = TYPED_NUMBER.exec(lead);
        const marker = TYPED_BULLET.exec(lead)?.[0] ?? number?.[0];
        if (marker) {
          dropLeading(content, marker.length);
          typed = {
            numId: number ? -2 : -1,
            ilvl: Math.min(8, Math.max(0, Math.round((props.indL ?? 36) / 36) - 1)),
            kind: number ? "ordered" : "bullet",
            type: null,
            start: number ? Number(number[1]) : 1,
            marker: null,
            checked: false,
            legal: false,
          };
        }
      }
    }

    let dropCap = false;
    let breakBefore = para.breakBefore;
    if (cap) {
      if (content[0]?.type === "text") {
        content[0] = { ...content[0], text: cap.text + content[0].text };
        dropCap = true;
      } else if (!content.length) {
        content.push({ type: "text", text: cap.text });
      } else {
        content.unshift({ type: "text", text: cap.text });
        dropCap = true;
      }
      breakBefore = breakBefore || cap.breakBefore;
      cap = null;
    }

    const attrs: Record<string, unknown> = {};
    const align = ALIGN[props.jc ?? ""] ?? "left";
    const refAlign = styled ? (ALIGN[ref.pPr.jc ?? ""] ?? "left") : "left";
    if (align !== refAlign || (align !== "left" && !styled)) {
      // (Back to the left in a centred style can't be said by a paragraph;
      // the style's alignment stands.)
      if (align !== "left") attrs.align = align;
    }
    if (breakBefore) attrs.pageBreakBefore = true;
    if (breakRev && !isCode) attrs.tc = tcOf(breakRev);
    if (dropCap) attrs.dropCap = true;
    if (para.colBreak) attrs.colBreak = true;
    if (para.sect) {
      const own = sectionDiff(sectionProps(para.sect), opts.base ?? {});
      // (Where the first section's page numbers start is the document's
      // own setting; and a first section with nothing else of its own is
      // just the document.)
      if (firstSection) delete own.pn;
      if (!firstSection || Object.keys(own).length) attrs.sect = encodeSection(own);
      firstSection = false;
    }

    if (!isCode) {
      if (used.font && used.font !== ref.rPr.font) {
        const id = otherFontId(used.font);
        if (id) attrs.font = id;
      }
      if (used.size && used.size !== refSize) attrs.size = round(used.size, 1);
      const refLine = styled ? lineMultiple(ref.pPr, refSize) : baseLine;
      if (props.lineRule && props.lineAt && props.lineAt >= 4 && props.lineAt <= 400) {
        if (!(styled && ref.pPr.lineRule === props.lineRule && ref.pPr.lineAt === props.lineAt)) {
          attrs.lineRule = props.lineRule;
          attrs.lineAt = round(props.lineAt, 1);
        }
      } else {
        const line = lineMultiple(props, paraSize);
        if (line !== undefined && line !== refLine && line >= 0.8 && line <= 4) attrs.line = line;
      }
      const refBefore = styled ? (ref.pPr.before ?? 0) : 0;
      const refAfter = styled ? (ref.pPr.after ?? 0) : baseAfter;
      const before = props.before ?? 0;
      const after = props.after ?? 0;
      if (before !== refBefore) attrs.sa = round(Math.min(200, Math.max(0, before)), 1);
      if (after !== refAfter) attrs.sb = round(Math.min(200, Math.max(0, after)), 1);
      // A list item's indents are the list's, not the writer's.
      if (!listed && !typed) {
        const indL = Math.max(0, props.indL ?? 0);
        const indR = Math.max(0, props.indR ?? 0);
        const refL = styled ? Math.max(0, ref.pPr.indL ?? 0) : 0;
        const refR = styled ? Math.max(0, ref.pPr.indR ?? 0) : 0;
        if (indL !== refL) attrs.indL = round(Math.min(720, indL), 1);
        if (indR !== refR) attrs.indR = round(Math.min(720, indR), 1);
        // The style's first-line indent is for prose (see the page layout):
        // a centred line has none unless it says so.
        const prose = (align === "left" || align === "justify") && !dropCap;
        const expected = prose ? (styled ? (ref.pPr.indFirst ?? 0) : baseFirst > 3 ? baseFirst : 0) : 0;
        const first = props.indFirst ?? 0;
        if (Math.abs(first - expected) > 0.5) attrs.indF = round(Math.min(720, Math.max(-720, first)), 1);
      }
      if (props.keepNext && !(styled && ref.pPr.keepNext) && !headingLevel) attrs.keepNext = true;
      if (props.keepLines && !headingLevel) attrs.keepLines = true;
      if (props.shade) attrs.shade = hex(props.shade);
    }

    const body = content.length ? { content } : {};

    if (headingLevel) {
      const hasBorder = props.border ? { bdr: encodeBorder({ ...props.border, color: hex(props.border.color) }) } : {};
      items.push({ kind: "p", node: { type: "heading", attrs: { ...attrs, ...hasBorder, level: Number(headingLevel) }, ...body }, extra: images });
      continue;
    }

    // A rule drawn on an empty paragraph is a divider line.
    if (props.rule && !content.length && !images.length) {
      items.push({ kind: "rule", node: { type: "horizontalRule" }, extra: [] });
      continue;
    }
    if (props.border && !isCode) attrs.bdr = encodeBorder({ ...props.border, color: hex(props.border.color) });
    if (element) attrs.element = element;

    const hasAttrs = Object.keys(attrs).length > 0;
    const node: JSONContent = { type: "paragraph", ...(hasAttrs ? { attrs } : {}), ...body };

    if (level && listed) {
      const bullet = level.fmt === "bullet";
      const ilvl = Math.min(8, Math.max(0, props.ilvl ?? 0));
      const kind = bullet ? bulletKind(level) : { marker: null };
      // Round, hollow, square by depth is how bullets come anyway.
      if (kind.marker === ([null, "circle", "square"] as const)[ilvl % 3]) kind.marker = null;
      items.push({
        kind: "list",
        node,
        extra: images,
        list: {
          numId: props.numId!,
          ilvl,
          kind: !bullet ? "ordered" : "task" in kind && kind.task ? "task" : "bullet",
          type: ORDERED_TYPE[level.fmt] ?? null,
          start: level.start,
          marker: kind.marker,
          checked: "task" in kind && kind.task === "on",
          // "1.1." — a number that shows the levels above it (or whose
          // next level down does: the list that starts a legal numbering).
          legal:
            !bullet &&
            (placeholders(level.text) > 1 || placeholders(numbering.level(props.numId!, ilvl + 1)?.text) > 1),
        },
      });
      continue;
    }
    if (typed) {
      items.push({ kind: "list", node, extra: images, list: typed });
      continue;
    }
    if (isCode) {
      items.push({ kind: "code", node, extra: images });
      continue;
    }
    if (isQuote) {
      items.push({ kind: "quote", node, extra: images });
      continue;
    }
    // A paragraph that only held pictures is the pictures, set where the
    // paragraph was.
    if (!content.length && images.length && !breakBefore) {
      const side = align === "center" || align === "right" ? align : props.jc === "left" || props.jc === "start" ? "left" : null;
      items.push(...images.map((img) => ({ kind: "p" as const, node: side ? { ...img, attrs: { ...img.attrs, align: side } } : img, extra: [] })));
      continue;
    }
    items.push({ kind: "p", node, extra: images });
  }

  const blocks: JSONContent[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.kind === "quote") {
      const quote: JSONContent[] = [];
      while (i < items.length && items[i].kind === "quote") {
        quote.push(items[i].node, ...items[i].extra);
        i += 1;
      }
      blocks.push({ type: "blockquote", content: quote });
    } else if (item.kind === "code") {
      const lines: string[] = [];
      while (i < items.length && items[i].kind === "code") {
        lines.push(
          (items[i].node.content ?? []).map((n) => (n.type === "hardBreak" ? "\n" : (n.text ?? ""))).join(""),
        );
        i += 1;
      }
      const text = lines.join("\n");
      blocks.push({ type: "codeBlock", ...(text ? { content: [{ type: "text", text }] } : {}) });
    } else if (item.kind === "list") {
      // Nest by level; a change of list (or of kind) at a level starts anew.
      // A checklist's ticked and unticked items are one list (Word needs a
      // numbering definition for each).
      const stack: { list: JSONContent; ilvl: number; numId: number; kind: ListInfo["kind"] }[] = [];
      while (i < items.length && items[i].kind === "list") {
        const cur = items[i];
        const info = cur.list!;
        while (stack.length && stack[stack.length - 1].ilvl > info.ilvl) stack.pop();
        const top = stack[stack.length - 1];
        const sameList = top && (top.numId === info.numId || (top.kind === "task" && info.kind === "task"));
        if (top && top.ilvl === info.ilvl && (top.kind !== info.kind || !sameList)) stack.pop();
        const parent = stack[stack.length - 1];
        if (!parent || parent.ilvl < info.ilvl) {
          let list: JSONContent;
          if (info.kind === "task") list = { type: "taskList", content: [] };
          else if (info.kind === "bullet") {
            list = { type: "bulletList", ...(info.marker ? { attrs: { marker: info.marker } } : {}), content: [] };
          } else {
            // Inside a legal list the numbering carries on by itself; the
            // list that starts one says so.
            const root = stack[0];
            const inLegal = info.legal && root && root.list.type === "orderedList";
            if (inLegal) root.list.attrs = { ...root.list.attrs, type: LEGAL };
            list = {
              type: "orderedList",
              attrs: { start: info.start, type: info.legal ? (inLegal ? null : LEGAL) : info.type },
              content: [],
            };
          }
          if (!parent) blocks.push(list);
          else {
            const host = parent.list.content![parent.list.content!.length - 1];
            host.content!.push(list);
          }
          stack.push({ list, ilvl: info.ilvl, numId: info.numId, kind: info.kind });
        }
        const holder = stack[stack.length - 1].list;
        holder.content!.push(
          info.kind === "task"
            ? { type: "taskItem", ...(info.checked ? { attrs: { checked: true } } : {}), content: [cur.node, ...cur.extra] }
            : { type: "listItem", content: [cur.node, ...cur.extra] },
        );
        i += 1;
      }
    } else {
      // A caption under a picture is the picture's.
      const prev = blocks[blocks.length - 1];
      const words = item.node.type === "paragraph" && item.node.attrs?.element === "caption" ? (item.node.content ?? []) : null;
      if (prev?.type === "image" && !prev.attrs?.caption && words?.length && words.every((n) => n.type === "text") && !item.extra.length) {
        prev.attrs = { ...prev.attrs, caption: words.map((n) => n.text ?? "").join("").trim().slice(0, 500) };
        i += 1;
        continue;
      }
      blocks.push(item.node, ...item.extra);
      i += 1;
    }
  }
  return blocks;
  }

  const blocks = convert(opts.tree ?? paras);

  // Styles the file left as they come need no entry.
  const stylesOut: Record<string, string> = {};
  for (const [id, value] of Object.entries(styleTable)) if (value) stylesOut[id] = value;

  return { content: { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] }, settings, styles: stylesOut, fontNames };
}
