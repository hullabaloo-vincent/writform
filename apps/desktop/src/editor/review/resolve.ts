/**
 * Accepting and rejecting tracked changes.
 *
 * Two outcomes, whichever the change: its content STAYS (an insertion
 * accepted, a deletion rejected) — the marks come off and it is ordinary
 * text; or it GOES (an insertion rejected, a deletion accepted) — and it is
 * removed exactly as if it had been selected and deleted, so paragraphs
 * join the way they would have.
 *
 * Works on a plain transform, so the same code resolves a change in the
 * editor and produces the "no markup" text that printing, PDFs and the
 * other exports use.
 */

import type { JSONContent } from "@tiptap/core";
import { Node as PmNode, type Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

import { changesOf, type Change } from "./changes";
import { DELETION, INSERTION, markName, parseRevs, withRev } from "./TrackMarks";

export type Verdict = "accept" | "reject";

/** Whether resolving this change removes what it marks. */
export const removes = (change: Change, verdict: Verdict) => (change.kind === "ins") === (verdict === "reject");

/**
 * Resolve `changes` (as listed for the transform's document before any of
 * this call's steps) one way or the other.
 */
export function resolveChanges(tr: Transform, changes: Change[], verdict: Verdict): void {
  const base = tr.steps.length;
  const at = (pos: number, assoc: number) => tr.mapping.slice(base).map(pos, assoc);
  // Back to front, so what's before a change is where it was listed. (One
  // inside another — a deletion within an insertion — is mapped.)
  const ordered = [...changes].sort((a, b) => b.from - a.from || b.to - a.to);
  for (const change of ordered) {
    const going = removes(change, verdict);
    untrack(tr, change, at, going);
    if (going) remove(tr, change, at);
  }
}

/** Take the change's marks and attributes off: what it covers is now just
 *  part of the document. (Before removing, too: a paragraph that survives
 *  the removal mustn't still say it is leaving.) */
function untrack(tr: Transform, change: Change, at: (pos: number, assoc: number) => number, going: boolean): void {
  const type = tr.doc.type.schema.marks[markName(change.kind)];
  for (const piece of change.pieces) {
    if (piece.what === "text") {
      // (Text that is about to go needn't be unmarked first.)
      if (going) continue;
      const from = at(piece.from, 1);
      const to = at(piece.to, -1);
      if (type && to > from) tr.removeMark(from, to, type);
      continue;
    }
    const pos = at(piece.pos, 1);
    const node = pos <= tr.doc.content.size ? tr.doc.nodeAt(pos) : null;
    if (!node || node.type.name !== piece.name || !parseRevs(node.attrs.tc)?.[change.kind]) continue;
    tr.setNodeAttribute(pos, "tc", withRev(node.attrs.tc, change.kind, null));
  }
}

/**
 * Delete a range the way selecting it and pressing Delete would — so what
 * accepting a deletion leaves is what deleting directly would have left.
 *
 * That way of deleting may drop an emptied first paragraph and keep the
 * last one instead of joining the last into the first. The break BEFORE the
 * range is still there either way, so whichever paragraph is left keeps
 * what the first one said about it.
 */
export function removeRange(tr: Transform, from: number, to: number): void {
  const $from = tr.doc.resolve(from);
  const $to = tr.doc.resolve(to);
  if ($from.sameParent($to) && $from.parent.inlineContent) {
    tr.delete(from, to);
    return;
  }
  const head = $from.parent.isTextblock && "tc" in $from.parent.attrs ? (($from.parent.attrs.tc as string | null) ?? null) : undefined;
  const before = tr.steps.length;
  tr.deleteRange(from, to);
  if (head === undefined) return;
  const $at = tr.doc.resolve(tr.mapping.slice(before).map(from, 1));
  const pos = $at.parent.isTextblock ? $at.before() : $at.nodeAfter?.isTextblock ? $at.pos : -1;
  const left = pos < 0 ? null : tr.doc.nodeAt(pos);
  if (left && "tc" in left.attrs && ((left.attrs.tc as string | null) ?? null) !== head) tr.setNodeAttribute(pos, "tc", head);
}

function remove(tr: Transform, change: Change, at: (pos: number, assoc: number) => number): void {
  const from = at(change.from, 1);
  const to = at(change.to, -1);
  if (to <= from) return;
  const start = tr.steps.length;
  try {
    removeRange(tr, from, to);
    return;
  } catch {
    // Fall through: piece by piece.
  }
  // (A failed step adds nothing, but be sure of where we stand.)
  if (tr.steps.length !== start) return;
  for (let i = change.pieces.length - 1; i >= 0; i -= 1) {
    const piece = change.pieces[i];
    if (piece.what === "break") continue;
    const a = at(piece.from, 1);
    const b = at(piece.to, -1);
    if (b <= a) continue;
    try {
      tr.delete(a, b);
    } catch {
      // Leave it: untracked text is better than a broken document.
    }
  }
}

/** The document with every change resolved one way. */
export function resolvedDoc(doc: PmNode, verdict: Verdict): PmNode {
  const changes = changesOf(doc);
  if (!changes.length) return doc;
  const tr = new Transform(doc);
  resolveChanges(tr, changes, verdict);
  return tr.doc;
}

/** Whether TipTap JSON holds any tracked change. */
export function jsonHasChanges(node: JSONContent): boolean {
  if (node.marks?.some((m) => m.type === INSERTION || m.type === DELETION)) return true;
  if (typeof node.attrs?.tc === "string" && node.attrs.tc) return true;
  return (node.content ?? []).some(jsonHasChanges);
}

/**
 * The same for TipTap JSON. `schema` is the document schema; without one
 * (or if the JSON doesn't fit it) the words are still right — deleted text
 * dropped or kept, marks off — but paragraphs aren't joined.
 */
export function resolvedJson(doc: JSONContent, verdict: Verdict, schema?: Schema | null): JSONContent {
  if (!jsonHasChanges(doc)) return doc;
  if (schema) {
    try {
      return resolvedDoc(PmNode.fromJSON(schema, doc), verdict).toJSON() as JSONContent;
    } catch {
      // Below.
    }
  }
  return plainResolve(doc, verdict);
}

function plainResolve(node: JSONContent, verdict: Verdict): JSONContent {
  const gone = verdict === "accept" ? DELETION : INSERTION;
  const goneKind = verdict === "accept" ? "del" : "ins";
  const walk = (n: JSONContent): JSONContent | null => {
    if (n.marks?.some((m) => m.type === gone)) return null;
    const revs = parseRevs(n.attrs?.tc);
    // (A paragraph's `tc` is its break, which stays; a thing's is itself.)
    const whole = n.type !== "paragraph" && n.type !== "heading";
    if (revs?.[goneKind] && whole) return null;
    const out: JSONContent = { ...n };
    if (n.marks) {
      const marks = n.marks.filter((m) => m.type !== INSERTION && m.type !== DELETION);
      if (marks.length) out.marks = marks;
      else delete out.marks;
    }
    if (n.attrs && "tc" in n.attrs) out.attrs = { ...n.attrs, tc: null };
    if (n.content) out.content = n.content.map(walk).filter((c): c is JSONContent => c !== null);
    return out;
  };
  return walk(node) ?? { type: "doc", content: [{ type: "paragraph" }] };
}
