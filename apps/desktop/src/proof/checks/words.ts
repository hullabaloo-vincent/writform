import { hasCapital, matchCase } from "../engine/casing";
import type { Place, Rules, WordRule } from "../types";
import { issue, swap, type Check } from "./check";
import { findPhrases, indexPhrases, type PhraseIndex } from "./phraseMatch";

/** [the rule's id, start, end] for each place a rule's words are found. */
type Hit = [string, number, number];

/** The rules as they are matched, for the rules now in force. */
let compiled: { stamp: string; index: PhraseIndex<WordRule> } | null = null;

function compile(rules: Rules): PhraseIndex<WordRule> {
  if (compiled?.stamp === rules.wordsStamp) return compiled.index;
  const index = indexPhrases(rules.words.filter((rule) => rule.kind !== "allow").map((rule) => ({ find: rule.find, exact: rule.cs, what: rule })));
  compiled = { stamp: rules.wordsStamp, index };
  return index;
}

/**
 * The writer's own words: a word or phrase to be written another way
 * ("per cent" as "percent"), and words to be pointed out. Whole words
 * only, in any capitals unless the rule says they matter. Not looked for
 * in someone else's words (an epigraph, a block quote).
 */
export const words: Check<Hit[]> = {
  id: "words",
  label: "Your preferred words and words to look at",
  group: "spelling",
  stamp: (rules) => rules.wordsStamp,
  local(block, facts, _env, rules) {
    if (block.role === "extract" || !rules.words.length) return null;
    const index = compile(rules);
    const tk = facts.tokens;
    const text = block.text;
    const hits: Hit[] = [];
    findPhrases(text, tk, index, (first, last, rule) => {
      const start = tk.start[first];
      const end = tk.end[last];
      // Already as preferred ("Internet" under a rule that asks for it).
      if (rule.kind === "prefer" && text.slice(start, end) === rule.use) return false;
      hits.push([rule.id, start, end]);
    });
    return hits.length ? hits : null;
  },
  reduce({ scan, local, rules }) {
    const by = new Map<string, Place[]>();
    const rule = new Map(rules.words.map((w) => [w.id, w]));
    local.forEach((hits, block) => {
      for (const [id, start, end] of hits ?? []) {
        const r = rule.get(id);
        if (!r) continue;
        let places = by.get(id);
        if (!places) by.set(id, (places = []));
        const place: Place = { block, start, end, form: null };
        if (r.kind === "prefer") {
          const exact = r.cs || hasCapital(r.use);
          const made = exact ? { text: r.use, sure: true } : matchCase(scan.blocks[block].text.slice(start, end), r.use);
          place.fixes = { "": swap(start, end, made.text) };
          if (!made.sure) place.review = true;
        }
        places.push(place);
      }
    });
    return [...by].map(([id, places]) => {
      const r = rule.get(id) as WordRule;
      const whose = r.from === "yours" ? "From your rules." : "From this document’s rules.";
      const note = r.note ? `${r.note} ${whose}` : whose;
      return r.kind === "prefer" ? issue(words, `p.${id}`, "rule", `“${r.find}” where you write “${r.use}”`, note, places) : issue(words, `l.${id}`, "look", `“${r.find}”`, r.note ? note : `A word you asked to look at. ${whose}`, places);
    });
  },
};
