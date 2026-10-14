import type { Editor } from "@tiptap/core";
import type { Mark, Node as PmNode } from "@tiptap/pm/model";

import { fontLabel } from "../../fonts/css";
import { curTypography } from "../TextFormat";
import type { FormatContext } from "./effective";
import { curParaFormat } from "./ParaFormat";
import { wordRangeAt } from "./wordAt";

/**
 * "Formatting here": what the text at the caret looks the way it does
 * because of, in three layers and in words. Its style. What its paragraph
 * was given on top of the style. What the words themselves were given.
 * Each of the last two can be cleared without touching the other, which is
 * how a paragraph that looks wrong is put right without losing its italics.
 */

export interface FormattingHere {
  /** The paragraph's style by name. */
  style: string;
  /** What the paragraph has of its own. */
  paragraph: string[];
  /** What the words have of their own. */
  text: string[];
}

const pt = (n: number) => `${Math.round(n * 100) / 100} pt`;
const inch = (points: number) => `${Math.round((points / 72) * 100) / 100} in`;
const ALIGN: Record<string, string> = { center: "Centred", right: "Aligned right", justify: "Justified", left: "Aligned left" };

/** The paragraph or heading the caret is in. */
function blockAt(editor: Editor): PmNode | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    const node = $from.node(d);
    if (node.type.name === "paragraph" || node.type.name === "heading") return node;
  }
  return null;
}

/** The marks on the selected words: on any of them, or at the caret. */
function marksHere(editor: Editor): Mark[] {
  const { state } = editor;
  const { from, to, empty, $from } = state.selection;
  if (empty) return [...(state.storedMarks ?? $from.marks())];
  const seen = new Map<string, Mark>();
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) for (const mark of node.marks) if (!seen.has(mark.type.name)) seen.set(mark.type.name, mark);
  });
  return [...seen.values()];
}

/** The marks that are how words look (not a link, not a tracked change). */
const LOOK_MARKS = ["bold", "italic", "underline", "strike", "code", "fontFamily", "fontSize", "textColor", "highlight", "vscript"];

export function describeHere(editor: Editor, ctx: FormatContext): FormattingHere {
  const block = blockAt(editor);
  let style = "Normal";
  if (block?.type.name === "heading") style = `Heading ${Number(block.attrs.level) || 1}`;
  else if (typeof block?.attrs.element === "string") style = ctx.styles.list.find((s) => s.id === block.attrs.element)?.name ?? "Normal";

  const paragraph: string[] = [];
  const typo = curTypography(editor);
  const para = curParaFormat(editor);
  if (typo.align) paragraph.push(ALIGN[typo.align] ?? "Aligned");
  if (typo.font) paragraph.push(`Font ${fontLabel(typo.font)}`);
  if (typo.size) paragraph.push(`Size ${pt(Number(typo.size))}`);
  if (typo.line) paragraph.push(`Line spacing ${typo.line}`);
  if (para.lineRule && para.lineAt) paragraph.push(`Lines ${para.lineRule === "exact" ? "exactly" : "at least"} ${pt(para.lineAt)}`);
  if (typo.sb !== null && typo.sb !== undefined) paragraph.push(`Space before ${pt(Number(typo.sb))}`);
  if (typo.sa !== null && typo.sa !== undefined) paragraph.push(`Space after ${pt(Number(typo.sa))}`);
  if (para.indL) paragraph.push(`Left indent ${inch(para.indL)}`);
  if (para.indR) paragraph.push(`Right indent ${inch(para.indR)}`);
  if (para.indF) paragraph.push(para.indF < 0 ? `Hanging indent ${inch(-para.indF)}` : `First line indent ${inch(para.indF)}`);
  if (para.keepNext) paragraph.push("Kept with the next paragraph");
  if (para.keepLines) paragraph.push("Lines kept together");
  if (para.shade) paragraph.push("Shaded");
  if (para.bdr) paragraph.push("Border");
  if (typo.dropCap) paragraph.push("Drop cap");

  const text: string[] = [];
  for (const mark of marksHere(editor)) {
    const name = mark.type.name;
    if (name === "bold") text.push("Bold");
    else if (name === "italic") text.push("Italic");
    else if (name === "underline") text.push("Underlined");
    else if (name === "strike") text.push("Struck through");
    else if (name === "code") text.push("Code");
    else if (name === "fontFamily" && typeof mark.attrs.f === "string") text.push(`Font ${fontLabel(mark.attrs.f)}`);
    else if (name === "fontSize" && mark.attrs.pt) text.push(`Size ${pt(Number(mark.attrs.pt))}`);
    else if (name === "textColor") text.push("Coloured");
    else if (name === "highlight") text.push("Highlighted");
    else if (name === "vscript") text.push(mark.attrs.v === "sub" ? "Subscript" : "Superscript");
  }
  return { style, paragraph, text };
}

/** What a paragraph is given back to when its own formatting is cleared:
 *  everything that is how it looks. Its style, its level, where it falls on
 *  the page and what is tracked on it stay. */
const PARAGRAPH_OWN = ["align", "font", "size", "line", "sa", "sb", "dropCap", "indL", "indR", "indF", "lineRule", "lineAt", "keepNext", "keepLines", "shade", "bdr"];

/** Take off what the selected paragraphs have of their own. Their style and their words' formatting stay. */
export function clearParagraphOwn(editor: Editor): boolean {
  const { state } = editor;
  if (!editor.isEditable) return false;
  const tr = state.tr;
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
      const attrs: Record<string, unknown> = { ...node.attrs };
      let changed = false;
      for (const key of PARAGRAPH_OWN) {
        if (key in attrs && attrs[key] !== null && attrs[key] !== undefined) {
          attrs[key] = null;
          changed = true;
        }
      }
      if (changed) tr.setNodeMarkup(pos, undefined, attrs);
    });
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

/** Take off what the selected words have of their own (the word at the
 *  caret when nothing is selected). Links and tracked changes are not
 *  formatting and stay. */
export function clearTextOwn(editor: Editor): boolean {
  const { state } = editor;
  if (!editor.isEditable) return false;
  const { empty, $from } = state.selection;
  const word = empty ? wordRangeAt($from) : null;
  const ranges = empty ? (word ? [word] : []) : state.selection.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos }));
  const tr = state.tr;
  for (const { from, to } of ranges) {
    for (const name of LOOK_MARKS) {
      const type = state.schema.marks[name];
      if (type) tr.removeMark(from, to, type);
    }
  }
  if (empty) tr.setStoredMarks([]);
  if (!tr.docChanged && !empty) return false;
  editor.view.dispatch(tr);
  return true;
}
