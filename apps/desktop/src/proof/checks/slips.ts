import { SLIPS } from "../data/en/slips";
import { hasCapital, matchCase } from "../engine/casing";
import { F_SPEECH } from "../engine/tokens";
import type { Place } from "../types";
import { issue, swap, type Check } from "./check";
import { findPhrases, indexPhrases } from "./phraseMatch";

/** [which slip, start, end]. */
type Hit = [number, number, number];

const index = indexPhrases(SLIPS.map(([find], i) => ({ find, exact: false, what: i })));

/**
 * Slips a spelling checker passes because each word in them is a word:
 * "could of", "sneak peak", "its a". A short list, each with what was
 * meant. "Could of" and its like are how some people talk, and are left
 * alone inside quote marks.
 */
export const slips: Check<Hit[]> = {
  id: "slips",
  label: "Slips a spelling checker misses",
  group: "spelling",
  english: true,
  local(block, facts) {
    if (block.role === "extract") return null;
    const tk = facts.tokens;
    const hits: Hit[] = [];
    findPhrases(block.text, tk, index, (first, last, i) => {
      if (SLIPS[i][2] && (block.role === "speech" || tk.flag[first] & F_SPEECH)) return false;
      hits.push([i, tk.start[first], tk.end[last]]);
    });
    return hits.length ? hits : null;
  },
  reduce({ scan, local }) {
    const by = new Map<number, Place[]>();
    local.forEach((hits, block) => {
      for (const [i, start, end] of hits ?? []) {
        const to = SLIPS[i][1];
        const made = hasCapital(to) ? { text: to, sure: true } : matchCase(scan.blocks[block].text.slice(start, end), to);
        const list = by.get(i) ?? [];
        list.push({ block, start, end, form: null, fixes: { "": swap(start, end, made.text) }, ...(made.sure ? {} : { review: true }) });
        by.set(i, list);
      }
    });
    return [...by].map(([i, places]) => ({ ...issue(slips, SLIPS[i][0], "rule", `“${SLIPS[i][0]}” for “${SLIPS[i][1]}”`, "Each word is a word, so a spelling checker lets it by.", places), terms: [SLIPS[i][0]] }));
  },
};
