/**
 * What the text at the selection actually looks like — the answer the
 * ribbon's font, size and colour boxes show. Formatting comes from four
 * places, nearest first: a mark on the text, the paragraph's own
 * attributes, the paragraph's style, and the document's body text.
 */

import type { Editor } from "@tiptap/core";
import type { Mark, Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

import { isFontId } from "../../fonts/ids";
import { colorAttr, sizeAttr, vscriptAttr, type VScript } from "../schema/sanitize";
import { headingStyleId, NORMAL_STYLE, QUOTE_STYLE, type ResolvedStyles, type StyleLook } from "../styles/sheet";

export interface FormatContext {
  /** The document's styles, resolved against its body text. */
  styles: ResolvedStyles;
  /** The newest schema level this document may use here (the lower of the
   *  app's and its server's): below 2, formatting is by paragraph only. */
  level: number;
}

export interface RunLook {
  /** A font id; null is the document's body font. */
  font: string | null;
  size: number;
  color: string | null;
  highlight: string | null;
  vscript: VScript | null;
  /** The selection holds more than one value of these. */
  mixed: { font: boolean; size: boolean; color: boolean; highlight: boolean };
}

/** The style a block takes its look from. */
export function styleIdOf(block: PmNode, $pos: ResolvedPos | null, styles: ResolvedStyles): string {
  if (block.type.name === "heading") return headingStyleId(block.attrs.level);
  const element = block.attrs.element;
  if (typeof element === "string" && styles.has(element)) return element;
  if ($pos) {
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.name === "blockquote") return QUOTE_STYLE;
    }
  }
  return NORMAL_STYLE;
}

/** The style of the block the selection starts in. */
export function currentStyleId(state: EditorState, styles: ResolvedStyles): string {
  const { $from } = state.selection;
  return styleIdOf($from.parent, $from, styles);
}

interface One {
  font: string | null;
  size: number;
  color: string | null;
  highlight: string | null;
  vscript: VScript | null;
}

function lookOf(marks: readonly Mark[], block: PmNode, base: StyleLook): One {
  const out: One = {
    font: isFontId(block.attrs.font) ? block.attrs.font : base.font,
    size: sizeAttr(block.attrs.size) ?? base.size,
    color: base.color,
    highlight: null,
    vscript: null,
  };
  for (const mark of marks) {
    switch (mark.type.name) {
      case "fontFamily":
        if (isFontId(mark.attrs.f)) out.font = mark.attrs.f;
        break;
      case "fontSize":
        out.size = sizeAttr(mark.attrs.pt) ?? out.size;
        break;
      case "textColor":
        out.color = colorAttr(mark.attrs.c) ?? out.color;
        break;
      case "highlight":
        out.highlight = colorAttr(mark.attrs.c);
        break;
      case "vscript":
        out.vscript = vscriptAttr(mark.attrs.v);
        break;
      default:
    }
  }
  return out;
}

/** How many pieces of text a long selection is read through before the
 *  answer is taken as it stands. */
const LOOK_LIMIT = 400;

export function effectiveRun(state: EditorState, ctx: FormatContext): RunLook {
  const { selection, doc } = state;
  const { $from, from, to, empty } = selection;
  const mixed = { font: false, size: false, color: false, highlight: false };

  if (empty || !$from.parent.isTextblock) {
    const marks = state.storedMarks ?? $from.marks();
    const block = $from.parent;
    return { ...lookOf(marks, block, ctx.styles.look(styleIdOf(block, $from, ctx.styles))), mixed };
  }

  const acc: { first: One | null; seen: number; base: StyleLook | null; block: PmNode | null } = {
    first: null,
    seen: 0,
    base: null,
    block: null,
  };
  doc.nodesBetween(from, to, (node, pos) => {
    if (acc.seen >= LOOK_LIMIT) return false;
    if (node.isTextblock) {
      acc.block = node;
      acc.base = ctx.styles.look(styleIdOf(node, doc.resolve(pos + 1), ctx.styles));
      return true;
    }
    if (!node.isText || !acc.block || !acc.base) return true;
    // A piece that only touches the selection's edge isn't in it.
    if (Math.min(to, pos + node.nodeSize) <= Math.max(from, pos)) return false;
    acc.seen += 1;
    const one = lookOf(node.marks, acc.block, acc.base);
    const f = acc.first;
    if (!f) acc.first = one;
    else {
      if (one.font !== f.font) mixed.font = true;
      if (one.size !== f.size) mixed.size = true;
      if (one.color !== f.color) mixed.color = true;
      if (one.highlight !== f.highlight) mixed.highlight = true;
    }
    return false;
  });
  if (acc.first) return { ...acc.first, mixed };
  // A selection with no text in it (empty paragraphs): the first block's own.
  const start = $from.parent;
  return { ...lookOf([], start, ctx.styles.look(styleIdOf(start, $from, ctx.styles))), mixed };
}

/** `effectiveRun` for an editor. */
export function curRun(editor: Editor, ctx: FormatContext): RunLook {
  return effectiveRun(editor.state, ctx);
}

/** The size a block's text is set in when it carries no size of its own. */
export function blockBaseSize(block: PmNode, $pos: ResolvedPos | null, styles: ResolvedStyles): number {
  return sizeAttr(block.attrs.size) ?? styles.look(styleIdOf(block, $pos, styles)).size;
}
