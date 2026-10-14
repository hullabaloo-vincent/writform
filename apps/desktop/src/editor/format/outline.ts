import type { Editor } from "@tiptap/core";

import { blockOffsets } from "../../book/model/structure";

/**
 * A heading and everything under it moved a level up or down the outline:
 * Heading 2 becomes Heading 1 or Heading 3, and each heading beneath it
 * moves by the same step, so the shape of the section is kept. One step,
 * one undo. Not done at all where any of them would leave Heading 1 to 6.
 */

/** The headings in the blocks `from` to `to` (top-level block numbers, the last not included). */
function headingsIn(editor: Editor, from: number, to: number): { pos: number; level: number }[] {
  const { doc } = editor.state;
  const offsets = blockOffsets(doc);
  const out: { pos: number; level: number }[] = [];
  for (let i = from; i < to && i < doc.childCount; i += 1) {
    const node = doc.child(i);
    if (node.type.name === "heading") out.push({ pos: offsets[i], level: Number(node.attrs.level) || 1 });
  }
  return out;
}

/** Can that section go a level up (-1) or down (1)? */
export function canShiftHeadings(editor: Editor, from: number, to: number, dir: -1 | 1): boolean {
  const all = headingsIn(editor, from, to);
  return editor.isEditable && all.length > 0 && all.every((h) => h.level + dir >= 1 && h.level + dir <= 6);
}

export function shiftHeadings(editor: Editor, from: number, to: number, dir: -1 | 1): boolean {
  if (!canShiftHeadings(editor, from, to, dir)) return false;
  const tr = editor.state.tr;
  for (const { pos, level } of headingsIn(editor, from, to)) {
    const node = tr.doc.nodeAt(pos);
    if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: level + dir });
  }
  editor.view.dispatch(tr);
  return true;
}
