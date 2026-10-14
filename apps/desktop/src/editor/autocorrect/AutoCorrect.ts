import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

import { reviewMode } from "../review/Suggesting";
import { smartPunctuationEnabled } from "../SmartPunctuation";
import { fixFor, type Fix } from "./engine";
import { listsFor, useAutoCorrect } from "./store";

/**
 * AutoCorrect in the editor: when a word is finished (a space or Enter
 * after it), a slip from the list is set right, a sentence gets its
 * capital, TWo capitals and a wORD typed with the caps lock on are mended,
 * and (c), 1/2 and 1st become their signs. What it does is decided in
 * ./engine.ts. This file is where and when.
 *
 * Each correction is a step of its own for Undo: one Undo (or Backspace
 * straight after) takes back the correction and leaves what was typed.
 *
 * It keeps out of the way of everything else. It does nothing in code, to
 * a reader, while an input method is composing, to text someone suggested
 * be deleted, or (while suggesting) to anything but the writer's own
 * suggested words: mending a word that is already in the text would be a
 * suggestion nobody made.
 */

export interface AutoCorrectOptions {
  /** The language the text is written in. */
  lang: () => string | undefined;
  /** May a sentence's capital be set in this paragraph? (Not in a script's
   *  lines of capitals, not in verse.) */
  capitals: (block: PmNode) => boolean;
  /** Can an ordinal's letters be raised in this document? */
  raise: () => boolean;
}

/** The correction just made, while Backspace can still take it back. */
interface Last {
  /** Where the corrected text stands. */
  from: number;
  to: number;
  /** What had been typed there. */
  typed: string;
  /** The caret a Backspace must be at. */
  caret: number;
}

const key = new PluginKey<Last | null>("wf-autocorrect");
const OTHER = String.fromCharCode(0xfffc);

/** The paragraph's own text before a place (a note in it is one unit, not
 *  its words), or null where there is no correcting. */
function textBefore(state: EditorState, pos: number): { text: string; start: number; block: PmNode } | null {
  const $pos = state.doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  let text = "";
  let left = $pos.parentOffset;
  block.forEach((child) => {
    if (left <= 0) return;
    const part = child.isText ? (child.text ?? "") : OTHER.repeat(child.nodeSize);
    text += part.slice(0, left);
    left -= part.length;
  });
  return { text, start: $pos.start(), block };
}

/** May this stretch of the text be corrected? */
function mendable(view: EditorView, from: number, to: number, suggesting: boolean): boolean {
  let ok = true;
  view.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const names = node.marks.map((m) => m.type.name);
    if (names.includes("code") || names.includes("deletion")) ok = false;
    if (suggesting && !names.includes("insertion")) ok = false;
  });
  return ok;
}

/** The apostrophe the writer's own typing gets. */
const apostrophes = (text: string): string => (smartPunctuationEnabled() ? text : text.split("’").join("'"));

/** Each correction is its own step for Undo. */
function ownStep(view: EditorView, tr: Transaction): void {
  const manager = (yUndoPluginKey.getState(view.state) as { undoManager?: { stopCapturing(): void } } | undefined)?.undoManager;
  manager?.stopCapturing();
  view.dispatch(closeHistory(tr));
  manager?.stopCapturing();
}

const defaults = (): AutoCorrectOptions => ({ lang: () => undefined, capitals: () => true, raise: () => false });

/** The correction for `typed` after the place `pos`, made (as its own step). */
function mend(view: EditorView, editor: Editor, options: AutoCorrectOptions, pos: number, typed: string, afterTyped: boolean): boolean {
  const choices = useAutoCorrect.getState();
  if (choices.off || !view.editable || view.composing) return false;
  const here = textBefore(view.state, pos);
  if (!here) return false;
  const fix: Fix | null = fixFor(here.text, typed, {
    kinds: choices.kinds,
    lists: listsFor(options.lang()),
    capitalsHere: options.capitals(here.block),
    raiseHere: options.raise() && !!view.state.schema.marks.vscript,
  });
  if (!fix) return false;
  const from = here.start + fix.from;
  const to = here.start + fix.to;
  const end = afterTyped ? pos + typed.length : pos;
  if (to > end) return false;
  if (!mendable(view, from, to, reviewMode(editor) === "suggest")) return false;
  const was = view.state.doc.textBetween(from, to);
  const text = apostrophes(fix.text);
  const tr = view.state.tr;
  if (text !== was) tr.insertText(text, from, to);
  if (fix.raise) {
    const mark = view.state.schema.marks.vscript;
    if (mark) tr.addMark(from + fix.raise[0], from + fix.raise[1], mark.create({ v: "super" }));
  }
  if (!tr.docChanged) return false;
  const caret = tr.mapping.map(end);
  // (What is typed next is not raised with the ordinal.)
  if (fix.raise) tr.setStoredMarks([]);
  tr.setMeta(key, { from, to: from + text.length, typed: was, caret } satisfies Last);
  ownStep(view, tr);
  return true;
}

/** Is there a correction to make for this key here? (Nothing is changed.) */
function wanted(view: EditorView, options: AutoCorrectOptions, pos: number, typed: string): boolean {
  const choices = useAutoCorrect.getState();
  if (choices.off || !view.editable || view.composing) return false;
  const here = textBefore(view.state, pos);
  if (!here) return false;
  return !!fixFor(here.text, typed, { kinds: choices.kinds, lists: listsFor(options.lang()), capitalsHere: options.capitals(here.block), raiseHere: options.raise() && !!view.state.schema.marks.vscript });
}

/** What is typed. After the input rules of everything else (smart quotes,
 *  lists): they see the key first. */
const Typing = Extension.create<AutoCorrectOptions>({
  name: "autoCorrect",
  priority: 10,
  addOptions: defaults,

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin<Last | null>({
        key,
        state: {
          init: () => null,
          apply(tr, value) {
            const set = tr.getMeta(key) as Last | null | undefined;
            if (set !== undefined) return set;
            // Anything else the writer does puts it out of Backspace's reach.
            return tr.docChanged || tr.selectionSet ? null : value;
          },
        },
        props: {
          handleTextInput(view, from, to, text, deflt) {
            if (from !== to || text.length !== 1) return false;
            // Only when there is a correction to make is the key taken
            // here: otherwise it goes on as it always did.
            if (!wanted(view, options, from, text)) return false;
            // The key first, as typed. Then the correction, a step of its own.
            view.dispatch(deflt());
            mend(view, editor, options, from, text, true);
            return true;
          },
        },
      }),
    ];
  },
});

/** Enter and Backspace. Ahead of the editor's own keys for them, which
 *  would otherwise have the key and say no more. */
const Keys = Extension.create<AutoCorrectOptions>({
  name: "autoCorrectKeys",
  priority: 1000,
  addOptions: defaults,

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("wf-autocorrect-keys"),
        props: {
          handleKeyDown(view, event) {
            if (event.metaKey || event.ctrlKey || event.altKey) return false;
            if (event.key === "Enter" && !event.shiftKey) {
              // Enter finishes the word before the caret too. (The key
              // then goes on to do what it does.)
              const { empty, from } = view.state.selection;
              if (empty) mend(view, editor, options, from, "\n", false);
              return false;
            }
            if (event.key === "Backspace") {
              const last = key.getState(view.state);
              const { empty, from } = view.state.selection;
              if (!last || !empty || from !== last.caret) return false;
              // Straight after a correction: put back what was typed.
              const tr = view.state.tr.insertText(last.typed, last.from, last.to);
              const mark = view.state.schema.marks.vscript;
              if (mark) tr.removeMark(last.from, last.from + last.typed.length, mark);
              tr.setMeta(key, null);
              ownStep(view, tr);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/** Both parts, set up alike. */
export function autoCorrect(options: Partial<AutoCorrectOptions> = {}): Extension[] {
  const all = { ...defaults(), ...options };
  return [Typing.configure(all), Keys.configure(all)];
}
