import { ASIDES } from "../data/en/names";
import { BREAK, fold, isWordy, PUNCT, SPACE, tokenText, WORD } from "../engine/tokens";
import type { Form, Place } from "../types";
import { issue, swap, type Check } from "./check";

/** [1 with the comma and 0 without, where the comma is or would go]. */
type Hit = [number, number];

const SUBJECTS = new Set(["i", "he", "she", "it", "they", "we", "you", "then", "there", "this", "that"]);

/**
 * The comma before "and" in a list of three or more: apples, pears, and
 * plums against apples, pears and plums. Only what is plainly a list is
 * weighed. Left alone: a comma beside a quote mark, an aside between
 * commas (however, he said), and "and" that begins a new clause (…, and
 * he left).
 */
export const serialComma: Check<Hit[]> = {
  id: "serialComma",
  label: "The comma before “and” in a list",
  group: "punctuation",
  english: true,
  offIn: ["screenplay", "stageplay", "poetry"],
  local(block, facts) {
    if (block.role !== "body") return null;
    const tk = facts.tokens;
    const text = block.text;
    const hits: Hit[] = [];
    const ch = (i: number): string => (i >= 0 && i < tk.n && tk.kind[i] === PUNCT ? text[tk.start[i]] : "");
    const word = (i: number): string => (i >= 0 && i < tk.n && tk.kind[i] === WORD ? fold(tokenText(text, tk, i)) : "");
    /** Going back from token `i`: an item of one to four words, ended on
     *  the left by a comma. Returns the comma's token, or -1. */
    const itemBefore = (i: number): number => {
      let words = 0;
      let j = i;
      while (j >= 0) {
        if (isWordy(tk.kind[j])) words += 1;
        else if (tk.kind[j] === PUNCT) {
          if (ch(j) === "," && words >= 1 && words <= 4) return j;
          // (A hyphen inside a word is part of the item.)
          if (ch(j) !== "-" && ch(j) !== "’" && ch(j) !== "'") return -1;
        } else if (tk.kind[j] === BREAK) return -1;
        if (words > 4) return -1;
        j -= 1;
      }
      return -1;
    };
    const aside = (from: number, to: number): boolean => {
      for (let i = from; i < to; i += 1) if (tk.kind[i] === WORD && (ASIDES.has(word(i)) || word(i) === "said")) return true;
      return false;
    };
    for (let i = 2; i < tk.n; i += 1) {
      const w = word(i);
      if ((w !== "and" && w !== "or") || tk.kind[i - 1] !== SPACE) continue;
      // What follows must be an item, not a new clause.
      const next = i + 2 < tk.n && tk.kind[i + 1] === SPACE ? word(i + 2) : "";
      if (!next || SUBJECTS.has(next)) continue;
      const comma = ch(i - 2) === ",";
      const last = comma ? i - 3 : i - 2;
      const c1 = itemBefore(last);
      if (c1 < 0) continue;
      // Not beside a quote mark, and not an aside.
      const beside = (j: number) => "\"'“”‘’".includes(text[tk.start[j] - 1] ?? "x") || "\"'“”‘’".includes(text[tk.end[j]] ?? "x");
      if (beside(c1) || (comma && beside(i - 2)) || aside(c1, i)) continue;
      if (comma) {
        hits.push([1, tk.start[i - 2]]);
        continue;
      }
      // Without the comma it is surely a list only with a third item before:
      // "x, a, b and c". Or when three short items end the clause.
      const c0 = itemBefore(c1 - 1);
      let after = i + 2;
      let words = 0;
      while (after < tk.n && words < 3 && (isWordy(tk.kind[after]) || tk.kind[after] === SPACE)) {
        if (isWordy(tk.kind[after])) words += 1;
        after += 1;
      }
      const ends = after >= tk.n || (tk.kind[after] === PUNCT && ".,;:!?".includes(ch(after)));
      const short = words >= 1 && words <= 2 && ends;
      if (c0 >= 0 || short) hits.push([0, tk.end[last]]);
    }
    return hits.length ? hits : null;
  },
  reduce({ local, rules }) {
    const withComma: Place[] = [];
    const without: Place[] = [];
    local.forEach((hits, block) => {
      for (const [has, at] of hits ?? []) {
        // (Each is for a person's eye: Fix all leaves them.)
        if (has) withComma.push({ block, start: at, end: at + 1, form: "with", fixes: { without: swap(at, at + 1, "") }, review: true });
        else without.push({ block, start: at, end: at, form: "without", fixes: { with: swap(at, at, ",") }, review: true });
      }
    });
    const rule = rules.setting("serialComma");
    const forms: Form[] = [
      { id: "with", label: "With it (a, b, and c)", count: withComma.length },
      { id: "without", label: "Without (a, b and c)", count: without.length },
    ];
    const places = [...withComma, ...without].sort((a, b) => a.block - b.block || a.start - b.start);
    if (rule === "always" || rule === "never") {
      const wrong = rule === "always" ? without : withComma;
      if (!wrong.length) return [];
      const made = issue(serialComma, "list", "consistency", "The comma before “and” in a list", rule === "always" ? "The rules ask for the comma." : "The rules ask for no comma.", places, forms);
      return [{ ...made, preferred: rule === "always" ? "with" : "without", preferredFrom: "document" }];
    }
    if (!withComma.length || !without.length) return [];
    return [issue(serialComma, "list", "consistency", "The comma before “and” in a list", "Lists of three or more are written both ways. Each place is for you to look at.", places, forms)];
  },
};
