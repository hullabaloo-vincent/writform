import { KNOWN_ABBREVIATIONS } from "../data/en/names";
import type { BlockFacts } from "../engine/facts";
import { F_CAP, F_UPPER, PUNCT, SPACE, tokenText, WORD } from "../engine/tokens";
import type { BlockInput, Form, Issue, Place } from "../types";
import { issue, swap, type Check } from "./check";

/** An abbreviation as it is written in one place: its letters (capitals,
 *  no dots), how it is written, and where. `long` is the name it is given
 *  there ("Light Detection and Ranging (LIDAR)"), if it is given one. */
interface Use {
  key: string;
  shape: string;
  start: number;
  end: number;
  long?: string;
}

const ROMAN = /^(?=[IVXLCDM]+$)M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

function usesIn(block: BlockInput, facts: BlockFacts): Use[] {
  const tk = facts.tokens;
  const text = block.text;
  const out: Use[] = [];
  const upper = (i: number): boolean => i >= 0 && i < tk.n && tk.kind[i] === WORD && (tk.flag[i] & F_UPPER) !== 0;
  const single = (i: number): boolean => i >= 0 && i < tk.n && tk.kind[i] === WORD && tk.end[i] - tk.start[i] === 1 && (tk.flag[i] & F_CAP) !== 0;
  const dot = (i: number): boolean => i >= 0 && i < tk.n && tk.kind[i] === PUNCT && text[tk.start[i]] === ".";
  for (let i = 0; i < tk.n; i += 1) {
    if (tk.kind[i] !== WORD) continue;
    // U.S.A. : single capitals with full stops between.
    if (single(i) && dot(i + 1) && single(i + 2)) {
      let last = i;
      let letters = text[tk.start[i]];
      while (dot(last + 1) && single(last + 2)) {
        last += 2;
        letters += text[tk.start[last]];
      }
      const end = dot(last + 1) ? tk.end[last + 1] : tk.end[last];
      if (letters.length >= 2 && letters.length <= 6) out.push({ key: letters, shape: "dotted", start: tk.start[i], end });
      i = last + 1;
      continue;
    }
    const word = tokenText(text, tk, i);
    const plain = word.replace(/s$/, "");
    if (plain.length < 2 || plain.length > 6) continue;
    if (upper(i) || (plain === plain.toUpperCase() && plain !== plain.toLowerCase())) {
      // Not SHOUTING (a run of capitals) and not a number in Roman figures.
      const beside = (j: number) => j >= 0 && j < tk.n && upper(j);
      const prev = i >= 2 && tk.kind[i - 1] === SPACE ? i - 2 : -1;
      const next = i + 2 < tk.n && tk.kind[i + 1] === SPACE ? i + 2 : -1;
      if (beside(prev) || beside(next) || ROMAN.test(plain)) continue;
      const use: Use = { key: plain, shape: "capitals", start: tk.start[i], end: tk.start[i] + plain.length };
      // Light Detection and Ranging (LIDAR): the words before, by their initials.
      const opened = i >= 1 && tk.kind[i - 1] === PUNCT && text[tk.start[i - 1]] === "(";
      const closed = i + 1 < tk.n && tk.kind[i + 1] === PUNCT && text[tk.start[i + 1]] === ")";
      if (opened && closed) {
        const words: number[] = [];
        for (let j = i - 2; j >= 0 && words.length < plain.length * 2; j -= 1) {
          if (tk.kind[j] === WORD) words.unshift(j);
          else if (tk.kind[j] !== SPACE && !(tk.kind[j] === PUNCT && text[tk.start[j]] === "-")) break;
        }
        // The fewest trailing words whose initials spell it, small words let by.
        for (let from = words.length - 1; from >= 0; from -= 1) {
          const initials = words
            .slice(from)
            .filter((w) => tk.flag[w] & F_CAP || tk.end[w] - tk.start[w] > 3)
            .map((w) => text[tk.start[w]].toUpperCase())
            .join("");
          if (initials === plain) {
            use.long = text.slice(tk.start[words[from]], tk.end[words[words.length - 1]]);
            break;
          }
        }
        // Not every abbreviation is its initials (LIDAR). A run of
        // capitalised words that begins with its first letter will do.
        if (!use.long) {
          let from = words.length;
          while (from > 0 && (tk.flag[words[from - 1]] & F_CAP || tk.end[words[from - 1]] - tk.start[words[from - 1]] <= 3)) from -= 1;
          const run = words.slice(from).filter((w) => tk.flag[w] & F_CAP);
          const first = run.find((w) => text[tk.start[w]].toUpperCase() === plain[0]);
          if (run.length >= 2 && first !== undefined && first !== words[words.length - 1]) use.long = text.slice(tk.start[first], tk.end[words[words.length - 1]]);
        }
      }
      out.push(use);
    }
  }
  return out;
}

/**
 * An abbreviation written two ways: NASA and Nasa, US and U.S. Not
 * weighed: Roman numbers, and words in a run of capitals.
 */
export const abbrForms: Check<Use[]> = {
  id: "abbrForms",
  label: "An abbreviation written two ways",
  group: "abbreviations",
  local(block, facts) {
    if (block.role === "caps" || block.role === "heading" || block.role === "extract") return null;
    const found = usesIn(block, facts);
    return found.length ? found : null;
  },
  reduce({ scan, facts, local }) {
    const out: Issue[] = [];
    const by = new Map<string, Map<string, Place[]>>();
    local.forEach((list, block) => {
      for (const use of list ?? []) {
        let shapes = by.get(use.key);
        if (!shapes) by.set(use.key, (shapes = new Map()));
        const places = shapes.get(use.shape) ?? [];
        places.push({ block, start: use.start, end: use.end, form: use.shape });
        shapes.set(use.shape, places);
      }
    });
    // Nasa beside NASA: the same letters with one capital.
    const wanted = new Map<string, string>();
    for (const key of by.keys()) if (key.length >= 3) wanted.set(key.charAt(0) + key.slice(1).toLowerCase(), key);
    if (wanted.size) {
      scan.blocks.forEach((b, block) => {
        if (b.role === "caps" || b.role === "heading" || b.role === "extract") return;
        const tk = facts[block].tokens;
        for (let i = 0; i < tk.n; i += 1) {
          if (tk.kind[i] !== WORD || !(tk.flag[i] & F_CAP) || tk.flag[i] & F_UPPER) continue;
          const key = wanted.get(tokenText(b.text, tk, i));
          if (!key) continue;
          const shapes = by.get(key) as Map<string, Place[]>;
          const places = shapes.get("word") ?? [];
          places.push({ block, start: tk.start[i], end: tk.end[i], form: "word" });
          shapes.set("word", places);
        }
      });
    }
    const written = (key: string, shape: string): string => (shape === "dotted" ? `${key.split("").join(".")}.` : shape === "word" ? key.charAt(0) + key.slice(1).toLowerCase() : key);
    for (const [key, shapes] of by) {
      if (shapes.size < 2) continue;
      const forms: Form[] = [...shapes].map(([shape, places]) => ({ id: shape, label: written(key, shape), count: places.length }));
      const places = [...shapes].flatMap(([shape, list]) =>
        list.map((place) => {
          const fixes: NonNullable<Place["fixes"]> = {};
          for (const other of shapes.keys()) if (other !== shape) fixes[other] = swap(place.start, place.end, written(key, other));
          return { ...place, fixes };
        }),
      );
      out.push({ ...issue(abbrForms, key, "consistency", forms.map((f) => f.label).join(" and "), "The same abbreviation, written more than one way.", places.sort((a, b) => a.block - b.block || a.start - b.start), forms), terms: [key.toLowerCase()] });
    }
    return out;
  },
};

/**
 * Abbreviations and what they stand for: one given two meanings, one
 * explained twice, one used before it is explained or never explained,
 * and one explained and then not used. For reports and papers. Off in
 * fiction unless switched on.
 */
export const abbreviations: Check<Use[]> = {
  id: "abbreviations",
  label: "Abbreviations and their definitions",
  group: "abbreviations",
  offIn: ["manuscript", "screenplay", "stageplay", "poetry"],
  local(block, facts) {
    if (block.role === "caps" || block.role === "extract") return null;
    const found = usesIn(block, facts).filter((use) => use.shape === "capitals");
    return found.length ? found : null;
  },
  reduce({ local }) {
    const out: Issue[] = [];
    const all = new Map<string, { block: number; use: Use }[]>();
    local.forEach((list, block) => {
      for (const use of list ?? []) all.set(use.key, [...(all.get(use.key) ?? []), { block, use }]);
    });
    const twoWays: Place[] = [];
    const twice: Place[] = [];
    const early: Place[] = [];
    const never: Place[] = [];
    const unused: Place[] = [];
    const at = ({ block, use }: { block: number; use: Use }): Place => ({ block, start: use.start, end: use.end, form: null });
    for (const [key, uses] of all) {
      const defined = uses.filter((u) => u.use.long);
      const meanings = new Set(defined.map((u) => (u.use.long as string).toLowerCase()));
      if (meanings.size > 1) twoWays.push(...defined.map(at));
      else if (defined.length > 1) twice.push(...defined.slice(1).map(at));
      if (defined.length) {
        const first = uses.indexOf(defined[0]);
        if (first > 0) early.push(...uses.slice(0, first).map(at));
        if (uses.length === defined.length) unused.push(at(defined[0]));
      } else if (!KNOWN_ABBREVIATIONS.has(key) && key.length >= 2) never.push(at(uses[0]));
    }
    const add = (key: string, title: string, detail: string, places: Place[]) => {
      if (places.length) out.push(issue(abbreviations, key, "look", title, detail, places.sort((a, b) => a.block - b.block || a.start - b.start)));
    };
    add("twoWays", "An abbreviation given two meanings", "The same letters are explained in two different ways.", twoWays);
    add("twice", "An abbreviation explained more than once", "It is spelled out again after the first time.", twice);
    add("early", "An abbreviation used before it is explained", "These uses come before the place it is spelled out.", early);
    add("never", "Abbreviations that are never explained", "The first use of each is listed. Well-known ones (UK, TV, DNA) are not.", never);
    add("unused", "An abbreviation explained and then not used", "It is spelled out and given its letters, and the letters are never used again.", unused);
    return out;
  },
};
