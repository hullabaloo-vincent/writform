/**
 * Suggesting: an edit rewritten as a proposal.
 *
 * In Suggesting mode nothing a person does changes the text outright. This
 * takes the transaction their edit made and builds the one that is applied
 * instead:
 *  - what the edit would have deleted stays, marked as a deletion (unless
 *    it was their own suggested insertion — that is simply taken back);
 *  - what it would have inserted goes in after that, marked as an insertion;
 *  - a paragraph break added or removed is marked on the paragraph after it.
 *
 * Formatting isn't tracked: changes of style, alignment, lists and the like
 * go through as they are, and so do edits to a table's rows and columns and
 * to text that can't carry marks (code).
 *
 * Bookkeeping. The edit's steps are written against the document as the
 * edit left it; ours still holds everything the edit deleted. `Gaps` is the
 * map between the two: at each place the edit removed something, how much
 * of it we kept. Every later position of the edit is shifted by what was
 * kept before it.
 */

import { Fragment, Slice, type Mark, type MarkType, type Node as PmNode } from "@tiptap/pm/model";
import { AllSelection, NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
  AddMarkStep,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  StepMap,
  Transform,
  type MapResult,
  type Mappable,
  type Step,
} from "@tiptap/pm/transform";

import { breakAfter, breakStart, trackKind } from "./changes";
import { removeRange } from "./resolve";
import { authorAttr, DELETION, encodeRevs, INSERTION, parseRevs, revOf, withRev, type Rev } from "./TrackMarks";

export interface SuggestContext {
  /** Who is suggesting. */
  author: string;
  /** Now, seconds since 1970. */
  now: number;
}

interface Types {
  ins: MarkType;
  del: MarkType;
}

/** Thrown where an edit can't be turned into a suggestion; it is then
 *  applied as it is. */
class Untracked extends Error {}

class Gaps implements Mappable {
  /** Sorted by `at`. A size can be negative where what went in is smaller
   *  than what the edit put there (a paste we tidied). */
  private list: { at: number; size: number }[] = [];

  map(pos: number, assoc = 1): number {
    let shift = 0;
    for (const gap of this.list) {
      if (gap.at < pos || (gap.at === pos && assoc > 0)) shift += gap.size;
      else if (gap.at > pos) break;
    }
    return pos + shift;
  }

  mapResult(pos: number, assoc = 1): MapResult {
    return StepMap.empty.mapResult(this.map(pos, assoc));
  }

  /** The edit replaced [from, to) with `size` tokens; we kept `kept` tokens
   *  of the range. */
  replaced(from: number, to: number, size: number, kept: number): void {
    const next: { at: number; size: number }[] = [];
    let placed = false;
    const place = () => {
      if (!placed && kept !== 0) next.push({ at: from, size: kept });
      placed = true;
    };
    for (const gap of this.list) {
      if (gap.at <= from) next.push(gap);
      // Kept by an earlier step, inside what this one removes: now part
      // of `kept`.
      else if (gap.at < to) continue;
      else {
        place();
        next.push({ at: gap.at - (to - from) + size, size: gap.size });
      }
    }
    place();
    this.list = next;
  }

  /** What went in at `at` differs in size from what the edit put there. */
  adjust(at: number, delta: number): void {
    if (!delta) return;
    const index = this.list.findIndex((gap) => gap.at > at);
    this.list.splice(index < 0 ? this.list.length : index, 0, { at, size: delta });
  }

  /** A step applied as it is moved positions. */
  through(map: StepMap): void {
    this.list = this.list.flatMap((gap) => {
      const result = map.mapResult(gap.at, -1);
      return result.deletedAcross ? [] : [{ at: result.pos, size: gap.size }];
    });
  }
}

const structureOf = (step: Step): boolean => (step as unknown as { structure?: boolean }).structure === true;

const tableRole = (node: PmNode): string | undefined => node.type.spec.tableRole as string | undefined;
const isTablePart = (node: PmNode) => {
  const role = tableRole(node);
  return role === "row" || role === "cell" || role === "header_cell";
};

/**
 * A step that changes one node's type or attributes in place (a heading
 * made a paragraph; a picture resized) carries the attributes it was built
 * with — including a `tc` that may be out of date, or none at all. This is
 * the node such a step replaces, if it is one.
 */
function retyped(step: Step, doc: PmNode): PmNode | null {
  if (step instanceof ReplaceAroundStep) {
    if (!structureOf(step) || step.gapFrom !== step.from + 1 || step.gapTo !== step.to - 1 || step.insert !== 1 || step.slice.content.childCount !== 1) return null;
    const old = step.from < doc.content.size ? doc.nodeAt(step.from) : null;
    return old && step.from + old.nodeSize === step.to ? old : null;
  }
  if (step instanceof ReplaceStep) {
    const { from, to, slice } = step;
    if (to <= from || slice.openStart || slice.openEnd || slice.content.childCount !== 1) return null;
    const old = doc.nodeAt(from);
    const next = slice.content.firstChild!;
    return old && !old.isText && from + old.nodeSize === to && old.type === next.type && old.content.eq(next.content) ? old : null;
  }
  return null;
}

/** The same step, giving the node this `tc` (when it can say one, and
 *  means the same by it as `like` does). */
function withTc(step: Step, like: PmNode): Step {
  if (!(step instanceof ReplaceAroundStep) && !(step instanceof ReplaceStep)) return step;
  const next = step.slice.content.firstChild;
  if (!next || !("tc" in next.attrs)) return step;
  const tc = trackKind(next) === trackKind(like) ? ((like.attrs.tc as string | null) ?? null) : null;
  if (((next.attrs.tc as string | null) ?? null) === tc) return step;
  const slice = new Slice(Fragment.from(next.type.create({ ...next.attrs, tc }, next.content, next.marks)), step.slice.openStart, step.slice.openEnd);
  return step instanceof ReplaceAroundStep
    ? new ReplaceAroundStep(step.from, step.to, step.gapFrom, step.gapTo, slice, step.insert, true)
    : new ReplaceStep(step.from, step.to, slice);
}

/** A step that adds or removes rows, columns or cells. */
function isTableEdit(step: Step, doc: PmNode): boolean {
  if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) return false;
  let found = false;
  step.slice.content.forEach((node) => {
    if (isTablePart(node)) found = true;
  });
  if (found || step.to <= step.from) return found;
  doc.nodesBetween(step.from, step.to, (node, pos) => {
    if (found) return false;
    const inside = pos >= step.from && pos + node.nodeSize <= step.to;
    // (A whole table inside the range is a thing removed, not an edit to it.)
    if (tableRole(node) === "table" && inside) return false;
    if (isTablePart(node) && inside) found = true;
    return !found;
  });
  return found;
}

/** Whether a range holds anything a reader would miss: words, a picture, a
 *  paragraph's start. (Only the edges of lists and quotes: no.) */
function rangeHasContent(doc: PmNode, from: number, to: number): boolean {
  if (to <= from) return false;
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.isText || node.isLeaf) found = true;
    else if (node.isTextblock && pos >= from) found = true;
    else if (trackKind(node) === "unit" && pos >= from && pos + node.nodeSize <= to) found = true;
    return !found;
  });
  return found;
}

function sliceHasContent(slice: Slice): boolean {
  let found = false;
  const walk = (fragment: Fragment, open: number) => {
    fragment.forEach((node, _offset, index) => {
      if (found) return;
      // The first node of an open slice continues what's already there.
      const continues = index === 0 && open > 0;
      if (node.isText || node.isLeaf) found = true;
      else if (!continues && (node.isTextblock || trackKind(node) === "unit")) found = true;
      else walk(node.content, continues ? open - 1 : 0);
    });
  };
  walk(slice.content, slice.openStart);
  return found;
}

function tracksReplace(step: ReplaceStep, doc: PmNode, types: Types): boolean {
  const { from, to, slice } = step;
  // One node swapped for the same node with other attributes (a picture
  // resized) is formatting.
  if (retyped(step, doc)) return false;
  // Inside text that can't be marked.
  const $from = doc.resolve(from);
  if ($from.parent.isTextblock && !$from.parent.type.allowsMarkType(types.ins) && to <= $from.end()) return false;
  return rangeHasContent(doc, from, to) || sliceHasContent(slice);
}

/** The attributes of a mark of `type` by this author right beside
 *  [from, to), so a change made a keystroke at a time is one mark. */
function beside(doc: PmNode, from: number, to: number, type: MarkType, rev: Rev): Rev {
  const side = (node: PmNode | null | undefined): Rev | null => {
    const mark = node?.isText ? type.isInSet(node.marks) : null;
    return mark && revOf(mark.attrs).a === rev.a ? revOf(mark.attrs) : null;
  };
  return side(doc.resolve(from).nodeBefore) ?? side(doc.resolve(to).nodeAfter) ?? rev;
}

/**
 * A deletion that ends inside a paragraph can arrive as "remove up to here,
 * and put this paragraph's start back" — the slice ends with the open,
 * empty nodes the range ends in. Those aren't something added: this is the
 * slice without them.
 */
function withoutReopened(step: ReplaceStep, doc: PmNode): Slice {
  const { slice } = step;
  if (!slice.openEnd || step.to <= step.from) return slice;
  const chain: PmNode[] = [];
  for (let node = slice.content.lastChild, i = 0; node && i < slice.openEnd; node = node.lastChild, i += 1) chain.push(node);
  const $to = doc.resolve(step.to);
  let count = 0;
  for (let i = chain.length - 1, depth = $to.depth; i >= 0 && depth > 0; i -= 1, depth -= 1) {
    const node = chain[i];
    const there = $to.node(depth);
    // Holds nothing but the next of the chain, and is the node the range
    // ends in, whose start is within the range.
    if (node.childCount !== (i === chain.length - 1 ? 0 : 1) || !node.hasMarkup(there.type, there.attrs, there.marks)) break;
    if ($to.before(depth) < step.from) break;
    count += 1;
  }
  if (!count) return slice;
  const strip = (fragment: Fragment, level: number): Fragment => {
    const last = fragment.lastChild!;
    if (level === chain.length - count) return fragment.cut(0, fragment.size - last.nodeSize);
    return fragment.replaceChild(fragment.childCount - 1, last.copy(strip(last.content, level + 1)));
  };
  return new Slice(strip(slice.content, 0), slice.openStart, slice.openEnd - count);
}

type Op =
  | { kind: "mark"; from: number; to: number }
  | { kind: "cut"; from: number; to: number }
  | { kind: "attr"; pos: number; value: string | null }
  | { kind: "join"; pos: number };

/**
 * A deletion is about text: from somewhere in one paragraph to somewhere in
 * another. The editor often widens it to whole nodes — a paragraph selected
 * from its first letter is removed as a node. This narrows the range back
 * to the text, and says which paragraphs it had swallowed whole at either
 * end (`first`: its start was in the range; `last`: its end was).
 */
function narrow(doc: PmNode, from: number, to: number): { from: number; to: number; first: number | null; last: number | null } {
  const whole = (node: PmNode | null | undefined) => !node || node.isLeaf || trackKind(node) === "unit" || !!node.type.spec.isolating;
  let a = from;
  let first: number | null = null;
  while (a < to) {
    const $a = doc.resolve(a);
    if ($a.parent.inlineContent) break;
    const after = $a.nodeAfter;
    if (whole(after)) break;
    if (after!.isTextblock) first = a;
    a += 1;
    if (first !== null) break;
  }
  let b = to;
  let last: number | null = null;
  while (b > a) {
    const $b = doc.resolve(b);
    if ($b.parent.inlineContent) break;
    const before = $b.nodeBefore;
    if (whole(before)) break;
    if (before!.isTextblock) last = b - before!.nodeSize;
    b -= 1;
    if (last !== null) break;
  }
  return { from: a, to: b, first, last };
}

/** What marks a paragraph's break as deleted by `rev.a` (their own new
 *  break is simply undone; one already struck stays as it is). */
function strikeBreak(pos: number, node: PmNode, rev: Rev): Op | null {
  const revs = parseRevs(node.attrs.tc);
  if (revs?.ins?.a === rev.a) return { kind: "join", pos };
  return revs?.del ? null : { kind: "attr", pos, value: withRev(node.attrs.tc, "del", rev) };
}

function applyOp(tr: Transform, op: Op, mark: Mark): void {
  if (op.kind === "mark") tr.addMark(op.from, op.to, mark);
  else if (op.kind === "cut") tr.delete(op.from, op.to);
  else if (op.kind === "attr") tr.setNodeAttribute(op.pos, "tc", op.value);
  else {
    const node = tr.doc.nodeAt(op.pos);
    if (node) tr.setNodeAttribute(op.pos, "tc", withRev(node.attrs.tc, "ins", null));
    const start = breakStart(tr.doc, op.pos);
    if (start.joins) removeRange(tr, start.pos, op.pos + 1);
  }
}

/**
 * Mark [from, to) as deleted by `rev.a` — or, where it is their own
 * suggested insertion, take it back out.
 *
 * Returns a position when one break is still to be struck and isn't there
 * yet: whole paragraphs were replaced, nothing lies before them to join,
 * and what replaces them (`replacing`) hasn't gone in. It is where the last
 * of them ends; the break after it is the one.
 */
function markDeleted(tr: Transform, from: number, to: number, rev: Rev, types: Types, replacing = false): number | null {
  const doc = tr.doc;
  let ops: Op[] = [];
  let owed: number | null = null;
  const range = narrow(doc, from, to);
  const strike = (pos: number, node: PmNode): Op | null => strikeBreak(pos, node, rev);
  doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
    if (node.isText) {
      const a = Math.max(pos, range.from);
      const b = Math.min(pos + node.nodeSize, range.to);
      const mine = types.ins.isInSet(node.marks);
      if (!parent || !parent.type.allowsMarkType(types.del) || (mine && revOf(mine.attrs).a === rev.a)) ops.push({ kind: "cut", from: a, to: b });
      else if (!types.del.isInSet(node.marks)) ops.push({ kind: "mark", from: a, to: b });
      return false;
    }
    const inside = pos >= range.from && pos + node.nodeSize <= range.to;
    const kind = trackKind(node);
    if (kind === "unit") {
      if (!inside) return true;
      const revs = parseRevs(node.attrs.tc);
      if (revs?.ins?.a === rev.a) ops.push({ kind: "cut", from: pos, to: pos + node.nodeSize });
      else if (!revs?.del) ops.push({ kind: "attr", pos, value: withRev(node.attrs.tc, "del", rev) });
      return false;
    }
    if (kind === "break" && pos >= range.from) {
      // The range came into this paragraph from the one before: the break
      // between them goes (their own new one is simply undone).
      const op = strike(pos, node);
      if (op) ops.push(op);
      return true;
    }
    if (node.isLeaf && inside) {
      ops.push({ kind: "cut", from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
  // Whole paragraphs at both ends: one more break goes than the text
  // between crosses. The first paragraph's own, where there is text before
  // it to join; else the one after the last.
  if (range.first !== null && range.last !== null) {
    const node = doc.nodeAt(range.first)!;
    const own = parseRevs(node.attrs.tc)?.ins?.a === rev.a;
    if (breakStart(doc, range.first).joins) {
      const op = strike(range.first, node);
      if (op) ops.unshift(op);
    } else if (own) {
      // Their own new paragraph with nothing before it: all of it goes.
      const end = range.first + node.nodeSize;
      ops = ops.filter((op) => ("pos" in op ? op.pos : op.from) >= end);
      ops.unshift({ kind: "cut", from: range.first, to: end });
    } else {
      const end = range.last + doc.nodeAt(range.last)!.nodeSize;
      // (With something about to go in after them, the break after the
      // last is that thing's: the caller strikes it once it is there.)
      if (replacing) owed = end;
      else {
        const next = breakAfter(doc, end);
        const op = next === null ? null : strike(next, doc.nodeAt(next)!);
        if (op) ops.push(op);
      }
    }
  }
  const mark = types.del.create(beside(doc, range.from, range.to, types.del, rev));
  const before = tr.steps.length;
  // Back to front: each leaves what's before it where it was.
  for (let i = ops.length - 1; i >= 0; i -= 1) applyOp(tr, ops[i], mark);
  return owed === null ? null : tr.mapping.slice(before).map(owed, -1);
}

/** Mark what now lies in [from, to) as inserted by `rev.a`. */
function markInserted(tr: Transform, from: number, to: number, rev: Rev, types: Types): void {
  const doc = tr.doc;
  const texts: { from: number; to: number }[] = [];
  const nodes: number[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.isText) {
      if (parent && parent.type.allowsMarkType(types.ins)) texts.push({ from: Math.max(pos, from), to: Math.min(pos + node.nodeSize, to) });
      return false;
    }
    const kind = trackKind(node);
    if (kind && pos >= from) nodes.push(pos);
    // What's inside a thing added whole is part of it.
    return kind !== "unit" || pos < from;
  });
  const mark = types.ins.create(beside(doc, from, to, types.ins, rev));
  for (const range of texts) {
    // Typed inside struck text, it isn't struck itself.
    tr.removeMark(range.from, range.to, types.del);
    tr.addMark(range.from, range.to, mark);
  }
  for (const pos of nodes) tr.setNodeAttribute(pos, "tc", encodeRevs({ ins: rev }));
}

/** Content about to go in as a suggestion: without the tracking it came
 *  with. Typed text takes the marks of the text around it — they are just
 *  taken off; in a paste, what was copied struck isn't pasted back. */
function cleanSlice(slice: Slice, types: Types, pasted: boolean): Slice {
  let tracked = false;
  slice.content.descendants((node) => {
    if (types.ins.isInSet(node.marks) || types.del.isInSet(node.marks) || (node.attrs.tc && parseRevs(node.attrs.tc))) tracked = true;
    return !tracked;
  });
  if (!tracked) return slice;
  const clean = (fragment: Fragment, dropUnits: boolean): Fragment => {
    const out: PmNode[] = [];
    fragment.forEach((node) => {
      if (node.isText) {
        if (pasted && types.del.isInSet(node.marks)) return;
        out.push(node.mark(types.del.removeFromSet(types.ins.removeFromSet(node.marks))));
        return;
      }
      const revs = node.attrs.tc ? parseRevs(node.attrs.tc) : null;
      if (pasted && revs?.del && dropUnits && trackKind(node) === "unit") return;
      let content = clean(node.content, true);
      // Without a removed thing its parent may not hold together.
      if (!node.type.validContent(content)) content = clean(node.content, false);
      out.push(node.type.create(revs ? { ...node.attrs, tc: null } : node.attrs, content, node.marks));
    });
    return Fragment.from(out);
  };
  const content = clean(slice.content, false);
  return new Slice(content, slice.openStart, slice.openEnd);
}

function replaceTracked(tr: Transaction, gaps: Gaps, step: ReplaceStep, doc: PmNode, rev: Rev, types: Types, pasted: boolean): void {
  const from = gaps.map(step.from, 1);
  const to = Math.max(from, gaps.map(step.to, -1));
  const added = withoutReopened(step, doc);
  const inserts = sliceHasContent(added);
  const before = tr.steps.length;
  const owed = to > from ? markDeleted(tr, from, to, rev, types, inserts) : null;
  const deleted = tr.mapping.slice(before);
  const keptFrom = deleted.map(from, -1);
  const at = deleted.map(to, 1);
  gaps.replaced(step.from, step.to, step.slice.size, at - keptFrom);

  let size = 0;
  if (inserts) {
    const slice = cleanSlice(added, types, pasted);
    const first = tr.steps.length;
    if (tr.maybeStep(new ReplaceStep(at, at, slice)).failed) {
      // It was shaped for the range it replaced; fit it where it goes now.
      tr.replaceRange(at, at, slice);
    }
    let a = Infinity;
    let b = -Infinity;
    for (let i = first; i < tr.steps.length; i += 1) {
      tr.mapping.maps[i].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        a = Math.min(a, newStart);
        b = Math.max(b, newEnd);
      });
    }
    if (b > a) {
      size = b - a;
      markInserted(tr, a, b, rev, types);
      // Whole paragraphs replaced by new ones, at the very start: the new
      // text goes on from where the old was struck (see `markDeleted`).
      if (owed !== null) {
        const count = tr.steps.length;
        const end = tr.mapping.slice(first).map(owed, -1);
        const next = breakAfter(tr.doc, end);
        const node = next === null ? null : tr.doc.nodeAt(next);
        const op = node && next !== null ? strikeBreak(next, node, rev) : null;
        if (op) applyOp(tr, op, types.del.create(rev));
        // (Joined into the struck paragraph, what went in is two tokens shorter.)
        size += tr.mapping.slice(count).map(b, 1) - b;
      }
    }
  }
  // (What went in may not be the size of what the edit put there.)
  gaps.adjust(step.from + step.slice.size, size - step.slice.size);
}

/** A deletion that reaches from one depth into another arrives as a step
 *  that removes two ranges and keeps what's between. */
function aroundTracked(tr: Transaction, gaps: Gaps, step: ReplaceAroundStep, rev: Rev, types: Types): void {
  // The later range first, so the earlier one's positions hold.
  for (const [start, end] of [
    [step.gapTo, step.to],
    [step.from, step.gapFrom],
  ]) {
    if (end <= start) continue;
    const from = gaps.map(start, 1);
    const to = Math.max(from, gaps.map(end, -1));
    const before = tr.steps.length;
    if (to > from) markDeleted(tr, from, to, rev, types);
    const deleted = tr.mapping.slice(before);
    gaps.replaced(start, end, 0, deleted.map(to, 1) - deleted.map(from, -1));
  }
}

/**
 * The transaction to apply in place of `tr` while `ctx.author` is
 * suggesting. Returns `tr` itself where there is nothing to track.
 */
export function suggestTransaction(state: EditorState, tr: Transaction, ctx: SuggestContext): Transaction {
  const types = { ins: state.schema.marks[INSERTION], del: state.schema.marks[DELETION] };
  if (!types.ins || !types.del || !tr.docChanged) return tr;
  if (tr.steps.some((step, i) => isTableEdit(step, tr.docs[i]))) return tr;

  const rev: Rev = { a: authorAttr(ctx.author), t: ctx.now };
  const pasted = !!tr.getMeta("paste") || tr.getMeta("uiEvent") === "drop";
  const out = state.tr;
  const gaps = new Gaps();
  let tracked = false;
  try {
    tr.steps.forEach((step, i) => {
      const doc = tr.docs[i];
      if (step instanceof ReplaceStep && tracksReplace(step, doc, types)) {
        replaceTracked(out, gaps, step, doc, rev, types, pasted);
        tracked = true;
        return;
      }
      if (step instanceof ReplaceAroundStep && !structureOf(step)) {
        const removes = rangeHasContent(doc, step.from, step.gapFrom) || rangeHasContent(doc, step.gapTo, step.to);
        if (removes) {
          if (step.slice.size) throw new Untracked();
          aroundTracked(out, gaps, step, rev, types);
          tracked = true;
          return;
        }
      }
      // Tracking isn't formatting: nothing but accepting and rejecting
      // takes these marks off or puts them on.
      if ((step instanceof AddMarkStep || step instanceof RemoveMarkStep) && (step.mark.type === types.ins || step.mark.type === types.del)) {
        tracked = true;
        return;
      }
      let mapped = step.map(gaps);
      if (!mapped) throw new Untracked();
      // Whether the node is a suggestion is ours to say, not the step's.
      if (retyped(step, doc)) {
        const ours = out.doc.nodeAt((mapped as ReplaceStep | ReplaceAroundStep).from);
        if (ours) mapped = withTc(mapped, ours);
      }
      if (out.maybeStep(mapped).failed) throw new Untracked();
      gaps.through(step.getMap());
    });
  } catch (e) {
    if (!(e instanceof Untracked)) console.warn("[suggesting] applied as a direct edit", e);
    return tr;
  }
  if (!tracked) return tr;

  // Where the edit left the selection, in our document. Deleting forwards
  // steps past what it struck; anything else stays before it.
  const first = tr.steps[0];
  const forward =
    tr.steps.length === 1 &&
    first instanceof ReplaceStep &&
    !first.slice.size &&
    state.selection.empty &&
    first.from === state.selection.head &&
    first.to > first.from;
  const assoc = forward ? 1 : -1;
  const sel = tr.selection;
  const max = out.doc.content.size;
  const place = (pos: number, side: number) => Math.max(0, Math.min(max, gaps.map(pos, side)));
  let selection: Selection;
  try {
    if (sel instanceof AllSelection) selection = new AllSelection(out.doc);
    else if (sel instanceof NodeSelection) selection = NodeSelection.create(out.doc, place(sel.from, 1));
    else if (sel instanceof TextSelection) {
      const $anchor = out.doc.resolve(place(sel.anchor, assoc));
      const $head = out.doc.resolve(place(sel.head, assoc));
      selection = $anchor.parent.inlineContent && $head.parent.inlineContent ? new TextSelection($anchor, $head) : Selection.near($head, assoc);
    } else selection = Selection.near(out.doc.resolve(place(sel.head, assoc)), assoc);
  } catch {
    selection = Selection.near(out.doc.resolve(place(sel.head, assoc)), assoc);
  }
  out.setSelection(selection);
  copyRest(tr, out);
  return out;
}

/** Everything but the steps and the selection: metadata, stored marks,
 *  whether to scroll. */
function copyRest(from: Transaction, to: Transaction): void {
  const meta = (from as unknown as { meta: Record<string, unknown> }).meta ?? {};
  for (const key of Object.keys(meta)) {
    const value = meta[key];
    // An input rule remembers its own transaction so Backspace can undo
    // it; ours isn't that one.
    if (value && typeof value === "object" && (value as { transform?: unknown }).transform instanceof Transform) continue;
    to.setMeta(key, value);
  }
  if (from.storedMarksSet) to.setStoredMarks(from.storedMarks);
  if (from.scrolledIntoView) to.scrollIntoView();
}

/**
 * Outside Suggesting, three things still keep tracking honest:
 *  - "clear formatting" and the like don't strip tracking marks;
 *  - a paragraph split off a tracked one isn't itself that change;
 *  - text typed inside a suggestion isn't part of it (pasted or dropped
 *    text keeps what it was copied with).
 * Returns `tr`, possibly with steps added, or a replacement for it.
 */
export function tidyTransaction(state: EditorState, tr: Transaction): Transaction {
  const types = { ins: state.schema.marks[INSERTION], del: state.schema.marks[DELETION] };
  if (!types.ins || !types.del || !tr.docChanged) return tr;
  const isTracking = (step: Step) => (step instanceof AddMarkStep || step instanceof RemoveMarkStep) && (step.mark.type === types.ins || step.mark.type === types.del);

  let out = tr;
  if (tr.steps.some(isTracking)) {
    // (Mark steps move nothing, so the others apply as they are.)
    out = state.tr;
    for (const step of tr.steps) {
      if (isTracking(step)) continue;
      if (out.maybeStep(step).failed) return tr;
    }
    try {
      out.setSelection(Selection.fromJSON(out.doc, tr.selection.toJSON()));
    } catch {
      // The mapped selection will do.
    }
    copyRest(tr, out);
  }

  const pasted = !!out.getMeta("paste") || out.getMeta("uiEvent") === "drop";
  const stored = out.storedMarksSet ? out.storedMarks : undefined;
  const count = out.steps.length;
  const unmark: { from: number; to: number }[] = [];
  const untrack: number[] = [];
  const restore: { pos: number; old: PmNode }[] = [];
  for (let i = 0; i < count; i += 1) {
    const step = out.steps[i];
    // A paragraph given another type without its attributes (Enter at the
    // start of a heading does that to the empty half) is still the
    // suggestion it was.
    const was = step instanceof ReplaceAroundStep ? retyped(step, out.docs[i]) : null;
    if (was?.attrs.tc) restore.push({ pos: out.mapping.slice(i + 1, count).map((step as ReplaceAroundStep).from, 1), old: was });
    if (!(step instanceof ReplaceStep) || !step.slice.size) continue;
    const after = out.docs[i + 1] ?? out.doc;
    const rest = out.mapping.slice(i + 1, count);
    const end = step.from + step.slice.size;
    const flat = step.slice.openStart === 0 && step.slice.openEnd === 0 && step.slice.content.firstChild?.isInline;
    if (flat && !pasted) {
      let marked = false;
      step.slice.content.forEach((node) => {
        if (types.ins.isInSet(node.marks) || types.del.isInSet(node.marks)) marked = true;
      });
      if (marked) unmark.push({ from: rest.map(step.from, -1), to: rest.map(end, 1) });
    }
    // A split: only the edges of blocks went in.
    if (step.from === step.to && step.slice.openStart > 0 && step.slice.openEnd > 0 && !sliceHasText(step.slice)) {
      after.nodesBetween(step.from, Math.min(end, after.content.size), (node, pos) => {
        if (pos >= step.from && trackKind(node) === "break" && node.attrs.tc) untrack.push(rest.map(pos, 1));
        return true;
      });
    }
  }
  for (const range of unmark) {
    if (range.to <= range.from) continue;
    out.removeMark(range.from, range.to, types.ins);
    out.removeMark(range.from, range.to, types.del);
  }
  for (const { pos, old } of restore) {
    const node = pos < out.doc.content.size ? out.doc.nodeAt(pos) : null;
    if (node && "tc" in node.attrs && !node.attrs.tc && trackKind(node) === trackKind(old)) out.setNodeAttribute(pos, "tc", old.attrs.tc);
  }
  for (const pos of untrack) {
    const node = pos <= out.doc.content.size ? out.doc.nodeAt(pos) : null;
    if (node && trackKind(node) === "break" && node.attrs.tc) out.setNodeAttribute(pos, "tc", null);
  }
  // (Adding a step forgets the stored marks.)
  if (out.steps.length !== count && stored !== undefined) out.setStoredMarks(stored);
  return out;
}

function sliceHasText(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (node.isText || node.isLeaf) found = true;
    return !found;
  });
  return found;
}
