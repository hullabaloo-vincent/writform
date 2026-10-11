/**
 * The tracked changes in a document, read off the text itself.
 *
 * A change is a run of tracked pieces — marked words, tracked paragraph
 * breaks, things added or removed whole — of one kind by one person, with
 * nothing else between them: "deleted from here in this paragraph to there
 * in the next" is one change, as it was one keystroke.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { DELETION, INSERTION, parseRevs, revOf, type Rev, type RevKind } from "./TrackMarks";

export interface Piece {
  kind: RevKind;
  rev: Rev;
  /** Marked text; a node taken whole; or the break before a paragraph. */
  what: "text" | "node" | "break";
  from: number;
  to: number;
  /** For a node or a break: where the node that says so is. */
  pos: number;
  /** For a node: what it is ("image", "table", …). */
  name: string;
}

export interface Change {
  /** Unique among a document's changes at one moment (not across edits). */
  id: string;
  kind: RevKind;
  author: string;
  time: number;
  from: number;
  to: number;
  pieces: Piece[];
}

/** How a node takes part in tracking: its `tc` speaks of the break before
 *  it, of the node as a whole, or it has none. */
export function trackKind(node: PmNode): "break" | "unit" | null {
  if (!("tc" in node.attrs)) return null;
  if (!node.isTextblock) return "unit";
  // A block whose text can't be marked (code) is added or removed whole.
  const mark = node.type.schema.marks[INSERTION];
  return mark && node.type.allowsMarkType(mark) ? "break" : "unit";
}

/**
 * Where the break before the textblock at `pos` begins: the end of the text
 * before it, when only the edges of blocks lie between. `joins` is false
 * when there is no text there to join — the start of the document or of a
 * table cell, or after a picture or a table.
 */
export function breakStart(doc: PmNode, pos: number): { pos: number; joins: boolean } {
  let at = pos;
  for (;;) {
    const $at = doc.resolve(at);
    const before = $at.nodeBefore;
    if (!before) {
      if ($at.depth === 0 || $at.parent.type.spec.isolating) return { pos: at, joins: false };
      at = $at.before();
      continue;
    }
    if (before.isTextblock) return trackKind(before) === "break" ? { pos: at - 1, joins: true } : { pos: at, joins: false };
    if (before.isLeaf || before.isAtom || before.type.spec.isolating) return { pos: at, joins: false };
    at -= 1;
  }
}

/** The textblock whose break follows the one ending at `end` (the position
 *  after it), when only the edges of blocks lie between. */
export function breakAfter(doc: PmNode, end: number): number | null {
  let at = end;
  for (;;) {
    const $at = doc.resolve(at);
    const after = $at.nodeAfter;
    if (!after) {
      if ($at.depth === 0 || $at.parent.type.spec.isolating) return null;
      at = $at.after();
      continue;
    }
    if (after.isTextblock) return trackKind(after) === "break" ? at : null;
    if (after.isLeaf || after.isAtom || after.type.spec.isolating) return null;
    at += 1;
  }
}

/** Every tracked piece, in document order. */
export function piecesOf(doc: PmNode): Piece[] {
  const out: Piece[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      for (const mark of node.marks) {
        const name = mark.type.name;
        if (name !== INSERTION && name !== DELETION) continue;
        out.push({ kind: name === INSERTION ? "ins" : "del", rev: revOf(mark.attrs), what: "text", from: pos, to: pos + node.nodeSize, pos, name: "text" });
      }
      return false;
    }
    const kind = trackKind(node);
    if (!kind) return true;
    const revs = parseRevs(node.attrs.tc);
    if (!revs) return kind === "break" || !node.isLeaf;
    if (kind === "break") {
      const start = breakStart(doc, pos).pos;
      for (const k of ["ins", "del"] as const) {
        if (revs[k]) out.push({ kind: k, rev: revs[k]!, what: "break", from: start, to: pos + 1, pos, name: node.type.name });
      }
      return true;
    }
    for (const k of ["ins", "del"] as const) {
      if (revs[k]) out.push({ kind: k, rev: revs[k]!, what: "node", from: pos, to: pos + node.nodeSize, pos, name: node.type.name });
    }
    // What's inside a thing added or removed whole goes with it.
    return false;
  });
  return out;
}

/** Whether nothing but the ends of blocks lies between two positions (a
 *  struck paragraph end, then a struck picture: one change). */
function onlyClosings(doc: PmNode, from: number, to: number): boolean {
  if (to - from > 16) return false;
  for (let pos = from; pos < to; pos += 1) {
    if (doc.resolve(pos).nodeAfter) return false;
  }
  return true;
}

/** Whether a document has any tracked change at all (cheaper than listing). */
export function hasChanges(doc: PmNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.isText) {
      if (node.marks.some((m) => m.type.name === INSERTION || m.type.name === DELETION)) found = true;
      return false;
    }
    if (node.attrs.tc && parseRevs(node.attrs.tc)) found = true;
    return !found;
  });
  return found;
}

/** The document's changes, in the order they come in the text. */
export function changesOf(doc: PmNode): Change[] {
  const pieces = piecesOf(doc);
  const out: Change[] = [];
  for (const kind of ["del", "ins"] as const) {
    let cur: Change | null = null;
    for (const piece of pieces) {
      if (piece.kind !== kind) continue;
      if (cur && piece.rev.a === cur.author && (piece.from <= cur.to || onlyClosings(doc, cur.to, piece.from))) {
        cur.to = Math.max(cur.to, piece.to);
        cur.pieces.push(piece);
        // The change is as old as its first keystroke.
        if (piece.rev.t && (!cur.time || piece.rev.t < cur.time)) cur.time = piece.rev.t;
      } else {
        cur = { id: "", kind, author: piece.rev.a, time: piece.rev.t, from: piece.from, to: piece.to, pieces: [piece] };
        out.push(cur);
      }
    }
  }
  // A deletion before the insertion that replaces it.
  out.sort((x, y) => x.from - y.from || (x.kind === y.kind ? x.to - y.to : x.kind === "del" ? -1 : 1));
  out.forEach((change) => {
    change.id = `${change.kind}:${change.from}:${change.to}`;
  });
  return out;
}

/** The words a change is about (its marked text; breaks as a pilcrow). */
export function changeText(doc: PmNode, change: Change, max = 160): string {
  let text = "";
  for (const piece of change.pieces) {
    if (text.length > max) break;
    if (piece.what === "text") text += doc.textBetween(piece.from, piece.to);
    else if (piece.what === "break") text += text || change.pieces.length > 1 ? " ¶ " : "";
    else text += ` [${NODE_NAMES[piece.name] ?? piece.name}] `;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

const NODE_NAMES: Record<string, string> = {
  image: "picture",
  table: "table",
  horizontalRule: "divider",
  hardBreak: "line break",
  footnote: "note",
  toc: "contents",
  codeBlock: "code",
};

/** "a paragraph break", "a picture" — when a change has no words. */
export function changeThing(change: Change): string {
  const first = change.pieces[0];
  if (change.pieces.every((p) => p.what === "break")) return change.pieces.length > 1 ? "paragraph breaks" : "a paragraph break";
  if (first.what === "node") {
    const name = NODE_NAMES[first.name] ?? first.name;
    return /^[aeiou]/.test(name) ? `an ${name}` : name === "contents" || name === "code" ? name : `a ${name}`;
  }
  return "text";
}

/** One entry of the list of changes: a change, or a deletion together with
 *  the insertion that replaces it. */
export interface ChangeGroup {
  id: string;
  author: string;
  time: number;
  from: number;
  to: number;
  kind: "ins" | "del" | "replace";
  changes: Change[];
}

export function groupChanges(changes: Change[]): ChangeGroup[] {
  const out: ChangeGroup[] = [];
  for (let i = 0; i < changes.length; i += 1) {
    const c = changes[i];
    const next = changes[i + 1];
    if (c.kind === "del" && next && next.kind === "ins" && next.author === c.author && next.from === c.to) {
      out.push({ id: `${c.id}+${next.id}`, author: c.author, time: c.time || next.time, from: c.from, to: next.to, kind: "replace", changes: [c, next] });
      i += 1;
    } else {
      out.push({ id: c.id, author: c.author, time: c.time, from: c.from, to: c.to, kind: c.kind, changes: [c] });
    }
  }
  return out;
}

/** The changes a selection touches (a caret: the one it is in or beside). */
export function changesAt(changes: Change[], from: number, to: number): Change[] {
  return changes.filter((c) => (from === to ? c.from <= from && from <= c.to : c.from < to && from < c.to));
}
