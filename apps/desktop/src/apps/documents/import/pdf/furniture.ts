/**
 * What is printed on every page and is not the text: running heads, page
 * numbers, a title along the foot.
 *
 * A file that marks these as decoration is believed (read.ts leaves them
 * out of the text, and they come here as `marked`). For the rest, a line at
 * the head or the foot of a page is furniture when the same line, its
 * numbers apart, stands there on enough other pages. A number alone in a
 * corner is a page number wherever it is.
 *
 * What is found is taken out of the text and kept as the document's own
 * header and footer, a page's number as the field that counts pages.
 */

import type { Line } from "./model";

export interface PageLines {
  n: number;
  w: number;
  h: number;
  lines: Line[];
  /** Lines the file itself marked as decoration. */
  marked: Line[];
}

export interface Furniture {
  drop: Set<Line>;
  /** Header and footer slots (`hL hC hR fL fC fR`), fields in braces. */
  slots: Record<string, string>;
  /** The number the first page carries, when the pages say. */
  start: number | null;
}

const HEAD = 0.12;
const FOOT = 0.9;
const NUMBER = /^(?:page\s+)?(\d+|[ivxlcdm]+)(?:\s*(?:of|\/)\s*\d+)?\.?$/i;
/** A number between two dashes (a hyphen, or either of the longer ones). */
const DASH = `[-${String.fromCharCode(0x2013, 0x2014)}]`;
const DASHED = new RegExp(`^${DASH}\\s*\\d+\\s*${DASH}$`);

const band = (line: Line, h: number): "h" | "f" | null => (line.y <= h * HEAD ? "h" : line.y >= h * FOOT ? "f" : null);

function side(line: Line, w: number): "L" | "C" | "R" {
  if (line.x0 < w * 0.25 && line.x1 < w * 0.75) return "L";
  if (line.x1 > w * 0.75 && line.x0 > w * 0.25) return "R";
  return "C";
}

const even = (text: string): string =>
  (NUMBER.test(text.trim()) || DASHED.test(text.trim()) ? text.replace(/[ivxlcdm]+/gi, (m) => (/^\d/.test(m) ? m : "#")) : text)
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();

export function findFurniture(pages: PageLines[]): Furniture {
  const withText = pages.filter((p) => p.lines.length > 0).length;
  const enough = Math.max(2, Math.min(4, Math.ceil(withText * 0.4)));

  // How many pages each line of a head or a foot stands on.
  const seen = new Map<string, { page: PageLines; line: Line }[]>();
  for (const page of pages) {
    const once = new Set<string>();
    for (const line of [...page.lines, ...page.marked]) {
      const where = band(line, page.h);
      if (!where) continue;
      const key = `${where}${side(line, page.w)}|${even(line.text)}`;
      if (once.has(key)) continue;
      once.add(key);
      const list = seen.get(key);
      if (list) list.push({ page, line });
      else seen.set(key, [{ page, line }]);
    }
  }

  const drop = new Set<Line>();
  const found = new Map<string, { page: PageLines; line: Line }[]>();
  const take = (key: string, list: { page: PageLines; line: Line }[]) => {
    const had = found.get(key);
    if (had) had.push(...list);
    else found.set(key, [...list]);
  };
  for (const [key, list] of seen) {
    const marked = list.every(({ page, line }) => page.marked.includes(line));
    if (list.length < enough && !marked) continue;
    for (const { line } of list) drop.add(line);
    take(key, list);
  }
  // A number alone in a corner (where a page's number goes).
  for (const page of pages) {
    for (const line of page.lines) {
      if (drop.has(line)) continue;
      const text = line.text.trim();
      const top = line.y < 54;
      const foot = line.y > page.h - 54 || (line.y >= page.h * FOOT && page.lines.every((other) => other === line || other.y <= line.y - line.size));
      if ((top && /^\d+[A-Z]?\.?$/.test(text)) || (foot && (/^\d+$/.test(text) || DASHED.test(text) || /^page\s+\d+(\s+of\s+\d+)?$/i.test(text)))) {
        drop.add(line);
        take(`${top ? "h" : "f"}${side(line, page.w)}|${even(text)}`, [{ page, line }]);
      }
    }
  }

  // The document's own header and footer: what stands there most.
  const slots: Record<string, string> = { hL: "", hC: "", hR: "", fL: "", fC: "", fR: "" };
  const weight: Record<string, number> = {};
  const offsets = new Map<number, number>();
  for (const [key, list] of found) {
    const slot = key.slice(0, 2);
    const texts = list.map(({ line }) => line.text.trim());
    // Its numbers: one that changes from page to page counts pages, one
    // that never does and is how many pages there are is the count.
    const parts = texts.map((text) => text.split(/(\d+)/));
    const shape = parts[0];
    const alike = parts.every((p) => p.length === shape.length);
    let template = texts[0];
    if (alike) {
      template = shape
        .map((piece, k) => {
          if (k % 2 === 0) return piece;
          const values = new Set(parts.map((p) => p[k]));
          if (values.size > 1 || (list.length === 1 && shape.length === 3 && !shape[0].trim() && !/\d/.test(shape[2]))) {
            // (How far the printed number is from the page's place in the file.)
            for (let i = 0; i < list.length; i += 1) {
              const off = Number(parts[i][k]) - list[i].page.n;
              offsets.set(off, (offsets.get(off) ?? 0) + 1);
            }
            return "{page}";
          }
          return Number(piece) === pages.length && pages.length > 1 ? "{pages}" : piece;
        })
        .join("");
    }
    if (/^[ivxlcdm]+$/i.test(template)) template = "{page}";
    // ("Page 3 of 9": the second number is how many there are, whatever
    // number the first page carries.)
    template = template.replace(/(\{page\}\s*(?:of|\/)\s*)\d+/i, "$1{pages}");
    if ((weight[slot] ?? 0) < list.length) {
      weight[slot] = list.length;
      slots[slot] = template.slice(0, 200);
    }
  }
  let start: number | null = null;
  let most = 0;
  for (const [off, count] of offsets) {
    if (count > most) {
      most = count;
      start = off + 1;
    }
  }
  return { drop, slots, start: start !== null && start >= 0 && start < 100000 ? start : null };
}
