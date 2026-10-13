/**
 * Every distinct word met while a document is open, given a number. What
 * is known about a word (its stem, its syllables, whether it is one of
 * the small words) is worked out once, the first time it is seen. After
 * that each word in the text is a number, and counting them is cheap.
 */

import { STOP_WORDS } from "../data/en/stop";
import { STOP_BY_LANGUAGE } from "../data/stop";
import { stem } from "./stem";
import { syllables } from "./syllables";

/** One of the small words (the, of, was): never a repeat. */
export const V_STOP = 1;

export class Vocab {
  private ids = new Map<string, number>();
  private stems = new Map<string, number>();
  /** By id: the word in lowercase. */
  readonly word: string[] = [];
  /** By id: the id of its stem (a number of its own, not a word's id). */
  readonly stemOf: number[] = [];
  readonly syllables: number[] = [];
  readonly bits: number[] = [];

  private english: boolean;
  private small: Set<string>;

  /** For English (true), or for another language by its two letters. */
  constructor(language: boolean | string) {
    this.english = language === true || language === "en";
    const other = typeof language === "string" ? STOP_BY_LANGUAGE[language] : undefined;
    this.small = this.english ? STOP_WORDS : new Set(other ? other.split(" ") : []);
  }

  /** The id of a word, given in lowercase with a plain apostrophe. */
  id(lower: string): number {
    let id = this.ids.get(lower);
    if (id !== undefined) return id;
    id = this.word.length;
    this.ids.set(lower, id);
    this.word.push(lower);
    const key = this.english ? stem(lower) : lower;
    let s = this.stems.get(key);
    if (s === undefined) {
      s = this.stems.size;
      this.stems.set(key, s);
    }
    this.stemOf.push(s);
    this.syllables.push(this.english ? syllables(lower) : 0);
    this.bits.push(this.small.has(lower) ? V_STOP : 0);
    return id;
  }

  /** The id a word has, or -1 when it has never been met. */
  has(lower: string): number {
    return this.ids.get(lower) ?? -1;
  }

  get size(): number {
    return this.word.length;
  }
}
