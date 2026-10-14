/**
 * How footnotes and endnotes are numbered on the screen.
 *
 * The usual numbering (1, 2, 3 for footnotes and i, ii, iii for endnotes,
 * running through the document) is the stylesheet's own counters, which
 * cost nothing. The document may ask for more (settings `fnFormat`,
 * `enFormat`, `fnRestart`): numbers in capitals or letters with counters of
 * their own, and otherwise each note's label is worked out here and put on
 * its reference as `data-n`. Footnotes that start again on each page take
 * their labels from the page map, where the engine has found which page
 * each lands on (doclayout/layout.ts), and run on until it has.
 */

import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { UNTRACKED_META } from "../review/TrackMarks";
import { noteFormat, noteKind, noteLabel, noteRestart, parseSection, type NoteFormat, type NoteKind, type NoteRestart } from "../schema/sanitize";

export interface NoteNumbering {
  fnFormat: NoteFormat;
  enFormat: NoteFormat;
  fnRestart: NoteRestart;
}

export const USUAL_NUMBERING: NoteNumbering = { fnFormat: "1", enFormat: "i", fnRestart: "doc" };

/** A document's numbering, from its settings. */
export function numberingOf(settings: { fnFormat?: unknown; enFormat?: unknown; fnRestart?: unknown } | null | undefined): NoteNumbering {
  return { fnFormat: noteFormat(settings?.fnFormat, "1"), enFormat: noteFormat(settings?.enFormat, "i"), fnRestart: noteRestart(settings?.fnRestart) };
}

/** Formats the stylesheet's counters draw as such. */
const COUNTED: Record<NoteKind, NoteFormat[]> = { foot: ["1", "i", "I"], end: ["1", "i", "I"] };

/** Whether a kind of note is labelled here (not by the counters). */
function labelled(kind: NoteKind, n: NoteNumbering): boolean {
  if (kind === "end") return !COUNTED.end.includes(n.enFormat);
  return n.fnRestart !== "doc" || !COUNTED.foot.includes(n.fnFormat);
}

/**
 * Every note's label, by where its reference is, for the numbering given.
 * `pages`: footnotes' labels from the engine, by note (every note of the
 * document in the order cited), used when they start again on each page
 * and the count matches.
 */
export function noteLabels(doc: PmNode, n: NoteNumbering, pages?: readonly (string | null)[] | null): Map<number, string> {
  const out = new Map<number, string>();
  const count: Record<NoteKind, number> = { foot: 0, end: 0 };
  let index = 0;
  const paged = n.fnRestart === "page" && pages ? pages : null;
  doc.forEach((block, offset) => {
    // A section that starts here starts its footnotes again.
    if (n.fnRestart === "section" && (block.type.name === "paragraph" || block.type.name === "heading") && parseSection(block.attrs.sect)) count.foot = 0;
    block.descendants((node, pos) => {
      if (node.type.name !== "footnote") return true;
      const kind = noteKind(node.attrs.kind);
      count[kind] += 1;
      const fromPage = kind === "foot" ? paged?.[index] : null;
      out.set(offset + 1 + pos, fromPage ?? noteLabel(count[kind], kind === "foot" ? n.fnFormat : n.enFormat));
      index += 1;
      return false;
    });
  });
  return out;
}

interface State {
  numbering: NoteNumbering;
  labels: Map<number, string> | null;
  set: DecorationSet;
}

export const noteNumbersKey = new PluginKey<State>("wf-note-numbers");
const REFRESH = "wf-note-numbers-refresh";

export interface NoteNumbersOptions {
  numbering: () => NoteNumbering;
  /** Footnotes' labels as the engine set them on their pages (or null). */
  pageLabels: () => readonly (string | null)[] | null;
}

function build(doc: PmNode, numbering: NoteNumbering, pages: readonly (string | null)[] | null): State {
  const wanted = labelled("foot", numbering) || labelled("end", numbering);
  if (!wanted) return { numbering, labels: null, set: DecorationSet.empty };
  const labels = noteLabels(doc, numbering, pages);
  const decorations: Decoration[] = [];
  for (const [pos, label] of labels) {
    const node = doc.nodeAt(pos);
    if (!node || !labelled(noteKind(node.attrs.kind), numbering)) continue;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { "data-n": label }));
  }
  return { numbering, labels, set: DecorationSet.create(doc, decorations) };
}

export const NoteNumbers = Extension.create<NoteNumbersOptions>({
  name: "noteNumbers",

  addOptions() {
    return { numbering: () => USUAL_NUMBERING, pageLabels: () => null };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<State>({
        key: noteNumbersKey,
        state: {
          init: (_config, state) => build(state.doc, options.numbering(), options.pageLabels()),
          apply: (tr, value, _old, state) => {
            if (!tr.docChanged && !tr.getMeta(REFRESH)) return value;
            return build(state.doc, options.numbering(), options.pageLabels());
          },
        },
        props: {
          decorations: (state) => noteNumbersKey.getState(state)?.set ?? null,
          // The counters' own formats, said on the text for the stylesheet.
          attributes: (state): Record<string, string> => {
            const n = noteNumbersKey.getState(state)?.numbering ?? USUAL_NUMBERING;
            const out: Record<string, string> = {};
            if (n.fnFormat !== "1") out["data-fnf"] = n.fnFormat === "I" ? "upper" : n.fnFormat === "i" ? "lower" : "own";
            if (n.enFormat !== "i") out["data-enf"] = n.enFormat === "I" ? "upper" : n.enFormat === "1" ? "digits" : "own";
            return out;
          },
        },
      }),
    ];
  },
});

/** The numbering or the page map changed: label the notes again. */
export function refreshNoteNumbers(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(REFRESH, true).setMeta("addToHistory", false));
}

/** A note's label as the document numbers it: the note at `pos`, the
 *  `ordinal`th of its kind. */
export function noteLabelAt(state: EditorState, pos: number, kind: NoteKind, ordinal: number): string {
  const st = noteNumbersKey.getState(state);
  const own = st?.labels?.get(pos);
  if (own) return own;
  const n = st?.numbering ?? USUAL_NUMBERING;
  return noteLabel(ordinal, kind === "foot" ? n.fnFormat : n.enFormat);
}

/** Whether a transaction asked for the notes to be labelled again. */
export const isNoteRefresh = (tr: { getMeta(key: string): unknown }): boolean => !!tr.getMeta(REFRESH);

/** Every note of one kind made the other (footnotes to endnotes, or back),
 *  as one step. Gives how many were. */
export function convertNotes(editor: Editor, from: NoteKind): number {
  const { state } = editor;
  const tr = state.tr;
  let count = 0;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "footnote") return true;
    if (noteKind(node.attrs.kind) === from) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, kind: from === "foot" ? "end" : null });
      count += 1;
    }
    return false;
  });
  // (Not a suggestion: what kind a note is, like its look, is not tracked.)
  if (count) editor.view.dispatch(tr.setMeta(UNTRACKED_META, true));
  return count;
}
