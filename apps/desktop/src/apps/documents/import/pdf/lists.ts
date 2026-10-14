/**
 * Lists found among paragraphs.
 *
 * A list is paragraphs that each begin with a bullet or with the next
 * number, two of them or more. An item set further in than the one before
 * it begins a list inside that one. A paragraph without a marker, set in to
 * where an item's words are, is more of that item.
 *
 * A dash is a bullet only where the words that follow it hang under each
 * other: a line of speech begins with a dash too, in most of Europe's
 * novels, and a page of talk is not a list.
 */

import type { Block, ListBlock, ParaBlock } from "./model";
import { textOf } from "./paras";

const DASHES = `-${String.fromCharCode(0x2013, 0x2014)}`;
// (The hyphen last in its class: anywhere else it would mean "from here to there".)
const BULLET = new RegExp(`^([${String.fromCharCode(0x2022, 0x25e6, 0x25aa, 0x25ab, 0x25cf, 0x25cb, 0x25a0, 0x25a1, 0x2023, 0x2043, 0x00b7, 0xf0b7, 0xf0a7, 0x2013, 0x2014)}*-])\\s+`);
const NUMBER = /^\(?(\d{1,3}|[a-zA-Z]|[ivxlc]{1,5}|[IVXLC]{1,5})([.)])\s+/;

interface Marker {
  ordered: boolean;
  /** How much of the paragraph's start it is. */
  length: number;
  dash: boolean;
  raw: string;
}

function markerOf(text: string): Marker | null {
  const bullet = BULLET.exec(text);
  if (bullet) return { ordered: false, length: bullet[0].length, dash: DASHES.includes(bullet[1]), raw: bullet[1] };
  const number = NUMBER.exec(text);
  if (number) return { ordered: true, length: number[0].length, dash: false, raw: number[1] };
  return null;
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function roman(raw: string): number {
  let total = 0;
  const s = raw.toLowerCase();
  for (let k = 0; k < s.length; k += 1) {
    const here = ROMAN[s[k]] ?? 0;
    total += here < (ROMAN[s[k + 1]] ?? 0) ? -here : here;
  }
  return total;
}

/** How a list counts ("1" "a" "A" "i" "I"), told by its first number, and
 *  what that number is. */
function counting(raw: string): { numbering: string; start: number } {
  if (/^\d+$/.test(raw)) return { numbering: "1", start: Number(raw) };
  const upper = raw === raw.toUpperCase();
  // (A list that begins with "i" counts in Roman. One that begins with "a"
  // counts in letters.)
  if (/^[ivxlc]+$/i.test(raw) && (raw.length > 1 || raw.toLowerCase() === "i")) return { numbering: upper ? "I" : "i", start: roman(raw) };
  return { numbering: upper ? "A" : "a", start: raw.toLowerCase().charCodeAt(0) - 96 };
}

/** A paragraph without its first `length` characters. */
function without(para: ParaBlock, length: number): ParaBlock {
  let left = length;
  const spans = para.spans
    .map((span) => {
      if (left <= 0 || span.note) return span;
      const cut = Math.min(left, span.text.length);
      left -= cut;
      return { ...span, text: span.text.slice(cut) };
    })
    .filter((span) => span.text.length > 0 || span.note);
  const { indent: _indent, inset: _inset, ...rest } = para;
  return { ...rest, spans };
}

/** Whether a paragraph without a marker is more of the item before it:
 *  all of it set in to where the item's words are (a first line that
 *  starts in is only a paragraph beginning). */
function more(para: ParaBlock, item: ParaBlock): boolean {
  const words = item.hang ?? item.x + 12;
  if (words <= item.x + 6) return false;
  return para.x >= words - 4 && (para.hang === undefined || para.hang >= words - 4);
}

interface Item {
  para: ParaBlock;
  marker: Marker;
  more: ParaBlock[];
}

export function findLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let k = 0;
  while (k < blocks.length) {
    const b = blocks[k];
    const first = b.kind === "para" && !b.heading && !b.element ? markerOf(textOf(b)) : null;
    if (!first) {
      out.push(b);
      k += 1;
      continue;
    }
    const items: Item[] = [];
    let j = k;
    while (j < blocks.length) {
      const c = blocks[j];
      if (c.kind !== "para" || c.heading || c.element) break;
      const marker = markerOf(textOf(c));
      const last = items[items.length - 1];
      if (marker) items.push({ para: c, marker, more: [] });
      else if (last && more(c, last.para)) last.more.push(c);
      else break;
      j += 1;
    }
    // A dash begins a line of speech as often as an item: it is a bullet
    // only where an item's words hang under each other.
    const hangs = items.some((item) => item.para.hang !== undefined && item.para.hang > item.para.x + 6);
    const real = items.filter((item) => !item.marker.dash || hangs);
    if (real.length < 2 || real.length !== items.length) {
      out.push(b);
      k += 1;
      continue;
    }

    // How deep each item is: by how far in it starts.
    const levels: number[] = [];
    for (const x of items.map((item) => item.para.x).sort((a, c) => a - c)) {
      if (!levels.length || x - levels[levels.length - 1] > 6) levels.push(x);
    }
    const depthOf = (item: Item) => {
      let depth = 0;
      for (let d = 0; d < levels.length; d += 1) if (item.para.x >= levels[d] - 3) depth = d;
      return depth;
    };
    const stack: { depth: number; list: ListBlock }[] = [];
    for (const item of items) {
      const depth = depthOf(item);
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
      let top = stack[stack.length - 1];
      if (top && top.depth === depth && top.list.ordered !== item.marker.ordered) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (!top || top.depth < depth) {
        const list: ListBlock = { kind: "list", page: item.para.page, ordered: item.marker.ordered, items: [], ...(item.marker.ordered ? counting(item.marker.raw) : {}) };
        if (top) top.list.items[top.list.items.length - 1].blocks.push(list);
        else out.push(list);
        stack.push({ depth, list });
        top = stack[stack.length - 1];
      }
      top.list.items.push({ blocks: [without(item.para, item.marker.length), ...item.more.map((para) => without(para, 0))] });
    }
    k = j;
  }
  return out;
}
