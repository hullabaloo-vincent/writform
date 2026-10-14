/**
 * Page labels: what a reader's page box shows for each page ("iv", "12"),
 * so "go to page 12" lands on the page that says 12 and not on the twelfth
 * sheet. Worked out from the numbers the layout printed.
 *
 * A PDF says them as runs: from this page on, this style, counting from
 * this number. A page whose number is in no style a PDF knows gets its own
 * words. A page that shows no number takes the one it would have had.
 *
 * Nothing here touches the PDF writer or a page.
 */

/** decimal, roman (lower, upper), letters (lower, upper: a…z, aa…zz). */
export type LabelStyle = "D" | "r" | "R" | "a" | "A";

export interface LabelRun {
  /** The first page it applies to (0-based). */
  at: number;
  style?: LabelStyle;
  /** The number that page carries (1 when absent). */
  start?: number;
  /** A label in words of its own, for one page. */
  text?: string;
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function toRoman(n: number): string {
  let rest = n;
  let out = "";
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

/** The number a roman numeral stands for, when it is written the one
 *  usual way (so that writing the number again gives the same letters). */
function fromRoman(lower: string): number | null {
  if (!/^[ivxlcdm]+$/.test(lower)) return null;
  let n = 0;
  let rest = lower;
  for (const [value, glyph] of ROMAN) {
    while (rest.startsWith(glyph)) {
      n += value;
      rest = rest.slice(glyph.length);
    }
  }
  return rest === "" && n >= 1 && n <= 3999 && toRoman(n) === lower ? n : null;
}

/** a…z are 1…26, then aa…zz are 27…52 (the letter said again). */
function fromLetters(lower: string): number | null {
  if (!/^[a-z]+$/.test(lower) || lower.length > 20) return null;
  const first = lower[0];
  for (let i = 1; i < lower.length; i += 1) if (lower[i] !== first) return null;
  return (lower.length - 1) * 26 + (first.charCodeAt(0) - 96);
}

interface Read {
  style: LabelStyle;
  n: number;
}

/** Every way a printed number can be read. */
function readings(folio: string): Read[] {
  const out: Read[] = [];
  if (/^\d{1,7}$/.test(folio)) {
    const n = Number(folio);
    // (A PDF's count starts at 1, and "007" would come back as "7".)
    if (n >= 1 && String(n) === folio) out.push({ style: "D", n });
    return out;
  }
  const lower = folio.toLowerCase();
  const cased = folio === lower ? "lower" : folio === folio.toUpperCase() ? "upper" : null;
  if (!cased) return out;
  const roman = fromRoman(lower);
  if (roman !== null) out.push({ style: cased === "lower" ? "r" : "R", n: roman });
  const letters = fromLetters(lower);
  if (letters !== null) out.push({ style: cased === "lower" ? "a" : "A", n: letters });
  return out;
}

export function pageLabels(folios: (string | null)[]): LabelRun[] {
  const count = folios.length;
  // What each page is: a number in a style, its own words, or not yet known.
  const pages: ({ style: LabelStyle; n: number } | { text: string } | null)[] = new Array(count).fill(null);
  let prev = null as Read | null;
  for (let i = 0; i < count; i += 1) {
    const folio = folios[i];
    if (folio === null) {
      // (A page between two that count on: it is counted too.)
      if (prev) prev = { style: prev.style, n: prev.n + 1 };
      continue;
    }
    const ways = readings(folio);
    // "i" after "h" is the ninth letter. After nothing, it is roman one.
    const before = prev;
    const going = before ? ways.find((w) => w.style === before.style && w.n === before.n + 1) : undefined;
    const read: Read | undefined = going ?? ways[0];
    if (read) {
      pages[i] = read;
      prev = read;
    } else {
      pages[i] = { text: folio };
      prev = null;
    }
  }

  // Pages that show no number take the one they would have had: counted
  // back from the next numbered page when that fits, else on from the one
  // before, else by where they stand.
  for (let i = 0; i < count; i += 1) {
    if (pages[i] !== null) continue;
    let j = i + 1;
    while (j < count && pages[j] === null) j += 1;
    const next = j < count ? pages[j] : null;
    const before = i > 0 ? pages[i - 1] : null;
    const back = next && "style" in next ? { style: next.style, n: next.n - (j - i) } : null;
    const on = before && "style" in before ? { style: before.style, n: before.n + 1 } : null;
    if (back && back.n >= 1 && (!on || on.style !== back.style || on.n === back.n)) pages[i] = back;
    else if (on) pages[i] = on;
    // Unnumbered pages before a book's page 1: its front matter, i ii iii.
    else if (next && "style" in next && next.style === "D") pages[i] = { style: "r", n: i + 1 };
    else pages[i] = { style: "D", n: i + 1 };
  }

  const runs: LabelRun[] = [];
  let last = null as Read | null;
  for (let i = 0; i < count; i += 1) {
    const page = pages[i]!;
    if ("text" in page) {
      runs.push({ at: i, text: page.text });
      last = null;
    } else if (!last || last.style !== page.style || last.n + 1 !== page.n) {
      runs.push({ at: i, style: page.style, ...(page.n !== 1 ? { start: page.n } : {}) });
      last = page;
    } else {
      last = page;
    }
  }
  return runs;
}

/** Whether the labels say anything a reader would not show anyway (1, 2, 3
 *  from the first page). */
export const plainLabels = (runs: LabelRun[]): boolean => runs.length === 0 || (runs.length === 1 && runs[0].at === 0 && runs[0].style === "D" && runs[0].start === undefined);
