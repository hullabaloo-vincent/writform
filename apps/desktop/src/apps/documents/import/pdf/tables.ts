/**
 * Tables found on a page.
 *
 * A PDF has no tables, only what one looks like. Two looks are known here.
 * A ruled one: lines across and lines down that meet in a grid, with text
 * in the boxes (a box with no line between it and the next is one cell
 * across both). And one set in space alone: rows of short pieces of text
 * whose edges line up down the page, three columns of them, or two over
 * three rows or more.
 *
 * Text set in columns lines up down the page too, and is not a table: where
 * the pieces are lines of running text, they are left to be read as
 * columns (order.ts). So is a list, whose numbers stand in a column of
 * their own.
 */

import { makeLine } from "./lines";
import type { Block, Line, PageData, Rule, TableBlock, TableCell } from "./model";

export interface FoundTable {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  block: TableBlock;
  /** The lines it took. */
  used: Set<Line>;
}

/** Values that are one value, a little apart: each cluster's middle. */
function clusters(values: number[], within: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= within) last.push(v);
    else out.push([v]);
  }
  return out.map((group) => group.reduce((sum, v) => sum + v, 0) / group.length);
}

const across = (r: Rule) => Math.abs(r.y0 - r.y1) < 1;
const TOUCH = 2.5;

/** A line cut where it crosses the given places (a cell's edges). */
function cutAt(line: Line, xs: number[]): Line[] {
  const groups = new Map<number, typeof line.runs>();
  for (const run of line.runs) {
    const mid = run.x + run.w / 2;
    let k = 0;
    while (k < xs.length && mid > xs[k]) k += 1;
    const group = groups.get(k);
    if (group) group.push(run);
    else groups.set(k, [run]);
  }
  if (groups.size < 2) return [line];
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, runs]) => makeLine(line.page, runs.map((run) => ({ ...run, text: run.text.trim() }))));
}

const allBold = (lines: Line[]) => lines.length > 0 && lines.every((line) => line.runs.every((run) => run.bold || !run.text.trim()));

/** Tables drawn with lines. */
function ruled(page: PageData, lines: Line[], toBlocks: (lines: Line[]) => Block[]): FoundTable[] {
  const rules = page.rules;
  // (A page of thousands of lines is a drawing, and too much to sort out.)
  if (rules.length < 4 || rules.length > 1500) return [];
  // Which lines touch which: a table is lines that hang together.
  const group = rules.map((_, k) => k);
  const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
  for (let a = 0; a < rules.length; a += 1) {
    for (let b = a + 1; b < rules.length; b += 1) {
      const h = across(rules[a]) ? rules[a] : rules[b];
      const v = across(rules[a]) ? rules[b] : rules[a];
      if (across(rules[a]) === across(rules[b])) continue;
      if (v.x0 >= h.x0 - TOUCH && v.x0 <= h.x1 + TOUCH && h.y0 >= v.y0 - TOUCH && h.y0 <= v.y1 + TOUCH) group[find(a)] = find(b);
    }
  }
  const sets = new Map<number, Rule[]>();
  rules.forEach((rule, k) => {
    const root = find(k);
    const set = sets.get(root);
    if (set) set.push(rule);
    else sets.set(root, [rule]);
  });

  const out: FoundTable[] = [];
  for (const set of sets.values()) {
    const hs = set.filter(across);
    const vs = set.filter((r) => !across(r));
    const ys = clusters(hs.map((r) => r.y0), TOUCH);
    const xs = clusters(vs.map((r) => r.x0), TOUCH);
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    if (rows < 1 || cols < 1 || rows * cols < 2) continue;
    const x0 = xs[0];
    const x1 = xs[cols];
    const top = ys[0];
    const bottom = ys[rows];

    // Whether there is a line between two boxes.
    const wallRight = (r: number, c: number) => {
      const mid = (ys[r] + ys[r + 1]) / 2;
      return vs.some((v) => Math.abs(v.x0 - xs[c + 1]) <= TOUCH && v.y0 <= mid && v.y1 >= mid);
    };
    const wallBelow = (r: number, c: number) => {
      const mid = (xs[c] + xs[c + 1]) / 2;
      return hs.some((h) => Math.abs(h.y0 - ys[r + 1]) <= TOUCH && h.x0 <= mid && h.x1 >= mid);
    };

    const inside = lines.filter((line) => {
      const cy = (line.top + line.bottom) / 2;
      return cy > top - 1 && cy < bottom + 1 && line.x1 > x0 && line.x0 < x1;
    });
    if (!inside.length) continue;
    const pieces = inside.flatMap((line) => cutAt(line, xs.slice(1, -1)));

    const taken = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
    const grid: TableCell[][] = [];
    const held: Line[][][] = [];
    let cells = 0;
    for (let r = 0; r < rows; r += 1) {
      const row: TableCell[] = [];
      const rowLines: Line[][] = [];
      for (let c = 0; c < cols; c += 1) {
        if (taken[r][c]) continue;
        let colspan = 1;
        while (c + colspan < cols && !wallRight(r, c + colspan - 1) && !taken[r][c + colspan]) colspan += 1;
        let rowspan = 1;
        while (r + rowspan < rows && !wallBelow(r + rowspan - 1, c)) rowspan += 1;
        for (let dr = 0; dr < rowspan; dr += 1) for (let dc = 0; dc < colspan; dc += 1) taken[r + dr][c + dc] = true;
        const left = xs[c];
        const right = xs[c + colspan];
        const upper = ys[r];
        const lower = ys[r + rowspan];
        const own = pieces.filter((line) => {
          const cx = (line.x0 + line.x1) / 2;
          const cy = (line.top + line.bottom) / 2;
          return cx >= left && cx < right && cy >= upper && cy < lower;
        });
        for (const line of own) {
          line.left = left + 3;
          line.right = right - 3;
        }
        const shade = page.fills.find((f) => Math.abs(f.box.x - left) <= 3 && Math.abs(f.box.x + f.box.w - right) <= 3 && Math.abs(f.box.y - upper) <= 3 && Math.abs(f.box.y + f.box.h - lower) <= 3);
        row.push({ blocks: toBlocks(own), colspan, rowspan, ...(shade ? { bg: shade.color } : {}) });
        rowLines.push(own);
        cells += 1;
      }
      grid.push(row);
      held.push(rowLines);
    }
    // One box round some text is a box, not a table.
    if (cells < 2) continue;
    const firstRow = held[0].flat();
    const rest = held.slice(1).flat(2);
    out.push({
      x0,
      x1,
      top,
      bottom,
      used: new Set(inside),
      block: {
        kind: "table",
        page: page.n,
        cols: xs.slice(1).map((x, k) => x - xs[k]),
        rows: grid,
        head: rows > 1 && allBold(firstRow) && !allBold(rest),
        ruled: true,
      },
    });
  }
  return out;
}

interface Band {
  x0: number;
  x1: number;
}

const MARK_ONLY = new RegExp(`^(?:[${String.fromCharCode(0x2022, 0x25e6, 0x25aa, 0x25ab, 0x25cf, 0x25cb, 0x25a0, 0x25a1, 0x2023, 0x2043, 0x00b7, 0x2013, 0x2014, 0xf0b7, 0xf0a7)}*-]|\\(?(?:\\d{1,3}|[a-zA-Z]|[ivxlc]{1,5}|[IVXLC]{1,5})[.)])$`);

/** Whether most of some pieces share an edge or a middle, to 4 points. */
function aligned(pieces: Line[]): boolean {
  if (pieces.length < 2) return true;
  const share = (of: (line: Line) => number) => {
    const groups = clusters(pieces.map(of), 4);
    return Math.max(...groups.map((g) => pieces.filter((line) => Math.abs(of(line) - g) <= 4).length));
  };
  const best = Math.max(share((l) => l.x0), share((l) => l.x1), share((l) => (l.x0 + l.x1) / 2));
  return best >= pieces.length * 0.6;
}

/** Tables set in space alone. */
function spaced(page: PageData, lines: Line[], unit: number, toBlocks: (lines: Line[]) => Block[]): FoundTable[] {
  // The page's rows: pieces of text on one baseline.
  const rows: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - line.y) <= Math.max(1, Math.min(last[0].size, line.size) * 0.2)) last.push(line);
    else rows.push([line]);
  }
  const out: FoundTable[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].length < 2) {
      k += 1;
      continue;
    }
    // A stretch of rows that begins and ends with rows of several pieces,
    // none of them far below the one before.
    let end = k;
    for (let j = k + 1; j < rows.length; j += 1) {
      const gap = rows[j][0].y - rows[j - 1][0].y;
      if (gap > Math.max(rows[j][0].size, rows[j - 1][0].size) * 3) break;
      if (rows[j].length >= 2) end = j;
      else if (j - end > 3) break;
    }
    const stretch = rows.slice(k, end + 1);
    const many = stretch.filter((row) => row.length >= 2);
    const next = end + 1;

    // Its columns: where the pieces of those rows stand, taken together.
    const bands: Band[] = [];
    for (const piece of many.flat().sort((a, b) => a.x0 - b.x0)) {
      const last = bands[bands.length - 1];
      if (last && piece.x0 <= last.x1 + unit * 0.5) last.x1 = Math.max(last.x1, piece.x1);
      else bands.push({ x0: piece.x0, x1: piece.x1 });
    }
    const bandOf = (line: Line) => bands.findIndex((b) => (line.x0 + line.x1) / 2 >= b.x0 - 1 && (line.x0 + line.x1) / 2 <= b.x1 + 1);
    const spans = (line: Line) => bands.filter((b) => line.x1 > b.x0 + 1 && line.x0 < b.x1 - 1).length;
    const columns = bands.length;
    const enoughRows = columns >= 3 ? many.length >= 2 : many.length >= 3;
    let ok = columns >= 2 && enoughRows;
    // Every row's pieces each in a column of their own.
    if (ok) ok = many.every((row) => new Set(row.map(bandOf)).size === row.length && row.every((piece) => bandOf(piece) >= 0 && spans(piece) === 1));
    // A line on its own belongs to one column (a cell's second line), or
    // the table stops before it.
    let rowsIn = stretch;
    if (ok) {
      const stop = stretch.findIndex((row) => row.length === 1 && (bandOf(row[0]) < 0 || spans(row[0]) !== 1));
      if (stop >= 0) {
        rowsIn = stretch.slice(0, stop);
        const left = rowsIn.filter((row) => row.length >= 2).length;
        ok = columns >= 3 ? left >= 2 : left >= 3;
        // (What comes after the stop is looked at again, from there.)
        if (!ok) rowsIn = stretch;
      }
    }
    const pieces = (c: number) => rowsIn.flat().filter((line) => bandOf(line) === c);
    // Columns whose pieces line up.
    if (ok) ok = bands.filter((_, c) => aligned(pieces(c))).length >= columns - 1;
    // Not a list: its numbers or bullets are not a column of a table.
    if (ok) {
      const first = pieces(0);
      if (bands[0].x1 - bands[0].x0 <= unit * 3 && first.filter((line) => MARK_ONLY.test(line.text.trim())).length >= first.length * 0.8) ok = false;
    }
    // Not text in columns: lines that fill their column, long ones.
    if (ok) {
      const prose = bands.filter((b, c) => {
        const own = pieces(c);
        const full = own.filter((line) => line.x1 - line.x0 >= (b.x1 - b.x0) * 0.6).length;
        const letters = own.reduce((sum, line) => sum + line.text.length, 0) / Math.max(1, own.length);
        return b.x1 - b.x0 >= unit * 6 && full >= own.length * 0.5 && letters >= 25 && own.length >= 4;
      }).length;
      if (prose >= 2) ok = false;
    }
    if (!ok) {
      k = next;
      continue;
    }

    // Rows of cells: a row of several pieces begins one, a line alone
    // under it goes on in its column.
    const cells: Line[][][] = [];
    for (const row of rowsIn) {
      if (row.length >= 2 || !cells.length) cells.push(bands.map(() => []));
      const into = cells[cells.length - 1];
      for (const piece of row) into[Math.max(0, bandOf(piece))].push(piece);
    }
    const edges = [bands[0].x0, ...bands.slice(1).map((b, c) => (bands[c].x1 + b.x0) / 2), bands[columns - 1].x1];
    const used = new Set(rowsIn.flat());
    const grid: TableCell[][] = cells.map((row) =>
      row.map((own, c) => {
        for (const line of own) {
          line.left = bands[c].x0;
          line.right = bands[c].x1;
        }
        return { blocks: toBlocks(own), colspan: 1, rowspan: 1 };
      }),
    );
    const all = rowsIn.flat();
    out.push({
      x0: bands[0].x0,
      x1: bands[columns - 1].x1,
      top: Math.min(...all.map((l) => l.top)),
      bottom: Math.max(...all.map((l) => l.bottom)),
      used,
      block: { kind: "table", page: page.n, cols: edges.slice(1).map((x, c) => x - edges[c]), rows: grid, head: cells.length > 1 && allBold(cells[0].flat()) && !allBold(cells.slice(1).flat(2)), ruled: false },
    });
    k += rowsIn.length;
  }
  return out;
}

/**
 * The tables of a page. `toBlocks` makes what is inside a cell of the lines
 * that are in it. `unit` is the height of the page's text.
 */
export function findTables(page: PageData, lines: Line[], unit: number, toBlocks: (lines: Line[]) => Block[]): FoundTable[] {
  const drawn = ruled(page, lines, toBlocks);
  const taken = new Set(drawn.flatMap((t) => [...t.used]));
  const rest = lines.filter((line) => !taken.has(line));
  return [...drawn, ...spaced(page, rest, unit, toBlocks)];
}
