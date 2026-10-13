import { SPEECH_VERBS } from "../data/en/speechVerbs";
import { SPEECH_ENDS } from "../data/marks";
import type { BlockFacts } from "../engine/facts";
import { firstAt, type QuoteSpan } from "../engine/quotes";
import { countWords, F_CAP, isLetter, WORD } from "../engine/tokens";
import type { BlockInput, Edit, Env, Form, Place } from "../types";
import { issue, type Check } from "./check";

/** A quotation that reads as speech: its span and whether it can be changed. */
interface Speech {
  span: QuoteSpan;
  sure: boolean;
}


function looksSpoken(block: BlockInput, facts: BlockFacts, span: QuoteSpan, env: Env): boolean {
  const { marks } = facts.quotes;
  const tk = facts.tokens;
  const text = block.text;
  const from = marks[span.open].at + 1;
  const to = span.close >= 0 ? marks[span.close].at : text.length;
  const a = firstAt(tk, from);
  const b = firstAt(tk, to);
  if (countWords(tk, a, b) >= 3) return true;
  if (to > from && SPEECH_ENDS.includes(text[to - 1])) return true;
  if (env.base !== "en") return false;
  // "Yes," she said. / He said, "Yes". (But not: what they called 'progress'.)
  const first = a < b ? tk.flag[a] & F_CAP : 0;
  if (!first && countWords(tk, a, b) < 2) return false;
  const said = (i: number) => i >= 0 && i < tk.n && tk.kind[i] === WORD && SPEECH_VERBS.has(text.slice(tk.start[i], tk.end[i]).toLowerCase());
  for (let i = b; i < Math.min(tk.n, b + 9); i += 1) if (said(i)) return true;
  for (let i = a - 1; i >= Math.max(0, a - 9); i -= 1) if (said(i)) return true;
  return false;
}

/** An apostrophe at a word's edge (dogs’, ’tis): what makes a single mark
 *  doubtful to turn into a double one or back. */
function edgeApostrophe(block: BlockInput, facts: BlockFacts, span: QuoteSpan): boolean {
  const { marks } = facts.quotes;
  const text = block.text;
  const end = span.close >= 0 ? span.close : marks.length;
  for (let m = span.open + 1; m < end; m += 1) {
    const mark = marks[m];
    if (mark.level !== 1 || mark.role !== "apostrophe") continue;
    const inWord = mark.at > 0 && isLetter(text.charCodeAt(mark.at - 1)) && mark.at + 1 < text.length && isLetter(text.codePointAt(mark.at + 1) as number);
    if (!inWord) return true;
  }
  return false;
}

/**
 * Speech in double marks in some places and single in others. A quotation
 * of a word or two ('the Beast') is not speech and is not counted. The fix
 * changes the marks round the speech and turns any quotation inside it the
 * other way. It is not offered where an apostrophe could be mistaken for a
 * mark, or where the speech is not closed.
 */
export const speechQuotes: Check<Speech[]> = {
  id: "speechQuotes",
  label: "Double or single marks for speech",
  group: "punctuation",
  offIn: ["screenplay", "stageplay"],
  local(block, facts, env) {
    if (block.role === "extract" || block.role === "caps") return null;
    const found: Speech[] = [];
    for (const span of facts.quotes.spans) {
      if (span.depth !== 0 || facts.quotes.marks[span.open].shape === "angle") continue;
      if (!looksSpoken(block, facts, span, env)) continue;
      found.push({ span, sure: span.close >= 0 && !edgeApostrophe(block, facts, span) });
    }
    return found.length ? found : null;
  },
  reduce({ facts, local, env }) {
    const count = { double: 0, single: 0 };
    const places: Place[] = [];
    const q = env.quotes;
    local.forEach((found, block) => {
      for (const { span, sure } of found ?? []) {
        const { marks } = facts[block].quotes;
        const form = span.level === 2 ? "double" : "single";
        const other = span.level === 2 ? "single" : "double";
        count[form] += 1;
        const open = marks[span.open];
        const place: Place = { block, start: open.at, end: span.close >= 0 ? marks[span.close].at + 1 : open.at + 1, form };
        if (sure && !q.spaced) {
          // Every mark from the opening one to the closing one turns over.
          const edits: Edit[] = [];
          for (let m = span.open; m <= span.close; m += 1) {
            const mark = marks[m];
            if (mark.role !== "open" && mark.role !== "close") continue;
            const level = mark.level === 2 ? 1 : 2;
            const text = mark.shape === "straight" ? (level === 2 ? '"' : "'") : mark.role === "open" ? (level === 2 ? q.open2 : q.open1) : level === 2 ? q.close2 : q.close1;
            edits.push({ start: mark.at, end: mark.at + 1, text });
          }
          place.fixes = { [other]: { edits } };
        }
        places.push(place);
      }
    });
    if (!count.double || !count.single) return [];
    const forms: Form[] = [
      { id: "double", label: "Double “ ”", count: count.double },
      { id: "single", label: "Single ‘ ’", count: count.single },
    ];
    return [issue(speechQuotes, "speech", "consistency", "Double and single quote marks for speech", "Speech is marked both ways. A quotation inside speech takes the other kind.", places, forms)];
  },
};
