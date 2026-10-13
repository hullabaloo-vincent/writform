import { BREAK, NUMBER, PUNCT, SPACE, WORD } from "../engine/tokens";
import type { Place } from "../types";
import { issue, type Check } from "./check";

/** Offsets of brackets left open, and of closing ones with nothing open. */
interface Found {
  open: number[];
  stray: number[];
}

const OPENERS = "([{";
const CLOSERS = ")]}";
const ROMAN = /^(?:i{1,3}|iv|vi{0,3}|ix|x)$/i;

/**
 * Brackets and quote marks opened and not closed. A speech that runs over
 * several paragraphs opens each of them and closes only the last, so a
 * paragraph left open is fine when the next one opens again. Left alone:
 * "a)" and "1)" in a list, and smileys.
 */
export const openPairs: Check<Found> = {
  id: "openPairs",
  label: "Brackets and quote marks left open",
  group: "punctuation",
  local(block, facts) {
    const tk = facts.tokens;
    const text = block.text;
    /** The brackets now open, one stack a kind. */
    const stacks: number[][] = [[], [], []];
    const stray: number[] = [];
    for (let i = 0; i < tk.n; i += 1) {
      if (tk.kind[i] !== PUNCT) continue;
      const at = tk.start[i];
      const ch = text[at];
      const opener = OPENERS.indexOf(ch);
      const closer = CLOSERS.indexOf(ch);
      if (opener < 0 && closer < 0) continue;
      // :) ;-( =)
      const face = text.slice(Math.max(0, at - 2), at);
      if (/[:;=]-?$/.test(face)) continue;
      if (opener >= 0) {
        stacks[opener].push(at);
        continue;
      }
      if (stacks[closer].length) {
        stacks[closer].pop();
        continue;
      }
      // a)  1)  iv)
      if (closer === 0 && i > 0) {
        const label = tk.kind[i - 1] === WORD || tk.kind[i - 1] === NUMBER ? text.slice(tk.start[i - 1], tk.end[i - 1]) : "";
        const lead = i >= 2 ? tk.kind[i - 2] : 0;
        const short = label.length === 1 || (tk.kind[i - 1] === NUMBER && label.length <= 3) || ROMAN.test(label);
        if (label && short && (lead === 0 || lead === SPACE || lead === BREAK)) continue;
      }
      stray.push(at);
    }
    const open = stacks.flat().sort((a, b) => a - b);
    return open.length || stray.length ? { open, stray } : null;
  },
  reduce({ scan, facts, local, next }) {
    const out = [];
    const one = (block: number, at: number): Place => ({ block, start: at, end: at + 1, form: null });

    const opened: Place[] = [];
    const closed: Place[] = [];
    local.forEach((found, block) => {
      for (const at of found?.open ?? []) opened.push(one(block, at));
      for (const at of found?.stray ?? []) closed.push(one(block, at));
    });
    if (opened.length) out.push(issue(openPairs, "bracket.open", "look", "A bracket opened and not closed", "The paragraph ends before the brackets do.", opened));
    if (closed.length) out.push(issue(openPairs, "bracket.close", "look", "A closing bracket with no opening one", "Nothing was open for it to close.", closed));

    // Single marks are only weighed where they are how speech is written.
    let doubles = 0;
    let singles = 0;
    for (const f of facts) {
      for (const span of f.quotes.spans) {
        if (span.depth !== 0) continue;
        if (span.level === 2) doubles += 1;
        else singles += 1;
      }
    }
    const single = singles > doubles;

    const unclosed: Place[] = [];
    const stray: Place[] = [];
    facts.forEach((f, block) => {
      if (scan.blocks[block].role === "caps") return;
      const q = f.quotes;
      if (q.open.length) {
        const mark = q.marks[q.open[0]];
        if (mark.level === 2 || single) {
          const after = next[block];
          const carriesOn = after >= 0 && facts[after].quotes.opens === mark.level;
          if (!carriesOn) unclosed.push(one(block, mark.at));
        }
      }
      for (const m of q.stray) stray.push(one(block, q.marks[m].at));
    });
    if (unclosed.length) {
      out.push(issue(openPairs, "quote.open", "look", "A quote mark opened and not closed", "The paragraph ends before the quotation does. A speech that runs on into the next paragraph is left alone.", unclosed));
    }
    if (stray.length) out.push(issue(openPairs, "quote.close", "look", "A closing quote mark with no opening one", "Nothing was open for it to close.", stray));
    return out;
  },
};
