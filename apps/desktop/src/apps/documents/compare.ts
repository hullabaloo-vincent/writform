/**
 * Comparing two versions of a document, for reading side by side.
 *
 * Paragraph by paragraph first — an exact alignment, so a paragraph that
 * only moved down because one was added above it reads as unchanged — then
 * word by word inside the paragraphs that changed. Text only: formatting
 * isn't compared, and a version's own tracked changes read as accepted.
 */

import type { JSONContent } from "@tiptap/core";

import { blockHunks } from "./restore";

/** Words in a piece of a paragraph (a full stop alone isn't one). */
const countWords = (text: string): number => (text.match(/[\p{L}\p{N}'’]+/gu) ?? []).length;

export interface CompareBlock {
  /** What it is: "paragraph", "heading", … (a change of kind is a change). */
  kind: string;
  text: string;
}

export interface Segment {
  text: string;
  op: "same" | "del" | "ins";
}

export interface CompareRow {
  status: "same" | "changed" | "added" | "removed";
  /** The older side's paragraph, with what was taken out marked. */
  left: Segment[] | null;
  /** The newer side's, with what was put in marked. */
  right: Segment[] | null;
  /** Both in one: what went struck, what came marked. */
  merged: Segment[];
  leftKind?: string;
  rightKind?: string;
}

export interface Comparison {
  rows: CompareRow[];
  changed: number;
  wordsAdded: number;
  wordsRemoved: number;
}

const DELETION = "deletion";

/** Every paragraph-like block of a document, in reading order: lists and
 *  tables give their paragraphs; a picture or a divider is a line of its
 *  own, so adding or removing one shows. */
export function flattenBlocks(doc: JSONContent): CompareBlock[] {
  const out: CompareBlock[] = [];
  const inline = (nodes: JSONContent[]): string =>
    nodes
      .map((node) => {
        if (node.marks?.some((m) => m.type === DELETION)) return "";
        if (typeof node.attrs?.tc === "string" && node.attrs.tc.includes("del:")) return "";
        if (node.type === "text") return node.text ?? "";
        if (node.type === "hardBreak") return "\n";
        if (node.type === "footnote") return ` [${inline(node.content ?? [])}]`;
        return "";
      })
      .join("");
  const walk = (node: JSONContent) => {
    const type = node.type ?? "paragraph";
    const whole = typeof node.attrs?.tc === "string" && node.attrs.tc.includes("del:") && type !== "paragraph" && type !== "heading";
    if (whole) return;
    if (type === "paragraph" || type === "heading" || type === "codeBlock") {
      const kind = type === "heading" ? `heading ${Number(node.attrs?.level) || 1}` : type === "paragraph" ? String(node.attrs?.element || "paragraph") : "code";
      out.push({ kind, text: inline(node.content ?? []) });
      return;
    }
    if (type === "image") out.push({ kind: "picture", text: String(node.attrs?.caption ?? "") });
    else if (type === "horizontalRule") out.push({ kind: "divider", text: "" });
    else if (type === "toc") out.push({ kind: "contents", text: "" });
    else (node.content ?? []).forEach(walk);
  };
  (doc.content ?? []).forEach(walk);
  return out;
}

/** Words, the spaces between them, and punctuation, each a token. */
export function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

const TOKEN_LIMIT = 4000;

/** The two sides of a changed paragraph, and both in one line. */
export function diffWords(before: string, after: string): { left: Segment[]; right: Segment[]; merged: Segment[] } {
  const a = tokens(before);
  const b = tokens(after);
  const left: Segment[] = [];
  const right: Segment[] = [];
  const merged: Segment[] = [];
  const push = (list: Segment[], text: string, op: Segment["op"]) => {
    if (!text) return;
    const last = list[list.length - 1];
    if (last && last.op === op) last.text += text;
    else list.push({ text, op });
  };
  if (a.length > TOKEN_LIMIT || b.length > TOKEN_LIMIT) {
    push(left, before, "del");
    push(right, after, "ins");
    push(merged, before, "del");
    push(merged, after, "ins");
    return { left, right, merged };
  }
  let i = 0;
  let j = 0;
  const same = (to: number) => {
    const text = a.slice(i, to).join("");
    push(left, text, "same");
    push(right, text, "same");
    push(merged, text, "same");
  };
  for (const hunk of blockHunks(a, b)) {
    same(hunk.oldStart);
    const gone = a.slice(hunk.oldStart, hunk.oldEnd).join("");
    const come = b.slice(hunk.newStart, hunk.newEnd).join("");
    push(left, gone, "del");
    push(right, come, "ins");
    push(merged, gone, "del");
    push(merged, come, "ins");
    i = hunk.oldEnd;
    j = hunk.newEnd;
  }
  void j;
  same(a.length);
  return { left, right, merged };
}

/** How alike two paragraphs are, 0–1: the share of their words in common. */
function likeness(a: string, b: string): number {
  if (a === b) return 1;
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      shared += 1;
      counts.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

/** Enough in common to be the same paragraph, rewritten. */
const ALIKE = 0.35;
/** Above this many pairings a stretch of rewriting is paired in order. */
const PAIR_LIMIT = 40000;

/** Within a stretch where the two sides differ: which old paragraph became
 *  which new one (the pairing with the most in common, kept in order). */
function pair(a: CompareBlock[], b: CompareBlock[]): [number | null, number | null][] {
  const out: [number | null, number | null][] = [];
  if (!a.length || !b.length || a.length * b.length > PAIR_LIMIT) {
    // Nothing to pair, or too much: side by side in order, the rest alone.
    const both = a.length && b.length ? Math.min(a.length, b.length) : 0;
    for (let k = 0; k < both; k += 1) out.push([k, k]);
    for (let k = both; k < a.length; k += 1) out.push([k, null]);
    for (let k = both; k < b.length; k += 1) out.push([null, k]);
    return out;
  }
  const n = a.length;
  const m = b.length;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const like = Array.from({ length: n }, (_, x) => Float64Array.from({ length: m }, (_, y) => likeness(a[x].text, b[y].text)));
  for (let x = n - 1; x >= 0; x -= 1) {
    for (let y = m - 1; y >= 0; y -= 1) {
      const together = like[x][y] >= ALIKE ? like[x][y] + score[x + 1][y + 1] : -1;
      score[x][y] = Math.max(score[x + 1][y], score[x][y + 1], together);
    }
  }
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    const together = like[x][y] >= ALIKE ? like[x][y] + score[x + 1][y + 1] : -1;
    if (together >= score[x + 1][y] && together >= score[x][y + 1]) {
      out.push([x, y]);
      x += 1;
      y += 1;
    } else if (score[x + 1][y] >= score[x][y + 1]) {
      out.push([x, null]);
      x += 1;
    } else {
      out.push([null, y]);
      y += 1;
    }
  }
  for (; x < n; x += 1) out.push([x, null]);
  for (; y < m; y += 1) out.push([null, y]);
  return out;
}

const key = (block: CompareBlock) => `${block.kind}\n${block.text}`;

/** `before` and `after` as rows to read across. */
export function compareDocs(before: JSONContent, after: JSONContent): Comparison {
  const a = flattenBlocks(before);
  const b = flattenBlocks(after);
  const rows: CompareRow[] = [];
  let changed = 0;
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let i = 0;
  const same = (to: number) => {
    for (; i < to; i += 1) {
      const seg: Segment[] = [{ text: a[i].text, op: "same" }];
      rows.push({ status: "same", left: seg, right: seg, merged: seg, leftKind: a[i].kind, rightKind: a[i].kind });
    }
  };
  for (const hunk of blockHunks(a.map(key), b.map(key))) {
    same(hunk.oldStart);
    const olds = a.slice(hunk.oldStart, hunk.oldEnd);
    const news = b.slice(hunk.newStart, hunk.newEnd);
    for (const [x, y] of pair(olds, news)) {
      changed += 1;
      if (x !== null && y !== null) {
        const words = diffWords(olds[x].text, news[y].text);
        for (const seg of words.left) if (seg.op === "del") wordsRemoved += countWords(seg.text);
        for (const seg of words.right) if (seg.op === "ins") wordsAdded += countWords(seg.text);
        rows.push({ status: "changed", left: words.left, right: words.right, merged: words.merged, leftKind: olds[x].kind, rightKind: news[y].kind });
      } else if (x !== null) {
        wordsRemoved += countWords(olds[x].text);
        const seg: Segment[] = [{ text: olds[x].text, op: "del" }];
        rows.push({ status: "removed", left: seg, right: null, merged: seg, leftKind: olds[x].kind });
      } else if (y !== null) {
        wordsAdded += countWords(news[y].text);
        const seg: Segment[] = [{ text: news[y].text, op: "ins" }];
        rows.push({ status: "added", left: null, right: seg, merged: seg, rightKind: news[y].kind });
      }
    }
    i = hunk.oldEnd;
  }
  same(a.length);
  return { rows, changed, wordsAdded, wordsRemoved };
}
