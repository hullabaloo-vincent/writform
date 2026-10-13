/**
 * Going to a place in the text from somewhere that is not the text: a row
 * in a panel, the Find field, the outline.
 *
 * ProseMirror's own `tr.scrollIntoView()` works from the BROWSER's
 * selection, and that only follows the editor's while the editor has the
 * focus (and never in a document that can only be read). Asked for from a
 * panel it silently does nothing. So the place is found by its coordinates
 * and the page is scrolled to it directly.
 *
 * Rule: anything outside the text that sends the reader to a place in it
 * goes through `showInText` or `showRange`, never `tr.scrollIntoView()`.
 */

import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** The element the text scrolls in. */
function scrollerOf(dom: HTMLElement): HTMLElement | null {
  for (let el = dom.parentElement; el && el !== document.body; el = el.parentElement) {
    const flow = getComputedStyle(el).overflowY;
    if (flow === "auto" || flow === "scroll") return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/** How near the edge of what can be seen a place may be and still count
 *  as in view. */
const MARGIN = 96;

/** Scroll so that `from` (to `to`) can be seen. A place already well in
 *  view is left where it is. Otherwise it is put a third of the way down. */
export function reveal(view: EditorView, from: number, to = from): void {
  try {
    const scroller = scrollerOf(view.dom as HTMLElement);
    if (!scroller) return;
    const a = view.coordsAtPos(from);
    const b = to > from ? view.coordsAtPos(to, -1) : a;
    const box = scroller.getBoundingClientRect();
    // A phone's keyboard covers the foot of the page without making it any
    // shorter: what can be seen ends where the keyboard begins.
    const screen = typeof window !== "undefined" ? window.visualViewport : null;
    const seenTop = screen ? Math.max(box.top, screen.offsetTop) : box.top;
    const seenBottom = screen ? Math.min(box.bottom, screen.offsetTop + screen.height) : box.bottom;
    const height = seenBottom - seenTop;
    if (height <= 0) return;
    const top = Math.min(a.top, b.top);
    const bottom = Math.max(a.bottom, b.bottom);
    const margin = Math.min(MARGIN, height / 4);
    if (top >= seenTop + margin && bottom <= seenBottom - margin) return;
    scroller.scrollTop += top - (seenTop + height / 3);
  } catch {
    // A position with no place on the page (not laid out): nothing to show.
  }
}

/** A finger and not a mouse: giving the text the focus would bring the
 *  keyboard up over it. */
export const touchFirst = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/**
 * Select a place in the text and bring it into view, wherever the focus
 * is. `focus` gives the text the focus afterwards (when it can be written
 * in): leave it off while the reader is typing somewhere else.
 */
export function showInText(view: EditorView, selection: Selection, focus = false): void {
  view.dispatch(view.state.tr.setSelection(selection));
  reveal(view, selection.from, selection.to);
  if (focus && view.editable) view.focus();
}

/** The same for a stretch of text given by its ends (held to the document,
 *  and to somewhere a selection can be). */
export function showRange(view: EditorView, from: number, to = from, focus = false): void {
  const doc = view.state.doc;
  const size = doc.content.size;
  const a = Math.max(0, Math.min(size, from));
  const b = Math.max(a, Math.min(size, to));
  let selection: Selection;
  try {
    selection = TextSelection.between(doc.resolve(a), doc.resolve(b));
  } catch {
    selection = Selection.near(doc.resolve(a));
  }
  showInText(view, selection, focus);
}
