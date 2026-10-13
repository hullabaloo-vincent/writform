import { firstAt } from "../engine/quotes";
import { countWords, F_SPEECH, PUNCT, SPACE, WORD } from "../engine/tokens";
import type { Place } from "../types";
import { issue, type Check } from "./check";

interface Found {
  /** Flat [start, end] pairs. */
  marks: number[];
  brackets: number[];
}

const MARKERS = new Set(["TK", "TKTK", "TODO", "FIXME", "TBD", "TBC"]);
/** Words that make a bracketed aside a note to oneself. */
const NOTE = /(?:^|[^a-z])(?:tk|todo|tbd|tbc|check|add|fix|note|insert|expand|cite|citation|ref|research|verify|rewrite|more|describe|name|date|placeholder|cut|move|change)(?:$|[^a-z])/i;

/**
 * What a draft leaves behind: highlighting, TK and TODO, XXX, a row of
 * question marks, a note in square brackets. Left alone: [sic], a
 * bracketed ellipsis, citation numbers, and a word supplied inside a
 * quotation ("[he] said").
 */
export const leftovers: Check<Found> = {
  id: "leftovers",
  label: "Left in the text",
  group: "leftovers",
  local(block, facts) {
    const tk = facts.tokens;
    const text = block.text;
    const marks: number[] = [];
    const brackets: number[] = [];
    for (let i = 0; i < tk.n; i += 1) {
      const kind = tk.kind[i];
      const s = tk.start[i];
      if (kind === WORD) {
        const word = text.slice(s, tk.end[i]);
        if (MARKERS.has(word) || /^X{3,}$/.test(word)) marks.push(s, tk.end[i]);
        else if (word.toLowerCase() === "lorem" && i + 2 < tk.n && text.slice(tk.start[i + 2], tk.end[i + 2]).toLowerCase() === "ipsum") marks.push(s, tk.end[i + 2]);
      } else if (kind === PUNCT && text[s] === "?" && text.startsWith("???", s) && (i === 0 || tk.kind[i - 1] === SPACE || "([".includes(text[s - 1]))) {
        let j = i;
        while (j + 1 < tk.n && tk.kind[j + 1] === PUNCT && text[tk.start[j + 1]] === "?") j += 1;
        marks.push(s, tk.end[j]);
        i = j;
      } else if (kind === PUNCT && text[s] === "[") {
        const close = text.indexOf("]", s + 1);
        if (close < 0 || close - s > 240 || text.slice(s + 1, close).includes("[")) continue;
        const inner = text.slice(s + 1, close).trim();
        const a = firstAt(tk, s + 1);
        const b = firstAt(tk, close);
        if (!inner || /^sic$/i.test(inner) || /^(?:\.{3}|…)$/.test(inner) || /^[\d\s,;–-]+$/.test(inner)) continue;
        const noted = NOTE.test(inner) || inner.includes("?") || (countWords(tk, a, b) > 0 && inner === inner.toUpperCase() && inner.length >= 3);
        const quoted = (tk.flag[i] & F_SPEECH) !== 0 || block.role === "extract";
        if (!noted && (quoted || countWords(tk, a, b) === 0)) continue;
        brackets.push(s, close + 1);
        i = b;
      }
    }
    return marks.length || brackets.length ? { marks, brackets } : null;
  },
  reduce({ scan, local, env }) {
    const out = [];
    const lit: Place[] = [];
    if (env.highlights) {
      scan.blocks.forEach((b, block) => {
        for (let k = 0; k < b.highlight.length; k += 2) {
          const start = b.highlight[k];
          const end = b.highlight[k + 1];
          lit.push({ block, start, end, form: null, fixes: { "": { mark: "highlight", add: false, start, end } } });
        }
      });
    }
    if (lit.length) out.push(issue(leftovers, "highlight", "look", "Highlighted text", "Highlighting is often a note to come back to. Fix takes the highlight off and leaves the words.", lit));
    const places = (pick: (f: Found) => number[]): Place[] => {
      const list: Place[] = [];
      local.forEach((found, block) => {
        const at = found ? pick(found) : [];
        for (let k = 0; k < at.length; k += 2) list.push({ block, start: at[k], end: at[k + 1], form: null });
      });
      return list;
    };
    const marks = places((f) => f.marks);
    if (marks.length) out.push(issue(leftovers, "placeholder", "look", "Placeholders", "TK, TODO, XXX and rows of question marks stand in for words still to be written.", marks));
    const brackets = places((f) => f.brackets);
    if (brackets.length) out.push(issue(leftovers, "bracket", "look", "Notes in square brackets", "Square brackets often hold a note to yourself.", brackets));
    return out;
  },
};
