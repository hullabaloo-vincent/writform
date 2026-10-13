import { LEGIT_DOUBLES, SMALL_WORDS } from "../data/en/doubles";
import { F_CAP, F_SPEECH, fold, SPACE, tokenText, WORD } from "../engine/tokens";
import type { Place } from "../types";
import { issue, swap, type Check } from "./check";

/** [start of the first word, its end, the end of the second], and the word. */
type Hit = [number, number, number, string];

/**
 * The same word twice in a row ("the the"). Left alone: a pair that is
 * right as it stands (had had), a name (Duran Duran), and inside speech
 * anything but the small words nobody doubles on purpose.
 */
export const doubled: Check<Hit[]> = {
  id: "doubled",
  label: "Doubled words",
  group: "punctuation",
  local(block, facts, env) {
    if (block.role === "caps") return null;
    const tk = facts.tokens;
    const english = env.base === "en";
    const hits: Hit[] = [];
    for (let i = 0; i + 2 < tk.n; i += 1) {
      if (tk.kind[i] !== WORD || tk.kind[i + 1] !== SPACE || tk.kind[i + 2] !== WORD) continue;
      if (tk.flag[i + 2] & F_CAP) continue;
      const word = fold(tokenText(block.text, tk, i));
      if (word !== fold(tokenText(block.text, tk, i + 2))) continue;
      const spoken = block.role === "speech" || (tk.flag[i] & F_SPEECH) !== 0;
      if (english ? LEGIT_DOUBLES.has(word) || (spoken && !SMALL_WORDS.has(word)) : spoken) continue;
      hits.push([tk.start[i], tk.end[i], tk.end[i + 2], word]);
      i += 1;
    }
    return hits.length ? hits : null;
  },
  reduce({ local }) {
    const by = new Map<string, Place[]>();
    local.forEach((hits, block) => {
      for (const [start, cut, end, word] of hits ?? []) {
        let places = by.get(word);
        if (!places) by.set(word, (places = []));
        places.push({ block, start, end, form: null, fixes: { "": swap(cut, end, "") } });
      }
    });
    return [...by].map(([word, places]) => ({ ...issue(doubled, word, "rule", `“${word} ${word}”`, "The same word twice in a row.", places), terms: [`${word} ${word}`] }));
  },
};
