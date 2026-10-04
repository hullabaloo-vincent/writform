/**
 * Restoring a saved version, gently. `setContent` replaced the whole
 * document in one transaction: for a novel that's one enormous sync update,
 * and y-tiptap re-pairs paragraphs by position, so nearly every paragraph
 * was rewritten and every comment anchor drifted.
 *
 * Instead: diff the current and target documents block by block, and apply
 * only the stretches that differ — from the end backwards, so earlier
 * positions stay valid — in bounded transactions. Unchanged paragraphs keep
 * their identity (and their comments); each transaction becomes one bounded
 * Yjs update. The result is checked against the target, with a plain
 * replace as the fallback.
 */

import type { Editor, JSONContent } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";

import { compactDocJson } from "./compactJson";

/** JSON size of one transaction's inserted blocks (well under any server cap). */
const CHUNK_JSON_BYTES = 96 * 1024;

export interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function positionsOf(keys: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  keys.forEach((key, i) => {
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  });
  return map;
}

/** First index in `positions[key]` that is ≥ `from` (binary search). */
function nextAt(positions: Map<string, number[]>, key: string, from: number): number | undefined {
  const list = positions.get(key);
  if (!list) return undefined;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : undefined;
}

/** Largest edit distance the exact diff explores before settling for the
 *  greedy one (bounds its memory at ~16 MB in the worst case). */
const MAX_EDIT_DISTANCE = 2000;

/**
 * Exact block diff: runs of `oldKeys` to replace with runs of `newKeys`.
 * Myers' minimal diff on what's between the shared head and tail —
 * manuscripts repeat blocks (empty lines, "* * *", "Chapter" headings), and
 * a minimal script keeps every untouched paragraph (and its comments) in
 * place. Falls back to the greedy look-ahead for wholesale rewrites.
 */
export function blockHunks(oldKeys: string[], newKeys: string[]): Hunk[] {
  let head = 0;
  while (head < oldKeys.length && head < newKeys.length && oldKeys[head] === newKeys[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldKeys.length - head &&
    tail < newKeys.length - head &&
    oldKeys[oldKeys.length - 1 - tail] === newKeys[newKeys.length - 1 - tail]
  ) {
    tail += 1;
  }
  const a = oldKeys.slice(head, oldKeys.length - tail);
  const b = newKeys.slice(head, newKeys.length - tail);
  if (a.length === 0 && b.length === 0) return [];
  const matches = myersMatches(a, b, MAX_EDIT_DISTANCE);
  const hunks = matches ? hunksFromMatches(matches, a.length, b.length) : greedyHunks(a, b);
  return hunks.map((h) => ({
    oldStart: h.oldStart + head,
    oldEnd: h.oldEnd + head,
    newStart: h.newStart + head,
    newEnd: h.newEnd + head,
  }));
}

/** Myers O((N+M)·D) shortest edit script, as the list of matched (old, new)
 *  index pairs in order; null when the distance exceeds `maxD`. */
function myersMatches(a: string[], b: string[], maxD: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = v before step d, window k ∈ [-d-1, d+1] at index k + d + 1.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxD); d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
          ? v[off + k + 1]
          : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], d: number, n: number, m: number): [number, number][] {
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let step = d; step > 0; step -= 1) {
    const w = trace[step];
    const at = (k: number) => w[k + step + 1];
    const k = x - y;
    const prevK = k === -step || (k !== step && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // The edit lands on (startX, startY); a diagonal snake runs to (x, y).
    const startX = prevK === k + 1 ? prevX : prevX + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  return matches.reverse();
}

function hunksFromMatches(matches: [number, number][], n: number, m: number): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [x, y] of matches) {
    if (x > i || y > j) hunks.push({ oldStart: i, oldEnd: x, newStart: j, newEnd: y });
    i = x + 1;
    j = y + 1;
  }
  if (i < n || j < m) hunks.push({ oldStart: i, oldEnd: n, newStart: j, newEnd: m });
  return hunks;
}

/** The greedy look-ahead of the history view's `alignChanges` (moved blocks
 *  match instead of reading as delete + insert), over exact keys. */
function greedyHunks(oldKeys: string[], newKeys: string[]): Hunk[] {
  const oldPos = positionsOf(oldKeys);
  const newPos = positionsOf(newKeys);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  const close = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  while (i < oldKeys.length && j < newKeys.length) {
    if (oldKeys[i] === newKeys[j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    if (!cur) cur = { oldStart: i, oldEnd: i, newStart: j, newEnd: j };
    const insertedUntil = nextAt(newPos, oldKeys[i], j + 1);
    const deletedUntil = nextAt(oldPos, newKeys[j], i + 1);
    const preferInsert =
      insertedUntil !== undefined &&
      (deletedUntil === undefined || insertedUntil - j <= deletedUntil - i);
    if (preferInsert) {
      j = insertedUntil;
    } else if (deletedUntil !== undefined) {
      i = deletedUntil;
    } else {
      i += 1;
      j += 1;
    }
    cur.oldEnd = i;
    cur.newEnd = j;
  }
  if (i < oldKeys.length || j < newKeys.length) {
    if (!cur) cur = { oldStart: i, oldEnd: i, newStart: j, newEnd: j };
    cur.oldEnd = oldKeys.length;
    cur.newEnd = newKeys.length;
  }
  close();
  return hunks;
}

function chunkNodes(nodes: PmNode[], limit: number): PmNode[][] {
  const chunks: PmNode[][] = [];
  let current: PmNode[] = [];
  let size = 0;
  for (const node of nodes) {
    const bytes = JSON.stringify(node.toJSON()).length;
    if (current.length > 0 && size + bytes > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(node);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const nextFrame = () =>
  new Promise<void>((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 0),
  );

/**
 * Make the editor's document equal `target`, touching only what differs.
 * Resolves "incremental" when the gentle path matched the target exactly,
 * "replaced" when it fell back to a whole-document replace.
 */
export async function applyRestore(
  editor: Editor,
  target: JSONContent,
): Promise<"incremental" | "replaced"> {
  const schema = editor.schema;
  const compactTarget = compactDocJson(target);
  let targetBlocks = compactTarget.content ?? [];
  if (targetBlocks.length === 0) targetBlocks = [{ type: "paragraph" }];

  try {
    const doc = editor.state.doc;
    const current: PmNode[] = [];
    doc.forEach((node) => current.push(node));
    // Start offset of every original block (offsets[n] = end of the doc).
    const offsets: number[] = [];
    let pos = 0;
    for (const node of current) {
      offsets.push(pos);
      pos += node.nodeSize;
    }
    offsets.push(pos);

    const oldKeys = current.map((n) => JSON.stringify(compactDocJson(n.toJSON())));
    const newKeys = targetBlocks.map((b) => JSON.stringify(b));
    const hunks = blockHunks(oldKeys, newKeys);

    // Back to front: blocks before a hunk are untouched, so `offsets` hold.
    for (let h = hunks.length - 1; h >= 0; h -= 1) {
      const hunk = hunks[h];
      const from = offsets[hunk.oldStart];
      const to = offsets[hunk.oldEnd];
      const nodes = targetBlocks
        .slice(hunk.newStart, hunk.newEnd)
        .map((json) => schema.nodeFromJSON(json));
      const chunks = chunkNodes(nodes, CHUNK_JSON_BYTES);
      if (chunks.length === 0) {
        editor.view.dispatch(editor.state.tr.delete(from, to));
      } else {
        let insertAt = from;
        chunks.forEach((chunk, k) => {
          const fragment = Fragment.from(chunk);
          const tr = editor.state.tr;
          if (k === 0) tr.replaceWith(from, to, fragment);
          else tr.insert(insertAt, fragment);
          insertAt += fragment.size;
          editor.view.dispatch(tr);
        });
      }
      // Let the page breathe on long restores (and the sync batch).
      if (h % 8 === 0) await nextFrame();
    }

    const result = JSON.stringify(compactDocJson(editor.getJSON()));
    if (result === JSON.stringify({ ...compactTarget, content: targetBlocks })) {
      return "incremental";
    }
  } catch (e) {
    console.warn("[restore] incremental restore failed; replacing", e);
  }
  editor.commands.setContent(target);
  return "replaced";
}
