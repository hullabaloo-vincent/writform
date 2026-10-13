import { DISTINCT, PARTICLES, PREFIXES, TENS, UNITS } from "../data/en/hyphens";
import { ARTICLES, PREPOSITIONS, STOP_WORDS } from "../data/en/stop";
import { matchCase } from "../engine/casing";
import type { BlockFacts } from "../engine/facts";
import { F_CAP, F_JOINED, F_START, F_UNSURE, fold, PUNCT, SPACE, tokenText, type Tokens, WORD } from "../engine/tokens";
import type { BlockInput, Form, Issue, Place } from "../types";
import { issue, swap, type Check } from "./check";

/** A compound written with hyphens: its words (lowercase, spaced), where
 *  it runs, and the tokens it starts and ends on. */
interface Joined {
  key: string;
  start: number;
  end: number;
  first: number;
  last: number;
}

const DETERMINERS = new Set(["the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our", "their", "no", "some", "any", "each", "every"]);
const wordAt = (text: string, tk: Tokens, i: number): string => (i >= 0 && i < tk.n && tk.kind[i] === WORD ? fold(tokenText(text, tk, i)) : "");
const hyphenAt = (tk: Tokens, i: number): boolean => i >= 0 && i < tk.n && tk.kind[i] === PUNCT && (tk.flag[i] & F_JOINED) !== 0;

/** Whether what stands at a compound describes the word after it ("a
 *  short-term plan") or stands on its own ("in the short term"). The two
 *  are hyphenated by different rules, and only like is weighed with like. */
function before(text: string, tk: Tokens, first: number, last: number): boolean {
  // "in the short term": a noun after a preposition, whatever follows.
  const p1 = wordAt(text, tk, first - 2);
  const p2 = wordAt(text, tk, first - 4);
  if (DETERMINERS.has(p1) && PREPOSITIONS.has(p2)) return false;
  if (last + 2 >= tk.n || tk.kind[last + 1] !== SPACE || tk.kind[last + 2] !== WORD) return false;
  return !STOP_WORDS.has(fold(tokenText(text, tk, last + 2)));
}

function joinedIn(block: BlockInput, facts: BlockFacts): Joined[] {
  const tk = facts.tokens;
  const text = block.text;
  const out: Joined[] = [];
  for (let i = 0; i < tk.n; i += 1) {
    if (tk.kind[i] !== WORD || !hyphenAt(tk, i + 1) || hyphenAt(tk, i - 1)) continue;
    let last = i;
    while (hyphenAt(tk, last + 1) && tk.kind[last + 2] === WORD) last += 2;
    const parts: string[] = [];
    let caps = 0;
    for (let j = i; j <= last; j += 2) {
      parts.push(fold(tokenText(text, tk, j)));
      if (tk.flag[j] & F_CAP && !(tk.flag[j] & (F_START | F_UNSURE))) caps += 1;
    }
    const n = parts.length;
    // Not: b-b-but, Jean-Luc, twenty-one, or a word in pieces (no-one-else-ish runs of five).
    if (n >= 2 && n <= 4 && caps === 0 && !parts.some((part) => part.length < 2) && !(TENS.has(parts[0]) && UNITS.has(parts[1]))) out.push({ key: parts.join(" "), start: tk.start[i], end: tk.end[last], first: i, last });
    i = last;
  }
  return out;
}

/**
 * A phrase hyphenated in some places and open in others (short-term,
 * short term), and a word hyphenated in some places and closed in others
 * (co-operate, cooperate). Left alone: a phrase that describes the next
 * word against the same phrase standing alone, which differ by rule; a
 * verb of two words against the thing named after it (to follow up, the
 * follow-up); names; and pairs that are two different words (re-cover,
 * recover).
 */
export const hyphens: Check<Joined[]> = {
  id: "hyphens",
  label: "With and without a hyphen",
  group: "hyphens",
  english: true,
  local(block, facts) {
    if (block.role === "extract" || block.role === "caps") return null;
    const found = joinedIn(block, facts);
    return found.length ? found : null;
  },
  reduce({ scan, facts, local }) {
    const out: Issue[] = [];
    // ---- what the text hyphenates, somewhere
    const phrases = new Map<string, null>();
    const closed = new Map<string, string>();
    for (const list of local) {
      for (const j of list ?? []) {
        const parts = j.key.split(" ");
        if (PREFIXES.has(parts[0]) || parts.length === 2) {
          const one = parts.join("");
          if (parts.length === 2 && !DISTINCT.has(one)) closed.set(one, j.key);
        }
        if (!PREFIXES.has(parts[0])) phrases.set(j.key, null);
      }
    }
    if (!phrases.size && !closed.size) return out;
    const firsts = new Map<string, string[]>();
    for (const key of phrases.keys()) {
      const first = key.slice(0, key.indexOf(" "));
      firsts.set(first, [...(firsts.get(first) ?? []), key]);
    }

    // ---- the same words written open, and the same word written closed
    type Use = { place: Place; role: "before" | "after" };
    const hyphenated = new Map<string, Use[]>();
    const open = new Map<string, Use[]>();
    const hyphenWord = new Map<string, Place[]>();
    const closedWord = new Map<string, Place[]>();
    const push = <T,>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    scan.blocks.forEach((b, block) => {
      if (b.role === "extract" || b.role === "caps") return;
      const tk = facts[block].tokens;
      const text = b.text;
      for (const j of local[block] ?? []) {
        const parts = j.key.split(" ");
        const one = parts.join("");
        if (parts.length === 2 && closed.get(one) === j.key) push(hyphenWord, one, { block, start: j.start, end: j.end, form: "hyphen", fixes: { closed: swap(tk.end[j.first], tk.start[j.last], "") } });
        if (!phrases.has(j.key)) continue;
        const edits = [];
        for (let t = j.first + 1; t < j.last; t += 2) edits.push({ start: tk.start[t], end: tk.end[t], text: " " });
        push(hyphenated, j.key, { place: { block, start: j.start, end: j.end, form: "hyphen", fixes: { open: { edits } } }, role: before(text, tk, j.first, j.last) ? "before" : "after" });
      }
      for (let i = 0; i < tk.n; i += 1) {
        if (tk.kind[i] !== WORD) continue;
        const word = fold(tokenText(text, tk, i));
        const whole = closed.get(word);
        if (whole && !hyphenAt(tk, i - 1) && !hyphenAt(tk, i + 1)) {
          const made = matchCase(text.slice(tk.start[i], tk.end[i]), whole.replace(" ", "-"));
          push(closedWord, word, { block, start: tk.start[i], end: tk.end[i], form: "closed", fixes: { hyphen: swap(tk.start[i], tk.end[i], made.text) } });
        }
        if (hyphenAt(tk, i - 1)) continue;
        for (const key of firsts.get(word) ?? []) {
          const parts = key.split(" ");
          let last = i;
          let ok = true;
          for (let k = 1; k < parts.length && ok; k += 1) {
            ok = tk.kind[last + 1] === SPACE && tk.end[last + 1] - tk.start[last + 1] === 1 && wordAt(text, tk, last + 2) === parts[k];
            last += 2;
          }
          if (!ok || hyphenAt(tk, last + 1)) continue;
          // "to follow up" is a verb. Only "the follow up" is the thing.
          if (parts.length === 2 && PARTICLES.has(parts[1]) && !DETERMINERS.has(wordAt(text, tk, i - 2))) continue;
          if (parts.length === 2 && ARTICLES.has(parts[0])) continue;
          const edits = [];
          for (let t = i + 1; t < last; t += 2) edits.push({ start: tk.start[t], end: tk.end[t], text: "-" });
          push(open, key, { place: { block, start: tk.start[i], end: tk.end[last], form: "open", fixes: { hyphen: { edits } } }, role: before(text, tk, i, last) ? "before" : "after" });
          i = last;
          break;
        }
      }
    });

    for (const [key, uses] of hyphenated) {
      const others = open.get(key);
      if (!others) continue;
      for (const role of ["before", "after"] as const) {
        const a = uses.filter((u) => u.role === role).map((u) => u.place);
        const b = others.filter((u) => u.role === role).map((u) => u.place);
        if (!a.length || !b.length) continue;
        const forms: Form[] = [
          { id: "hyphen", label: key.replace(/ /g, "-"), count: a.length },
          { id: "open", label: key, count: b.length },
        ];
        const detail = role === "before" ? "Before the word it describes, with a hyphen in some places and without in others." : "Standing on its own, with a hyphen in some places and without in others.";
        out.push({ ...issue(hyphens, `${key}:${role}`, "consistency", `${key.replace(/ /g, "-")} and ${key}`, detail, [...a, ...b].sort((x, y) => x.block - y.block || x.start - y.start), forms), terms: [key, key.replace(/ /g, "-")] });
      }
    }
    for (const [one, a] of hyphenWord) {
      const b = closedWord.get(one);
      if (!b) continue;
      const whole = (closed.get(one) as string).replace(" ", "-");
      const forms: Form[] = [
        { id: "hyphen", label: whole, count: a.length },
        { id: "closed", label: one, count: b.length },
      ];
      out.push({ ...issue(hyphens, `w.${one}`, "consistency", `${whole} and ${one}`, "One word, with a hyphen in some places and without in others.", [...a, ...b].sort((x, y) => x.block - y.block || x.start - y.start), forms), terms: [one, whole] });
    }
    return out;
  },
};
