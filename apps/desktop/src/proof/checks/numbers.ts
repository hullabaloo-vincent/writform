import { LABELS, MEASURES, NUMBER_WORDS, TENS, TENS_FOR, UNITS, WORDS_FOR } from "../data/en/hyphens";
import { matchCase } from "../engine/casing";
import { ALNUM, BREAK, F_CAP, F_JOINED, F_START, F_UNSURE, fold, NUMBER, PUNCT, SPACE, tokenText, type Tokens, WORD } from "../engine/tokens";
import type { Form, Place } from "../types";
import { issue, swap, type Check } from "./check";

interface Found {
  /** twenty-one and twenty one: [0 hyphen, 1 open, the joiner's start, its end]. */
  compounds: [number, number, number][];
  /** A number in a sentence: [its value, 1 when written in figures, start, end]. */
  numbers: [number, number, number, number][];
}

const wordOf = (text: string, tk: Tokens, i: number): string => (i >= 0 && i < tk.n && (tk.kind[i] === WORD || tk.kind[i] === ALNUM) ? fold(tokenText(text, tk, i)) : "");
/** The next token that is not a space, or -1. */
const after = (tk: Tokens, i: number): number => (i + 1 < tk.n && tk.kind[i + 1] === SPACE ? (i + 2 < tk.n ? i + 2 : -1) : i + 1 < tk.n ? i + 1 : -1);
const beforeOf = (tk: Tokens, i: number): number => (i - 1 >= 0 && tk.kind[i - 1] === SPACE ? i - 2 : i - 1);

export function inWords(n: number): string {
  if (n < 20) return WORDS_FOR[n];
  const unit = n % 10;
  return unit ? `${TENS_FOR[Math.floor(n / 10)]}-${WORDS_FOR[unit]}` : TENS_FOR[Math.floor(n / 10)];
}

/**
 * Numbers. A number from twenty-one to ninety-nine written with its
 * hyphen in some places and without in others. And small numbers in a
 * sentence written as words in some places and as figures in others,
 * weighed apart for numbers under ten and for ten to ninety-nine.
 *
 * Not counted as a number in a sentence: the word "one", a figure that
 * is a label (page 3, Room 12), a measure (5 km, 3 pm, 20%), money, a
 * time, a date, a range or a score, a figure beside a capitalised word (an
 * address), a list's number, anything in a heading or a table, and a
 * figure in a sentence that also holds a figure of 100 or more (figures
 * are kept together).
 */
export const numbers: Check<Found> = {
  id: "numbers",
  label: "Numbers as words and as figures",
  group: "numbers",
  english: true,
  local(block, facts) {
    if (block.role === "extract" || block.role === "caps") return null;
    const tk = facts.tokens;
    const text = block.text;
    const found: Found = { compounds: [], numbers: [] };
    const counted = block.role === "body" && !block.cell && !block.note;
    // Sentences that hold a big figure: every figure in them is left alone.
    const big = new Uint8Array(tk.n);
    if (counted) {
      let from = 0;
      let has = false;
      const close = (to: number) => {
        if (has) for (let k = from; k < to; k += 1) big[k] = 1;
        from = to;
        has = false;
      };
      for (let i = 0; i < tk.n; i += 1) {
        if (tk.kind[i] === NUMBER && Number(tokenText(text, tk, i).replace(/,/g, "")) >= 100) has = true;
        if (tk.kind[i] === BREAK || (tk.kind[i] === PUNCT && ".!?".includes(text[tk.start[i]]) && (i + 1 >= tk.n || tk.kind[i + 1] === SPACE))) close(i + 1);
      }
      close(tk.n);
    }
    for (let i = 0; i < tk.n; i += 1) {
      const kind = tk.kind[i];
      if (kind === WORD) {
        const word = fold(tokenText(text, tk, i));
        // ---- twenty-one, twenty one
        if (TENS.has(word)) {
          const joined = i + 2 < tk.n && tk.kind[i + 1] === PUNCT && (tk.flag[i + 1] & F_JOINED) !== 0 && UNITS.has(wordOf(text, tk, i + 2));
          const open = !joined && i + 2 < tk.n && tk.kind[i + 1] === SPACE && tk.end[i + 1] - tk.start[i + 1] === 1 && UNITS.has(wordOf(text, tk, i + 2));
          // "twenty one-dollar bills" is twenty of them.
          const runsOn = i + 3 < tk.n && tk.kind[i + 3] === PUNCT && (tk.flag[i + 3] & F_JOINED) !== 0;
          if ((joined || open) && !runsOn) {
            found.compounds.push([joined ? 0 : 1, tk.start[i + 1], tk.end[i + 1]]);
            if (counted) found.numbers.push([NUMBER_WORDS[word] + WORDS_FOR.indexOf(wordOf(text, tk, i + 2)), 0, tk.start[i], tk.end[i + 2]]);
            i += 2;
            continue;
          }
        }
        if (counted && word in NUMBER_WORDS && !(tk.flag[i] & F_CAP && !(tk.flag[i] & (F_START | F_UNSURE)))) {
          // "one in ten", "nine to five": still numbers. But not part of a bigger one ("two hundred").
          const next = wordOf(text, tk, after(tk, i));
          if (next === "hundred" || next === "thousand" || next === "million" || next === "billion") continue;
          found.numbers.push([NUMBER_WORDS[word], 0, tk.start[i], tk.end[i]]);
        }
        continue;
      }
      if (kind !== NUMBER || !counted || big[i]) continue;
      const figure = tokenText(text, tk, i);
      if (!/^\d{1,2}$/.test(figure)) continue;
      const value = Number(figure);
      const p = beforeOf(tk, i);
      const n = after(tk, i);
      const touchL = i > 0 && tk.kind[i - 1] === PUNCT ? text[tk.start[i - 1]] : "";
      const touchR = i + 1 < tk.n && tk.kind[i + 1] === PUNCT ? text[tk.start[i + 1]] : "";
      // 3:30, 3/4, 3-4, $5, #7, 5%, 2.
      if ((touchL && ":/-–$£€#.,".includes(touchL)) || (touchR && ":/-–%°".includes(touchR))) continue;
      // A list's number: "1." or "2)" at the start.
      if ((i === 0 || tk.kind[i - 1] === BREAK) && (touchR === "." || touchR === ")")) continue;
      const prev = wordOf(text, tk, p);
      const next = wordOf(text, tk, n);
      if (LABELS.has(prev) || MEASURES.has(next)) continue;
      // Beside a capitalised word: Apollo 11, 12 Main Street.
      const capped = (j: number) => j >= 0 && j < tk.n && tk.kind[j] === WORD && (tk.flag[j] & F_CAP) !== 0 && !(tk.flag[j] & F_START);
      if (capped(p) || capped(n)) continue;
      found.numbers.push([value, 1, tk.start[i], tk.end[i]]);
    }
    return found.compounds.length || found.numbers.length ? found : null;
  },
  reduce({ scan, local }) {
    const out = [];
    // ---- twenty-one and twenty one
    const joined: Place[] = [];
    const open: Place[] = [];
    local.forEach((found, block) => {
      for (const [kind, start, end] of found?.compounds ?? []) {
        if (kind === 0) joined.push({ block, start, end, form: "hyphen", fixes: { open: swap(start, end, " ") } });
        else open.push({ block, start, end, form: "open", fixes: { hyphen: swap(start, end, "-") } });
      }
    });
    if (joined.length && open.length) {
      const forms: Form[] = [
        { id: "hyphen", label: "With a hyphen (twenty-one)", count: joined.length },
        { id: "open", label: "Without (twenty one)", count: open.length },
      ];
      out.push(issue(numbers, "compound", "consistency", "Numbers like twenty-one, with and without a hyphen", "Numbers from twenty-one to ninety-nine are hyphenated in some places and not in others.", [...joined, ...open].sort((a, b) => a.block - b.block || a.start - b.start), forms));
    }
    // ---- words and figures
    for (const bucket of ["small", "tens"] as const) {
      const asWords: Place[] = [];
      const asFigures: Place[] = [];
      local.forEach((found, block) => {
        for (const [value, figure, start, end] of found?.numbers ?? []) {
          if ((bucket === "small") !== value < 10) continue;
          if (figure) asFigures.push({ block, start, end, form: "figures", fixes: { words: swap(start, end, inWords(value)) } });
          else asWords.push({ block, start, end, form: "words", fixes: { figures: swap(start, end, String(value)) } });
        }
      });
      if (!asWords.length || !asFigures.length) continue;
      // (A figure made a word at the head of a sentence takes its capital.)
      for (const place of asFigures) {
        const fix = place.fixes?.words;
        const text = scan.blocks[place.block].text;
        if (fix && "edits" in fix && (place.start === 0 || /[.!?]\s+$/.test(text.slice(0, place.start)))) fix.edits[0].text = matchCase("Xx", fix.edits[0].text).text;
      }
      const forms: Form[] = [
        { id: "words", label: bucket === "small" ? "In words (three)" : "In words (thirty)", count: asWords.length },
        { id: "figures", label: bucket === "small" ? "In figures (3)" : "In figures (30)", count: asFigures.length },
      ];
      out.push(
        issue(
          numbers,
          bucket,
          "consistency",
          bucket === "small" ? "Numbers under ten, as words and as figures" : "Numbers from ten to ninety-nine, as words and as figures",
          "Numbers in a sentence are written both ways. Labels, measures, times and money are not counted.",
          [...asWords, ...asFigures].sort((a, b) => a.block - b.block || a.start - b.start),
          forms,
        ),
      );
    }
    return out;
  },
};
