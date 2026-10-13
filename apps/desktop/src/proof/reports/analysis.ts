/**
 * A document read for its style: every block's words and sentences, then
 * what can only be told from the whole (which words are names, how often
 * each word is used, which words come again too soon) and a tally for
 * each chapter. The reports are views of this.
 */

import type { BlockFacts } from "../engine/facts";
import type { Env, Scan } from "../types";
import { chaptersOf, type Chapter } from "./chapters";
import { styleFacts, W_CAP, W_MID, W_SPEECH, type StyleFacts } from "./facts";
import type { Hit, Scope } from "./types";
import { V_STOP, type Vocab } from "./vocab";

/** A sentence longer than this is a long one. */
export const LONG_SENTENCE = 30;
/** How near the same word must come again to be a close repeat, in words. */
export const REPEAT_WINDOW = 30;
/** …and for a word that is rare in the text, which the ear remembers longer. */
export const RARE_WINDOW = 150;

export interface Roll {
  words: number;
  speech: number;
  syllables: number;
  /** Paragraphs of prose with words in them. */
  paragraphs: number;
  sentences: number;
  sentenceWords: number;
  long: number;
  /** Words that come again too soon (each one after the first). */
  repeats: number;
}

/** The same word, come again within a few lines. */
export interface Cluster {
  /** The word as first written (a vocabulary id). */
  word: number;
  chapter: number;
  hits: Hit[];
  /** How many words lie from its first use to its last. */
  span: number;
}

export interface StyleAnalysis {
  scan: Scan;
  /** Each block's tokens and quote marks (for the reports that read them). */
  facts: BlockFacts[];
  style: StyleFacts[];
  vocab: Vocab;
  chapters: Chapter[];
  rolls: Roll[];
  total: Roll;
  /** By block: its chapter. */
  chapterOf: Int32Array;
  /** By vocabulary id: how often it is used, and whether it is a name. */
  uses: Int32Array;
  name: Uint8Array;
  clusters: Cluster[];
  /** Read as fiction (a manuscript with speech in it). */
  fiction: boolean;
  english: boolean;
}

const STYLE = "$style";
const roll = (): Roll => ({ words: 0, speech: 0, syllables: 0, paragraphs: 0, sentences: 0, sentenceWords: 0, long: 0, repeats: 0 });

/** The style facts of a block, made once for its text. */
export function styleOf(scan: Scan, facts: BlockFacts[], i: number, vocab: Vocab): StyleFacts {
  const had = facts[i].per.get(STYLE);
  if (had) return had.note as StyleFacts;
  const made = styleFacts(scan.blocks[i], facts[i], vocab);
  facts[i].per.set(STYLE, { stamp: "", note: made });
  return made;
}

/** Everything told from the whole, given each block's facts. */
export function analyse(scan: Scan, style: StyleFacts[], vocab: Vocab, env: Env, facts: BlockFacts[] = []): StyleAnalysis {
  const n = scan.blocks.length;
  const english = env.base === "en";

  // ---- chapters, and a tally for each
  const found = chaptersOf(scan, env.format);
  const chapterOf = new Int32Array(n).fill(-1);
  const chapters: Chapter[] = [];
  const rolls: Roll[] = [];
  const total = roll();
  for (const chapter of found) {
    const r = roll();
    for (let b = chapter.first; b < chapter.end; b += 1) {
      const f = style[b];
      if (f.kind === 0) continue;
      r.words += f.n;
      r.speech += f.speech;
      r.syllables += f.syllables;
      if (f.kind === 2 && f.n > 0) r.paragraphs += 1;
      for (let s = 0; s < f.sWords.length; s += 1) {
        r.sentences += 1;
        r.sentenceWords += f.sWords[s];
        if (f.sWords[s] > LONG_SENTENCE) r.long += 1;
      }
    }
    // (A part's heading with its chapters straight after, or nothing
    // before the first chapter: no row.)
    const part = chapter.heading >= 0 && scan.blocks[chapter.heading].heading === "part";
    if (r.words === 0 && (chapter.heading < 0 || part)) continue;
    for (let b = chapter.first; b < chapter.end; b += 1) chapterOf[b] = chapters.length;
    chapters.push(chapter);
    rolls.push(r);
    for (const key of Object.keys(total) as (keyof Roll)[]) total[key] += r[key];
  }

  // ---- words: how often, and which are names
  const size = vocab.size;
  const uses = new Int32Array(size);
  const capMid = new Int32Array(size);
  const lowMid = new Int32Array(size);
  for (const f of style) {
    for (let w = 0; w < f.n; w += 1) {
      const id = f.ids[w];
      if (id < 0) continue;
      uses[id] += 1;
      if (f.flag[w] & W_MID) {
        if (f.flag[w] & W_CAP) capMid[id] += 1;
        else lowMid[id] += 1;
      }
    }
  }
  const name = new Uint8Array(size);
  for (let id = 0; id < size; id += 1) if (capMid[id] >= 2 && lowMid[id] * 5 < capMid[id] + lowMid[id]) name[id] = 1;

  // ---- the same word, come again too soon (within a chapter)
  const clusters: Cluster[] = [];
  const rare = Math.max(2, Math.floor(total.words / 25_000));
  chapters.forEach((chapter, c) => {
    const last = new Map<number, number>();
    const open = new Map<number, Cluster & { from: number; to: number }>();
    const close = (stem: number) => {
      const cluster = open.get(stem);
      if (!cluster) return;
      open.delete(stem);
      clusters.push({ word: cluster.word, chapter: c, hits: cluster.hits, span: cluster.to - cluster.from });
      rolls[c].repeats += cluster.hits.length - 1;
      total.repeats += cluster.hits.length - 1;
    };
    const lastHit = new Map<number, Hit>();
    let g = 0;
    for (let b = chapter.first; b < chapter.end; b += 1) {
      const f = style[b];
      for (let w = 0; w < f.n; w += 1) {
        g += 1;
        const id = f.ids[w];
        if (id < 0 || name[id] || vocab.bits[id] & V_STOP) continue;
        const word = vocab.word[id];
        if (word.length < 4) continue;
        const stem = vocab.stemOf[id];
        const hit: Hit = { block: b, start: f.at[w], end: f.end[w] };
        const was = last.get(stem);
        const reach = word.length >= 6 && uses[id] <= rare ? RARE_WINDOW : REPEAT_WINDOW;
        if (was !== undefined && g - was <= reach) {
          let cluster = open.get(stem);
          if (!cluster) {
            cluster = { word: id, chapter: c, hits: [lastHit.get(stem) as Hit], span: 0, from: was, to: was };
            open.set(stem, cluster);
          }
          cluster.hits.push(hit);
          cluster.to = g;
        } else close(stem);
        last.set(stem, g);
        lastHit.set(stem, hit);
      }
    }
    for (const stem of [...open.keys()]) close(stem);
  });

  const fiction = env.format === "manuscript" && total.words > 0 && total.speech / total.words >= 0.05;
  return { scan, facts, style, vocab, chapters, rolls, total, chapterOf, uses, name, clusters, fiction, english };
}

/** The blocks a scope covers: [from, to). */
export function scopeBlocks(a: StyleAnalysis, scope: Scope): [number, number] {
  if (scope.kind === "chapter") {
    const chapter = a.chapters[scope.index];
    return chapter ? [chapter.first, chapter.end] : [0, 0];
  }
  if (scope.kind === "blocks") return [Math.max(0, scope.from), Math.min(a.scan.blocks.length, scope.to)];
  return [0, a.scan.blocks.length];
}

/** The tally for a scope. */
export function scopeRoll(a: StyleAnalysis, scope: Scope): Roll {
  if (scope.kind === "all") return a.total;
  if (scope.kind === "chapter") return a.rolls[scope.index] ?? roll();
  const [from, to] = scopeBlocks(a, scope);
  const r = roll();
  for (let b = from; b < to; b += 1) {
    const f = a.style[b];
    if (f.kind === 0) continue;
    r.words += f.n;
    r.speech += f.speech;
    r.syllables += f.syllables;
    if (f.kind === 2 && f.n > 0) r.paragraphs += 1;
    for (let s = 0; s < f.sWords.length; s += 1) {
      r.sentences += 1;
      r.sentenceWords += f.sWords[s];
      if (f.sWords[s] > LONG_SENTENCE) r.long += 1;
    }
  }
  for (const cluster of a.clusters) if (cluster.hits[0].block >= from && cluster.hits[0].block < to) r.repeats += cluster.hits.length - 1;
  return r;
}

export { W_SPEECH };
