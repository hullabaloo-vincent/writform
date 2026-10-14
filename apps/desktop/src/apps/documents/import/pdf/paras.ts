/**
 * Lines into paragraphs.
 *
 * A PDF keeps no paragraphs: a line ends where the page did, and nothing
 * says whether the next one goes on with it. What does say: more space than
 * the lines of a paragraph have between them, a first line that starts in,
 * a line that stops short when the next line's first word would have fitted
 * after it, a change of size, a turn to the middle of the page.
 *
 * A word broken at a line's end is put together again. Its hyphen stays
 * when the word is written with one elsewhere in the text ("well-known"
 * broken after "well-"), and goes when it was only the break.
 */

import type { Line, ParaBlock, Run, Span } from "./model";

export interface Metrics {
  /** The size most of the text is set in. */
  size: number;
  /** The font most of it is set in, and its colour. */
  font: string;
  color: string | null;
  /** Baseline to baseline in running text of that size. */
  leading: number;
  /** The space paragraphs have between them, beyond that. */
  gap: number;
}

const bucket = (size: number): number => Math.round(size * 2) / 2;

function most<T>(counts: Map<T, number>, fallback: T): T {
  let best = fallback;
  let top = -1;
  for (const [value, count] of counts) {
    if (count > top) {
      top = count;
      best = value;
    }
  }
  return best;
}

/** What most of the text looks like. */
export function measure(lines: Line[]): Metrics {
  const sizes = new Map<number, number>();
  const fonts = new Map<string, number>();
  const colors = new Map<string | null, number>();
  for (const line of lines) {
    for (const run of line.runs) {
      if (run.shift) continue;
      const letters = run.text.trim().length;
      sizes.set(bucket(run.size), (sizes.get(bucket(run.size)) ?? 0) + letters);
    }
  }
  const size = most(sizes, 12);
  const steps = new Map<number, number>();
  let prev: Line | null = null;
  for (const line of lines) {
    if (Math.abs(bucket(line.size) - size) <= 0.75) {
      for (const run of line.runs) {
        const letters = run.text.trim().length;
        // (Bold and italic faces of the body font are the body font.)
        if (!run.bold && !run.italic) fonts.set(run.font, (fonts.get(run.font) ?? 0) + letters);
        colors.set(run.color, (colors.get(run.color) ?? 0) + letters);
      }
      if (prev && prev.page === line.page && !line.starts && Math.abs(bucket(prev.size) - size) <= 0.75) {
        const step = Math.round((line.y - prev.y) * 2) / 2;
        if (step > size * 0.7 && step < size * 4) steps.set(step, (steps.get(step) ?? 0) + 1);
      }
    }
    prev = line;
  }
  // (The least step that is common: paragraphs stand further apart.)
  const often = (share: number) => [...steps.entries()].filter(([, count]) => count >= Math.max(1, Math.max(...steps.values()) * share)).map(([step]) => step);
  const common = often(0.3);
  // (Held to what lines of text can be: one line of two says nothing.)
  const leading = Math.min(size * 2.6, Math.max(size, common.length ? Math.min(...common) : size * 1.2));
  // Paragraphs stand a little further apart than lines do: the next step
  // up that is common, if there is one.
  const wider = often(0.1)
    .filter((step) => step >= leading * 1.15 && step <= leading * 2.5)
    .sort((a, b) => (steps.get(b) ?? 0) - (steps.get(a) ?? 0))[0];
  return { size, font: most(fonts, ""), color: most(colors, null), leading, gap: wider ? wider - leading : 0 };
}

/** Words written with a hyphen inside a line (not broken by one). */
export function hyphenated(lines: Line[]): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    for (const word of line.text.match(/\p{L}+(?:-\p{L}+)+/gu) ?? []) found.add(word.toLowerCase());
  }
  return found;
}

const SOFT = String.fromCharCode(0xad);

/**
 * What goes between the end of one line and the start of the next, and
 * whether the first loses its last character (a hyphen that was the break).
 */
export function seam(before: string, after: string, compounds: Set<string>): { cut: boolean; glue: string } {
  if (before.endsWith(SOFT)) return { cut: true, glue: "" };
  const head = /(\p{L}+)-$/u.exec(before);
  if (!head) return { cut: false, glue: " " };
  const tail = /^(\p{L}+)/u.exec(after);
  if (!tail) return { cut: false, glue: " " };
  // A name after the hyphen, or a number: the hyphen was written.
  if (!/^\p{Ll}/u.test(tail[1])) return { cut: false, glue: "" };
  // The whole of what the hyphen is in ("mother-in-" before "law").
  const stem = /([\p{L}-]+)-$/u.exec(before)?.[1] ?? head[1];
  const rest = /^([\p{L}-]+)/u.exec(after)?.[1] ?? tail[1];
  if (compounds.has(`${stem}-${rest}`.toLowerCase()) || compounds.has(`${head[1]}-${tail[1]}`.toLowerCase())) return { cut: false, glue: "" };
  return { cut: true, glue: "" };
}

const width = (line: Line) => (line.right ?? line.x1) - (line.left ?? line.x0);

export function isCentred(line: Line): boolean {
  const left = line.left ?? line.x0;
  const across = width(line);
  if (line.x1 - line.x0 >= across * 0.8 || line.x0 <= left + 6) return false;
  return Math.abs((line.x0 + line.x1) / 2 - (left + across / 2)) <= Math.max(6, across * 0.05);
}

function isRight(line: Line): boolean {
  const left = line.left ?? line.x0;
  const right = line.right ?? line.x1;
  return line.x0 > left + width(line) * 0.2 && Math.abs(line.x1 - right) <= 3;
}

export function startsIn(line: Line): boolean {
  const offset = line.x0 - (line.left ?? line.x0);
  return offset >= 6 && offset <= Math.min(60, width(line) * 0.5);
}

/** Dots that lead the eye across to a page number. */
const LEADER = /(?:\.\s?){4,}\s*\d+$/;

/** A bullet or a number that begins a list's item. */
export const MARKER = new RegExp(`^(?:[${String.fromCharCode(0x2022, 0x25e6, 0x25aa, 0x25ab, 0x25cf, 0x25cb, 0x25a0, 0x25a1, 0x2023, 0x2043, 0x00b7, 0x2013, 0x2014, 0xf0b7, 0xf0a7)}*-]|\\(?(?:\\d{1,3}|[a-zA-Z]|[ivxlc]{1,5}|[IVXLC]{1,5})[.)])\\s+\\S`);

const styleOf = (run: Run) => `${run.bold ? 1 : 0}${run.italic ? 1 : 0}${run.mono ? 1 : 0}|${run.color ?? ""}|${run.font}|${bucket(run.size)}|${run.link ?? ""}|${run.shift ?? ""}`;

function spanOf(run: Run): Span {
  return {
    text: run.text,
    ...(run.bold ? { bold: true } : {}),
    ...(run.italic ? { italic: true } : {}),
    ...(run.mono ? { mono: true } : {}),
    ...(run.color ? { color: run.color } : {}),
    ...(run.font ? { font: run.font } : {}),
    size: bucket(run.size),
    ...(run.link ? { link: run.link } : {}),
    ...(run.shift ? { shift: run.shift } : {}),
  };
}

/** The text of some lines as one run of styled pieces. */
export function spansOf(lines: Line[], compounds: Set<string>): Span[] {
  const out: { span: Span; key: string }[] = [];
  const add = (run: Run) => {
    if (run.note) {
      // A note stands where its number stood, saying what it says.
      out.push({ span: { text: "", note: spansOf(run.note, compounds) }, key: `note${out.length}` });
      // (The space after its number is the text's, not the number's.)
      if (run.text) out.push({ span: { text: run.text }, key: `space${out.length}` });
      return;
    }
    if (!run.text) return;
    const key = styleOf(run);
    const last = out[out.length - 1];
    if (last && last.key === key) last.span.text += run.text;
    else out.push({ span: spanOf(run), key });
  };
  let prev: Line | null = null;
  for (const line of lines) {
    if (prev && out.length) {
      let back = out.length - 1;
      while (back > 0 && out[back].span.note) back -= 1;
      const last = out[back].span;
      last.text = last.text.replace(/\s+$/, "");
      const { cut, glue } = seam(prev.text, line.text, compounds);
      if (cut) last.text = last.text.slice(0, -1);
      last.text += glue;
    }
    for (const run of line.runs) add(run);
    prev = line;
  }
  const spans = out.map((o) => o.span).filter((span) => span.text.length > 0 || span.note);
  if (spans.length) {
    spans[0].text = spans[0].text.replace(/^\s+/, "");
    spans[spans.length - 1].text = spans[spans.length - 1].text.replace(/\s+$/, "");
  }
  return spans.filter((span) => span.text.length > 0 || span.note);
}

/** A paragraph of these lines. */
export function paraOf(lines: Line[], compounds: Set<string>): ParaBlock | null {
  const spans = spansOf(lines, compounds);
  if (!spans.length) return null;
  const sizes = new Map<number, number>();
  for (const line of lines) sizes.set(bucket(line.size), (sizes.get(bucket(line.size)) ?? 0) + line.text.length);
  const centred = lines.every(isCentred);
  const right = !centred && lines.every(isRight);
  const first = lines[0];
  return {
    kind: "para",
    spans,
    page: first.page,
    size: most(sizes, first.size),
    bold: spans.every((span) => span.bold || !span.text.trim()),
    lines: lines.length,
    x: first.x0 - (first.left ?? first.x0),
    ...(lines.length > 1 ? { hang: lines[1].x0 - (lines[1].left ?? lines[1].x0) } : {}),
    ...(centred ? { align: "center" as const } : right ? { align: "right" as const } : {}),
    ...(!centred && !right && startsIn(first) && lines.length > 1 ? { indent: true } : {}),
    ...(!centred && !right && startsIn(first) ? { inset: first.x0 - (first.left ?? first.x0) } : {}),
  };
}

/** Whether `line` begins a new paragraph after `prev`. */
export function breaksAfter(prev: Line, line: Line, m: Metrics, lead: number | null, reach?: number): boolean {
  const sizeChanged = Math.abs(bucket(prev.size) - bucket(line.size)) > 0.75;
  if (MARKER.test(line.text)) return true;
  if (line.starts || prev.page !== line.page) {
    // Across a column or a page: it goes on only when the last line ran
    // full and stopped in the middle of a sentence, and this one starts at
    // the edge.
    const full = prev.x1 >= (prev.right ?? prev.x1) - width(prev) * 0.15;
    const resumes = line.x0 <= (line.left ?? line.x0) + 2;
    const midSentence = !/[.!?:;"”’)\]]$/.test(prev.text) || /^\p{Ll}/u.test(line.text);
    return !(full && resumes && !sizeChanged && midSentence);
  }
  if (sizeChanged) return true;
  const step = line.y - prev.y;
  const tall = Math.max(prev.size, line.size);
  const usual = lead ?? (m.leading * tall) / m.size;
  if (step > usual * 1.3 + 0.5 || step < tall * 0.4) return true;
  const centred = isCentred(line);
  // (Two lines that end at the same place are one block set in from both
  // sides, whichever of them looks centred.)
  if (isCentred(prev) !== centred && Math.abs(prev.x1 - line.x1) > 3) return true;
  // A line of a contents page (dots, then a page number) is a line.
  if (LEADER.test(prev.text)) return true;
  // It stopped short though the next word would have fitted: it ended.
  let short = false;
  if (!centred && !/[\p{L}]-$/u.test(prev.text)) {
    const word = /^\S+/.exec(line.text)?.[0] ?? "";
    const wide = line.text.length ? ((line.x1 - line.x0) * word.length) / line.text.length : 0;
    short = (reach ?? prev.right ?? prev.x1) - prev.x1 > wide + tall * 0.6;
  }
  if (short) return true;
  // A line that starts in after one at the edge begins a paragraph, unless
  // the one before it ran full and stopped mid-sentence: then it is a
  // paragraph whose first line hangs out to the left of the rest.
  if (!centred && startsIn(line) && prev.x0 <= (prev.left ?? prev.x0) + 2) return /[.!?:"\u201d\u2019)\]]$/.test(prev.text);
  return false;
}

/** Lines, in the order they are read, as paragraphs. */
export function paragraphs(lines: Line[], m: Metrics, compounds: Set<string>): ParaBlock[] {
  const out: ParaBlock[] = [];
  let open: Line[] = [];
  let lead: number | null = null;
  const flush = () => {
    const para = open.length ? paraOf(open, compounds) : null;
    if (para) out.push(para);
    open = [];
    lead = null;
  };
  // How far a line could have run. The column's edge, as a rule. But text
  // set in from both sides (a quotation, an abstract) stops short of that
  // on every line: where a line's neighbours, starting where it starts,
  // run about as far as each other and no further, that is its edge.
  const reach = lines.map((line, k) => {
    const edge = line.right ?? line.x1;
    // (The lines after a first line that starts in begin to its left.)
    const near = [lines[k - 1], line, lines[k + 1], lines[k + 2]].filter(
      (o, at): o is Line => !!o && o.page === line.page && (Math.abs(o.x0 - line.x0) <= 3 || (at >= 2 && o.x0 < line.x0)) && Math.abs(o.y - line.y) <= m.leading * 3.5 * (line.size / m.size),
    );
    const far = Math.max(...near.map((o) => o.x1));
    const full = near.filter((o) => o.x1 >= far - line.size * 3).length;
    return far < edge - line.size * 2 && full >= 2 && far - line.x0 >= line.size * 15 ? far : edge;
  });
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    const prev = open[open.length - 1];
    if (prev) {
      if (breaksAfter(prev, line, m, lead, reach[k - 1])) flush();
      else if (prev.page === line.page && !line.starts && lead === null) lead = line.y - prev.y;
    }
    open.push(line);
  }
  flush();
  return out;
}

const words = (para: ParaBlock): number =>
  para.spans
    .map((span) => span.text)
    .join("")
    .trim()
    .split(/\s+/).length;

export const textOf = (para: ParaBlock): string => para.spans.map((span) => span.text).join("");

/**
 * Which paragraphs are headings, and how deep. Larger type than the text's
 * is a heading, the largest the highest. A short line all in bold, in the
 * text's own size and with text after it, is one below those. Headings
 * that are numbered ("2.1 Method") go as deep as their numbers.
 */
export function markHeadings(blocks: ParaBlock[], m: Metrics): void {
  const sizes = [...new Set(blocks.filter((b) => b.size >= m.size + 1.5 && b.lines <= 3 && words(b) <= 20).map((b) => b.size))].sort((a, b) => b - a).slice(0, 5);
  for (let k = 0; k < blocks.length; k += 1) {
    const b = blocks[k];
    const level = sizes.indexOf(b.size);
    if (level !== -1 && b.lines <= 3 && words(b) <= 20) {
      b.heading = level + 1;
      continue;
    }
    const next = blocks[k + 1];
    const text = textOf(b).trim();
    if (b.bold && b.lines === 1 && words(b) <= 12 && b.size >= m.size - 0.75 && b.size < m.size + 1.5 && text.length >= 2 && !/[.,;:]$/.test(text) && next && !next.bold && !next.heading) {
      b.heading = Math.min(6, sizes.length + 1);
    }
  }
  // Numbered headings of one look: each as deep as its number.
  const depthOf = (b: ParaBlock): number => (/^(\d+(?:\.\d+)*)\.?\s/.exec(textOf(b))?.[1].split(".").length ?? 0);
  const byLevel = new Map<number, ParaBlock[]>();
  for (const b of blocks) {
    if (!b.heading || !depthOf(b)) continue;
    const list = byLevel.get(b.heading);
    if (list) list.push(b);
    else byLevel.set(b.heading, [b]);
  }
  for (const [level, list] of byLevel) {
    const least = Math.min(...list.map(depthOf));
    for (const b of list) b.heading = Math.min(6, level + depthOf(b) - least);
  }
  for (const b of blocks) {
    if (b.heading) {
      delete b.indent;
      delete b.inset;
    }
  }
}
