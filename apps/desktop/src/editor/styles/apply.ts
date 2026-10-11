/**
 * Applying and capturing paragraph styles. A style is applied by saying
 * what the paragraph is — a heading node, a paragraph with the style's name
 * in `element`, a paragraph inside a quote — and taking off the paragraph
 * formatting set by hand, so it looks like its style. Formatting on the
 * words themselves (bold, a colour) stays, as in Word.
 */

import type { Editor } from "@tiptap/core";
import type { Mark, Node as PmNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

import { isFontId } from "../../fonts/ids";
import { currentStyleId } from "../format/effective";
import { colorAttr, firstIndentAttr, indentAttr, numberAttr, sizeAttr } from "../schema/sanitize";
import { NORMAL_STYLE, QUOTE_STYLE, type ResolvedStyles, type StyleAlign, type StyleProps } from "./sheet";

/** Paragraph formatting a style replaces when it's applied. */
const RESET: Record<string, null> = {
  align: null,
  font: null,
  size: null,
  line: null,
  sa: null,
  sb: null,
  dropCap: null,
  indL: null,
  indR: null,
  indF: null,
  lineRule: null,
  lineAt: null,
};

/** Marks a style can state, and so can absorb. */
const STYLE_MARKS = ["bold", "italic", "underline", "textColor", "fontFamily", "fontSize"];

function selectedBlocks(state: EditorState): { node: PmNode; pos: number }[] {
  const out: { node: PmNode; pos: number }[] = [];
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (node.type.name === "paragraph" || node.type.name === "heading") out.push({ node, pos });
      return !node.isTextblock;
    });
  }
  return out;
}

/** Make the selected paragraphs this style. */
export function applyStyle(editor: Editor, id: string, styles: ResolvedStyles): boolean {
  if (id === QUOTE_STYLE) {
    if (editor.isActive("blockquote")) return true;
    return editor.chain().focus().setBlockquote().run();
  }
  const heading = /^h([1-6])$/.exec(id);
  if (!heading && id !== NORMAL_STYLE && !styles.has(id)) return false;
  // Body text isn't a quote: it comes out of one.
  const chain = id === NORMAL_STYLE && editor.isActive("blockquote") ? editor.chain().focus().unsetBlockquote() : editor.chain().focus();
  return chain
    .command(({ tr, state, dispatch }) => {
      const { paragraph, heading: headingType } = state.schema.nodes;
      const blocks = selectedBlocks(state);
      if (!blocks.length) return false;
      if (dispatch) {
        for (const { node, pos } of blocks) {
          const kept: Record<string, unknown> = { ...node.attrs, ...RESET };
          if (heading) tr.setNodeMarkup(pos, headingType, { ...kept, level: Number(heading[1]) });
          else tr.setNodeMarkup(pos, paragraph, { ...kept, element: id === NORMAL_STYLE ? null : id });
        }
      }
      return true;
    })
    .run();
}

/** Marks every piece of the block's text carries, by type name. */
function sharedMarks(block: PmNode): Map<string, Mark> {
  const acc: { shared: Map<string, Mark> | null } = { shared: null };
  block.forEach((child) => {
    if (!child.isText) return;
    const own = new Map(child.marks.map((m) => [m.type.name, m] as const));
    if (!acc.shared) {
      acc.shared = own;
      return;
    }
    for (const [name, mark] of [...acc.shared]) {
      const other = own.get(name);
      if (!other || !other.eq(mark)) acc.shared.delete(name);
    }
  });
  return acc.shared ?? new Map();
}

/**
 * What the paragraph under the selection looks like beyond its style: its
 * own paragraph formatting, and the formatting all of its text shares.
 */
export function capturedProps(editor: Editor): StyleProps {
  const block = selectedBlocks(editor.state)[0]?.node;
  const out: StyleProps = {};
  if (!block) return out;
  const a = block.attrs;
  if (isFontId(a.font)) out.font = a.font;
  const size = sizeAttr(a.size);
  if (size !== null) out.size = size;
  if (a.align === "center" || a.align === "right" || a.align === "justify") out.align = a.align as StyleAlign;
  const line = numberAttr(a.line, 0.5, 5);
  if (line !== null) out.line = line;
  const before = numberAttr(a.sa, 0, 200);
  if (before !== null) out.before = before;
  const after = numberAttr(a.sb, 0, 200);
  if (after !== null) out.after = after;
  const indL = indentAttr(a.indL);
  if (indL !== null) out.indL = indL;
  const indR = indentAttr(a.indR);
  if (indR !== null) out.indR = indR;
  const indF = firstIndentAttr(a.indF);
  if (indF !== null) out.indF = indF;
  if (a.keepNext === true) out.keepNext = true;

  const marks = sharedMarks(block);
  if (marks.has("bold")) out.bold = true;
  if (marks.has("italic")) out.italic = true;
  if (marks.has("underline")) out.underline = true;
  const color = colorAttr(marks.get("textColor")?.attrs.c);
  if (color) out.color = color;
  const font = marks.get("fontFamily")?.attrs.f;
  if (isFontId(font)) out.font = font;
  const pt = sizeAttr(marks.get("fontSize")?.attrs.pt);
  if (pt !== null) out.size = pt;
  return out;
}

/**
 * Take the hand-set formatting off the selection's first paragraph — what
 * `capturedProps` read — once a style has absorbed it. With `element`, the
 * paragraph is given that style too (a new style made from it).
 */
export function clearCaptured(editor: Editor, element?: string): boolean {
  const block = selectedBlocks(editor.state)[0];
  if (!block) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      if (!dispatch) return true;
      const { node, pos } = block;
      const from = pos + 1;
      const to = pos + node.nodeSize - 1;
      const shared = sharedMarks(node);
      for (const name of STYLE_MARKS) {
        const type = state.schema.marks[name];
        if (type && shared.has(name)) tr.removeMark(from, to, type);
      }
      const attrs: Record<string, unknown> = { ...node.attrs, ...RESET };
      // A style of the document's own is a paragraph's (a heading that
      // takes one stops being a heading).
      if (element) tr.setNodeMarkup(pos, state.schema.nodes.paragraph, { ...attrs, element });
      else tr.setNodeMarkup(pos, undefined, attrs);
      return true;
    })
    .run();
}

/** The style in force where the selection starts. */
export function curStyle(editor: Editor, styles: ResolvedStyles): string {
  return currentStyleId(editor.state, styles);
}
