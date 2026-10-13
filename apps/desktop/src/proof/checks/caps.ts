import { NAME_HOMOGRAPHS } from "../data/en/names";
import type { BlockFacts } from "../engine/facts";
import { F_CAP, F_START, F_UNSURE, F_UPPER, fold, PUNCT, SPACE, tokenText, type Tokens, WORD } from "../engine/tokens";
import type { BlockInput, Form, Place } from "../types";
import { issue, kept, stampOf, swap, type Check } from "./check";

/** [the word in lowercase, its class, start] for each capitalised word in
 *  the middle of a sentence. */
type Hit = [string, string, number];

const DETERMINERS = new Set(["the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our", "their", "no", "some", "any", "each", "every"]);
const wordAt = (text: string, tk: Tokens, i: number): string => (i >= 0 && i < tk.n && tk.kind[i] === WORD ? fold(tokenText(text, tk, i)) : "");
const capAt = (tk: Tokens, i: number): boolean => i >= 0 && i < tk.n && tk.kind[i] === WORD && (tk.flag[i] & F_CAP) !== 0;
const punctAt = (text: string, tk: Tokens, i: number): string => (i >= 0 && i < tk.n && tk.kind[i] === PUNCT ? text[tk.start[i]] : "");

/**
 * How a word stands, which settles whether its capital can be compared:
 * D after "the" or "my" (the President, my mum), V called out between
 * commas (Yes, Mum, I will), B bare. "My mum" and "Mum said" are both
 * right, so only uses of one kind are weighed against each other.
 */
function classOf(text: string, tk: Tokens, i: number): string {
  const prev = i >= 2 && tk.kind[i - 1] === SPACE ? i - 2 : -1;
  if (prev >= 0 && DETERMINERS.has(wordAt(text, tk, prev))) return "D";
  const before = punctAt(text, tk, prev >= 0 ? prev : i - 1) === ",";
  const after = ",.!?".includes(punctAt(text, tk, i + 1) || "x");
  if (before && after) return "V";
  return "B";
}

/** In mid-sentence and standing alone: not beside another capital
 *  (President Lincoln is a name, and no evidence about "president"). */
function alone(tk: Tokens, i: number): boolean {
  const prev = i >= 2 && tk.kind[i - 1] === SPACE ? i - 2 : -1;
  const next = i + 2 < tk.n && tk.kind[i + 1] === SPACE ? i + 2 : -1;
  // (The first word of a sentence has its capital for another reason.)
  const named = (j: number) => capAt(tk, j) && !(tk.flag[j] & F_START);
  return !named(prev) && !named(next);
}

const weighed = (block: BlockInput): boolean => block.role === "body";
const mid = (tk: Tokens, i: number): boolean => !(tk.flag[i] & (F_START | F_UNSURE));

function capitals(block: BlockInput, facts: BlockFacts): Hit[] {
  const tk = facts.tokens;
  const hits: Hit[] = [];
  for (let i = 0; i < tk.n; i += 1) {
    if (tk.kind[i] !== WORD || !(tk.flag[i] & F_CAP) || tk.flag[i] & F_UPPER || !mid(tk, i) || !alone(tk, i)) continue;
    const word = fold(tokenText(block.text, tk, i));
    if (word.length < 3 || NAME_HOMOGRAPHS.has(word) || word.includes("'")) continue;
    hits.push([word, classOf(block.text, tk, i), tk.start[i]]);
  }
  return hits;
}

/**
 * A word with a capital in some places and without in others, in the
 * middle of a sentence: the President and the president. Left alone: the
 * first word of a sentence or of speech, a word beside another capital,
 * headings, and words that are also names (Will, Rose, May).
 */
export const caps: Check<Hit[]> = {
  id: "caps",
  label: "A capital in some places and not in others",
  group: "capitals",
  english: true,
  local(block, facts) {
    if (!weighed(block)) return null;
    const hits = capitals(block, facts);
    return hits.length ? hits : null;
  },
  reduce({ scan, facts, local }) {
    const upper = new Map<string, Place[]>();
    for (let block = 0; block < local.length; block += 1) {
      for (const [word, cls, start] of local[block] ?? []) {
        const key = `${word}:${cls}`;
        const list = upper.get(key) ?? [];
        const text = scan.blocks[block].text;
        list.push({ block, start, end: start + word.length, form: "capital", fixes: { lower: swap(start, start + 1, text[start].toLowerCase()) } });
        upper.set(key, list);
      }
    }
    if (!upper.size) return [];
    const wanted = new Set([...upper.keys()].map((key) => key.slice(0, key.lastIndexOf(":"))));
    const lower = new Map<string, Place[]>();
    const stamp = stampOf(wanted);
    scan.blocks.forEach((b, block) => {
      if (!weighed(b)) return;
      // Where those words stand without their capital (kept with the
      // block for as long as the words asked about are the same).
      const found = kept(facts[block], "caps:lower", stamp, () => {
        const tk = facts[block].tokens;
        const out: [string, number, number][] = [];
        for (let i = 0; i < tk.n; i += 1) {
          if (tk.kind[i] !== WORD || tk.flag[i] & F_CAP || !mid(tk, i)) continue;
          const word = fold(tokenText(b.text, tk, i));
          if (wanted.has(word) && alone(tk, i)) out.push([`${word}:${classOf(b.text, tk, i)}`, tk.start[i], tk.end[i]]);
        }
        return out;
      });
      for (const [key, start, end] of found) {
        if (!upper.has(key)) continue;
        const list = lower.get(key) ?? [];
        list.push({ block, start, end, form: "lower", fixes: { capital: swap(start, start + 1, b.text[start].toUpperCase()) } });
        lower.set(key, list);
      }
    });
    const out = [];
    for (const [key, withCap] of upper) {
      const without = lower.get(key);
      if (!without) continue;
      const word = key.slice(0, key.lastIndexOf(":"));
      const capital = word.charAt(0).toUpperCase() + word.slice(1);
      const forms: Form[] = [
        { id: "capital", label: capital, count: withCap.length },
        { id: "lower", label: word, count: without.length },
      ];
      const how = key.endsWith(":D") ? "After “the” or “my”" : key.endsWith(":V") ? "Called out between commas" : "In the middle of a sentence";
      out.push({ ...issue(caps, key, "consistency", `${capital} and ${word}`, `${how}, with a capital in some places and without in others.`, [...withCap, ...without].sort((a, b) => a.block - b.block || a.start - b.start), forms), terms: [word] });
    }
    return out;
  },
};
