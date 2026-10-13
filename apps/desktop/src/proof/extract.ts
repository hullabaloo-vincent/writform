/**
 * A ProseMirror document as the checks read it: its paragraphs as plain
 * text (`Scan`), and beside them how each one's text maps back to
 * positions in the document (`BlockPos`). The only part of the checker
 * that knows ProseMirror.
 *
 * What a paragraph reads as is kept by node (unchanged paragraphs are the
 * same objects from one state to the next), so a keystroke re-reads one.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { OBJ } from "./engine/tokens";
import type { BlockInput, ListPlace, Role, Scan } from "./types";

export interface BlockPos {
  /** The document position where the block's content begins. */
  start: number;
  /** Stretches of `text` that are text in the document, one character to
   *  one position, flat: [offset in text, offset in the content, length…]. */
  runs: number[];
}

export interface Extracted {
  doc: PmNode;
  scan: Scan;
  places: BlockPos[];
}

interface Where {
  list: ListPlace | null;
  listId: number;
  cell: boolean;
  quoted: boolean;
  /** The above as a string: with the node, what a reading is kept under. */
  key: string;
}

interface Kept {
  key: string;
  input: BlockInput;
  runs: number[];
  notes: { offset: number; input: BlockInput; runs: number[] }[];
}

const kept = new WeakMap<PmNode, Kept>();

const struck = (node: PmNode): boolean => node.marks.some((m) => m.type.name === "deletion");
/** A table, a picture or a rule that someone has suggested removing. */
const removed = (node: PmNode): boolean => typeof node.attrs.tc === "string" && node.attrs.tc.includes("del:") && !node.isTextblock;

const HEADINGS: Record<string, Record<string, [Role, string | null]>> = {
  screenplay: { scene_heading: ["caps", "scene"], character: ["caps", null], transition: ["caps", null], dialogue: ["speech", null] },
  stageplay: { act_heading: ["caps", "act"], scene_heading: ["caps", "scene"], character: ["caps", null], dialogue: ["speech", null] },
  manuscript: {
    chapter_heading: ["heading", "chapter"],
    part_heading: ["heading", "part"],
    section_heading: ["heading", "section"],
    chapter_subtitle: ["heading", "subtitle"],
    subheading: ["heading", "subheading"],
    epigraph: ["extract", null],
    attribution: ["extract", null],
    verse: ["verse", null],
  },
  poetry: { stanza_title: ["heading", "stanza"] },
  none: { title: ["heading", "title"], subtitle: ["heading", "subtitle"] },
};

function roleOf(node: PmNode, format: string, quoted: boolean): [Role, string | null, string | null] {
  const element = typeof node.attrs.element === "string" ? node.attrs.element : null;
  if (node.type.name === "heading") return ["heading", `h${Number(node.attrs.level) || 1}`, element];
  const known = element ? HEADINGS[format]?.[element] : undefined;
  if (known) return [known[0], known[1], element];
  if (format === "poetry") return ["verse", null, element];
  return [quoted ? "extract" : "body", null, element];
}

interface TextOf {
  text: string;
  runs: number[];
  italic: number[];
  highlight: number[];
  link: number[];
  notes: { offset: number; node: PmNode }[];
}

function textOf(node: PmNode): TextOf {
  const out: TextOf = { text: "", runs: [], italic: [], highlight: [], link: [], notes: [] };
  const run = (offset: number, length: number) => {
    const r = out.runs;
    const k = r.length - 3;
    if (k >= 0 && r[k] + r[k + 2] === out.text.length && r[k + 1] + r[k + 2] === offset) r[k + 2] += length;
    else r.push(out.text.length, offset, length);
  };
  const span = (list: number[], from: number, to: number) => {
    if (list.length && list[list.length - 1] === from) list[list.length - 1] = to;
    else list.push(from, to);
  };
  node.forEach((child, offset) => {
    if (child.isText) {
      if (struck(child)) return;
      const value = child.text ?? "";
      let code = false;
      const from = out.text.length;
      for (const mark of child.marks) {
        const name = mark.type.name;
        if (name === "code") code = true;
        else if (name === "italic") span(out.italic, from, from + value.length);
        else if (name === "highlight") span(out.highlight, from, from + value.length);
        else if (name === "link") span(out.link, from, from + value.length);
      }
      if (code) {
        // Code is not prose: one mark stands for the run, and no position.
        if (!out.text.endsWith(OBJ)) out.text += OBJ;
        return;
      }
      run(offset, value.length);
      out.text += value;
    } else if (child.type.name === "footnote") {
      if (!removed(child)) out.notes.push({ offset, node: child });
    } else if (child.type.name === "hardBreak") {
      if (removed(child)) return;
      run(offset, 1);
      out.text += "\n";
    } else if (child.isLeaf && child.nodeSize === 1) {
      run(offset, 1);
      out.text += OBJ;
    } else {
      out.text += OBJ;
    }
  });
  return out;
}

function input(t: TextOf, role: Role, heading: string | null, element: string | null, where: Where, note: boolean): BlockInput {
  const list = note ? null : where.list;
  const sig = [role, heading ?? "", element ?? "", list ? `${list.kind}${list.depth}${list.part}` : "", `${where.cell ? 1 : 0}${note ? 1 : 0}${where.quoted ? 1 : 0}`, t.italic.join(","), t.highlight.join(","), t.link.join(",")].join("|");
  return { text: t.text, role, heading, element, list, cell: where.cell, note, quoted: where.quoted, italic: t.italic, highlight: t.highlight, link: t.link, sig };
}

function readBlock(node: PmNode, format: string, where: Where): Kept {
  const was = kept.get(node);
  if (was && was.key === where.key) return was;
  const t = textOf(node);
  const [role, heading, element] = roleOf(node, format, where.quoted);
  const made: Kept = {
    key: where.key,
    input: input(t, role, heading, element, where, false),
    runs: t.runs,
    notes: t.notes.map(({ offset, node: note }) => {
      const nt = textOf(note);
      return { offset, input: input(nt, "body", null, null, where, true), runs: nt.runs };
    }),
  };
  kept.set(node, made);
  return made;
}

const LISTS: Record<string, ListPlace["kind"]> = { bulletList: "bullet", orderedList: "ordered", taskList: "task" };

export function extract(doc: PmNode, format: string): Extracted {
  const blocks: BlockInput[] = [];
  const places: BlockPos[] = [];
  const prev: number[] = [];
  const list: number[] = [];
  let lists = 0;
  const where = (base: Omit<Where, "key">): Where => ({ ...base, key: `${format}|${base.list ? `${base.list.kind}${base.list.depth}${base.list.part}` : ""}|${base.cell ? 1 : 0}${base.quoted ? 1 : 0}` });

  const walk = (parent: PmNode, content: number, at: Where) => {
    let last = -1;
    parent.forEach((child, offset) => {
      const pos = content + offset;
      const name = child.type.name;
      if (removed(child) || name === "codeBlock") {
        last = -1;
        return;
      }
      if (child.isTextblock) {
        const k = readBlock(child, format, at);
        const index = blocks.length;
        blocks.push(k.input);
        places.push({ start: pos + 1, runs: k.runs });
        list.push(at.listId);
        // Prose runs on from the paragraph before. A heading, or a line in
        // capitals, begins again.
        const chains = k.input.role !== "heading" && k.input.role !== "caps";
        prev.push(chains ? last : -1);
        last = chains ? index : -1;
        for (const note of k.notes) {
          blocks.push(note.input);
          places.push({ start: pos + 1 + note.offset + 1, runs: note.runs });
          prev.push(-1);
          list.push(0);
        }
        return;
      }
      last = -1;
      if (child.isLeaf) return;
      const kind = LISTS[name];
      if (kind) {
        lists += 1;
        const id = lists;
        const count = child.childCount;
        child.forEach((item, itemOffset, index) => {
          const part: ListPlace["part"] = count === 1 ? "only" : index === 0 ? "first" : index === count - 1 ? "last" : "middle";
          walk(item, pos + 1 + itemOffset + 1, where({ list: { kind, depth: (at.list?.depth ?? 0) + 1, part }, listId: id, cell: at.cell, quoted: at.quoted }));
        });
        return;
      }
      const inside = name === "blockquote" ? where({ ...at, quoted: true }) : name === "tableCell" || name === "tableHeader" ? where({ ...at, cell: true }) : at;
      walk(child, pos + 1, inside);
    });
  };
  walk(doc, 0, where({ list: null, listId: 0, cell: false, quoted: false }));
  return { doc, scan: { blocks, prev: Int32Array.from(prev), list: Int32Array.from(list) }, places };
}

/** The document position of a text offset: where a range starts, or where
 *  something would be put in. Null when that spot is not text. */
export function posOf(place: BlockPos, offset: number): number | null {
  const r = place.runs;
  for (let k = 0; k < r.length; k += 3) if (offset >= r[k] && offset < r[k] + r[k + 2]) return place.start + r[k + 1] + (offset - r[k]);
  for (let k = 0; k < r.length; k += 3) if (offset === r[k] + r[k + 2]) return place.start + r[k + 1] + r[k + 2];
  return r.length === 0 && offset === 0 ? place.start : null;
}

/** The document position where a range ends. */
export function endOf(place: BlockPos, offset: number): number | null {
  const r = place.runs;
  for (let k = 0; k < r.length; k += 3) if (offset > r[k] && offset <= r[k] + r[k + 2]) return place.start + r[k + 1] + (offset - r[k]);
  return null;
}

/** Whether a stretch of text is one unbroken stretch of the document
 *  (nothing struck, no note and no object inside it): only such a stretch
 *  is changed by a fix. */
export function solid(place: BlockPos, a: number, b: number): boolean {
  if (a === b) return posOf(place, a) !== null;
  const r = place.runs;
  for (let k = 0; k < r.length; k += 3) if (a >= r[k] && b <= r[k] + r[k + 2]) return true;
  return false;
}

/** The stretch of the document a stretch of text covers, for showing it. */
export function rangeOf(place: BlockPos, a: number, b: number): { from: number; to: number } {
  const r = place.runs;
  let from = posOf(place, a);
  if (from === null) {
    from = place.start;
    for (let k = 0; k < r.length; k += 3) {
      if (r[k] >= a) {
        from = place.start + r[k + 1];
        break;
      }
      from = place.start + r[k + 1] + r[k + 2];
    }
  }
  let to = b > a ? endOf(place, b) : from;
  if (to === null) {
    to = from;
    for (let k = 0; k < r.length; k += 3) if (r[k] < b) to = place.start + r[k + 1] + Math.min(r[k + 2], b - r[k]);
  }
  return { from, to: Math.max(from, to) };
}
