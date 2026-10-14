/**
 * The order a page is read in.
 *
 * Top to bottom is right until a page has columns. Then the left column is
 * read to its foot before the right one is begun, and what runs across both
 * (a title above them, a table between them) is read where it stands.
 *
 * Columns are found by their gutter: a strip of clear paper, at least as
 * wide as a line of the text is tall, running down a good part of the page
 * with text on both sides of it. The page is cut there, and each part is
 * looked at again the same way, so columns under a title under a banner
 * come out in order too.
 */

import { joinLines } from "./lines";
import type { Line } from "./model";

/** Something with a place on the page. */
export interface Placed {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** A line of text. */
  line?: Line;
}

export interface Region<T extends Placed> {
  items: T[];
  x0: number;
  x1: number;
  /** One of several columns side by side. */
  column: boolean;
}

const extent = <T extends Placed>(items: T[]) => ({
  x0: Math.min(...items.map((it) => it.x0)),
  x1: Math.max(...items.map((it) => it.x1)),
  top: Math.min(...items.map((it) => it.top)),
  bottom: Math.max(...items.map((it) => it.bottom)),
});

/** Top to bottom, and left to right where two stand level. */
function downThePage<T extends Placed>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const out: T[] = [];
  let row: T[] = [];
  const flush = () => {
    out.push(...row.sort((a, b) => a.x0 - b.x0));
    row = [];
  };
  for (const it of sorted) {
    const first = row[0];
    // (Level: more than half of the shorter one's height is shared.)
    if (first && Math.min(first.bottom, it.bottom) - Math.max(first.top, it.top) <= Math.min(first.bottom - first.top, it.bottom - it.top) * 0.5) flush();
    row.push(it);
  }
  flush();
  return out;
}

/** Whether a side of a gutter reads as a column of running text: wide
 *  enough, and most of its lines run most of its width. */
function proseLike<T extends Placed>(side: T[], unit: number): { ok: boolean; letters: number } {
  const { x0, x1 } = extent(side);
  const width = x1 - x0;
  const full = side.filter((it) => it.x1 - it.x0 >= width * 0.6).length;
  const letters = side.reduce((sum, it) => sum + (it.line?.text.length ?? 40), 0) / side.length;
  return { ok: width >= unit * 6 && full >= side.length * 0.5, letters };
}

interface Cut {
  /** The stretch of `items` (in order down the page) the gutter runs beside. */
  from: number;
  to: number;
  at: number;
  height: number;
}

function findGutter<T extends Placed>(items: T[], unit: number, known: number[]): Cut | null {
  const all = extent(items);
  const least = (all.bottom - all.top) * 0.3;
  // Where a gutter may be: after the end of any line, and wherever another
  // page of the document has one (a last page whose second column is two
  // lines long has columns all the same).
  const strips = [...new Set(items.map((it) => Math.round(it.x1 / 2) * 2))].map((edge) => ({ l: edge + 0.5, r: edge + unit, told: false }));
  for (const at of known) strips.push({ l: at - unit * 0.4, r: at + unit * 0.4, told: true });
  let best: Cut | null = null;
  for (const { l, r, told } of strips) {
    if (r >= all.x1 || l <= all.x0) continue;
    let from = 0;
    const consider = (to: number) => {
      // items[from..to): nothing among them crosses the strip.
      const run = items.slice(from, to);
      const left = run.filter((it) => it.x1 <= l);
      const right = run.filter((it) => it.x0 >= r);
      if (!left.length || !right.length) return;
      const a = extent(left);
      const b = extent(right);
      // Side by side, not one above the other.
      const shared = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (shared < Math.min(a.bottom - a.top, b.bottom - b.top) * 0.5) return;
      const height = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
      const pl = proseLike(left, unit);
      const pr = proseLike(right, unit);
      if (told) {
        // Known from elsewhere: enough that one side is a column of text.
        const longer = left.length >= right.length ? pl : pr;
        if (Math.max(left.length, right.length) < 3 || !longer.ok || longer.letters < 25) return;
      } else {
        if (left.length < 3 || right.length < 3 || height < least) return;
        if (!pl.ok || !pr.ok || Math.max(pl.letters, pr.letters) < 25) return;
      }
      if (!best || height > best.height) best = { from, to, at: (l + r) / 2, height };
    };
    for (let k = 0; k < items.length; k += 1) {
      const it = items[k];
      if (it.x0 < r && it.x1 > l) {
        consider(k);
        from = k + 1;
      }
    }
    consider(items.length);
  }
  return best;
}

interface Cutting {
  unit: number;
  /** Gutters other pages have. */
  known: number[];
  /** Gutters found here. */
  found: number[];
}

function cut<T extends Placed>(items: T[], how: Cutting, column: boolean, out: Region<T>[], depth: number): void {
  if (!items.length) return;
  const { unit } = how;
  const found = depth < 6 && items.length >= 3 ? findGutter(items, unit, how.known) : null;
  if (found) how.found.push(found.at);
  if (!found) {
    const { x0, x1 } = extent(items);
    out.push({ items: downThePage(items), x0, x1, column });
    return;
  }
  const beside = items.slice(found.from, found.to);
  cut(items.slice(0, found.from), how, column, out, depth + 1);
  cut(
    beside.filter((it) => it.x1 <= found.at),
    how,
    true,
    out,
    depth + 1,
  );
  cut(
    beside.filter((it) => it.x0 >= found.at),
    how,
    true,
    out,
    depth + 1,
  );
  cut(items.slice(found.to), how, column, out, depth + 1);
}

/**
 * A page's things in the order they are read, as the stretches they fall
 * into (a column is one), with where its gutters are. `unit` is the height
 * of the page's text. `known` are the gutters of the document's other
 * pages.
 */
export function readingOrder<T extends Placed>(items: T[], unit: number, known: number[] = []): { regions: Region<T>[]; gutters: number[] } {
  const regions: Region<T>[] = [];
  const how: Cutting = { unit: Math.max(6, unit), known, found: [] };
  cut(
    [...items].sort((a, b) => a.top - b.top || a.x0 - b.x0),
    how,
    false,
    regions,
    0,
  );
  return { regions, gutters: how.found };
}

/**
 * Lines that turned out to stand in one row of one stretch were one line
 * with a wide space in it (a name and a date at the two ends of a line):
 * they are joined again.
 */
export function rejoin(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.page === line.page && Math.abs(prev.y - line.y) <= Math.max(1, Math.max(prev.size, line.size) * 0.2) && line.x0 >= prev.x1 - 1) {
      out[out.length - 1] = joinLines(prev, line);
    } else out.push(line);
  }
  return out;
}
