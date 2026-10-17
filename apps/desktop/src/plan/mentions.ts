/**
 * Where the cast and world appear in the text: each entry's name and other
 * names found as whole words, chapter by chapter.
 *
 * - Whole words only: "Ann" is not found in "Anna".
 * - "Anna's" is Anna.
 * - A name written with a capital is found only with one (or in capitals,
 *   as a screenplay's character cues are). One written in lower case ("the
 *   ring") is found however it is written. An entry can ask to be found
 *   whatever its capitals.
 * - A one-word name that is also a common word (Will, May, Rose) isn't
 *   counted where it opens a sentence.
 * - A name of several words has only spaces (or a joining hyphen) between
 *   them. The longest name found wins: "Anna Kent" is not also "Anna".
 * - A name two entries share counts for the first of them.
 * - Words someone suggested deleting, and footnotes, aren't counted.
 *
 * Each paragraph is read once and kept until it changes. Nothing here needs
 * a window.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { NAME_HOMOGRAPHS } from "../proof/data/en/names";
import { F_CAP, F_JOINED, F_UPPER, fold, OBJ, PUNCT, SPACE, tokenize, WORD, ALNUM, type Tokens } from "../proof/engine/tokens";
import type { CastEntry } from "./model";

interface Pattern {
  entry: string;
  words: string[];
  /** Each word must have a capital. */
  caps: boolean[];
  /** A single common word: not at a sentence's start. */
  common: boolean;
}

export interface NameIndex {
  /** Changes when any name does. */
  sig: string;
  byFirst: Map<string, Pattern[]>;
  /** Names more than one entry has: "Kit (Kit Marlowe, Kit the dog)". */
  clashes: string[];
}

/** The letters of a word as compared: lower case, without a closing 's. */
const key = (word: string): string => {
  const f = fold(word);
  return f.endsWith("'s") && f.length > 2 ? f.slice(0, -2) : f;
};

const wordsOf = (name: string): string[] => {
  const tk = tokenize(name);
  const out: string[] = [];
  for (let i = 0; i < tk.n; i += 1) if (tk.kind[i] === WORD || tk.kind[i] === ALNUM) out.push(name.slice(tk.start[i], tk.end[i]));
  return out;
};

export function buildNameIndex(cast: readonly CastEntry[]): NameIndex {
  const byFirst = new Map<string, Pattern[]>();
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  const sig: string[] = [];
  for (const entry of cast) {
    sig.push(`${entry.id}:${entry.anyCase ? 1 : 0}:${[entry.name, ...entry.aka].join("\u0001")}`);
    for (const name of [entry.name, ...entry.aka]) {
      const words = wordsOf(name);
      if (!words.length) continue;
      const folded = words.map(key);
      const id = folded.join(" ");
      const had = owner.get(id);
      if (had !== undefined) {
        if (had !== entry.id) clashes.push(name);
        continue;
      }
      owner.set(id, entry.id);
      const caps = words.map((w) => !entry.anyCase && w.charAt(0) !== w.charAt(0).toLowerCase());
      const pattern: Pattern = { entry: entry.id, words: folded, caps, common: folded.length === 1 && NAME_HOMOGRAPHS.has(folded[0]) };
      const list = byFirst.get(folded[0]);
      if (list) list.push(pattern);
      else byFirst.set(folded[0], [pattern]);
    }
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);
  return { sig: sig.join("\u0002"), byFirst, clashes };
}

/** A textblock's own text as the counts read it, and where each piece of
 *  it is in the block (text offset, offset in the block's content). */
interface Read {
  text: string;
  tk: Tokens;
  pieces: { at: number; pos: number; len: number }[];
}

const reads = new WeakMap<PmNode, Read>();
const struck = (node: PmNode) => node.marks.some((m) => m.type.name === "deletion");

function readBlock(node: PmNode): Read {
  const hit = reads.get(node);
  if (hit) return hit;
  let text = "";
  const pieces: Read["pieces"] = [];
  node.forEach((child, offset) => {
    if (child.isText && !struck(child)) {
      pieces.push({ at: text.length, pos: offset, len: child.text?.length ?? 0 });
      text += child.text ?? "";
    } else text += OBJ;
  });
  const read = { text, tk: tokenize(text), pieces };
  reads.set(node, read);
  return read;
}

const SENTENCE_END = ".!?…";
const QUOTES = "\"'“”‘’«»(";

/** Whether the word at token `i` opens a sentence. */
function opensSentence(read: Read, i: number): boolean {
  for (let j = i - 1; j >= 0; j -= 1) {
    const kind = read.tk.kind[j];
    if (kind === SPACE) continue;
    const t = read.text.slice(read.tk.start[j], read.tk.end[j]);
    if (kind === PUNCT && QUOTES.includes(t)) continue;
    return kind === PUNCT && SENTENCE_END.includes(t);
  }
  return true;
}

/** The names found in one textblock: entry, start and end in its text. */
function findIn(read: Read, index: NameIndex): { entry: string; from: number; to: number }[] {
  const out: { entry: string; from: number; to: number }[] = [];
  const { tk, text } = read;
  for (let i = 0; i < tk.n; i += 1) {
    if (tk.kind[i] !== WORD && tk.kind[i] !== ALNUM) continue;
    const patterns = index.byFirst.get(key(text.slice(tk.start[i], tk.end[i])));
    if (!patterns) continue;
    let took = 0;
    for (const p of patterns) {
      let j = i;
      let ok = true;
      for (let w = 0; w < p.words.length; w += 1) {
        if (w > 0) {
          // Only a space or a joining hyphen between a name's words.
          j += 1;
          if (j >= tk.n || !(tk.kind[j] === SPACE || (tk.kind[j] === PUNCT && tk.flag[j] & F_JOINED))) {
            ok = false;
            break;
          }
          j += 1;
        }
        if (j >= tk.n || (tk.kind[j] !== WORD && tk.kind[j] !== ALNUM)) {
          ok = false;
          break;
        }
        const word = text.slice(tk.start[j], tk.end[j]);
        // (A closing 's only on the last word.)
        if ((w < p.words.length - 1 ? fold(word) : key(word)) !== p.words[w]) {
          ok = false;
          break;
        }
        if (p.caps[w] && !(tk.flag[j] & (F_CAP | F_UPPER))) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (p.common && opensSentence(read, i)) continue;
      out.push({ entry: p.entry, from: tk.start[i], to: tk.end[j] });
      took = j;
      break;
    }
    if (took) i = took;
  }
  return out;
}

const counted = new WeakMap<PmNode, { sig: string; counts: Map<string, number> }>();

function countBlock(node: PmNode, index: NameIndex): Map<string, number> {
  const hit = counted.get(node);
  if (hit && hit.sig === index.sig) return hit.counts;
  const counts = new Map<string, number>();
  for (const m of findIn(readBlock(node), index)) counts.set(m.entry, (counts.get(m.entry) ?? 0) + 1);
  counted.set(node, { sig: index.sig, counts });
  return counts;
}

export interface EntryMentions {
  /** Column index → mentions there. */
  cols: Map<number, number>;
  total: number;
  /** The first column it appears in, or -1. */
  first: number;
}

export interface Mentions {
  byEntry: Map<string, EntryMentions>;
  clashes: string[];
}

/** Each entry's mentions, column by column (`columns` as resolve.ts gives
 *  them: each covers its blocks from `index` up to `endIndex`). */
export function mentionsByColumn(doc: PmNode, columns: readonly { index: number; endIndex: number }[], index: NameIndex): Mentions {
  const byEntry = new Map<string, EntryMentions>();
  if (!index.byFirst.size) return { byEntry, clashes: index.clashes };
  const colOf = new Int32Array(doc.childCount).fill(-1);
  columns.forEach((c, i) => {
    for (let b = c.index; b < Math.min(c.endIndex, doc.childCount); b += 1) colOf[b] = i;
  });
  const add = (counts: Map<string, number>, col: number) => {
    for (const [entry, n] of counts) {
      let m = byEntry.get(entry);
      if (!m) {
        m = { cols: new Map(), total: 0, first: -1 };
        byEntry.set(entry, m);
      }
      m.total += n;
      if (col >= 0) {
        m.cols.set(col, (m.cols.get(col) ?? 0) + n);
        if (m.first < 0 || col < m.first) m.first = col;
      }
    }
  };
  doc.forEach((block, _offset, b) => {
    const col = colOf[b];
    if (block.isTextblock) add(countBlock(block, index), col);
    else
      block.descendants((node) => {
        if (!node.isTextblock) return true;
        add(countBlock(node, index), col);
        return false;
      });
  });
  return { byEntry, clashes: index.clashes };
}

/** Every place an entry's names appear, in document order. */
export function findMentions(doc: PmNode, index: NameIndex, entry: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const counts = countBlock(node, index);
    if (!counts.has(entry)) return false;
    const read = readBlock(node);
    for (const m of findIn(read, index)) {
      if (m.entry !== entry) continue;
      const at = (t: number) => {
        for (const p of read.pieces) if (t >= p.at && t <= p.at + p.len) return pos + 1 + p.pos + (t - p.at);
        return pos + 1;
      };
      out.push({ from: at(m.from), to: at(m.to) });
    }
    return false;
  });
  return out;
}
