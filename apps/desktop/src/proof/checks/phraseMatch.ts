/**
 * Finding given phrases in a block's tokens: whole words, in order, with
 * a space (or nothing) between. Shared by the writer's own word rules and
 * the list of slips.
 */

import { BREAK, fold, OBJECT, SPACE, tokenize, tokenText, type Tokens } from "../engine/tokens";

export interface Phrase<T> {
  /** Its words and marks, without the spaces between. */
  parts: string[];
  /** Capitals must match. */
  exact: boolean;
  what: T;
}

export type PhraseIndex<T> = Map<string, Phrase<T>[]>;

/** The phrases, by the first of each one's parts. The longer is tried
 *  first ("in order to" before "in order"). */
export function indexPhrases<T>(list: { find: string; exact: boolean; what: T }[]): PhraseIndex<T> {
  const first: PhraseIndex<T> = new Map();
  for (const { find, exact, what } of list) {
    const tk = tokenize(find);
    const parts: string[] = [];
    for (let i = 0; i < tk.n; i += 1) if (tk.kind[i] !== SPACE) parts.push(exact ? tokenText(find, tk, i) : fold(tokenText(find, tk, i)));
    if (!parts.length) continue;
    const key = fold(parts[0]);
    const had = first.get(key);
    if (had) had.push({ parts, exact, what });
    else first.set(key, [{ parts, exact, what }]);
  }
  for (const group of first.values()) group.sort((a, b) => b.parts.length - a.parts.length);
  return first;
}

/** Where a phrase matches from token `i`: the token it ends on, or -1. */
function matchAt<T>(text: string, tk: Tokens, i: number, phrase: Phrase<T>): number {
  let j = i;
  for (let k = 0; k < phrase.parts.length; k += 1) {
    if (k > 0) {
      j += 1;
      if (j < tk.n && tk.kind[j] === SPACE) j += 1;
    }
    if (j >= tk.n || tk.kind[j] === SPACE || tk.kind[j] === BREAK || tk.kind[j] === OBJECT) return -1;
    const word = tokenText(text, tk, j);
    if ((phrase.exact ? word : fold(word)) !== phrase.parts[k]) return -1;
  }
  return j;
}

/** Every place a phrase is found: the first and last token of each, and
 *  which phrase. No two overlap. */
export function findPhrases<T>(text: string, tk: Tokens, index: PhraseIndex<T>, visit: (first: number, last: number, what: T) => boolean | void): void {
  if (!index.size) return;
  for (let i = 0; i < tk.n; i += 1) {
    if (tk.kind[i] === SPACE || tk.kind[i] === BREAK || tk.kind[i] === OBJECT) continue;
    const group = index.get(fold(tokenText(text, tk, i)));
    if (!group) continue;
    for (const phrase of group) {
      const last = matchAt(text, tk, i, phrase);
      if (last < 0) continue;
      // (False from the visitor: not a match after all, try the next.)
      if (visit(i, last, phrase.what) === false) continue;
      i = last;
      break;
    }
  }
}
