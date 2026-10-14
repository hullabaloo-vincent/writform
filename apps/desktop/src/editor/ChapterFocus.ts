import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { presetDesign, type BookDesign } from "../book/model/presets";
import { blockOffsets, scanStructure, type StructureEntry } from "../book/model/structure";

/**
 * One chapter on its own: the same document, showing only the text from a
 * heading in the outline to the next heading at its level or above. The
 * rest is hidden (never taken out), so co-writers, history and exports see
 * the whole text as ever. A choice of this view only.
 *
 * While a chapter is shown the caret keeps inside it, Select All takes the
 * chapter, and Backspace at its start or Delete at its end do nothing (they
 * would join it to text that can't be seen). A jump from outside the text
 * to somewhere else moves to the chapter that holds it (editor/ui/reveal.ts).
 */

export interface ChapterFocusState {
  /** Where the chapter's heading block begins. */
  from: number;
  /** Where the next heading at its level (or the document) begins. */
  to: number;
  /** Where its last block begins. */
  last: number;
  /** Its heading's top-level block index. */
  index: number;
  /** "Chapter Three · The Manipulator". */
  label: string;
}

interface PluginState {
  focus: ChapterFocusState | null;
  hidden: DecorationSet;
}

type Meta = { at: number | null } | { follow: number };

export const chapterFocusKey = new PluginKey<PluginState>("chapterFocus");

interface Options {
  format: () => string;
  design: () => BookDesign | undefined;
  /** Told when a chapter's heading went and the whole text is shown again. */
  onLost: () => void;
}

/** The chapter shown, or null when the whole text is. */
export function chapterFocus(state: EditorState): ChapterFocusState | null {
  return chapterFocusKey.getState(state)?.focus ?? null;
}

/** What an outline entry is called in the bar over the page. */
export function entryName(entry: StructureEntry): string {
  const name = entry.title || (entry.literal === null ? entry.text : "") || "Untitled";
  if (entry.label && (entry.kind === "chapter" || entry.kind === "part")) return entry.literal !== null && !entry.title ? entry.label : `${entry.label} · ${name}`;
  return name;
}

function entries(doc: PmNode, opts: Options): StructureEntry[] {
  return scanStructure(doc, opts.format(), opts.design() ?? presetDesign("classic")).entries;
}

function stretchOf(entry: StructureEntry, offsets: number[]): ChapterFocusState {
  return { from: offsets[entry.index], to: offsets[entry.endIndex], last: offsets[Math.max(entry.index, entry.endIndex - 1)], index: entry.index, label: entryName(entry) };
}

/** The entry that starts at `from`, as the document is now. */
function entryAt(doc: PmNode, from: number, opts: Options): ChapterFocusState | null {
  const offsets = blockOffsets(doc);
  const entry = entries(doc, opts).find((e) => offsets[e.index] === from);
  return entry ? stretchOf(entry, offsets) : null;
}

/**
 * The chapter that holds `pos`: the outermost entry around it, but in a
 * manuscript the chapter (or section) inside a part rather than the part.
 */
function entryHolding(doc: PmNode, pos: number, opts: Options): ChapterFocusState | null {
  const offsets = blockOffsets(doc);
  const around = entries(doc, opts).filter((e) => offsets[e.index] <= pos && pos < offsets[e.endIndex]);
  if (!around.length) return null;
  const inner = opts.format() === "manuscript" ? around.filter((e) => e.kind !== "part") : [];
  const pick = (inner.length ? inner : around).reduce((a, b) => (b.level < a.level ? b : a));
  return stretchOf(pick, offsets);
}

function hiddenFor(doc: PmNode, focus: ChapterFocusState | null): DecorationSet {
  if (!focus) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    if (offset < focus.from || offset >= focus.to) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: "wf-unfocused" }));
  });
  return DecorationSet.create(doc, decos);
}

/** Whether a transaction changed anything outside the chapter shown. */
function touchedOutside(tr: Transaction, focus: ChapterFocusState): boolean {
  let outside = false;
  tr.mapping.maps.forEach((map) => {
    map.forEach((oldStart, oldEnd) => {
      if (oldStart < focus.from || oldEnd > focus.to) outside = true;
    });
  });
  return outside;
}

/** The first and last places text can go in the chapter shown. */
function ends(doc: PmNode, focus: ChapterFocusState): { start: number; end: number } {
  const start = Selection.findFrom(doc.resolve(focus.from), 1, true)?.from ?? focus.from;
  const end = Selection.findFrom(doc.resolve(focus.to), -1, true)?.to ?? focus.to;
  return { start, end: Math.max(start, end) };
}

/** A selection inside the chapter shown, as near as can be to `sel`. */
function heldInside(doc: PmNode, sel: Selection, focus: ChapterFocusState): Selection | null {
  const { start, end } = ends(doc, focus);
  if (sel instanceof AllSelection) return TextSelection.create(doc, start, end);
  if (sel.from >= focus.from && sel.to <= focus.to) return null;
  const a = Math.min(Math.max(sel.from, start), end);
  const b = Math.min(Math.max(sel.to, start), end);
  return TextSelection.create(doc, a, Math.max(a, b));
}

export const ChapterFocus = Extension.create<Options>({
  name: "chapterFocus",
  priority: 1000,

  addOptions() {
    return { format: () => "none", design: () => undefined, onLost: () => {} };
  },

  addKeyboardShortcuts() {
    const shown = () => chapterFocus(this.editor.state);
    return {
      "Mod-a": () => {
        const focus = shown();
        if (!focus) return false;
        const { start, end } = ends(this.editor.state.doc, focus);
        this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, start, end)));
        return true;
      },
      Backspace: () => {
        const focus = shown();
        const sel = this.editor.state.selection;
        return !!focus && sel.empty && sel.from === ends(this.editor.state.doc, focus).start;
      },
      Delete: () => {
        const focus = shown();
        const sel = this.editor.state.selection;
        return !!focus && sel.empty && sel.from === ends(this.editor.state.doc, focus).end;
      },
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin<PluginState>({
        key: chapterFocusKey,
        state: {
          init: () => ({ focus: null, hidden: DecorationSet.empty }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(chapterFocusKey) as Meta | undefined;
            if (meta && "at" in meta) {
              const focus = meta.at === null ? null : entryAt(state.doc, meta.at, opts);
              return { focus, hidden: hiddenFor(state.doc, focus) };
            }
            if (meta && "follow" in meta) {
              const focus = entryHolding(state.doc, meta.follow, opts);
              return { focus, hidden: hiddenFor(state.doc, focus) };
            }
            if (!prev.focus || !tr.docChanged) return prev;
            // The heading is followed through the change and the chapter
            // looked for again (it may have grown, shrunk or gone).
            const from = tr.mapping.map(prev.focus.from, 1);
            const focus = entryAt(state.doc, from, opts);
            if (!focus) {
              queueMicrotask(() => opts.onLost());
              return { focus: null, hidden: DecorationSet.empty };
            }
            const same = focus.from === from && !touchedOutside(tr, prev.focus);
            return { focus, hidden: same ? prev.hidden.map(tr.mapping, state.doc) : hiddenFor(state.doc, focus) };
          },
        },
        props: {
          decorations: (state) => chapterFocusKey.getState(state)?.hidden ?? null,
        },
        // The caret keeps to the chapter shown, however it was moved.
        appendTransaction(_trs, _old, state) {
          const focus = chapterFocus(state);
          if (!focus) return null;
          const held = heldInside(state.doc, state.selection, focus);
          return held ? state.tr.setSelection(held) : null;
        },
      }),
    ];
  },
});

const optionsOf = (editor: Editor) => editor.extensionManager.extensions.find((e) => e.name === "chapterFocus")?.options as Options | undefined;

/** The chapter that holds `pos` (the caret's, unless told), shown or not:
 *  null where no heading holds it, or in an editor without this view. */
export function chapterAt(editor: Editor, pos = editor.state.selection.from): ChapterFocusState | null {
  const opts = optionsOf(editor);
  return opts ? entryHolding(editor.state.doc, pos, opts) : null;
}

/** Show only the chapter that holds `pos` (the caret's, unless told). False
 *  when no heading holds it. */
export function focusChapterAt(editor: Editor, pos = editor.state.selection.from): boolean {
  const focus = chapterAt(editor, pos);
  return focus ? focusEntry(editor, focus.from) : false;
}

/** Show only the outline entry whose heading block begins at `from`. */
export function focusEntry(editor: Editor, from: number): boolean {
  if (!chapterFocusKey.getState(editor.state)) return false;
  const before = editor.state.selection;
  editor.view.dispatch(editor.state.tr.setMeta(chapterFocusKey, { at: from } satisfies Meta));
  const focus = chapterFocus(editor.state);
  if (!focus) return false;
  // A caret that was elsewhere goes to the chapter's start.
  if (before.from < focus.from || before.to > focus.to) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, ends(editor.state.doc, focus).start)));
  return true;
}

/** Show the whole text again. */
export function showEverything(editor: Editor): boolean {
  if (!chapterFocus(editor.state)) return false;
  editor.view.dispatch(editor.state.tr.setMeta(chapterFocusKey, { at: null } satisfies Meta));
  return true;
}

/** The chapter before or after the one shown, at the same level or above. */
export function stepChapter(editor: Editor, dir: 1 | -1): boolean {
  const focus = chapterFocus(editor.state);
  const opts = optionsOf(editor);
  if (!focus || !opts) return false;
  const doc = editor.state.doc;
  const offsets = blockOffsets(doc);
  const all = entries(doc, opts);
  const here = all.findIndex((e) => e.index === focus.index);
  if (here < 0) return false;
  const level = all[here].level;
  for (let i = here + dir; i >= 0 && i < all.length; i += dir) {
    if (all[i].level <= level) return focusEntry(editor, offsets[all[i].index]);
  }
  return false;
}

/** Whether a chapter before or after the one shown can be stepped to. */
export function canStepChapter(editor: Editor, dir: 1 | -1): boolean {
  const focus = chapterFocus(editor.state);
  const opts = optionsOf(editor);
  if (!focus || !opts) return false;
  const all = entries(editor.state.doc, opts);
  const here = all.findIndex((e) => e.index === focus.index);
  if (here < 0) return false;
  for (let i = here + dir; i >= 0 && i < all.length; i += dir) if (all[i].level <= all[here].level) return true;
  return false;
}

/**
 * For a jump from outside the text (editor/ui/reveal.ts): when `pos` is
 * outside the chapter shown, the same transaction moves to the chapter
 * that holds it (or shows everything when none does).
 */
export function followTo(tr: Transaction, state: EditorState, pos: number): Transaction {
  const focus = chapterFocus(state);
  if (!focus || (pos >= focus.from && pos < focus.to)) return tr;
  return tr.setMeta(chapterFocusKey, { follow: pos } satisfies Meta);
}

/** The text of the chapter shown, from its first place to its last, or
 *  null when the whole text is shown. */
export function chapterText(state: EditorState): { start: number; end: number } | null {
  const focus = chapterFocus(state);
  return focus ? ends(state.doc, focus) : null;
}

/** Whether `pos` can be seen (true when the whole text is shown). */
export function inFocus(state: EditorState, pos: number): boolean {
  const focus = chapterFocus(state);
  return !focus || (pos >= focus.from && pos <= focus.to);
}
