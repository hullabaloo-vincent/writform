/**
 * Moving a picture: one block up or down with a button or the keyboard, or
 * dragged by its handle to wherever it should go.
 *
 * A picture here is a block of its own, between other blocks. It has no
 * anchor, no wrapping and no layer to get wrong: it is where it is in the
 * text, and moving it puts it somewhere else in the text.
 */

import type { Editor } from "@tiptap/core";
import { Fragment, type Node as PmNode, type NodeType, type ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const isCell = (node: PmNode): boolean => {
  const role = node.type.spec.tableRole as string | undefined;
  return role === "cell" || role === "header_cell";
};

/**
 * The block at `from` taken out and put at `to` (a place between blocks,
 * outside the one being moved), selected there. Null when that can't be.
 * A container left with nothing in it keeps an empty paragraph.
 */
export function moveBlock(state: EditorState, from: number, to: number): Transaction | null {
  const node = state.doc.nodeAt(from);
  if (!node || !node.isBlock) return null;
  const end = from + node.nodeSize;
  if (to >= from && to <= end) return null;
  const $to = state.doc.resolve(to);
  if (!$to.parent.canReplaceWith($to.index(), $to.index(), node.type)) return null;
  const $from = state.doc.resolve(from);
  const tr = state.tr;
  const alone = $from.parent.childCount === 1 && !$from.parent.type.validContent(Fragment.empty);
  const filler = alone ? $from.parent.type.contentMatch.defaultType?.createAndFill() : null;
  if (alone && !filler) return null;
  if (filler) tr.replaceWith(from, end, filler);
  else tr.delete(from, end);
  const at = tr.mapping.map(to, to > from ? -1 : 1);
  tr.insert(at, node);
  return tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView();
}

/** Where the block at `pos` goes when it is moved one step: over the block
 *  beside it, or out of what it is in (a quote, a list item) when it is at
 *  that thing's edge. Null at the edge of the text or of a table's cell. */
export function stepTarget(doc: PmNode, pos: number, dir: -1 | 1): number | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const index = $pos.index();
  if (dir < 0 && index > 0) return pos - parent.child(index - 1).nodeSize;
  if (dir > 0 && index < parent.childCount - 1) return pos + node.nodeSize + parent.child(index + 1).nodeSize;
  if ($pos.depth === 0 || isCell(parent)) return null;
  const out = dir < 0 ? $pos.before() : $pos.after();
  const $out = doc.resolve(out);
  return $out.parent.canReplaceWith($out.index(), $out.index(), node.type) ? out : null;
}

/** Move the selected picture one block up or down. */
export function movePicture(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") return false;
  const to = stepTarget(state.doc, sel.from, dir);
  const tr = to === null ? null : moveBlock(state, sel.from, to);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

/** Whether the selected picture can go a step that way. */
export function canMovePicture(editor: Editor, dir: -1 | 1): boolean {
  const sel = editor.state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === "image" && stepTarget(editor.state.doc, sel.from, dir) !== null;
}

/**
 * The block a pointer is over, as somewhere a picture could be dropped: the
 * innermost block around `$pos` whose container takes a picture beside it.
 * (Dropped before it or after it by which half the pointer is in.)
 */
export function dropBlock($pos: ResolvedPos, type: NodeType): { pos: number; node: PmNode } | null {
  for (let d = $pos.depth; d >= 1; d -= 1) {
    const parent = $pos.node(d - 1);
    const index = $pos.index(d - 1);
    if (parent.canReplaceWith(index, index, type)) return { pos: $pos.before(d), node: $pos.node(d) };
  }
  // Between two blocks of the text itself.
  const beside = $pos.nodeAfter ?? $pos.nodeBefore;
  if ($pos.depth === 0 && beside) return { pos: $pos.nodeAfter ? $pos.pos : $pos.pos - beside.nodeSize, node: beside };
  return null;
}

interface Drop {
  /** Where the picture would go. */
  to: number;
  /** The line that shows it, on screen. */
  left: number;
  top: number;
  width: number;
}

/** Where a picture dragged to a point on screen would land. */
function dropAt(view: EditorView, x: number, y: number, moving: { pos: number; node: PmNode }): Drop | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const doc = view.state.doc;
  // (Over a block that holds no text, a picture say, the place is the block.)
  const inside = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  const found = inside && inside.isBlock && !inside.isTextblock && inside.isLeaf ? { pos: hit.inside, node: inside } : dropBlock(doc.resolve(hit.pos), moving.node.type);
  if (!found) return null;
  const dom = view.nodeDOM(found.pos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const before = y < rect.top + rect.height / 2;
  const to = before ? found.pos : found.pos + found.node.nodeSize;
  // (Where it already is: nothing to do.)
  if (to >= moving.pos && to <= moving.pos + moving.node.nodeSize) return null;
  const $to = doc.resolve(to);
  if (!$to.parent.canReplaceWith($to.index(), $to.index(), moving.node.type)) return null;
  return { to, left: rect.left, top: before ? rect.top : rect.bottom, width: rect.width };
}

/**
 * A handle on a picture that moves it: press it, drag to where the picture
 * should go (a line shows the place, between two blocks), let go. Its own
 * pointer handling throughout, so it works the same with a mouse, a pen or
 * a finger, in every webview (the browser's own drag and drop does not).
 */
export function moveHandle(view: () => EditorView | null, getPos: () => number | undefined): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "wf-img-move";
  handle.contentEditable = "false";
  handle.setAttribute("role", "button");
  handle.setAttribute("aria-label", "Move this picture: drag it to where it should go");
  handle.title = "Drag to move the picture";
  // (Four arrows: the sign for "move" everywhere.)
  handle.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>';
  let line: HTMLElement | null = null;
  let drop: Drop | null = null;
  let moving: { pos: number; node: PmNode } | null = null;

  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const end = () => {
    line?.remove();
    line = null;
    drop = null;
    moving = null;
    handle.classList.remove("dragging");
  };
  handle.addEventListener("mousedown", stop);
  handle.addEventListener("pointerdown", (e) => {
    const v = view();
    const pos = getPos();
    const node = v && pos !== undefined ? v.state.doc.nodeAt(pos) : null;
    if (!v || pos === undefined || !node || !v.editable || e.button !== 0) return;
    stop(e);
    moving = { pos, node };
    handle.classList.add("dragging");
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    const v = view();
    if (!moving || !v) return;
    stop(e);
    drop = dropAt(v, e.clientX, e.clientY, moving);
    if (!drop) {
      line?.remove();
      line = null;
      return;
    }
    if (!line) {
      line = document.createElement("div");
      line.className = "wf-drop-line";
      document.body.append(line);
    }
    line.style.left = `${drop.left}px`;
    line.style.top = `${drop.top - 1}px`;
    line.style.width = `${drop.width}px`;
  });
  handle.addEventListener("pointerup", (e) => {
    const v = view();
    const target = drop;
    const from = moving;
    end();
    if (!v || !target || !from) return;
    stop(e);
    const tr = moveBlock(v.state, from.pos, target.to);
    if (tr) v.dispatch(tr);
    v.focus();
  });
  handle.addEventListener("pointercancel", end);
  return handle;
}
