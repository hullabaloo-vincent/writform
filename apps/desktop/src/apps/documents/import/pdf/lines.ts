/**
 * A page's strings as lines of text.
 *
 * Strings on one baseline are a row. A row is cut where the space between
 * two strings is too wide to be a space between words: what is left of the
 * cut and what is right of it are two lines (two columns side by side, two
 * cells of a table), to be put in order by whoever knows which (order.ts).
 * A note's raised number joins the line it is set against. Words drawn
 * twice a hair apart, which is how some programs make bold, are one bold
 * word.
 */

import type { Line, Run } from "./model";

/** The size most of a line's letters are in. */
function mainSize(runs: Run[]): number {
  const by = new Map<number, number>();
  for (const run of runs) {
    if (run.shift) continue;
    const key = Math.round(run.size * 2) / 2;
    by.set(key, (by.get(key) ?? 0) + run.text.trim().length);
  }
  let best = runs[0]?.size ?? 12;
  let most = -1;
  for (const [size, letters] of by) {
    if (letters > most) {
      most = letters;
      best = size;
    }
  }
  return best;
}

/** One line from runs that read on from each other, left to right. */
export function makeLine(page: number, parts: Run[]): Line {
  const runs: Run[] = [];
  let right = parts[0].x;
  for (const part of parts) {
    const prev = runs[runs.length - 1];
    if (prev) {
      const gap = part.x - right;
      // (The space takes the style of what it follows.)
      if (!/\s$/.test(prev.text) && !/^\s/.test(part.text) && gap > Math.max(1.5, Math.min(prev.size, part.size) * 0.16)) prev.text += " ";
    }
    runs.push({ ...part, text: part.text.replace(/\s+/g, " ") });
    right = Math.max(right, part.x + part.w);
  }
  const size = mainSize(runs);
  const y = runs.find((run) => !run.shift)?.y ?? runs[0].y;
  return {
    page,
    x0: runs[0].x,
    x1: right,
    y,
    top: y - size * 0.8,
    bottom: y + size * 0.22,
    size,
    runs,
    text: runs
      .map((run) => run.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

interface Row {
  y: number;
  size: number;
  runs: Run[];
}

/**
 * The lines of a page, top to bottom (those on one baseline left to right).
 * `runs` are the strings to read: the page's, or a part of them.
 */
export function linesOf(page: number, runs: Run[]): Line[] {
  const rows: Row[] = [];
  for (const run of [...runs].sort((a, b) => a.y - b.y || a.x - b.x)) {
    // (Rows come in order: only the last few can be this one's.)
    let home: Row | null = null;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 6; k -= 1) {
      const row = rows[k];
      // (By the smaller type of the two: a heading's baseline is not the
      // baseline of the text that happens to stand near it.)
      if (Math.abs(row.y - run.y) <= Math.max(1, Math.min(row.size, run.size) * 0.2)) {
        home = row;
        break;
      }
    }
    if (home) {
      home.runs.push(run);
      home.size = Math.max(home.size, run.size);
    } else rows.push({ y: run.y, size: run.size, runs: [run] });
  }

  // Small type just above a line (or just below it) and up against its
  // words is set on that line: a note's number, a power, a chemical's count.
  for (let k = 0; k < rows.length; k += 1) {
    const small = rows[k];
    if (!small.runs.length) continue;
    for (const j of [k + 1, k - 1]) {
      const big = rows[j];
      if (!big || !big.runs.length || small.size > big.size * 0.8) continue;
      const lift = big.y - small.y;
      const shift = lift > 0 && lift <= big.size * 0.75 ? "up" : lift < 0 && -lift <= big.size * 0.35 ? "down" : null;
      if (!shift) continue;
      // A few characters, up against a word of larger type and not over it.
      const beside = (run: Run) =>
        run.text.trim().length <= 8 &&
        big.runs.some((b) => run.size <= b.size * 0.8 && run.x <= b.x + b.w + big.size * 0.6 && run.x + run.w >= b.x - big.size * 0.6) &&
        big.runs.every((b) => Math.min(run.x + run.w, b.x + b.w) - Math.max(run.x, b.x) <= run.w * 0.3);
      const moved = small.runs.filter(beside);
      if (!moved.length) continue;
      for (const run of moved) big.runs.push({ ...run, shift });
      small.runs = small.runs.filter((run) => !moved.includes(run));
      if (!small.runs.length) break;
    }
  }

  const lines: Line[] = [];
  for (const row of rows) {
    if (!row.runs.length) continue;
    row.runs.sort((a, b) => a.x - b.x);
    // The same words drawn twice a hair apart are one bold word.
    // (One of the two may run on: then it is its start that was doubled.)
    const kept: Run[] = [];
    for (const run of row.runs) {
      const word = run.text.trim();
      const k = kept.findIndex((other) => {
        const theirs = other.text.trim();
        return !other.shift === !run.shift && Math.abs(other.x - run.x) <= run.size * 0.2 && Math.abs(other.y - run.y) <= run.size * 0.2 && theirs.length > 0 && word.length > 0 && (run.text.startsWith(theirs) || other.text.startsWith(word));
      });
      if (k < 0) {
        kept.push(run);
        continue;
      }
      const twin = kept[k];
      const apart = Math.abs(twin.x - run.x) > 0.01 || Math.abs(twin.y - run.y) > 0.01;
      const longer = run.text.length > twin.text.length ? run : twin;
      const head = Math.min(word.length, twin.text.trim().length);
      if (longer.text.trim().length === head) {
        if (apart) twin.bold = true;
        continue;
      }
      const part = longer.w * (head / longer.text.length);
      kept.splice(k, 1, { ...longer, text: longer.text.slice(0, head), w: part, bold: longer.bold || apart }, { ...longer, text: longer.text.slice(head), x: longer.x + part, w: longer.w - part });
    }
    let part: Run[] = [];
    let right = 0;
    for (const run of kept) {
      const gap = run.x - right;
      const size = Math.max(run.size, part[part.length - 1]?.size ?? 0);
      if (part.length && gap > size * 1.5) {
        lines.push(makeLine(page, part));
        part = [];
      }
      part.push(run);
      right = part.length === 1 ? run.x + run.w : Math.max(right, run.x + run.w);
    }
    if (part.length) lines.push(makeLine(page, part));
  }
  return lines.filter((line) => line.text.length > 0);
}

/** Two lines side by side on one baseline as one (what a wide space in a
 *  line was after all). */
export function joinLines(a: Line, b: Line): Line {
  const wide = b.x0 - a.x1 > a.size * 3;
  const runs = a.runs.map((run) => ({ ...run }));
  const last = runs[runs.length - 1];
  last.text = last.text.replace(/\s+$/, "") + (wide ? "\t" : " ");
  runs.push(...b.runs.map((run) => ({ ...run })));
  const text = `${a.text}${wide ? "\t" : " "}${b.text}`;
  return { ...a, x1: Math.max(a.x1, b.x1), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), runs, text };
}
