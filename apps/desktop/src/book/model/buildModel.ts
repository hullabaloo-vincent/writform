/**
 * Read a manuscript (editor JSON) as a book: split it into sections at
 * part / chapter / unnumbered-section headings, decide front vs body vs
 * back matter by position and name, number the chapters the way the design
 * says, apply the first-paragraph rules, and normalize punctuation. Direct
 * formatting (fonts, sizes, spacing) is deliberately ignored — the design
 * owns typography. Plain documents work too: Heading 1 is a chapter.
 */

import type { JSONContent } from "@tiptap/core";

import { SECTION_ELEMENTS } from "../../editor/DocElement";
import { quoteStyleFor } from "../../editor/SmartPunctuation";
import type { Book } from "./bookMap";
import {
  BACK_SECTIONS,
  FRONT_SECTIONS,
  numberLabel,
  parseHeading,
  SCENE_MARK,
} from "./chapters";
import { normalizeRuns } from "./punctuation";
import type {
  Align,
  Block,
  BookModel,
  EpigraphBlock,
  ParaBlock,
  QuoteBlock,
  Run,
  Section,
  Warning,
} from "./types";

function runsOf(node: JSONContent): Run[] {
  const runs: Run[] = [];
  const walk = (n: JSONContent, inherited: { italic?: boolean; bold?: boolean; href?: string }) => {
    const marks = n.marks ?? [];
    const italic =
      inherited.italic || marks.some((m) => m.type === "italic" || m.type === "underline");
    const bold = inherited.bold || marks.some((m) => m.type === "bold");
    const link = marks.find((m) => m.type === "link")?.attrs?.href as string | undefined;
    const href = inherited.href ?? link;
    if (n.type === "hardBreak") runs.push({ text: "\n", italic, bold });
    else if (n.text) runs.push({ text: n.text, ...(italic ? { italic } : {}), ...(bold ? { bold } : {}), ...(href ? { href } : {}) });
    for (const c of n.content ?? []) walk(c, { italic, bold, href });
  };
  for (const c of node.content ?? []) walk(c, {});
  // Merge neighbours with identical styling.
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.italic === r.italic && last.bold === r.bold && last.href === r.href && r.text !== "\n" && last.text !== "\n") {
      last.text += r.text;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

const textOf = (runs: Run[]) => runs.map((r) => r.text).join("");
const wordsIn = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function alignOf(node: JSONContent): Align {
  const a = node.attrs?.align;
  return a === "center" || a === "right" || a === "justify" ? a : "left";
}

/** Valid ISBN-10 or ISBN-13 (hyphens/spaces ignored). */
export function validIsbn(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) {
    const sum = [...s].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, ch, i) => acc + (ch === "X" ? 10 : Number(ch)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  return false;
}

export function buildModel(doc: JSONContent, format: string, book: Book): BookModel {
  const design = book.design;
  const blocks = doc.content ?? [];
  const warnings: Warning[] = [];
  const sections: Section[] = [];
  const quotes = quoteStyleFor(book.meta.language);
  const normalize = design.quotes !== "straight";
  const fix = (runs: Run[]): Run[] => {
    if (!normalize) return runs;
    const texts = normalizeRuns(runs.map((r) => r.text), { quotes });
    return runs.map((r, i) => ({ ...r, text: texts[i] })).filter((r) => r.text);
  };

  let current: Section | null = null;
  let chapterNo = 0;
  let partNo = 0;
  let blankLines = 0;
  /** The next paragraph starts fresh (no indent). */
  let fresh = true;
  /** Still in the opener: an epigraph here belongs to the heading. */
  let inOpener = false;

  const open = (kind: Section["kind"], src: number, heading = ""): Section => {
    const parsed = kind === "chapter" || kind === "part" ? parseHeading(heading, kind) : null;
    let number: number | null = null;
    let label = "";
    if (kind === "part") {
      partNo += 1;
      number = partNo;
      if (design.restartNumbersInParts) chapterNo = 0;
      if (design.chapterNumber !== "none" && design.chapterNumber !== "as-written") {
        label = numberLabel(partNo, design.chapterNumber === "numeral" ? "word" : design.chapterNumber, "Part");
      }
    } else if (kind === "chapter") {
      chapterNo += 1;
      number = chapterNo;
      if (parsed?.literal !== null && parsed?.literal !== undefined && parsed.literal !== chapterNo) {
        warnings.push({
          kind: "number-mismatch",
          message: `“${heading}” is chapter ${chapterNo}; it prints as ${numberLabel(chapterNo, design.chapterNumber === "as-written" ? "numeral" : design.chapterNumber, design.chapterLabel) || `chapter ${chapterNo}`}.`,
          src,
        });
      }
      if (design.chapterNumber !== "as-written") {
        label = numberLabel(chapterNo, design.chapterNumber, design.chapterLabel);
      }
    }
    const title =
      kind === "chapter" && design.chapterNumber !== "as-written"
        ? (parsed?.title ?? heading)
        : kind === "part" && design.chapterNumber !== "as-written"
          ? (parsed?.title ?? heading)
          : heading;
    const section: Section = {
      id: `s${sections.length + 1}`,
      kind,
      matter: "body",
      number,
      label,
      title: normalize ? normalizeRuns([title], { quotes })[0] : title,
      subtitle: "",
      epigraph: null,
      blocks: [],
      src,
      words: wordsIn(heading),
    };
    sections.push(section);
    current = section;
    fresh = true;
    inOpener = true;
    return section;
  };

  const ensure = (src: number): Section => current ?? open("untitled", src);

  /** A page break the writer put in: what comes next starts a new page —
   *  after a heading, too (the heading keeps its opening page to itself).
   *  Before the first section there's no page to break. */
  const breakPage = (src: number) => {
    current?.blocks.push({ kind: "pageBreak", src });
  };

  const pushPara = (node: JSONContent, src: number, runs: Run[]) => {
    const section = ensure(src);
    const element = (node.attrs?.element as string | null) ?? null;
    const align = alignOf(node);
    const para: ParaBlock = {
      kind: "para",
      runs: fix(runs),
      align: align === "justify" ? "left" : align,
      indent: !fresh && element !== "flush" && align !== "center" && align !== "right",
      opener: inOpener && section.blocks.every((b) => b.kind !== "para"),
      src,
    };
    section.blocks.push(para);
    section.words += wordsIn(textOf(runs));
    fresh = false;
    inOpener = false;
  };

  const lastEpigraph = (section: Section): EpigraphBlock | null => {
    const last = section.blocks[section.blocks.length - 1];
    if (last?.kind === "epigraph") return last;
    if (inOpener && section.epigraph) return section.epigraph;
    return null;
  };

  blocks.forEach((node, src) => {
    const type = node.type ?? "paragraph";
    const element = (node.attrs?.element as string | null) ?? null;

    if (type === "heading") {
      const runs = runsOf(node);
      const text = textOf(runs).trim();
      const level = (node.attrs?.level as number) ?? 1;
      if (level === 1) {
        const kind = parseHeading(text, "part").labelled && format !== "manuscript" ? "part" : "chapter";
        open(kind, src, text);
      } else {
        if (node.attrs?.pageBreakBefore) breakPage(src);
        ensure(src).blocks.push({ kind: "subheading", runs: fix(runs), src });
        fresh = true;
      }
      return;
    }

    if (type === "paragraph") {
      const runs = runsOf(node);
      const text = textOf(runs);
      const headingKind = element ? SECTION_ELEMENTS.get(element) : undefined;
      if (headingKind) {
        open(headingKind, src, text.trim());
        return;
      }
      // Any line can start a new page — verse, an epigraph, a letter's first
      // line — except a chapter's subtitle, which belongs to its heading.
      if (node.attrs?.pageBreakBefore && !(element === "chapter_subtitle" && current && inOpener)) {
        breakPage(src);
        fresh = true;
      }
      if (!text.trim()) {
        // An empty line there just to carry a page break isn't spacing.
        if (!node.attrs?.pageBreakBefore) blankLines += 1;
        return;
      }
      if (element === "chapter_subtitle" && current && inOpener) {
        if (!current.title) current.title = fix(runs).map((r) => r.text).join("").trim();
        else current.subtitle = fix(runs).map((r) => r.text).join("").trim();
        return;
      }
      if (element === "subheading") {
        ensure(src).blocks.push({ kind: "subheading", runs: fix(runs), src });
        fresh = true;
        return;
      }
      if (element === "epigraph") {
        const section = ensure(src);
        // A line put on a new page doesn't join the epigraph before it.
        const existing = node.attrs?.pageBreakBefore ? null : lastEpigraph(section);
        if (existing && !existing.attribution) {
          existing.paras.push(fix(runs));
        } else {
          const epi: EpigraphBlock = { kind: "epigraph", paras: [fix(runs)], attribution: null, src };
          if (inOpener && !section.blocks.length) section.epigraph = epi;
          else section.blocks.push(epi);
        }
        fresh = true;
        return;
      }
      if (element === "attribution") {
        const section = ensure(src);
        const epi = lastEpigraph(section);
        if (epi) epi.attribution = fix(runs);
        else section.blocks.push({ kind: "para", runs: fix(runs), align: "right", indent: false, opener: false, src });
        fresh = true;
        return;
      }
      if (element === "verse") {
        const lines: Run[][] = [[]];
        for (const r of fix(runs)) {
          if (r.text === "\n") lines.push([]);
          else lines[lines.length - 1].push(r);
        }
        ensure(src).blocks.push({ kind: "verse", lines, src });
        current!.words += wordsIn(text);
        inOpener = false;
        return;
      }
      // A typed "* * *" line is a scene break in any format.
      if ((!element || element === "paragraph") && SCENE_MARK.test(text)) {
        ensure(src).blocks.push({ kind: "scene", src });
        fresh = true;
        return;
      }
      pushPara(node, src, runs);
      return;
    }

    if (type === "horizontalRule") {
      const section = ensure(src);
      // Consecutive breaks collapse; a break opening or closing a section
      // is dropped later.
      if (section.blocks[section.blocks.length - 1]?.kind !== "scene") {
        section.blocks.push({ kind: "scene", src });
      }
      fresh = true;
      return;
    }

    if (type === "blockquote") {
      // A page break inside a letter or extract continues it on a new page.
      let paras: QuoteBlock["paras"] = [];
      const flush = () => {
        if (!paras.length) return;
        ensure(src).blocks.push({ kind: "blockquote", paras, src });
        current!.words += paras.reduce((n, p) => n + wordsIn(textOf(p.runs)), 0);
        paras = [];
      };
      for (const c of node.content ?? []) {
        if (c.type !== "paragraph") continue;
        if (c.attrs?.pageBreakBefore) {
          flush();
          breakPage(src);
        }
        const para = { runs: fix(runsOf(c)), align: alignOf(c) };
        if (textOf(para.runs).trim()) paras.push(para);
      }
      flush();
      inOpener = false;
      return;
    }

    if (type === "bulletList" || type === "orderedList") {
      const items = (node.content ?? []).map((item) =>
        fix((item.content ?? []).flatMap((c) => runsOf(c))),
      );
      ensure(src).blocks.push({ kind: "list", ordered: type === "orderedList", items, src });
      fresh = true;
      inOpener = false;
      return;
    }

    if (type === "image") {
      const url = node.attrs?.src as string | undefined;
      if (url) ensure(src).blocks.push({ kind: "image", url, alt: String(node.attrs?.alt ?? ""), src });
      fresh = true;
      return;
    }

    if (type === "codeBlock") {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      for (const line of text.split("\n")) {
        if (line.trim()) pushPara({ type: "paragraph" }, src, [{ text: line }]);
      }
    }
  });

  // Breaks. A scene break against a page break moves to the new page's
  // top, where the engine shows its ornament (as at any page turn); repeats
  // collapse; no section ends on a break, and none opens on a scene break
  // (a page break there parts the text from the heading, so it stays).
  const isBreak = (b: Block | undefined) => b?.kind === "scene" || b?.kind === "pageBreak";
  for (const section of sections) {
    const blocks = section.blocks;
    for (let i = blocks.length - 2; i >= 0; i -= 1) {
      if (blocks[i].kind === "scene" && blocks[i + 1].kind === "pageBreak") {
        [blocks[i], blocks[i + 1]] = [blocks[i + 1], blocks[i]];
      }
    }
    section.blocks = blocks.filter((b, i) => !(isBreak(b) && blocks[i - 1]?.kind === b.kind));
    const lead = section.blocks[0]?.kind === "pageBreak" ? 1 : 0;
    while (section.blocks[lead]?.kind === "scene") section.blocks.splice(lead, 1);
    while (isBreak(section.blocks[section.blocks.length - 1])) section.blocks.pop();
    if (section.kind === "chapter" && section.blocks.length === 0) {
      warnings.push({ kind: "empty-section", message: `${section.label || section.title || "A chapter"} has no text.`, src: section.src });
    }
  }

  // Front / body / back by position: unnumbered sections before the first
  // chapter with front-matter names (Foreword, Preface…) are front matter;
  // after the last chapter, back-matter names are back matter.
  const firstChapter = sections.findIndex((s) => s.kind === "chapter" || s.kind === "part");
  let lastChapter = -1;
  sections.forEach((s, i) => {
    if (s.kind === "chapter") lastChapter = i;
  });
  sections.forEach((s, i) => {
    if (s.kind !== "section") return;
    if (firstChapter >= 0 && i < firstChapter && FRONT_SECTIONS.test(s.title)) s.matter = "front";
    else if (lastChapter >= 0 && i > lastChapter && BACK_SECTIONS.test(s.title) && !/^(epilogue|coda)$/i.test(s.title)) {
      s.matter = "back";
    }
  });

  if (blankLines > 0) {
    warnings.push({
      kind: "blank-lines",
      message: `${blankLines} blank line${blankLines === 1 ? " doesn’t" : "s don’t"} print — the design sets the spacing. Use a scene break (* * *) where you meant a pause.`,
    });
  }
  for (const [field, label] of [
    ["isbnPrint", "print"],
    ["isbnEbook", "ebook"],
  ] as const) {
    const value = book.meta[field];
    if (value && !validIsbn(value)) {
      warnings.push({ kind: "isbn", message: `The ${label} ISBN “${value}” isn’t valid — check the digits.` });
    }
  }

  return { book, sections, warnings, words: sections.reduce((n, s) => n + s.words, 0) };
}
