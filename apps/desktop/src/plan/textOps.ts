/**
 * What the plan changes in the text itself: a chapter's name, and a new
 * chapter. Each is one ordinary edit, which Undo takes back and which is a
 * suggestion while suggesting.
 */

import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PmNode } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

import type { PlanColumn } from "./resolve";

/** Typing just before stays its own undo step. */
function dispatchAlone(editor: Editor, tr: Parameters<Editor["view"]["dispatch"]>[0]): void {
  (yUndoPluginKey.getState(editor.state) as { undoManager?: { stopCapturing(): void } } | undefined)?.undoManager?.stopCapturing();
  editor.view.dispatch(closeHistory(tr));
}

/** Give a chapter a new name. A heading that is only a number ("Chapter
 *  3") with its title on the line under it has that line changed, and a
 *  number typed before the title is kept. */
export function renameHeading(editor: Editor, column: PlanColumn, name: string): boolean {
  const title = name.trim();
  if (!title || !editor.isEditable) return false;
  const { doc } = editor.state;
  const heading = doc.child(column.index);
  const entry = column.entry;
  let index = column.index;
  let text = title;
  const next = column.index + 1 < doc.childCount ? doc.child(column.index + 1) : null;
  if (entry.kind === "chapter" && entry.literal !== null && next?.attrs.element === "chapter_subtitle" && next.textContent.trim() === entry.title) {
    index = column.index + 1;
  } else if (entry.literal !== null && entry.title && entry.text.endsWith(entry.title)) {
    // "1. Just another day": the number stays.
    text = entry.text.slice(0, entry.text.length - entry.title.length) + title;
  } else if (entry.literal !== null && !entry.title) {
    // A heading that is only a number: the name goes after it.
    text = `${entry.text}. ${title}`;
  }
  const block: PmNode = index === column.index ? heading : doc.child(index);
  if (block.textContent === text) return false;
  let pos = 0;
  doc.forEach((_n, offset, i) => {
    if (i === index) pos = offset;
  });
  const from = pos + 1;
  const to = pos + 1 + block.content.size;
  const tr = editor.state.tr.insertText(text, from, to);
  dispatchAlone(editor, tr);
  return true;
}

/** What a new chapter is in each format, and the line it opens on. */
function newBlocks(editor: Editor, format: string, title: string, level: number): PmNode[] {
  const { schema } = editor.state;
  const text = title ? [schema.text(title)] : [];
  const para = (element: string | null, content: PmNode[] = []) => schema.nodes.paragraph.create({ element }, content);
  if (format === "manuscript") return [para("chapter_heading", text), para(null)];
  if (format === "screenplay") return [para("scene_heading", text), para("action")];
  if (format === "stageplay") return [para("scene_heading", text), para("stage_direction")];
  return [schema.nodes.heading.create({ level: Math.min(6, level + 1) }, text), para(null)];
}

/**
 * A new chapter (scene, section) in the text, after `after`'s whole
 * section, or at the very start of the text when `after` is null (the
 * book's first). Gives back where its heading starts.
 */
export function insertHeadingAfter(editor: Editor, format: string, after: PlanColumn | null, title: string, level = 0): number | null {
  if (!editor.isEditable) return null;
  const { doc } = editor.state;
  let at = 0;
  if (after) {
    if (after.endIndex >= doc.childCount) at = doc.content.size;
    else
      doc.forEach((_n, offset, i) => {
        if (i === after.endIndex) at = offset;
      });
  }
  const blocks = newBlocks(editor, format, title.trim(), after ? after.entry.level : level);
  dispatchAlone(editor, editor.state.tr.insert(at, blocks));
  return at;
}
