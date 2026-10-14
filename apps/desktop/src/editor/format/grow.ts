import type { Editor } from "@tiptap/core";
import { AllSelection, TextSelection, type EditorState, type Selection } from "@tiptap/pm/state";

import { sentencesOf, splitter } from "../speech/readAloud";
import { wordNear } from "./wordAt";

/**
 * Growing the selection by key: the word at the caret, then its sentence,
 * then its paragraph, then everything. Shrinking goes back the way it
 * came. (What a word processor's "extend" key does.)
 */

interface Span {
  from: number;
  to: number;
}

/** What each editor has grown through, to shrink back by. */
const grown = new WeakMap<Editor, { steps: Span[]; last: Span }>();

const same = (a: Span, b: Span) => a.from === b.from && a.to === b.to;
/** `outer` holds `inner` and is larger. */
const holds = (outer: Span, inner: Span) => outer.from <= inner.from && outer.to >= inner.to && !same(outer, inner);

/** The spans around the selection, smallest first. */
function around(state: EditorState, lang?: string): Span[] {
  const { $from, $to, from, to } = state.selection;
  const out: Span[] = [];
  if ($from.parent.isTextblock && $from.sameParent($to)) {
    const word = wordNear($from);
    if (word) out.push(word);
    const sentence = sentencesOf($from.parent, $from.before(), splitter(lang)).find((s) => s.from <= from && s.to >= to);
    if (sentence) out.push({ from: sentence.from, to: sentence.to });
  }
  // The paragraph, or every paragraph the selection touches.
  if ($from.parent.isTextblock && $to.parent.isTextblock) out.push({ from: $from.start(), to: $to.end() });
  return out;
}

const select = (editor: Editor, selection: Selection) => editor.view.dispatch(editor.state.tr.setSelection(selection));

/** One step larger. */
export function growSelection(editor: Editor, lang?: string): boolean {
  const { state } = editor;
  if (state.selection instanceof AllSelection) return false;
  const now: Span = { from: state.selection.from, to: state.selection.to };
  const mem = grown.get(editor);
  const steps = mem && same(mem.last, now) ? mem.steps : [];
  const next = around(state, lang).find((span) => holds(span, now));
  steps.push(now);
  if (next) {
    select(editor, TextSelection.create(state.doc, next.from, next.to));
    grown.set(editor, { steps, last: next });
  } else {
    const all = new AllSelection(state.doc);
    select(editor, all);
    grown.set(editor, { steps, last: { from: all.from, to: all.to } });
  }
  return true;
}

/** Back a step (only from a selection that was grown to). */
export function shrinkSelection(editor: Editor): boolean {
  const { state } = editor;
  const mem = grown.get(editor);
  const now: Span = { from: state.selection.from, to: state.selection.to };
  if (!mem || !same(mem.last, now) || !mem.steps.length) return false;
  const back = mem.steps.pop()!;
  const size = state.doc.content.size;
  if (back.from > size || back.to > size) return false;
  select(editor, TextSelection.create(state.doc, back.from, back.to));
  grown.set(editor, { steps: mem.steps, last: back });
  return true;
}
