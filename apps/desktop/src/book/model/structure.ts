/**
 * A document's structure — parts, chapters, unnumbered sections and
 * subheadings — with the numbers the book design will print. Shared by the
 * outline, the editor's chapter labels, and the exports' model builder.
 * Works on a ProseMirror node; word counts reuse the per-node cache.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { countDocWords } from "../../apps/documents/stats";
import { numberLabel, parseHeading } from "./chapters";
import type { BookDesign } from "./presets";

export type EntryKind = "part" | "chapter" | "section" | "subheading" | "heading";

export interface StructureEntry {
  /** Top-level block index. */
  index: number;
  /** Document position of the block's start. */
  pos: number;
  kind: EntryKind;
  /** 0 part, 1 chapter-level, 2 below. */
  level: number;
  /** The heading as typed. */
  text: string;
  /** The title to show (literal numbers peeled off; subtitle promoted). */
  title: string;
  /** Auto number for chapters/parts (null for unnumbered). */
  number: number | null;
  /** The number typed into the heading, if any. */
  literal: number | null;
  /** The printed label ("Chapter Three"), "" when the design prints none. */
  label: string;
  /** A typed number that disagrees with where the chapter now sits. */
  mismatch: boolean;
  /** Words from this heading to the next one at the same or higher level. */
  words: number;
  /** Exclusive end block index of this section (moves take index..end). */
  endIndex: number;
}

const ELEMENT_KIND: Record<string, EntryKind> = {
  chapter_heading: "chapter",
  part_heading: "part",
  section_heading: "section",
  subheading: "subheading",
};

/** Script formats' outline headings (unchanged from the old outline). */
const SCRIPT_HEADINGS: Record<string, number> = {
  scene_heading: 1,
  act_heading: 0,
  stanza_title: 1,
};

function kindOf(node: PmNode, format: string): { kind: EntryKind; level: number } | null {
  if (node.type.name === "heading") {
    const lvl = (node.attrs.level as number) ?? 1;
    // In a manuscript, a leftover Heading 1 is a chapter; deeper ones subheads.
    if (format === "manuscript") {
      return lvl === 1 ? { kind: "chapter", level: 1 } : { kind: "subheading", level: 2 };
    }
    return { kind: "heading", level: Math.max(0, lvl - 1) };
  }
  if (node.type.name !== "paragraph") return null;
  const element = (node.attrs.element as string | null) ?? "";
  if (format === "manuscript") {
    const kind = ELEMENT_KIND[element];
    if (!kind) return null;
    return { kind, level: kind === "part" ? 0 : kind === "subheading" ? 2 : 1 };
  }
  const level = SCRIPT_HEADINGS[element];
  return level === undefined ? null : { kind: "heading", level };
}

export function scanStructure(
  doc: PmNode,
  format: string,
  design: Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">,
  opts: { words?: boolean } = {},
): { entries: StructureEntry[]; total: number } {
  const entries: StructureEntry[] = [];
  const blockWords: number[] = [];
  const blocks: PmNode[] = [];
  let chapterNo = 0;
  let partNo = 0;
  let pos = 0;
  doc.forEach((node, offset, index) => {
    blocks.push(node);
    if (opts.words) blockWords.push(countDocWords(node));
    const kind = kindOf(node, format);
    pos = offset;
    if (!kind) return;
    const text = node.textContent.trim();
    let title = text;
    let number: number | null = null;
    let literal: number | null = null;
    let label = "";
    if (kind.kind === "chapter" || kind.kind === "part") {
      const parsed = parseHeading(text, kind.kind);
      literal = parsed.literal;
      title = parsed.title;
      if (kind.kind === "part") {
        partNo += 1;
        number = partNo;
        if (design.restartNumbersInParts) chapterNo = 0;
        label = design.chapterNumber === "none" || design.chapterNumber === "as-written"
          ? ""
          : numberLabel(partNo, design.chapterNumber === "numeral" ? "word" : design.chapterNumber, "Part");
      } else {
        chapterNo += 1;
        number = chapterNo;
        label =
          design.chapterNumber === "as-written"
            ? ""
            : numberLabel(chapterNo, design.chapterNumber, design.chapterLabel);
      }
    }
    entries.push({
      index,
      pos,
      kind: kind.kind,
      level: kind.level,
      text,
      title,
      number,
      literal,
      label,
      mismatch: literal !== null && number !== null && literal !== number,
      words: 0,
      endIndex: index + 1,
    });
  });

  // "CHAPTER 3" + a subtitle line under it: the subtitle is the real title.
  for (const entry of entries) {
    if (entry.kind !== "chapter" || entry.title) continue;
    const next = blocks[entry.index + 1];
    if (next?.type.name === "paragraph" && next.attrs.element === "chapter_subtitle") {
      entry.title = next.textContent.trim();
    }
  }

  // Section extents: until the next entry at the same or a higher level.
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    let end = blocks.length;
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[j].level <= entry.level) {
        end = entries[j].index;
        break;
      }
    }
    entry.endIndex = end;
    if (opts.words) {
      let words = 0;
      for (let b = entry.index; b < end; b += 1) words += blockWords[b];
      entry.words = words;
    }
  }

  const total = opts.words ? blockWords.reduce((a, b) => a + b, 0) : 0;
  return { entries, total };
}

/** Start position of every top-level block (plus the end of the doc). */
export function blockOffsets(doc: PmNode): number[] {
  const offsets: number[] = [];
  doc.forEach((_node, offset) => offsets.push(offset));
  offsets.push(doc.content.size);
  return offsets;
}
