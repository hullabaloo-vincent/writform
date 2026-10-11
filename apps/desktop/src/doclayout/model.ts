/**
 * A document as the page layout sees it: a flat list of blocks, each with
 * every measurement already decided — typeface, size, line pitch, spacing,
 * indents, list markers. Built on the main thread from the editor's
 * content and the document's settings; plain data, so it crosses to the
 * typesetting worker as-is.
 *
 * The look comes from one table (editor/styles/sheet.ts) that the screen
 * and the Word export read too.
 */

import type { JSONContent } from "@tiptap/core";

import { bodyLook, pageDims, type DocSettings } from "../apps/documents/docSettings";
import {
  colorAttr,
  firstIndentAttr,
  indentAttr,
  lineAtAttr,
  lineRuleAttr,
  MARKER_GLYPH,
  markerAttr,
  parseBorder,
  parseSection,
  sizeAttr,
  vscriptAttr,
  type Border,
  type LineRule,
  type SectionProps,
  type VScript,
} from "../editor/schema/sanitize";
import { noteKind, noteNumber, type NoteKind } from "../editor/nodes/Footnote";
import { imageAlign, imageCaption, type ImageAlign } from "../editor/nodes/Image";
import { tocDepth } from "../editor/nodes/Toc";
import { linesAttr, parseCols, type TableLines } from "../editor/tables/Table";
import {
  BLOCK_GAP,
  BULLETS,
  CODE_FONT,
  CODE_SIZE,
  headingStyleId,
  LEGAL,
  LIST_INDENT,
  listMarker,
  NORMAL_STYLE,
  QUOTE_STYLE,
  resolveStyles,
  SINGLE,
  type StyleOverrides,
} from "../editor/styles/sheet";
import { isFontId } from "../fonts/ids";
import { printFace, type PrintFace } from "../fonts/substitutes";

export interface DocRun {
  /** "\n" alone is a line break. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  /** A typeface of the run's own (the layout family that draws it). */
  family?: string;
  /** Points. */
  size?: number;
  /** `#rrggbb`. */
  color?: string;
  highlight?: string;
  vscript?: VScript;
  /** A note's reference number: which of the model's notes it cites. */
  note?: number;
  /** Where the run starts in the content of the editor's node (so the
   *  page view can say where in the text a page begins). */
  at?: number;
}

export type DocAlign = "left" | "center" | "right" | "justify";

interface BlockBase {
  /** The top-level block of the document this came from. */
  src: number;
  /** Space above and below, points (neighbours share the larger). */
  before: number;
  after: number;
  /** Indents from the column's edges, points. */
  left: number;
  right: number;
  breakBefore?: boolean;
  /** A section starts with this block (top-level blocks only): a new page,
   *  with whatever the section sets for itself. */
  sect?: SectionProps;
  /** Where the node it came from is in the editor's document (absent for
   *  what isn't there: a note's text, a title put in for print). Moves
   *  with every edit above it, so it is never part of how a block is set. */
  pos?: number;
}

export interface DocPara extends BlockBase {
  kind: "para";
  runs: DocRun[];
  /** Bundled family that draws it. */
  family: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
  align: DocAlign;
  /** Line pitch for type of the paragraph's own size, points. */
  leading: number;
  /** Line spacing as a multiple of single (a line with larger type on it
   *  is that much taller). */
  line: number;
  /** An exact or minimum line height instead, points. */
  lineRule?: LineRule;
  lineAt?: number;
  /** First-line indent, points. */
  first: number;
  /** How far the lines after the first are set in (a hanging indent). */
  hang?: number;
  underline?: boolean;
  /** The paragraph's own text colour (its style's). */
  color?: string;
  /** Background, `#rrggbb`. */
  shade?: string;
  border?: Border;
  /** A list marker, hung to the left of the text. */
  marker?: string;
  /** A drawn marker instead: a checklist's box (ticked or not), or a tick. */
  sign?: "box" | "boxOn" | "tick";
  /** Bordered like its neighbour above / below: the two share one box
   *  (no rule between them), as in Word. */
  joinPrev?: boolean;
  joinNext?: boolean;
  /** Stay with the block that follows (headings). */
  keepNext?: boolean;
  /** Never split across pages (headings). */
  keepLines?: boolean;
  /** Outline level 1–6 (headings). */
  outline?: number;
  dropCap?: boolean;
  /** Code: set as typed (no hyphenation). */
  pre?: boolean;
  /** Starts at the top of the next column. */
  colBreak?: boolean;
  /** Not the start of its node but this far into its content (a line of a
   *  block of code). */
  from?: number;
}

export interface DocImage extends BlockBase {
  kind: "image";
  url: string;
  /** The size the document gives it, CSS pixels (absent: its own). */
  w?: number;
  h?: number;
  align?: ImageAlign;
  /** The line under it, kept with it. */
  caption?: DocPara;
}

export interface DocRule extends BlockBase {
  kind: "rule";
  /** A short rule at the left (above the endnotes), not across the column. */
  short?: boolean;
}

export interface DocCell {
  blocks: DocBlock[];
  colspan: number;
  rowspan: number;
  /** Background, `#rrggbb`. */
  bg?: string;
}

export interface DocTable extends BlockBase {
  kind: "table";
  /** Column widths, points — or null: the width shared equally. */
  cols: number[] | null;
  /** The first row is a header, repeated when the table runs over a page. */
  head: boolean;
  lines: TableLines;
  rows: DocCell[][];
  /** Where each row is in the editor's document. */
  rowPos?: number[];
}

/** A table of contents: the layout fills in the headings and their pages. */
export interface DocToc extends BlockBase {
  kind: "toc";
  depth: number;
  family: string;
  size: number;
  leading: number;
}

export type DocBlock = DocPara | DocImage | DocRule | DocTable | DocToc;

export interface DocNote {
  kind: NoteKind;
  /** As printed: "3", "iv". */
  number: string;
  /** The note itself, its number leading. */
  para: DocPara;
}

export interface DocModel {
  blocks: DocBlock[];
  /** The sheet and its margins, points. */
  page: { w: number; h: number; mt: number; mb: number; ml: number; mr: number };
  settings: DocSettings;
  /** Body face and size, for headers, footers and line numbers. */
  body: { family: string; size: number };
  meta: { title: string; author: string; date: string; lang: string };
  /** Bundled families the layout draws with. */
  families: string[];
  /** Families tried, in order, for characters a block's own face lacks. */
  fallbacks: string[];
  /** Per family, further families tried first for what it lacks (the other
   *  scripts of a catalog family). */
  chains: Record<string, string[]>;
  /** Fonts set in a stand-in: [asked for, drawn in, why]. */
  substitutions: [asked: string, drawn: string, why: "missing" | "licence"][];
  /** Footnotes and endnotes, in the order they are cited. */
  notes: DocNote[];
}

export interface DocModelOptions {
  title: string;
  author?: string;
  settings: DocSettings;
  /** Today, as headers print it. */
  date?: string;
  lang?: string;
  /** What each font prints in on this device, worked out beforehand (the
   *  font store). Absent: the app's bundled faces only. */
  fonts?: { face: (id: string | null | undefined) => PrintFace; chains: Record<string, string[]> };
  /** What the document has changed about its styles. */
  styles?: StyleOverrides;
  /** Blocks at the start that aren't in the editor (a title put in for
   *  print): they have no place there, and the rest are counted without. */
  virtual?: number;
}

/** Nodes without content: one position each in the editor's document. */
const LEAVES = new Set(["hardBreak", "image", "horizontalRule", "toc"]);
const sizes = new WeakMap<JSONContent, number>();
/** A node's size as the editor counts positions. */
function sizeOf(node: JSONContent): number {
  if (node.type === "text") return (node.text ?? "").length;
  const known = sizes.get(node);
  if (known !== undefined) return known;
  const size = LEAVES.has(node.type ?? "") ? 1 : 2 + (node.content ?? []).reduce((n, child) => n + sizeOf(child), 0);
  sizes.set(node, size);
  return size;
}

const LINK_COLOR = "#0563c1";
export { LINK_COLOR };

/** Characters every bundled text face has; anything else may need another
 *  family to draw it. */
// eslint-disable-next-line no-control-regex
const COMMON = /^[\u0000-\u024f\u2000-\u206f\u20a0-\u20bf\u2122\u2190-\u2193\u2212]*$/;

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

/** A character's width in the code face, as a fraction of its size. */
const MONO_ADVANCE = 0.6;

interface Ctx {
  src: number;
  left: number;
  right: number;
  /** Inside a list item: no first-line indent. */
  listed: boolean;
  /** Inside a quote: paragraphs are in the Quote style. */
  quoted?: boolean;
}

export function buildDocModel(doc: JSONContent, opts: DocModelOptions): DocModel {
  const s = opts.settings;
  const dims = pageDims(s);
  const lookup = opts.fonts?.face ?? ((id: string | null | undefined) => printFace(id));
  const bodyFace = lookup(s.bodyFont);
  const body = bodyLook(s);
  const styles = resolveStyles(body, opts.styles);
  const bodySize = body.size;
  const bodyAfter = body.after;
  const gap = BLOCK_GAP * bodySize;

  const families = new Set<string>([bodyFace.family]);
  const substitutions = new Map<string, [string, string, "missing" | "licence"]>();
  let exotic = false;
  const face = (id: string | null | undefined): string => {
    const f = id ? lookup(id) : bodyFace;
    families.add(f.family);
    if (f.substituted) substitutions.set(f.asked, [f.asked, f.drawn, f.why ?? "missing"]);
    return f.family;
  };
  face(s.bodyFont);

  const notes: DocNote[] = [];
  const counts: Record<NoteKind, number> = { foot: 0, end: 0 };
  const noteSize = Math.max(7, Math.round(bodySize * 0.85 * 2) / 2);
  /** A note, set small: its number, then what it says. */
  const noteOf = (node: JSONContent, src: number): number => {
    const kind = noteKind(node.attrs?.kind);
    counts[kind] += 1;
    const number = noteNumber(counts[kind], kind);
    const line = Math.min(body.line, 1.15);
    notes.push({
      kind,
      number,
      para: {
        kind: "para",
        src,
        runs: [{ text: number, vscript: "super" }, { text: " " }, ...runsOf(node, src)],
        family: bodyFace.family,
        size: noteSize,
        align: "left",
        leading: noteSize * SINGLE * line,
        line,
        before: 0,
        after: noteSize * 0.25,
        left: 0,
        right: 0,
        first: 0,
      },
    });
    return notes.length - 1;
  };

  const runsOf = (node: JSONContent, src = 0): DocRun[] => {
    const out: DocRun[] = [];
    let next = 0;
    for (const child of node.content ?? []) {
      const at = next;
      next += sizeOf(child);
      if (child.type === "hardBreak") {
        out.push({ text: "\n", at });
        continue;
      }
      if (child.type === "footnote") {
        // In the text: its number, raised. The note itself is the layout's
        // to place (the foot of the page, or the end of the document).
        const index = noteOf(child, src);
        out.push({ text: notes[index].number, vscript: "super", note: index, at });
        continue;
      }
      if (child.type !== "text" || !child.text) continue;
      const run: DocRun = { text: child.text, at };
      for (const m of child.marks ?? []) {
        if (m.type === "bold") run.bold = true;
        else if (m.type === "italic") run.italic = true;
        else if (m.type === "underline") run.underline = true;
        else if (m.type === "strike") run.strike = true;
        else if (m.type === "code") run.code = true;
        else if (m.type === "link" && typeof m.attrs?.href === "string" && SAFE_LINK.test(m.attrs.href)) {
          run.link = m.attrs.href;
        } else if (m.type === "fontFamily" && isFontId(m.attrs?.f)) run.family = face(m.attrs.f as string);
        else if (m.type === "fontSize") {
          const pt = sizeAttr(m.attrs?.pt);
          if (pt !== null) run.size = pt;
        } else if (m.type === "textColor") {
          const c = colorAttr(m.attrs?.c);
          if (c) run.color = c;
        } else if (m.type === "highlight") {
          const c = colorAttr(m.attrs?.c);
          if (c) run.highlight = c;
        } else if (m.type === "vscript") {
          const v = vscriptAttr(m.attrs?.v);
          if (v) run.vscript = v;
        }
      }
      if (run.code) families.add(CODE_FONT);
      if (!exotic && !COMMON.test(run.text)) exotic = true;
      out.push(run);
    }
    return out;
  };

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const para = (node: JSONContent, ctx: Ctx, pos?: number): DocPara => {
    const a = node.attrs ?? {};
    const heading = node.type === "heading";
    // The style it takes its look from: what it is, the style it names, or
    // where it sits.
    const styleId = heading
      ? headingStyleId(a.level)
      : typeof a.element === "string" && styles.has(a.element)
        ? a.element
        : ctx.quoted
          ? QUOTE_STYLE
          : NORMAL_STYLE;
    const look = styles.look(styleId);
    const size = num(a.size) ?? look.size;
    const line = num(a.line) ?? look.line;
    const align: DocAlign = a.align === "center" || a.align === "right" || a.align === "justify" ? a.align : look.align;
    const runs = runsOf(node, ctx.src);
    // Tabs opening a paragraph are a hand-set indent.
    let tabs = 0;
    while (runs[0] && runs[0].text !== "\n" && /^\t/.test(runs[0].text)) {
      const lead = /^\t+/.exec(runs[0].text)![0].length;
      tabs += lead;
      runs[0] = { ...runs[0], text: runs[0].text.slice(lead), at: (runs[0].at ?? 0) + lead };
      if (!runs[0].text) runs.shift();
    }
    // A quote's own indents are its container's (below); every other style's
    // are the paragraph's.
    const styleL = styleId === QUOTE_STYLE ? 0 : look.indL;
    const styleR = styleId === QUOTE_STYLE ? 0 : look.indR;
    const indL = indentAttr(a.indL) ?? styleL;
    const indR = indentAttr(a.indR) ?? styleR;
    // The style's first-line indent is for running prose: not a list item,
    // not under a drop cap, not a centred or right-set line.
    const prose = !ctx.listed && !a.dropCap && (align === "left" || align === "justify");
    const indF = firstIndentAttr(a.indF) ?? (prose ? look.indF : 0);
    const hang = indF < 0 ? -indF : 0;
    const rule = lineRuleAttr(a.lineRule);
    const at = rule ? lineAtAttr(a.lineAt) : null;
    const block: DocPara = {
      kind: "para",
      src: ctx.src,
      runs,
      family: face(typeof a.font === "string" && isFontId(a.font) ? a.font : look.font),
      size,
      align,
      leading: size * SINGLE * line,
      line,
      before: num(a.sa) ?? look.before,
      after: num(a.sb) ?? look.after,
      // A hanging first line starts that far to the left of the rest.
      left: ctx.left + indL - hang,
      right: ctx.right + indR,
      first: Math.max(0, indF) + tabs * 36,
    };
    if (hang) block.hang = hang;
    if (rule && at !== null) {
      block.lineRule = rule;
      block.lineAt = at;
    }
    if (look.bold) block.bold = true;
    if (look.italic) block.italic = true;
    if (look.underline) block.underline = true;
    if (look.color) block.color = look.color;
    if (look.keepNext || a.keepNext === true) block.keepNext = true;
    if (look.keepLines || a.keepLines === true) block.keepLines = true;
    if (look.outline) block.outline = look.outline;
    const shade = colorAttr(a.shade);
    if (shade) block.shade = shade;
    const border = parseBorder(a.bdr);
    if (border) block.border = border;
    if (a.pageBreakBefore) block.breakBefore = true;
    if (a.colBreak === true) block.colBreak = true;
    if (a.dropCap && !heading) block.dropCap = true;
    if (pos !== undefined) block.pos = pos;
    return block;
  };

  /** A node's children, each with where it is (when the node's place is known). */
  const within = <T,>(node: JSONContent, pos: number | undefined, each: (child: JSONContent, at: number | undefined) => T[]): T[] => {
    let at = pos === undefined ? undefined : pos + 1;
    return (node.content ?? []).flatMap((child) => {
      const made = each(child, at);
      if (at !== undefined) at += sizeOf(child);
      return made;
    });
  };

  /** The space a quote, list or code block keeps around itself. */
  const fence = (blocks: DocBlock[]) => {
    if (!blocks.length) return;
    blocks[0].before = Math.max(blocks[0].before, gap);
    const last = blocks[blocks.length - 1];
    last.after = Math.max(last.after, gap);
  };

  const isList = (type: string | undefined) => type === "bulletList" || type === "orderedList" || type === "taskList";

  /** `legal` is the numbers of the items this list is nested in, when it
   *  continues a legal numbering ("1.1.1."); null otherwise. */
  const list = (node: JSONContent, ctx: Ctx, depth: number, legal: number[] | null, pos?: number): DocBlock[] => {
    const out: DocBlock[] = [];
    let itemPos = pos === undefined ? undefined : pos + 1;
    const ordered = node.type === "orderedList";
    const tasks = node.type === "taskList";
    const type = typeof node.attrs?.type === "string" ? node.attrs.type : null;
    // An untyped numbered list inside a legal one carries the numbering on.
    const isLegal = ordered && (type === LEGAL || (type === null && legal !== null));
    const marker = markerAttr(node.attrs?.marker);
    // (Legal numbering always counts from 1: the screen's counters do.)
    let n = ordered && !isLegal ? (num(node.attrs?.start) ?? 1) : 1;
    const left = ctx.left + LIST_INDENT;
    for (const item of node.content ?? []) {
      let first = true;
      let childPos = itemPos === undefined ? undefined : itemPos + 1;
      if (itemPos !== undefined) itemPos += sizeOf(item);
      for (const child of item.content ?? []) {
        const at = childPos;
        if (childPos !== undefined) childPos += sizeOf(child);
        if (isList(child.type)) {
          out.push(...list(child, { ...ctx, left, listed: true }, depth + 1, isLegal ? [...(legal ?? []), n] : null, at));
        } else {
          const inner = block(child, { ...ctx, left, listed: true }, at);
          const head = inner[0];
          if (first && head?.kind === "para") {
            if (tasks) head.sign = item.attrs?.checked === true ? "boxOn" : "box";
            else if (ordered) head.marker = isLegal ? listMarker(n, LEGAL, legal ?? []) : listMarker(n, type);
            else if (marker === "check") head.sign = "tick";
            else head.marker = marker ? MARKER_GLYPH[marker] : BULLETS[depth % BULLETS.length];
          }
          out.push(...inner);
        }
        first = false;
      }
      n += 1;
    }
    return out;
  };

  const block = (node: JSONContent, ctx: Ctx, pos?: number): DocBlock[] => {
    switch (node.type) {
      case "paragraph":
      case "heading":
        return [para(node, ctx, pos)];
      case "blockquote": {
        const quote = styles.look(QUOTE_STYLE);
        const inner = within(node, pos, (n, at) => block(n, { ...ctx, left: ctx.left + quote.indL, right: ctx.right + quote.indR, quoted: true }, at));
        fence(inner);
        return inner;
      }
      case "bulletList":
      case "orderedList":
      case "taskList": {
        const inner = list(node, ctx, 0, null, pos);
        // A list inside an item sits tight against it.
        if (!ctx.listed) fence(inner);
        return inner;
      }
      case "codeBlock": {
        const text = (node.content ?? []).map((n) => n.text ?? "").join("");
        if (!COMMON.test(text)) exotic = true;
        families.add(CODE_FONT);
        const size = bodySize * CODE_SIZE;
        let lineAt = 0;
        const lines: DocBlock[] = text.split("\n").map((line) => {
          // Leading spaces are the code's shape. The face is monospaced, so
          // they become an indent of exactly their width.
          const lead = /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;
          const rest = line.trimStart();
          const from = lineAt;
          lineAt += line.length + 1;
          return {
            kind: "para",
            src: ctx.src,
            ...(pos !== undefined ? { pos, ...(from > 0 ? { from } : {}) } : {}),
            runs: rest ? [{ text: rest, at: from + (line.length - rest.length) }] : [],
            family: CODE_FONT,
            size,
            align: "left",
            leading: size * 1.35,
            // 1.35 × the size, as a multiple of single.
            line: 1.35 / SINGLE,
            before: 0,
            after: 0,
            left: ctx.left + lead * size * MONO_ADVANCE,
            right: ctx.right,
            first: 0,
            pre: true,
          };
        });
        fence(lines);
        return lines;
      }
      case "horizontalRule":
        return [{ kind: "rule", src: ctx.src, before: bodySize * 0.5, after: bodySize * 0.5, left: ctx.left, right: ctx.right, ...(pos !== undefined ? { pos } : {}) }];
      case "image": {
        const url = typeof node.attrs?.src === "string" ? node.attrs.src : "";
        if (!url) return [];
        const w = num(node.attrs?.width);
        const h = num(node.attrs?.height);
        const align = imageAlign(node.attrs?.align);
        const text = imageCaption(node.attrs?.caption);
        // The caption is a paragraph in the Caption style, set under the
        // picture and to the same side.
        const caption = text
          ? para({ type: "paragraph", attrs: { element: "caption", align: align && align !== "left" ? align : null }, content: [{ type: "text", text }] }, ctx)
          : null;
        return [
          {
            kind: "image",
            src: ctx.src,
            url,
            ...(w && w > 0 ? { w } : {}),
            ...(h && h > 0 ? { h } : {}),
            ...(align ? { align } : {}),
            ...(caption ? { caption } : {}),
            ...(pos !== undefined ? { pos } : {}),
            before: 0,
            after: caption ? caption.after : bodyAfter,
            left: ctx.left,
            right: ctx.right,
          },
        ];
      }
      case "table": {
        const rows: DocCell[][] = (node.content ?? []).map((row) =>
          (row.content ?? []).map((cell): DocCell => {
            const bg = colorAttr(cell.attrs?.bg);
            const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, 1000) : 1);
            return {
              // A cell is a little page of its own: its blocks start at its edge.
              blocks: (cell.content ?? []).flatMap((n) => block(n, { src: ctx.src, left: 0, right: 0, listed: false })),
              colspan: whole(cell.attrs?.colspan),
              rowspan: whole(cell.attrs?.rowspan),
              ...(bg ? { bg } : {}),
            };
          }),
        );
        if (!rows.length) return [];
        const count = Math.max(1, ...rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
        return [
          {
            kind: "table",
            src: ctx.src,
            ...(pos !== undefined ? { pos, rowPos: within(node, pos, (_row, at) => [at ?? 0]) } : {}),
            before: 0,
            after: bodyAfter,
            left: ctx.left,
            right: ctx.right,
            cols: parseCols(node.attrs?.cols, count),
            head: node.attrs?.head === true,
            lines: linesAttr(node.attrs?.lines),
            rows,
          },
        ];
      }
      case "toc":
        return [
          {
            kind: "toc",
            src: ctx.src,
            ...(pos !== undefined ? { pos } : {}),
            before: 0,
            after: bodyAfter,
            left: ctx.left,
            right: ctx.right,
            depth: tocDepth(node.attrs?.depth),
            family: bodyFace.family,
            size: bodySize,
            leading: bodySize * SINGLE * Math.min(body.line, 1.3),
          },
        ];
      default:
        return within(node, pos, (n, at) => block(n, ctx, at));
    }
  };

  const blocks: DocBlock[] = [];
  const virtual = opts.virtual ?? 0;
  let place = 0;
  (doc.content ?? []).forEach((node, index) => {
    // (What was put in for print has no place in the editor; what follows
    // is where it would be without it.)
    const here = index < virtual ? undefined : place;
    if (index >= virtual) place += sizeOf(node);
    const src = Math.max(0, index - virtual);
    const made = block(node, { src, left: 0, right: 0, listed: false }, here);
    // A section starts with a top-level paragraph that says so.
    const sect = node.type === "paragraph" || node.type === "heading" ? parseSection(node.attrs?.sect) : null;
    if (sect && made[0]) made[0].sect = sect;
    blocks.push(...made);
  });

  // Endnotes close the document, under a short rule.
  const endnotes = notes.filter((n) => n.kind === "end");
  if (endnotes.length) {
    blocks.push({ kind: "rule", src: Math.max(0, (doc.content ?? []).length - 1), before: bodySize, after: bodySize * 0.4, left: 0, right: 0, short: true });
    for (const note of endnotes) blocks.push(note.para);
  }

  // Neighbours with the same border, shading and edges are one box: the
  // space between them belongs to the upper one (so the box has no gap).
  for (let i = 0; i + 1 < blocks.length; i += 1) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.kind !== "para" || b.kind !== "para" || !a.border || !b.border || b.breakBefore) continue;
    if (a.marker || a.sign || b.marker || b.sign) continue;
    const same =
      a.border.sides === b.border.sides && a.border.width === b.border.width && a.border.color === b.border.color && a.shade === b.shade && a.left === b.left && a.right === b.right;
    if (!same) continue;
    a.joinNext = true;
    b.joinPrev = true;
    a.after = Math.max(a.after, b.before);
    b.before = 0;
  }

  // Greek, Cyrillic, symbols: the faces most likely to have them.
  const fallbacks = exotic ? ["libertinus", "carlito"] : [];
  for (const f of fallbacks) families.add(f);
  // A catalog family's own other scripts come before those.
  const chains: Record<string, string[]> = {};
  for (const family of [...families]) {
    const extra = opts.fonts?.chains[family];
    if (!extra?.length) continue;
    chains[family] = extra;
    for (const f of extra) families.add(f);
  }

  return {
    blocks,
    page: { w: dims.w * 72, h: dims.h * 72, mt: s.mt * 72, mb: s.mb * 72, ml: s.ml * 72, mr: s.mr * 72 },
    settings: s,
    body: { family: bodyFace.family, size: bodySize },
    meta: {
      title: opts.title,
      author: opts.author ?? "",
      date: opts.date ?? new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
      lang: opts.lang ?? "en-US",
    },
    families: [...families],
    fallbacks,
    chains,
    substitutions: [...substitutions.values()],
    notes,
  };
}

/** The pictures a model draws, in order. */
export function modelImages(model: DocModel): string[] {
  const urls = (blocks: DocBlock[]): string[] =>
    blocks.flatMap((b) => (b.kind === "image" ? [b.url] : b.kind === "table" ? b.rows.flatMap((row) => row.flatMap((cell) => urls(cell.blocks))) : []));
  return [...new Set(urls(model.blocks))];
}
