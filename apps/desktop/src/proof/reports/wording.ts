/**
 * What the Word choice report finds in one block: likely passives, -ly
 * adverbs, filter words, told feelings, padding, worn phrases, words that
 * say a thing twice, wordy phrases, and words easily taken for one
 * another. Told from the words alone, by lists and a few rules. There is
 * no grammar here, so each finding is "likely" and for the writer to judge.
 */

import { findPhrases, indexPhrases } from "../checks/phraseMatch";
import { CLICHES, REDUNDANCIES, WORDY } from "../data/en/phrases";
import { BE_FORMS, BETWEEN, ED_NOT_VERBS, IRREGULAR_PARTICIPLES, STATE_WORDS } from "../data/en/verbs";
import { CONFUSED, FEELING_ADJECTIVES, FEELING_NOUNS, FEELING_WAVES, FILTER_ALWAYS, FILTER_CLAUSE, INTENSIFIERS, LINKING, LY_EXCEPTIONS, PADDING, PERSONS, SUBJECT_PRONOUNS } from "../data/en/wording";
import type { BlockFacts } from "../engine/facts";
import { F_CAP, F_SPEECH, F_START, F_UNSURE, fold, SPACE, tokenText, type Tokens, WORD } from "../engine/tokens";
import type { BlockInput } from "../types";

export const WORDING_GROUPS = ["passive", "adverbs", "filter", "feelings", "padding", "cliches", "redundant", "wordy", "confused"] as const;
export type WordingGroup = (typeof WORDING_GROUPS)[number];

export interface WordingHit {
  group: WordingGroup;
  start: number;
  end: number;
  /** What it is grouped under (a word, a phrase). */
  key: string;
  /** Inside quote marks. */
  spoken: boolean;
  /** What a fix would write in its place. */
  to?: string;
  /** A fix that takes it out (and the space after it). */
  cut?: [number, number];
  /** A plainer way, said in words (when it is not a straight swap). */
  advice?: string;
}

const POSS = ["his", "her", "my", "your", "our", "their", "its"];
/** Entries with "{poss}" stand for one each of his, her, my… */
const spread = <T,>(find: string, what: T): { find: string; exact: boolean; what: T }[] => (find.includes("{poss}") ? POSS.map((p) => ({ find: find.split("{poss}").join(p), exact: false, what })) : [{ find, exact: false, what }]);

const cliches = indexPhrases(CLICHES.flatMap((find) => spread(find, find)));
const redundant = indexPhrases(REDUNDANCIES.flatMap(([find, to]) => spread(find, { find, to })));
const wordy = indexPhrases(WORDY.flatMap(([find, to]) => spread(find, { find, to })));
const confused = new Map<string, string>();
for (const set of CONFUSED) for (const word of set) confused.set(word, set.join(" and "));

const DETERMINERS = new Set(["the", "a", "an", "this", "that", "these", "those", "his", "her", "my", "your", "our", "their", "its", "no", "some", "any", "each", "every"]);
const SENSES = new Set(["see", "hear", "feel", "smell", "taste"]);

/** The word tokens of a block, so that "the word before" is one step. */
function wordsOf(tk: Tokens): number[] {
  const out: number[] = [];
  for (let i = 0; i < tk.n; i += 1) if (tk.kind[i] === WORD) out.push(i);
  return out;
}

export function wordingOf(block: BlockInput, facts: BlockFacts): WordingHit[] {
  if (block.role !== "body" || block.note) return [];
  const tk = facts.tokens;
  const text = block.text;
  const hits: WordingHit[] = [];
  const w = wordsOf(tk);
  const word = (k: number): string => (k >= 0 && k < w.length ? fold(tokenText(text, tk, w[k])) : "");
  const spoken = (i: number): boolean => (tk.flag[i] & F_SPEECH) !== 0;
  /** Words k and k+1 are neighbours: one space and nothing else between. */
  const beside = (k: number): boolean => k >= 0 && k + 1 < w.length && w[k + 1] === w[k] + 2 && tk.kind[w[k] + 1] === SPACE;
  const named = (k: number): boolean => k >= 0 && k < w.length && (tk.flag[w[k]] & F_CAP) !== 0 && !DETERMINERS.has(word(k)) && word(k) !== "i";
  const push = (group: WordingGroup, from: number, to: number, key: string, more: Partial<WordingHit> = {}) => hits.push({ group, start: tk.start[from], end: tk.end[to], key, spoken: spoken(from), ...more });

  for (let k = 0; k < w.length; k += 1) {
    const i = w[k];
    const here = word(k);

    // ---- a likely passive: was (quietly) taken
    if (BE_FORMS.has(here)) {
      let j = k + 1;
      let between = 0;
      while (j < w.length && between < 2 && beside(j - 1) && (BETWEEN.has(word(j)) || (word(j).endsWith("ly") && word(j).length > 4))) {
        j += 1;
        between += 1;
      }
      if (j < w.length && beside(j - 1)) {
        const p = word(j);
        const irregular = IRREGULAR_PARTICIPLES.has(p);
        const regular = p.length >= 4 && p.endsWith("ed") && !p.endsWith("eed") && !ED_NOT_VERBS.has(p);
        if (irregular || regular) {
          let by = false;
          for (let m = j + 1; m <= j + 4 && m < w.length; m += 1) if (word(m) === "by") by = true;
          // "was tired" describes. "was tired by the climb" is done to her.
          if (!STATE_WORDS.has(p) || by) push("passive", i, w[j], p, { advice: irregular || by ? undefined : "maybe" });
        }
      }
    }

    // ---- an -ly adverb
    if (here.length >= 5 && here.endsWith("ly") && !LY_EXCEPTIONS.has(here) && !(tk.flag[i] & F_CAP && !(tk.flag[i] & (F_START | F_UNSURE)))) push("adverbs", i, i, here);

    // ---- a filter word: she saw, he could hear, Marianne noticed
    if (!spoken(i)) {
      const subject = (at: number): boolean => PERSONS.has(word(at)) || named(at);
      const person = (beside(k - 1) && subject(k - 1)) || (beside(k - 1) && beside(k - 2) && word(k - 1).endsWith("ly") && subject(k - 2));
      if (person && FILTER_ALWAYS.has(here)) push("filter", i, i, here);
      else if (person && FILTER_CLAUSE.has(here) && beside(k) && (word(k + 1) === "that" || SUBJECT_PRONOUNS.has(word(k + 1)) || word(k + 1) === "the" || named(k + 1))) push("filter", i, i, here);
      else if (person && here === "could" && beside(k) && SENSES.has(word(k + 1))) push("filter", i, w[k + 1], `could ${word(k + 1)}`);
      else if ((here === "seemed" || here === "appeared") && beside(k) && word(k + 1) === "to") push("filter", i, w[k + 1], `${here} to`);
    }

    // ---- a feeling told: felt (very) angry, a wave of relief
    if (LINKING.has(here) && beside(k)) {
      let j = k + 1;
      while (j < w.length && INTENSIFIERS.has(word(j)) && beside(j)) j += 1;
      if (j < w.length && FEELING_ADJECTIVES.has(word(j))) push("feelings", i, w[j], word(j));
    }
    if (FEELING_WAVES.has(here) && beside(k) && word(k + 1) === "of" && beside(k + 1) && FEELING_NOUNS.has(word(k + 2))) push("feelings", i, w[k + 2], word(k + 2));

    // ---- padding: very, really, just
    if (PADDING.has(here)) {
      // It can be lifted out cleanly from between two words (but not "a
      // very odd day", where "a" may then be wrong).
      const clean = k > 0 && beside(k - 1) && beside(k) && !(tk.flag[i] & F_START) && word(k - 1) !== "a" && word(k - 1) !== "an";
      push("padding", i, i, here, clean ? { cut: [tk.start[i], tk.start[w[k + 1]]] } : {});
    }

    // ---- words taken for one another
    const set = confused.get(here);
    if (set) push("confused", i, i, set);
  }

  // ---- phrases
  findPhrases(text, tk, cliches, (first, last, key) => void push("cliches", first, last, key));
  findPhrases(text, tk, redundant, (first, last, entry) => {
    const said = fold(text.slice(tk.start[first], tk.end[last]));
    const poss = POSS.find((p) => said.split(" ").includes(p)) ?? "";
    push("redundant", first, last, entry.find, { to: entry.to.split("{poss}").join(poss) });
  });
  findPhrases(text, tk, wordy, (first, last, entry) => void push("wordy", first, last, entry.find, entry.to.startsWith("(") ? { advice: entry.to.slice(1, -1) } : { to: entry.to }));
  return hits;
}
