/**
 * The few outside figures a report compares a text with. Each names who
 * says so, and each was read at its source when it was put here. Where
 * there is no such figure (most of fiction) a report says so and compares
 * the book's chapters with each other.
 */

import type { Guide } from "./types";

/** Average sentence length for writing that explains. Read at
 *  plainenglish.co.uk/how-to-write-in-plain-english on 2026-10-13: the
 *  guide gives an average of 15 to 20 words, and says not every sentence
 *  should be that long. */
const SENTENCE = { lo: 15, hi: 20, note: "Clear writing averages 15 to 20 words a sentence. Mix short ones with long.", source: "Plain English Campaign, How to write in plain English" };

export function sentenceGuide(average: number, fiction: boolean): Guide | undefined {
  if (fiction || !average) return undefined;
  return { ...SENTENCE, state: average < SENTENCE.lo ? "below" : average > SENTENCE.hi ? "above" : "in" };
}

export const GUIDE_FOOT = "A guide and not a rule.";
export const NO_GUIDE = "No usual range is given for this. Compare your chapters with each other.";
