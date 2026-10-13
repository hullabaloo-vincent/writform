/**
 * The sentences of a paragraph, for measuring them. (The checks ask a
 * different question, "might this word open a sentence?", and answer yes
 * whenever in doubt: see engine/sentences.ts. Here a sentence is counted
 * once.)
 *
 * A sentence ends at a full stop, a question mark or an exclamation mark,
 * when what follows is not a lowercase word ("Stop!" she said is one
 * sentence) and what came before is not a shortening (Mr. Ashworth). A
 * short tag after speech that ends in ? or ! joins it ("Stop!" Marianne
 * said).
 */

import { ABBREVIATIONS } from "../data/abbreviations";
import { SPEECH_VERBS } from "../data/en/speechVerbs";
import type { QuoteFacts } from "../engine/quotes";
import { BREAK, F_CAP, isWordy, PUNCT, SPACE, type Tokens, WORD } from "../engine/tokens";

const ENDERS = ".!?…";

/** Token ranges, flat: [first, end) for each sentence. Every word of the
 *  block is in exactly one. */
export function sentenceSpans(text: string, tk: Tokens, quotes: QuoteFacts): number[] {
  const closes = new Set<number>();
  for (const m of quotes.marks) if (m.role === "close") closes.add(m.at);
  const spans: number[] = [];
  let first = -1;
  /** Ended inside speech by ? or !: a tag may follow. */
  let tagAfter = false;
  const lowerNext = (from: number): boolean => {
    for (let j = from; j < tk.n; j += 1) {
      if (isWordy(tk.kind[j])) return tk.kind[j] === WORD && !(tk.flag[j] & F_CAP);
      if (tk.kind[j] === BREAK) return false;
    }
    return false;
  };
  const end = (at: number) => {
    if (first < 0) return;
    // "Stop!" Marianne said. A few words with a verb of speech: one sentence.
    if (tagAfter && spans.length >= 2) {
      let words = 0;
      let said = false;
      for (let j = first; j < at; j += 1) {
        if (!isWordy(tk.kind[j])) continue;
        words += 1;
        if (tk.kind[j] === WORD && SPEECH_VERBS.has(text.slice(tk.start[j], tk.end[j]).toLowerCase())) said = true;
      }
      if (words <= 4 && said) {
        spans[spans.length - 1] = at;
        first = -1;
        return;
      }
    }
    spans.push(first, at);
    first = -1;
  };

  for (let i = 0; i < tk.n; i += 1) {
    const kind = tk.kind[i];
    if (isWordy(kind)) {
      if (first < 0) first = i;
      continue;
    }
    if (kind === BREAK) {
      end(i);
      tagAfter = false;
      continue;
    }
    if (kind !== PUNCT || first < 0) continue;
    const ch = text[tk.start[i]];
    if (!ENDERS.includes(ch)) continue;
    // file.txt, 3.5, U.S.A
    if (ch === "." && i + 1 < tk.n && isWordy(tk.kind[i + 1])) continue;
    // Take the marks that close with it: ?!” )
    let j = i + 1;
    let closed = false;
    while (j < tk.n && tk.kind[j] === PUNCT) {
      const c = text[tk.start[j]];
      if (closes.has(tk.start[j])) closed = true;
      else if (!ENDERS.includes(c) && !")]}".includes(c)) break;
      j += 1;
    }
    const spaced = j >= tk.n || tk.kind[j] === SPACE || tk.kind[j] === BREAK;
    if (!spaced) continue;
    const before = tk.kind[i - 1] === WORD ? text.slice(tk.start[i - 1], tk.end[i - 1]) : "";
    const short = ch === "." && before !== "" && (before.length === 1 || ABBREVIATIONS.has(before.toLowerCase()));
    if (j < tk.n && (short || lowerNext(j))) continue;
    end(j);
    tagAfter = closed && (ch === "?" || ch === "!");
    i = j - 1;
  }
  end(tk.n);
  return spans;
}
