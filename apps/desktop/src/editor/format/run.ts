/**
 * Formatting the selected text: typeface, size, colour, highlight, sub- and
 * superscript. Each command is one transaction (one undo step).
 *
 * With nothing selected, a command sets what will be typed next. A
 * paragraph that lies wholly inside the selection also takes the typeface
 * or size as its own (the paragraph attributes every version has), so an
 * empty line in it — and whatever is typed into it later — matches.
 *
 * Where the document is held to schema level 1 (its server hasn't been
 * updated), typeface and size fall back to whole paragraphs and the rest
 * does nothing; the ribbon hides those buttons.
 */

import { Extension, type Editor } from "@tiptap/core";
import type { MarkType, Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

import { isFontId } from "../../fonts/ids";
import { colorAttr, sizeAttr, type VScript } from "../schema/sanitize";
import { setDocFont, setDocFontSize, SIZE_LADDER } from "../TextFormat";
import { blockBaseSize, effectiveRun, type FormatContext } from "./effective";

/** The next size up or down Word's ladder from `size`. */
export function stepSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return SIZE_LADDER.find((s) => s > size) ?? Math.min(200, size + 10);
  const below = [...SIZE_LADDER].reverse().find((s) => s < size);
  return below ?? Math.max(4, size - 1);
}

/** Paragraphs and headings lying wholly inside the selection. */
function coveredBlocks(state: EditorState): { node: PmNode; pos: number }[] {
  const out: { node: PmNode; pos: number }[] = [];
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    // An empty paragraph under the caret is all of itself.
    const block = $from.parent;
    if ((block.type.name === "paragraph" || block.type.name === "heading") && block.content.size === 0) {
      out.push({ node: block, pos: $from.before() });
    }
    return out;
  }
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
    if (pos + 1 >= from && pos + node.nodeSize - 1 <= to) out.push({ node, pos });
    return false;
  });
  return out;
}

/** Put a mark on the selection (null: take it off), or on what's typed next. */
function markSelection(tr: Transaction, state: EditorState, type: MarkType, attrs: Record<string, unknown> | null): void {
  const { empty, ranges } = state.selection;
  if (empty) {
    if (attrs) tr.addStoredMark(type.create(attrs));
    else tr.removeStoredMark(type);
    return;
  }
  for (const range of ranges) {
    if (attrs) tr.addMark(range.$from.pos, range.$to.pos, type.create(attrs));
    else tr.removeMark(range.$from.pos, range.$to.pos, type);
  }
}

function runCommand(
  editor: Editor,
  mark: string,
  attrs: Record<string, unknown> | null,
  /** The paragraph attribute that mirrors it, for wholly selected paragraphs. */
  block?: { key: string; value: unknown },
): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const type = state.schema.marks[mark];
      if (!type) return false;
      if (!dispatch) return true;
      // Node changes first: any step clears what's set for the next typing.
      if (block) {
        for (const { node, pos } of coveredBlocks(state)) {
          if (block.key in node.attrs && node.attrs[block.key] !== block.value) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, [block.key]: block.value });
          }
        }
      }
      markSelection(tr, state, type, attrs);
      return true;
    })
    .run();
}

/** Set the selection in a typeface (null: back to the paragraph's own). */
export function setRunFont(editor: Editor, id: string | null, level: number): boolean {
  const font = id && isFontId(id) ? id : null;
  if (level < 2) return setDocFont(editor, font);
  return runCommand(editor, "fontFamily", font ? { f: font } : null, { key: "font", value: font });
}

/** Set the selection's size in points (null: back to the paragraph's own). */
export function setRunSize(editor: Editor, pt: number | null, level: number): boolean {
  const size = sizeAttr(pt);
  if (level < 2) return setDocFontSize(editor, size);
  return runCommand(editor, "fontSize", size === null ? null : { pt: size }, { key: "size", value: size });
}

export function setRunColor(editor: Editor, color: string | null): boolean {
  const c = color ? colorAttr(color) : null;
  return runCommand(editor, "textColor", c ? { c } : null);
}

export function setHighlight(editor: Editor, color: string | null): boolean {
  const c = color ? colorAttr(color) : null;
  return runCommand(editor, "highlight", c ? { c } : null);
}

/** Superscript or subscript on; the same one again, off. */
export function toggleScript(editor: Editor, v: VScript): boolean {
  const on = editor.isActive("vscript", { v });
  return runCommand(editor, "vscript", on ? null : { v });
}

/**
 * One size larger or smaller. Every piece of the selection steps from its
 * own size, so a heading and its text keep their difference.
 */
export function stepRunSize(editor: Editor, dir: 1 | -1, ctx: FormatContext): boolean {
  const { state } = editor;
  if (ctx.level < 2) {
    const { $from } = state.selection;
    return setDocFontSize(editor, stepSize(blockBaseSize($from.parent, $from, ctx.styles), dir));
  }
  if (state.selection.empty) return setRunSize(editor, stepSize(effectiveRun(state, ctx).size, dir), ctx.level);
  return editor
    .chain()
    .focus()
    .command(({ tr, state: s, dispatch }) => {
      const type = s.schema.marks.fontSize;
      if (!type) return false;
      if (!dispatch) return true;
      const { from, to } = s.selection;
      const covered = new Set(coveredBlocks(s).map((b) => b.pos));
      const marks: { from: number; to: number; pt: number }[] = [];
      const blocks: { pos: number; node: PmNode; pt: number }[] = [];
      let base = 0;
      s.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
          base = blockBaseSize(node, s.doc.resolve(pos + 1), ctx.styles);
          if (covered.has(pos)) blocks.push({ pos, node, pt: stepSize(base, dir) });
          return true;
        }
        if (!node.isText) return true;
        const start = Math.max(from, pos);
        const end = Math.min(to, pos + node.nodeSize);
        if (end <= start) return false;
        const own = sizeAttr(node.marks.find((m) => m.type === type)?.attrs.pt);
        marks.push({ from: start, to: end, pt: stepSize(own ?? base, dir) });
        return false;
      });
      for (const b of blocks) tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, size: b.pt });
      for (const m of marks) tr.addMark(m.from, m.to, type.create({ pt: m.pt }));
      return true;
    })
    .run();
}

export interface RunShortcutOptions {
  /** Bind Word's keys for sub/superscript and one size up or down. */
  shortcuts: boolean;
  /** The document's styles and level, when the keys are pressed. */
  context: () => FormatContext | null;
}

/** ⌘= subscript, ⌘⇧= superscript, ⌘⇧. larger, ⌘⇧, smaller — as in Word. */
export const RunShortcuts = Extension.create<RunShortcutOptions>({
  name: "runShortcuts",
  addOptions() {
    return { shortcuts: false, context: () => null };
  },
  addKeyboardShortcuts() {
    const map: Record<string, () => boolean> = {};
    if (!this.options.shortcuts) return map;
    const script = (v: VScript) => () => {
      const ctx = this.options.context();
      return !!ctx && ctx.level >= 2 && toggleScript(this.editor, v);
    };
    const step = (dir: 1 | -1) => () => {
      const ctx = this.options.context();
      return !!ctx && stepRunSize(this.editor, dir, ctx);
    };
    map["Mod-="] = script("sub");
    map["Mod-Shift-="] = script("super");
    map["Mod-Shift-."] = step(1);
    map["Mod-Shift-,"] = step(-1);
    return map;
  },
});
