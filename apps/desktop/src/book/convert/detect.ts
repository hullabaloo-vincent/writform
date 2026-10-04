/**
 * Find a manuscript's structure in a document that was written (or
 * imported) as plain text: chapter and part headings however they were
 * typed, scene breaks ("* * *" lines, or blank lines), the title page the
 * writer typed by hand, an old table of contents, and stray leading tabs.
 *
 * Pure: takes the document's top-level blocks as editor JSON and returns a
 * reviewable result. `planOps` turns it (plus the writer's choices) into
 * per-block operations that `apply.ts` performs on JSON or a live editor.
 */

import type { JSONContent } from "@tiptap/core";

import { parseHeading, SCENE_MARK, UNNUMBERED_NAMES } from "../model/chapters";

export type CandidateKind = "chapter" | "part" | "section" | "subtitle" | "subheading";

export interface Candidate {
  index: number;
  kind: CandidateKind;
  text: string;
  /** Why it was picked, for the review list. */
  reason: string;
  /** The writer can untick a false positive. */
  accepted: boolean;
}

export interface FrontMatterFind {
  title?: string;
  author?: string;
  copyright?: string;
  copyrightYear?: number;
  copyrightHolder?: string;
  dedication?: string;
  alsoBy?: string[];
  /** Blocks that become generated pages (removed from the text). */
  indexes: number[];
  /** An old "Contents" list (the book generates its own). */
  contents: number[];
}

export interface DetectResult {
  blockCount: number;
  candidates: Candidate[];
  /** Lines that are only a scene-break mark. */
  sceneMarks: number[];
  /** Empty paragraphs: `between` = sits between two body paragraphs. */
  empties: { index: number; between: boolean }[];
  /** Suggested handling of blank lines (the writer can switch it). */
  blankPolicy: "delete" | "scene";
  front: FrontMatterFind;
  /** Leading whitespace characters to strip, by block. */
  strips: Map<number, number>;
  /** Page breaks made redundant (the design starts chapters on new pages). */
  pageBreaks: number[];
}

type Block = JSONContent;

function textOf(block: Block): string {
  let out = "";
  const walk = (n: JSONContent) => {
    if (n.type === "hardBreak") out += "\n";
    if (n.text) out += n.text;
    for (const c of n.content ?? []) walk(c);
  };
  walk(block);
  return out;
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function allMarked(block: Block, mark: string): boolean {
  let any = false;
  let all = true;
  const walk = (n: JSONContent) => {
    if (n.text?.trim()) {
      any = true;
      if (!(n.marks ?? []).some((m) => m.type === mark)) all = false;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(block);
  return any && all;
}

const isCaps = (s: string) => /\p{Lu}/u.test(s) && s === s.toUpperCase() && !/\p{Ll}/u.test(s);
const isParagraph = (b: Block) => b.type === "paragraph";
const isEmptyPara = (b: Block) => isParagraph(b) && !textOf(b).trim();
const elementOf = (b: Block) => (b.attrs?.element as string | null | undefined) ?? null;
const BOOK_ELEMENTS = new Set([
  "chapter_heading", "part_heading", "section_heading", "chapter_subtitle", "subheading",
  "epigraph", "attribution", "verse", "flush",
]);

/** Heading-shaped: short, no sentence ending, and set apart by emphasis. */
function headingLike(block: Block, text: string): boolean {
  const t = text.trim();
  if (!t || wordCount(t) > 8 || /[.,;:]$/.test(t) || t.includes("\n")) return false;
  return (
    block.attrs?.align === "center" ||
    allMarked(block, "bold") ||
    isCaps(t) ||
    block.type === "heading"
  );
}

export function detectStructure(blocks: Block[]): DetectResult {
  const texts = blocks.map(textOf);
  const candidates: Candidate[] = [];
  const taken = new Set<number>();
  const add = (index: number, kind: CandidateKind, reason: string) => {
    if (taken.has(index)) return;
    taken.add(index);
    candidates.push({ index, kind, text: texts[index].trim(), reason, accepted: true });
  };

  // Blocks that already carry a manuscript element stay as they are.
  blocks.forEach((b, i) => {
    if (BOOK_ELEMENTS.has(elementOf(b) ?? "")) taken.add(i);
  });

  // A typed table of contents near the start: its "Chapter One" lines are
  // entries, not chapters. It runs until a page break, a paragraph of
  // prose, or the first entry's text appearing again (the real chapter).
  const contents: number[] = [];
  const contentsAt = blocks.findIndex(
    (_, i) => i < Math.max(40, blocks.length * 0.15) && /^(table of )?contents$/i.test(texts[i].trim()),
  );
  if (contentsAt >= 0) {
    contents.push(contentsAt);
    let firstEntry: string | null = null;
    for (let j = contentsAt + 1; j < blocks.length; j += 1) {
      const t = texts[j].trim();
      if (blocks[j].attrs?.pageBreakBefore) break;
      if (!t) {
        contents.push(j);
        continue;
      }
      if (wordCount(t) > 12 || t.includes("\n") || t === firstEntry) break;
      firstEntry ??= t;
      contents.push(j);
    }
    for (const i of contents) taken.add(i);
  }

  // "Set apart": the start, after a page break, a scene break or 2+ blanks.
  const setApart = blocks.map((b, i) => {
    if (b.attrs?.pageBreakBefore) return true;
    let j = i - 1;
    let blanks = 0;
    while (j >= 0 && isEmptyPara(blocks[j])) {
      blanks += 1;
      j -= 1;
    }
    if (j < 0) return true;
    if (blocks[j].type === "horizontalRule" || SCENE_MARK.test(texts[j])) return true;
    return blanks >= 2;
  });

  // 1. Real heading nodes: the most common level is the chapter level.
  const levelCount = new Map<number, number>();
  blocks.forEach((b, i) => {
    if (b.type === "heading" && texts[i].trim()) {
      const lvl = (b.attrs?.level as number) ?? 1;
      levelCount.set(lvl, (levelCount.get(lvl) ?? 0) + 1);
    }
  });
  let chapterLevel: number | null = null;
  for (const [lvl, count] of [...levelCount.entries()].sort((a, b) => a[0] - b[0])) {
    if (count >= 2 && (chapterLevel === null || count > (levelCount.get(chapterLevel) ?? 0))) {
      chapterLevel = lvl;
    }
  }
  blocks.forEach((b, i) => {
    if (b.type !== "heading" || taken.has(i)) return;
    const t = texts[i].trim();
    if (!t) return;
    const lvl = (b.attrs?.level as number) ?? 1;
    if (UNNUMBERED_NAMES.test(t)) add(i, "section", "Heading named like a section");
    else if (parseHeading(t, "part").labelled) add(i, "part", "“Part …” heading");
    else if (chapterLevel === null || lvl === chapterLevel) add(i, "chapter", `Heading ${lvl}`);
    else if (lvl > chapterLevel) add(i, "subheading", `Heading ${lvl} inside a chapter`);
    else if (parseHeading(t, "chapter").literal !== null) add(i, "chapter", `Heading ${lvl}`);
  });

  // 2. Typed headings: "Chapter 3", "PART TWO", "Prologue"…
  const bare: number[] = [];
  const shortLines: number[] = [];
  blocks.forEach((b, i) => {
    if (!isParagraph(b) || taken.has(i)) return;
    const t = texts[i].trim();
    if (!t || wordCount(t) > 12 || t.includes("\n")) return;
    const chapter = parseHeading(t, "chapter");
    const part = parseHeading(t, "part");
    if (chapter.labelled && chapter.literal !== null) {
      add(i, "chapter", "Starts with “Chapter”");
    } else if (part.labelled && part.literal !== null) {
      add(i, "part", "Starts with “Part”");
    } else if (UNNUMBERED_NAMES.test(t) && (setApart[i] || headingLike(b, t))) {
      add(i, "section", "A section name on its own line");
    } else if (chapter.literal !== null && !chapter.labelled && wordCount(t) <= 4) {
      bare.push(i);
    } else if (setApart[i] && headingLike(b, t)) {
      shortLines.push(i);
    }
  });

  // Bare numbers ("12", "III", "Twelve") count only as a rising sequence.
  if (bare.length >= 3) {
    let rising = 0;
    for (let k = 1; k < bare.length; k += 1) {
      const a = parseHeading(texts[bare[k - 1]]).literal ?? 0;
      const c = parseHeading(texts[bare[k]]).literal ?? 0;
      if (c > a) rising += 1;
    }
    if (rising >= (bare.length - 1) * 0.7) {
      for (const i of bare) add(i, "chapter", "A chapter number on its own line");
    }
  }
  // Short, emphasized, set-apart lines are chapter titles when there are
  // enough of them to be a pattern.
  if (shortLines.length >= 3) {
    for (const i of shortLines) add(i, "chapter", "A short title line set apart");
  }

  // Subtitles: "CHAPTER 3" followed by its title line.
  for (const c of [...candidates]) {
    if (c.kind !== "chapter" || parseHeading(c.text).title) continue;
    let j = c.index + 1;
    while (j < blocks.length && isEmptyPara(blocks[j])) j += 1;
    if (j < blocks.length && !taken.has(j) && isParagraph(blocks[j])) {
      const t = texts[j].trim();
      if (t && wordCount(t) <= 10 && !t.includes("\n") && (headingLike(blocks[j], t) || allMarked(blocks[j], "italic"))) {
        add(j, "subtitle", "The title under a chapter number");
      }
    }
  }
  candidates.sort((a, b) => a.index - b.index);

  // Where the story starts: blank lines and stray lines before it belong
  // to the hand-made front matter, not to scene breaks.
  const firstStructural =
    candidates.find((c) => c.kind !== "subheading" && c.kind !== "subtitle")?.index ?? -1;

  // 3. Scene breaks and blank lines.
  const sceneMarks: number[] = [];
  blocks.forEach((b, i) => {
    if (isParagraph(b) && !taken.has(i) && texts[i].trim() && SCENE_MARK.test(texts[i])) {
      sceneMarks.push(i);
    }
  });
  const isBody = (i: number) =>
    i >= 0 && i < blocks.length && isParagraph(blocks[i]) && !!texts[i].trim() && !taken.has(i);
  const empties: { index: number; between: boolean }[] = [];
  blocks.forEach((b, i) => {
    if (!isEmptyPara(b)) return;
    let before = i - 1;
    while (before >= 0 && isEmptyPara(blocks[before])) before -= 1;
    let after = i + 1;
    while (after < blocks.length && isEmptyPara(blocks[after])) after += 1;
    empties.push({ index: i, between: i > firstStructural && isBody(before) && isBody(after) });
  });
  const bodyCount = blocks.filter((_, i) => isBody(i)).length;
  // Blank lines on most gaps = paragraph spacing (delete them all); a few
  // between paragraphs = scene breaks.
  const blankPolicy: "delete" | "scene" =
    empties.length === 0 || empties.length > bodyCount * 0.5 ? "delete" : "scene";

  // 4. Front matter before the first chapter-level heading.
  const front: FrontMatterFind = { indexes: [], contents };
  if (firstStructural > 0) {
    const pre = [...Array(firstStructural).keys()].filter(
      (i) => texts[i].trim() && !contents.includes(i),
    );
    // Title (+ "by Author") at the very top.
    const first = pre[0];
    if (first !== undefined && wordCount(texts[first]) <= 12 && (headingLike(blocks[first], texts[first]) || blocks[first].type === "heading")) {
      front.title = texts[first].trim();
      front.indexes.push(first);
      const by = pre[1];
      const m = by !== undefined ? /^by\s+(.+)$/i.exec(texts[by].trim()) : null;
      if (m) {
        front.author = m[1].trim();
        front.indexes.push(by);
      }
    }
    for (let k = 0; k < pre.length; k += 1) {
      const i = pre[k];
      const t = texts[i].trim();
      if (front.indexes.includes(i)) continue;
      if (/(copyright|©)/i.test(t) && !front.copyright) {
        // The copyright notice: this paragraph and the ones after it on
        // the same page.
        const run: number[] = [i];
        let n = i + 1;
        while (
          n < firstStructural &&
          texts[n].trim() &&
          !blocks[n].attrs?.pageBreakBefore &&
          !contents.includes(n)
        ) {
          run.push(n++);
        }
        front.copyright = run.map((x) => texts[x].trim()).join("\n");
        const y = /(?:©|copyright)\s*(?:©\s*)?(\d{4})\s*(?:by\s+)?([^.\n]*)/i.exec(front.copyright);
        if (y) {
          front.copyrightYear = Number(y[1]);
          if (y[2]?.trim()) front.copyrightHolder = y[2].trim().replace(/[,.]$/, "");
        }
        front.indexes.push(...run);
        k += run.length - 1;
        continue;
      }
      if (/^also by\b/i.test(t)) {
        const list: string[] = [];
        front.indexes.push(i);
        let n = i + 1;
        while (n < firstStructural && texts[n].trim()) {
          list.push(texts[n].trim());
          front.indexes.push(n);
          n += 1;
        }
        front.alsoBy = list;
        continue;
      }
      if (!front.dedication && /^(for|to)\s/i.test(t) && wordCount(t) <= 30 && blocks[i].attrs?.align === "center") {
        front.dedication = t;
        front.indexes.push(i);
      }
    }
  }

  // 5. Cleanup: stray indents, page breaks the design makes redundant.
  const strips = new Map<number, number>();
  blocks.forEach((b, i) => {
    if (!isParagraph(b) && b.type !== "heading") return;
    const first = b.content?.[0];
    if (!first?.text) return;
    const lead = /^[\t \u00A0]+/.exec(first.text)?.[0].length ?? 0;
    if (lead > 0) strips.set(i, lead);
  });
  const chapterLike = new Set(
    candidates.filter((c) => c.kind === "chapter" || c.kind === "part" || c.kind === "section").map((c) => c.index),
  );
  const pageBreaks = blocks
    .map((b, i) => (b.attrs?.pageBreakBefore && chapterLike.has(i) ? i : -1))
    .filter((i) => i >= 0);

  return {
    blockCount: blocks.length,
    candidates,
    sceneMarks,
    empties,
    blankPolicy,
    front,
    strips,
    pageBreaks,
  };
}

/** What happens to one block. */
export interface BlockOp {
  action: "keep" | "element" | "scene" | "delete";
  element?: string;
  /** Leading whitespace characters to remove. */
  strip?: number;
  clearPageBreak?: boolean;
}

export interface PlanChoices {
  blankPolicy: "delete" | "scene";
  /** Lift the hand-typed title page / copyright / dedication / also-by
   *  into the book's details (and remove them from the text). */
  extractFront: boolean;
  removeContents: boolean;
}

const ELEMENT_FOR: Record<CandidateKind, string> = {
  chapter: "chapter_heading",
  part: "part_heading",
  section: "section_heading",
  subtitle: "chapter_subtitle",
  subheading: "subheading",
};

export function planOps(result: DetectResult, choices: PlanChoices): Map<number, BlockOp> {
  const ops = new Map<number, BlockOp>();
  const set = (i: number, patch: Partial<BlockOp>) =>
    ops.set(i, { action: "keep", ...ops.get(i), ...patch });

  for (const c of result.candidates) {
    if (c.accepted) set(c.index, { action: "element", element: ELEMENT_FOR[c.kind] });
  }
  for (const i of result.sceneMarks) set(i, { action: "scene" });
  // Blank lines: scene breaks only BETWEEN body paragraphs (and never two
  // in a row); everything else just goes.
  let lastWasScene = false;
  for (const e of result.empties) {
    if (choices.blankPolicy === "scene" && e.between && !lastWasScene) {
      set(e.index, { action: "scene" });
      lastWasScene = true;
    } else {
      set(e.index, { action: "delete" });
    }
    const nextEmpty = result.empties.find((x) => x.index === e.index + 1);
    if (!nextEmpty) lastWasScene = false;
  }
  if (choices.extractFront) for (const i of result.front.indexes) set(i, { action: "delete" });
  if (choices.removeContents) for (const i of result.front.contents) set(i, { action: "delete" });
  for (const [i, n] of result.strips) {
    const op = ops.get(i);
    if (!op || op.action === "keep" || op.action === "element") set(i, { strip: n });
  }
  for (const i of result.pageBreaks) set(i, { clearPageBreak: true });
  return ops;
}

/** The one-line summary shown above Convert. */
export function summarize(result: DetectResult, choices: PlanChoices): string {
  const count = (k: CandidateKind) => result.candidates.filter((c) => c.accepted && c.kind === k).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (count("chapter")) parts.push(plural(count("chapter"), "chapter"));
  if (count("part")) parts.push(plural(count("part"), "part"));
  if (count("section")) parts.push(plural(count("section"), "unnumbered section"));
  const breaks =
    result.sceneMarks.length +
    (choices.blankPolicy === "scene" ? result.empties.filter((e) => e.between).length : 0);
  if (breaks) parts.push(plural(breaks, "scene break"));
  if (choices.extractFront && result.front.indexes.length) parts.push("title page → Book details");
  if (result.strips.size) parts.push(plural(result.strips.size, "stray indent"));
  return parts.length ? parts.join(", ") : "No structure found — chapters can be marked by hand.";
}
