/**
 * Footnotes put back where they are cited.
 *
 * A note is a small raised number in the text and, at the foot of the same
 * page, lines of smaller type that begin with that number. Where both are
 * found, the lines leave the page and are kept with the number: the
 * document then has a note there, which it numbers and sets at the foot of
 * whatever page that turns out to be.
 *
 * A number with no note under it, or small type with no number above it,
 * is left as it is.
 */

import { makeLine } from "./lines";
import type { Line, Run } from "./model";

const isNumber = (text: string) => /^\d{1,3}$/.test(text.trim());

/** The number a line of small type begins with, if it begins a note. */
export function startsNote(line: Line): number | null {
  const first = line.runs[0];
  if (first?.shift === "up" && isNumber(first.text)) return Number(first.text.trim());
  const plain = /^(\d{1,3})[.)]?\s+\S/.exec(line.text);
  return plain ? Number(plain[1]) : null;
}

/** A note's first line without its number. */
export function unnumbered(line: Line): Line | null {
  const runs = line.runs.map((run) => ({ ...run }));
  if (runs[0]?.shift === "up" && isNumber(runs[0].text)) runs.shift();
  else if (runs[0]) runs[0].text = runs[0].text.replace(/^\s*\d{1,3}[.)]?\s+/, "");
  const kept = runs.filter((run) => run.text.trim().length > 0 || run.note);
  if (!kept.length) return null;
  kept[0].text = kept[0].text.replace(/^\s+/, "");
  return { ...makeLine(line.page, kept), left: line.left, right: line.right };
}

/**
 * Take a page's footnotes out of its lines and give each to the number that
 * cites it. Returns the lines that are left, and how many notes were found.
 */
export function takeNotes(lines: Line[], bodySize: number): { lines: Line[]; notes: number } {
  const small = (line: Line) => line.size <= bodySize * 0.92;
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  // The numbers in the text: raised, and not the number a note begins with.
  const cites: { run: Run; line: Line; n: number }[] = [];
  for (const line of sorted) {
    line.runs.forEach((run, k) => {
      if (run.shift === "up" && isNumber(run.text) && !(k === 0 && small(line))) cites.push({ run, line, n: Number(run.text.trim()) });
    });
  }
  if (!cites.length) return { lines, notes: 0 };

  const gone = new Set<Line>();
  let notes = 0;
  for (const cite of cites) {
    const at = sorted.findIndex((line) => !gone.has(line) && small(line) && line.y > cite.line.y && startsNote(line) === cite.n);
    if (at < 0) continue;
    const said: Line[] = [sorted[at]];
    for (let k = at + 1; k < sorted.length; k += 1) {
      const line = sorted[k];
      const prev = said[said.length - 1];
      if (gone.has(line) || !small(line) || line.y - prev.y > prev.size * 2.5) break;
      // (The next note, or another column's small type, is not this note.)
      if (startsNote(line) !== null && startsNote(line) !== cite.n) break;
      if (line.x1 < prev.x0 || line.x0 > prev.x1) continue;
      said.push(line);
    }
    const first = unnumbered(said[0]);
    const body = [...(first ? [first] : []), ...said.slice(1)];
    for (const line of said) gone.add(line);
    cite.run.note = body;
    cite.run.text = /\s$/.test(cite.run.text) ? " " : "";
    cite.line.text = cite.line.runs
      .map((run) => run.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    notes += 1;
  }
  return { lines: lines.filter((line) => !gone.has(line)), notes };
}

/**
 * Give a note to the number that cites it among some lines (a paragraph's),
 * where the note is known already (a tagged file says which it is). With no
 * such number there, it goes at the paragraph's end.
 */
export function attachNote(lines: Line[], note: Line[]): void {
  if (!lines.length || !note.length) return;
  const n = startsNote(note[0]);
  const first = n === null ? note[0] : unnumbered(note[0]);
  const body = [...(first ? [first] : []), ...note.slice(1)];
  for (const line of lines) {
    const cite = line.runs.find((run) => run.shift === "up" && !run.note && n !== null && isNumber(run.text) && Number(run.text.trim()) === n);
    if (!cite) continue;
    cite.note = body;
    cite.text = /\s$/.test(cite.text) ? " " : "";
    return;
  }
  const last = lines[lines.length - 1];
  const end = last.runs[last.runs.length - 1];
  last.runs.push({ ...end, text: "", x: end.x + end.w, w: 0, note: body, shift: "up" });
}
