/**
 * A block as the reports read it: its words as numbers (see vocab.ts),
 * what is known of each, and its sentences. Made once for a block's text
 * and kept with the block's other facts.
 */

import type { BlockFacts } from "../engine/facts";
import { BREAK, F_CAP, F_JOINED, F_SPEECH, F_START, F_UNSURE, fold, isWordy, NUMBER, OBJECT, PUNCT } from "../engine/tokens";
import type { BlockInput } from "../types";
import { proseKind } from "./roles";
import { sentenceSpans } from "./sentences";
import type { Vocab } from "./vocab";

/** Inside quote marks (or someone else's words). */
export const W_SPEECH = 1;
export const W_CAP = 2;
/** In the middle of a sentence for certain. */
export const W_MID = 4;
/** A mark of punctuation stands between this word and the one before. */
export const W_BREAK = 8;
/** The first word of a sentence. */
export const W_SENT = 16;

export interface StyleFacts {
  kind: 0 | 1 | 2;
  /** Its words (numbers count as words). */
  n: number;
  /** By word: its id in the vocabulary (-1 for a number). */
  ids: Int32Array;
  at: Int32Array;
  end: Int32Array;
  flag: Uint8Array;
  /** Words inside speech. */
  speech: number;
  syllables: number;
  /** By sentence: its first word, how many words, where it runs in the text. */
  sFirst: Int32Array;
  sWords: Int32Array;
  sFrom: Int32Array;
  sTo: Int32Array;
  sSpeech: Uint8Array;
}

const NONE: StyleFacts = { kind: 0, n: 0, ids: new Int32Array(0), at: new Int32Array(0), end: new Int32Array(0), flag: new Uint8Array(0), speech: 0, syllables: 0, sFirst: new Int32Array(0), sWords: new Int32Array(0), sFrom: new Int32Array(0), sTo: new Int32Array(0), sSpeech: new Uint8Array(0) };

export function styleFacts(block: BlockInput, facts: BlockFacts, vocab: Vocab): StyleFacts {
  const kind = proseKind(block);
  if (kind === 0) return NONE;
  const tk = facts.tokens;
  const text = block.text;
  const voice = block.role === "extract";
  const ids: number[] = [];
  const at: number[] = [];
  const end: number[] = [];
  const flag: number[] = [];
  /** By token: the word it is (or -1). */
  const wordOf = new Int32Array(tk.n).fill(-1);
  let speech = 0;
  let syll = 0;
  let broke = true;
  for (let i = 0; i < tk.n; i += 1) {
    const k = tk.kind[i];
    if (!isWordy(k)) {
      if (k === BREAK || k === OBJECT || (k === PUNCT && !(tk.flag[i] & F_JOINED))) broke = true;
      continue;
    }
    const f = tk.flag[i];
    let bits = 0;
    if (voice || f & F_SPEECH) {
      bits |= W_SPEECH;
      speech += 1;
    }
    if (f & F_CAP) bits |= W_CAP;
    if (!(f & (F_START | F_UNSURE))) bits |= W_MID;
    if (broke) bits |= W_BREAK;
    broke = false;
    const id = k === NUMBER ? -1 : vocab.id(fold(text.slice(tk.start[i], tk.end[i])));
    syll += id < 0 ? 1 : vocab.syllables[id] || 1;
    wordOf[i] = ids.length;
    ids.push(id);
    at.push(tk.start[i]);
    end.push(tk.end[i]);
    flag.push(bits);
  }
  const sFirst: number[] = [];
  const sWords: number[] = [];
  const sFrom: number[] = [];
  const sTo: number[] = [];
  const sSpeech: number[] = [];
  if (kind === 2) {
    const spans = sentenceSpans(text, tk, facts.quotes);
    for (let s = 0; s < spans.length; s += 2) {
      let first = -1;
      let last = -1;
      let spoken = 0;
      for (let i = spans[s]; i < spans[s + 1]; i += 1) {
        const w = wordOf[i];
        if (w < 0) continue;
        if (first < 0) first = w;
        last = w;
        if (flag[w] & W_SPEECH) spoken += 1;
      }
      if (first < 0) continue;
      const count = last - first + 1;
      flag[first] |= W_SENT | W_BREAK;
      sFirst.push(first);
      sWords.push(count);
      sFrom.push(at[first]);
      sTo.push(end[last]);
      sSpeech.push(spoken * 2 >= count ? 1 : 0);
    }
  }
  return {
    kind,
    n: ids.length,
    ids: Int32Array.from(ids),
    at: Int32Array.from(at),
    end: Int32Array.from(end),
    flag: Uint8Array.from(flag),
    speech,
    syllables: syll,
    sFirst: Int32Array.from(sFirst),
    sWords: Int32Array.from(sWords),
    sFrom: Int32Array.from(sFrom),
    sTo: Int32Array.from(sTo),
    sSpeech: Uint8Array.from(sSpeech),
  };
}
