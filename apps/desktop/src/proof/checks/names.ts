import { NAME_HOMOGRAPHS } from "../data/en/names";
import { STOP_WORDS } from "../data/en/stop";
import { F_CAP, F_START, F_UNSURE, F_UPPER, fold, tokenText, WORD } from "../engine/tokens";
import type { BlockFacts } from "../engine/facts";
import type { Form, Place, Scan } from "../types";
import { issue, kept, stampOf, swap, type Check } from "./check";

/** Vowels (and a y that is not first) dropped, doubles made one, ph as f. */
function skeleton(name: string): string {
  let out = "";
  const n = name.replace(/ph/g, "f").replace(/ck/g, "k").replace(/c/g, "k");
  for (let i = 0; i < n.length; i += 1) {
    const ch = n[i];
    if ("aeiou".includes(ch) || (ch === "y" && i > 0)) continue;
    if (out[out.length - 1] !== ch) out += ch;
  }
  return out;
}

/** How many single changes (a letter in, out, changed, or two swapped)
 *  turn one word into another, up to `most`. */
export function distance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      least = Math.min(least, v);
    }
    if (least > most) return most + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Whether two names are near enough to be one name spelled two ways. */
export function alike(a: string, b: string): boolean {
  if (a === b) return false;
  const first = (w: string) => (w[0] === "c" ? "k" : w[0]);
  if (first(a) !== first(b)) return false;
  const short = Math.min(a.length, b.length);
  const d = distance(a, b, 3);
  if (d === 1 && short >= 5) return true;
  // Jon and John, Ann and Anne: one letter put in.
  if (d === 1 && short >= 3 && a.length !== b.length) return true;
  return d <= 3 && short >= 6 && skeleton(a) === skeleton(b);
}

/** The names in a text and how often each is used (a word with a capital
 *  in mid-sentence nearly every time), the commonest first. */
export function namesOf(scan: Scan, facts: BlockFacts[]): [string, number][] {
  const cap = new Map<string, number>();
  const low = new Map<string, number>();
  scan.blocks.forEach((b, block) => {
    if (b.role === "caps" || b.role === "heading") return;
    const tk = facts[block].tokens;
    for (let i = 0; i < tk.n; i += 1) {
      if (tk.kind[i] !== WORD || tk.flag[i] & (F_START | F_UNSURE | F_UPPER)) continue;
      let word = fold(tokenText(b.text, tk, i));
      if (word.endsWith("'s")) word = word.slice(0, -2);
      if (word.length < 3) continue;
      const map = tk.flag[i] & F_CAP ? cap : low;
      map.set(word, (map.get(word) ?? 0) + 1);
    }
  });
  const out: [string, number][] = [];
  for (const [word, n] of cap) {
    if (n * 10 >= (n + (low.get(word) ?? 0)) * 9 && !STOP_WORDS.has(word) && /^[a-z]+$/.test(word)) out.push([word.charAt(0).toUpperCase() + word.slice(1), n]);
  }
  return out.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/**
 * Two names so alike that one may be the other misspelled: Katherine and
 * Kathryn, Jon and John. A name is a word with a capital in mid-sentence
 * nearly every time it is used. Two names that turn up together in the
 * same paragraph more than once are two people, and are left alone.
 */
export const names: Check<never> = {
  id: "names",
  label: "Names that are nearly the same",
  group: "names",
  reduce({ scan, facts, env }) {
    if (env.base === "de") return [];
    // ---- which words are names: those with a capital in mid-sentence
    // (noted once for each block), then how often the same words stand
    // there without one (looked for again only when the words change).
    const bare = (word: string): string => (word.endsWith("'s") ? word.slice(0, -2) : word);
    const capMid = new Map<string, number>();
    const lowMid = new Map<string, number>();
    const read = (b: (typeof scan.blocks)[number]) => b.role !== "caps" && b.role !== "heading";
    scan.blocks.forEach((b, block) => {
      if (!read(b)) return;
      const capped = kept(facts[block], "names:cap", "", () => {
        const tk = facts[block].tokens;
        const out: string[] = [];
        for (let i = 0; i < tk.n; i += 1) {
          if (tk.kind[i] !== WORD || !(tk.flag[i] & F_CAP) || tk.flag[i] & (F_START | F_UNSURE | F_UPPER)) continue;
          const word = bare(fold(tokenText(b.text, tk, i)));
          if (word.length >= 3) out.push(word);
        }
        return out;
      });
      for (const word of capped) capMid.set(word, (capMid.get(word) ?? 0) + 1);
    });
    const asked = stampOf(capMid.keys());
    scan.blocks.forEach((b, block) => {
      if (!read(b) || !capMid.size) return;
      const lowered = kept(facts[block], "names:low", asked, () => {
        const tk = facts[block].tokens;
        const out: string[] = [];
        for (let i = 0; i < tk.n; i += 1) {
          if (tk.kind[i] !== WORD || tk.flag[i] & (F_CAP | F_START | F_UNSURE)) continue;
          const word = bare(fold(tokenText(b.text, tk, i)));
          if (capMid.has(word)) out.push(word);
        }
        return out;
      });
      for (const word of lowered) lowMid.set(word, (lowMid.get(word) ?? 0) + 1);
    });
    const people: string[] = [];
    for (const [word, n] of capMid) {
      const low = lowMid.get(word) ?? 0;
      if (n * 10 >= (n + low) * 9 && !STOP_WORDS.has(word) && !NAME_HOMOGRAPHS.has(word) && /^[a-z]+$/.test(word)) people.push(word);
    }
    if (people.length < 2) return [];
    // ---- which pairs are alike
    const byFirst = new Map<string, string[]>();
    for (const name of people) {
      const key = name[0] === "c" ? "k" : name[0];
      byFirst.set(key, [...(byFirst.get(key) ?? []), name]);
    }
    const pairs: [string, string][] = [];
    for (const group of byFirst.values()) {
      if (group.length > 400) continue;
      for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) if (alike(group[i], group[j])) pairs.push(group[i] < group[j] ? [group[i], group[j]] : [group[j], group[i]]);
    }
    if (!pairs.length) return [];
    // ---- every use of those names (at the head of a sentence too)
    const wanted = new Set(pairs.flat());
    const pairStamp = stampOf(wanted);
    const uses = new Map<string, [number, number, number][]>();
    const blocksOf = new Map<string, Set<number>>();
    scan.blocks.forEach((b, block) => {
      if (b.role === "caps") return;
      const found = kept(facts[block], "names:uses", pairStamp, () => {
        const tk = facts[block].tokens;
        const out: [string, number, number][] = [];
        for (let i = 0; i < tk.n; i += 1) {
          if (tk.kind[i] !== WORD || !(tk.flag[i] & F_CAP)) continue;
          let word = fold(tokenText(b.text, tk, i));
          let end = tk.end[i];
          if (word.endsWith("'s")) {
            word = word.slice(0, -2);
            end -= 2;
          }
          if (wanted.has(word)) out.push([word, tk.start[i], end]);
        }
        return out;
      });
      for (const [word, start, end] of found) {
        const list = uses.get(word);
        if (list) list.push([block, start, end]);
        else uses.set(word, [[block, start, end]]);
        if (!blocksOf.has(word)) blocksOf.set(word, new Set());
        (blocksOf.get(word) as Set<number>).add(block);
      }
    });
    const out = [];
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    for (const [a, b] of pairs) {
      const ua = uses.get(a) ?? [];
      const ub = uses.get(b) ?? [];
      if (!ua.length || !ub.length) continue;
      // Together in two paragraphs or more: two people.
      let together = 0;
      for (const block of blocksOf.get(a) ?? []) if (blocksOf.get(b)?.has(block)) together += 1;
      if (together >= 2) continue;
      const place = (form: string, other: string) => ([block, start, end]: [number, number, number]): Place => ({ block, start, end, form, fixes: { [other]: swap(start, end, cap(other)) } });
      const forms: Form[] = [
        { id: a, label: cap(a), count: ua.length },
        { id: b, label: cap(b), count: ub.length },
      ];
      const said = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n.toLocaleString("en-US")} times`);
      out.push({
        ...issue(names, `${a}|${b}`, "consistency", `${cap(a)} and ${cap(b)}`, `${cap(a)} ${said(ua.length)}, ${cap(b)} ${said(ub.length)}. If these are two people, set this finding aside for the document.`, [...ua.map(place(a, b)), ...ub.map(place(b, a))].sort((x, y) => x.block - y.block || x.start - y.start), forms),
        terms: [a, b],
      });
    }
    return out;
  },
};
