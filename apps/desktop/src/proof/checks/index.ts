/**
 * The checks, in the order their findings are listed.
 */

import type { Env, GroupId, Rules } from "../types";
import type { Check } from "./check";
import { abbreviations, abbrForms } from "./abbreviations";
import { accents } from "./accents";
import { caps } from "./caps";
import { dashes } from "./dashes";
import { doubled } from "./doubled";
import { headings } from "./headings";
import { hyphens } from "./hyphens";
import { italics } from "./italics";
import { leftovers } from "./leftovers";
import { lists } from "./lists";
import { names } from "./names";
import { numbers } from "./numbers";
import { openPairs } from "./openPairs";
import { quoteShape } from "./quoteShape";
import { serialComma } from "./serialComma";
import { slips } from "./slips";
import { spaces } from "./spaces";
import { speechQuotes } from "./speechQuotes";
import { spelling } from "./spelling";
import { words } from "./words";

export const CHECKS: Check<never>[] = [spelling, words, accents, slips, hyphens, dashes, caps, headings, names, numbers, serialComma, openPairs, quoteShape, speechQuotes, doubled, lists, italics, abbrForms, abbreviations, leftovers, spaces] as unknown as Check<never>[];

/** The groups findings are listed under, in order, and their names. */
export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "spelling", label: "Spelling" },
  { id: "hyphens", label: "Hyphens and dashes" },
  { id: "capitals", label: "Capitals" },
  { id: "names", label: "Names" },
  { id: "numbers", label: "Numbers" },
  { id: "punctuation", label: "Punctuation" },
  { id: "lists", label: "Lists" },
  { id: "italics", label: "Italics" },
  { id: "abbreviations", label: "Abbreviations" },
  { id: "leftovers", label: "Left in the text" },
  { id: "tidy", label: "Tidy up" },
];

/** Whether a check runs when nothing has been said about it. */
export const onByDefault = (check: Check<never>, env: Env): boolean => !check.offIn?.includes(env.format);

/** Every check at its default for this kind of document, and no words. */
export const defaultRules = (env: Env): Rules => {
  const off = new Set(CHECKS.filter((c) => !onByDefault(c, env)).map((c) => c.id));
  return { on: (id) => !off.has(id), setting: () => undefined, words: [], wordsStamp: "" };
};
