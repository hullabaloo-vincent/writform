/**
 * The format painter: copy how some text looks, then paint it onto other
 * text. What's copied is the formatting on the words where the selection
 * starts and the formatting of that paragraph; painting a selection gives
 * it the words' formatting, and paragraphs wholly inside it (or the one the
 * caret is in) the paragraph's.
 */

import type { Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";

import { RUN_MARK_NAMES } from "../marks/RunFormat";
import { PARA_FORMAT_KEYS, PARA_FORMAT_KEYS_4 } from "./ParaFormat";

/** What the painter carries: marks (never a link — that's content), and
 *  paragraph attributes. */
export interface Paint {
  marks: Mark[];
  block: Record<string, unknown>;
  /** Whether the paragraph formatting belongs to it (false while the app is
   *  held to the older level, where only the words' basic marks apply). */
  level: number;
}

const BASIC_MARKS = ["bold", "italic", "underline", "strike"];
const BLOCK_KEYS_1 = ["align", "font", "size", "line", "sa", "sb"];

export function pickUpFormat(editor: Editor, level: number): Paint {
  const { state } = editor;
  const { $from, empty, from } = state.selection;
  // Inside a selection, the first character's marks; at a caret, what
  // typing there would get.
  const at = empty ? null : state.doc.resolve(Math.min(from + 1, state.doc.content.size));
  const source = empty ? (state.storedMarks ?? $from.marks()) : (at?.marks() ?? []);
  const names = new Set<string>([...BASIC_MARKS, ...(level >= 2 ? RUN_MARK_NAMES : [])]);
  const block: Record<string, unknown> = {};
  const parent = $from.parent;
  if (parent.type.name === "paragraph" || parent.type.name === "heading") {
    for (const key of [...BLOCK_KEYS_1, ...(level >= 2 ? PARA_FORMAT_KEYS : []), ...(level >= 4 ? PARA_FORMAT_KEYS_4 : [])]) block[key] = parent.attrs[key] ?? null;
  }
  return { marks: source.filter((m) => names.has(m.type.name)), block, level };
}

export function paintFormat(editor: Editor, paint: Paint): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      if (!dispatch) return true;
      const { from, to, empty, $from } = state.selection;
      const names = [...BASIC_MARKS, ...(paint.level >= 2 ? RUN_MARK_NAMES : [])];
      const setBlock = (pos: number) => {
        const node = tr.doc.nodeAt(pos);
        if (!node || (node.type.name !== "paragraph" && node.type.name !== "heading")) return;
        const next: Record<string, unknown> = { ...node.attrs };
        for (const [key, value] of Object.entries(paint.block)) if (key in node.attrs) next[key] = value;
        tr.setNodeMarkup(pos, undefined, next);
      };
      if (empty) {
        if ($from.depth > 0) setBlock($from.before());
        return true;
      }
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        if (pos + 1 >= from && pos + node.nodeSize - 1 <= to) setBlock(pos);
        return false;
      });
      for (const name of names) {
        const type = state.schema.marks[name];
        if (type) tr.removeMark(from, to, type);
      }
      for (const mark of paint.marks) tr.addMark(from, to, mark);
      return true;
    })
    .run();
}
