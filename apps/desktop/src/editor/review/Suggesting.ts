/**
 * Review modes, per person: Editing (changes are made), Suggesting (changes
 * are proposed — see suggest.ts) and Viewing (nothing can be changed, and
 * the text reads as it would with every suggestion accepted).
 *
 * The mode is the reader's own; nothing about it is stored in the document.
 */

import { Extension, type Editor } from "@tiptap/core";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { breakAfter, breakStart, changesAt, changesOf, groupChanges, trackKind, type Change, type ChangeGroup } from "./changes";
import { resolveChanges, type Verdict } from "./resolve";
import { suggestTransaction, tidyTransaction } from "./suggest";
import { authorAttr, parseRevs, UNTRACKED_META, withRev } from "./TrackMarks";

export type ReviewMode = "edit" | "suggest" | "view";

export interface SuggestingOptions {
  /** Who this person is, for the changes they suggest. */
  author: () => string;
}

export interface SuggestingStorage {
  mode: ReviewMode;
}

/** Mark a transaction as one that is applied as it is. */
export const untracked = (tr: Transaction): Transaction => tr.setMeta(UNTRACKED_META, true);

const nowSeconds = () => Math.floor(Date.now() / 1000);

export const Suggesting = Extension.create<SuggestingOptions, SuggestingStorage>({
  name: "suggesting",

  addOptions() {
    return { author: () => "" };
  },

  addStorage() {
    return { mode: "edit" };
  },

  dispatchTransaction({ transaction, next }) {
    // What arrives from Yjs (other people, undo) and what says it isn't to
    // be tracked go through untouched.
    // (And an undo, where history is the editor's own rather than Yjs's:
    // it puts back what was, suggestions included.)
    if (!transaction.docChanged || transaction.getMeta(ySyncPluginKey) || transaction.getMeta(UNTRACKED_META) || transaction.getMeta("history$")) {
      next(transaction);
      return;
    }
    const state = this.editor.state;
    let amended = transaction;
    try {
      amended =
        this.storage.mode === "suggest"
          ? suggestTransaction(state, transaction, { author: this.options.author(), now: nowSeconds() })
          : tidyTransaction(state, transaction);
    } catch (e) {
      console.warn("[suggesting] applied as a direct edit", e);
    }
    next(amended);
  },

  addKeyboardShortcuts() {
    return {
      // At a paragraph's edge these would join it to its neighbour; as a
      // suggestion the break is marked instead, whatever lies between.
      Backspace: () => this.storage.mode === "suggest" && suggestJoin(this.editor, this.options.author(), -1),
      Delete: () => this.storage.mode === "suggest" && suggestJoin(this.editor, this.options.author(), 1),
    };
  },
});

function suggestJoin(editor: Editor, author: string, dir: -1 | 1): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  const block = $from.parent;
  if (!empty || !block.isTextblock) return false;
  const me = authorAttr(author);
  const rev = { a: me, t: nowSeconds() };
  if (dir < 0) {
    if ($from.parentOffset !== 0 || trackKind(block) !== "break") return false;
    // An indent comes off first (see ParaFormat), and the first paragraph
    // of a list item or a quote is taken out of it: both formatting.
    if (block.attrs.indF || block.attrs.indL) return false;
    const depth = $from.depth;
    if (depth > 1 && $from.index(depth - 1) === 0 && !$from.node(depth - 1).type.spec.isolating) return false;
    const pos = $from.before();
    const revs = parseRevs(block.attrs.tc);
    // Their own new paragraph is simply joined back (the default does it).
    if (revs?.ins?.a === me) return false;
    const start = breakStart(state.doc, pos);
    if (!start.joins) return false;
    const tr = state.tr;
    if (!revs?.del) tr.setNodeAttribute(pos, "tc", withRev(block.attrs.tc, "del", rev));
    tr.setSelection(TextSelection.create(tr.doc, start.pos)).scrollIntoView();
    editor.view.dispatch(untracked(tr));
    return true;
  }
  if ($from.parentOffset !== block.content.size || trackKind(block) !== "break") return false;
  const next = breakAfter(state.doc, $from.after());
  if (next === null) return false;
  const node = state.doc.nodeAt(next);
  if (!node) return false;
  const revs = parseRevs(node.attrs.tc);
  if (revs?.ins?.a === me) return false;
  const tr = state.tr;
  if (!revs?.del) tr.setNodeAttribute(next, "tc", withRev(node.attrs.tc, "del", rev));
  // Past the break it struck, so pressing again goes on.
  tr.setSelection(TextSelection.create(tr.doc, next + 1)).scrollIntoView();
  editor.view.dispatch(untracked(tr));
  return true;
}

/** The mode this editor is in. */
export function reviewMode(editor: Editor): ReviewMode {
  return (editor.storage as unknown as { suggesting?: SuggestingStorage }).suggesting?.mode ?? "edit";
}

/** Put the editor in a mode. (Whether it can be edited at all is the
 *  caller's to say: Viewing only ever takes that away.) */
export function setReviewMode(editor: Editor, mode: ReviewMode, editable = true): void {
  const storage = (editor.storage as unknown as { suggesting?: SuggestingStorage }).suggesting;
  if (storage) storage.mode = mode;
  const want = editable && mode !== "view";
  if (editor.isEditable !== want) editor.setEditable(want);
}

/** Accept or reject changes, as one step. */
export function resolveInEditor(editor: Editor, changes: Change[], verdict: Verdict): boolean {
  if (!changes.length) return false;
  const tr = editor.state.tr;
  resolveChanges(tr, changes, verdict);
  if (!tr.docChanged) return false;
  editor.view.dispatch(untracked(tr));
  return true;
}

export function resolveAll(editor: Editor, verdict: Verdict): boolean {
  return resolveInEditor(editor, changesOf(editor.state.doc), verdict);
}

/** The changes at the selection: the ones it touches, or with only a caret
 *  the one it is in. */
export function selectedChanges(editor: Editor): Change[] {
  const { from, to } = editor.state.selection;
  return changesAt(changesOf(editor.state.doc), from, to);
}

/** Select a change (and bring it into view). */
export function showChange(editor: Editor, range: { from: number; to: number }, focus = true): void {
  const doc = editor.state.doc;
  const size = doc.content.size;
  const from = Math.max(0, Math.min(size, range.from));
  const to = Math.max(from, Math.min(size, range.to));
  let selection: Selection;
  try {
    selection = TextSelection.between(doc.resolve(from), doc.resolve(to));
  } catch {
    selection = Selection.near(doc.resolve(from));
  }
  editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
  if (focus && editor.isEditable) editor.view.focus();
}

/** Go to the next (or previous) change from the selection; round again at
 *  the ends. Returns it, or null when there are none. */
export function stepChange(editor: Editor, dir: 1 | -1): ChangeGroup | null {
  const groups = groupChanges(changesOf(editor.state.doc));
  if (!groups.length) return null;
  const { from, to } = editor.state.selection;
  const next =
    dir > 0
      ? (groups.find((g) => g.from > from || (g.from === from && g.to > to)) ?? groups[0])
      : ([...groups].reverse().find((g) => g.from < from) ?? groups[groups.length - 1]);
  showChange(editor, next);
  return next;
}
