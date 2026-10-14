/**
 * The ruler's sums, kept apart from the screen (editor/ui/Ruler.tsx): where
 * a length on the paper is across the ruler, where the ruler's marks go,
 * and how a dragged mark settles.
 *
 * Lengths are points from the paper's left edge. The ruler is drawn over
 * the paper as it is on the screen, zoomed or not: `pxPerPt` says how wide
 * a point is there.
 */

import { PT_PER, type Unit } from "../../lib/units";

export interface RulerFrame {
  /** The paper's left edge, in the ruler's own pixels. */
  left: number;
  /** How wide a point of paper is on the screen. */
  pxPerPt: number;
  /** The paper's width, points. */
  paper: number;
}

export const ptToX = (f: RulerFrame, pt: number): number => f.left + pt * f.pxPerPt;
export const xToPt = (f: RulerFrame, x: number): number => (x - f.left) / f.pxPerPt;

/** The step a dragged mark settles to: a sixteenth of an inch, or a
 *  quarter of a centimetre. `free`: a tenth of a point. */
export function snapPt(pt: number, unit: Unit, free = false): number {
  if (free) return Math.round(pt * 10) / 10;
  const step = unit === "in" ? 72 / 16 : PT_PER.cm / 4;
  return Math.round((Math.round(pt / step) * step) * 100) / 100;
}

export interface Tick {
  pt: number;
  /** A whole inch or centimetre (with its number), a half, or a small one. */
  size: "whole" | "half" | "small";
  label?: string;
}

/**
 * The ruler's ticks across the paper, counted from the left margin as Word
 * counts them (a whole unit is numbered, negatives into the margin
 * unnumbered): eighths of an inch, or quarters of a centimetre.
 */
export function ticks(paper: number, origin: number, unit: Unit): Tick[] {
  const whole = PT_PER[unit];
  const parts = unit === "in" ? 8 : 4;
  const step = whole / parts;
  const out: Tick[] = [];
  const first = -Math.floor(origin / step);
  const last = Math.floor((paper - origin) / step);
  for (let i = first; i <= last; i += 1) {
    const pt = origin + i * step;
    if (pt < 0 || pt > paper) continue;
    const k = ((i % parts) + parts) % parts;
    if (k === 0) out.push({ pt, size: "whole", ...(i > 0 ? { label: String(i / parts) } : {}) });
    else out.push({ pt, size: k === parts / 2 ? "half" : "small" });
  }
  return out;
}

/** Where the paragraph's marks are, points from the paper's edge. */
export interface IndentMarks {
  /** The first line's start. */
  first: number;
  /** Where the other lines start (the left indent). */
  left: number;
  /** Where the lines end (the right indent). */
  right: number;
}

/** A paragraph's marks, from its indents (points) in a column that runs
 *  from `colLeft` to `colRight` (points from the paper's edge). */
export function indentMarks(colLeft: number, colRight: number, indL: number, indR: number, indF: number): IndentMarks {
  return { first: colLeft + indL + indF, left: colLeft + indL, right: colRight - indR };
}

/**
 * The indents a dragged mark leaves (points). The first-line mark moves
 * the first line alone. The left mark moves the other lines and leaves
 * the first line where it was (Word's hanging indent). The right mark
 * moves the lines' end.
 */
export function dragIndent(
  mark: "first" | "left" | "right",
  at: number,
  colLeft: number,
  colRight: number,
  now: { indL: number; indR: number; indF: number },
): { indL: number; indR: number; indF: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (mark === "right") return { ...now, indR: clamp(Math.round((colRight - at) * 10) / 10, 0, 720) };
  if (mark === "first") return { ...now, indF: clamp(Math.round((at - colLeft - now.indL) * 10) / 10, -720, 720) };
  const indL = clamp(Math.round((at - colLeft) * 10) / 10, 0, 720);
  const firstAt = now.indL + now.indF;
  return { ...now, indL, indF: clamp(Math.round((firstAt - indL) * 10) / 10, -720, 720) };
}
