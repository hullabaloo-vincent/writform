/**
 * How many syllables a word has, near enough to grade a text's reading
 * level. Counts runs of vowels and allows for the silent endings of
 * English. A table holds common words the rule gets wrong.
 */

import { SYLLABLES } from "../data/en/syllables";

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return 1;
  const known = SYLLABLES.get(w);
  if (known) return known;
  let core = w.replace(/'s$|'$/, "").replace(/'/g, "");
  if (core.length <= 3) return 1;
  let n = 0;
  // -ed is silent (walked) but not after t or d (wanted).
  if (/[^aeiouytd]ed$/.test(core)) core = core.slice(0, -2);
  // -es is silent (makes) but not after a hiss (boxes, places, watches).
  else if (/[^aeiousxzcg]es$/.test(core) && !/(?:ch|sh)es$/.test(core)) core = core.slice(0, -2);
  // -le after a consonant is a syllable of its own (table).
  if (/[^aeiouy]le$/.test(core)) n += 1;
  // A final e is silent (make).
  if (core.endsWith("e")) core = core.slice(0, -1);
  const groups = core.match(/[aeiouy]+/g);
  n += groups ? groups.length : 0;
  // Two vowels said apart (media, period, usual, theory, curious).
  if (/[^ct]ia|[^ctx]io(?!n)|[^gq]ua|eo|[^ctx]ious$/.test(core)) n += 1;
  if (core.endsWith("ism")) n += 1;
  return Math.max(1, n);
}
