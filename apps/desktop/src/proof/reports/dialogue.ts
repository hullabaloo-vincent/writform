/**
 * The tags on a block's speech ("…," she said), told from the words beside
 * each closing or opening quote mark: who, and which verb. Also what is
 * amiss in the punctuation between speech and tag, where that is plain
 * enough to fix.
 *
 * A sentence of its own after speech ("Go." She smiled.) is a beat, not a
 * tag, and is never counted or changed.
 */

import { TITLES } from "../data/abbreviations";
import { ACTION_VERBS, PLAIN_TAGS, SPEECH_VERBS } from "../data/en/speechVerbs";
import { LY_EXCEPTIONS } from "../data/en/wording";
import type { BlockFacts } from "../engine/facts";
import { firstAt } from "../engine/quotes";
import { F_CAP, F_SPEECH, fold, isLetter, isWordy, PUNCT, SPACE, tokenText, WORD } from "../engine/tokens";
import type { BlockInput } from "../types";

export interface Tag {
  verb: string;
  start: number;
  end: number;
  kind: "plain" | "speech" | "action";
  /** An -ly word on the tag: where, and the word. */
  adverb?: [number, number, string];
  /** What is amiss between the speech and the tag, and how to mend it. */
  slip?: { what: "action" | "stop" | "capital" | "bare"; start: number; end: number; fix?: { start: number; end: number; text: string }[] };
}

export interface DialogueFacts {
  tags: Tag[];
  /** Speech from end to end, and no tag on it. */
  bare: boolean;
}

const PRONOUNS = new Set(["he", "she", "they", "i", "we", "you", "it"]);
const POSSESSIVES = new Set(["my", "his", "her", "their", "our", "your"]);
const kindOf = (verb: string): Tag["kind"] | null => (PLAIN_TAGS.has(verb) ? "plain" : ACTION_VERBS.has(verb) ? "action" : SPEECH_VERBS.has(verb) ? "speech" : null);
const adverbLike = (word: string): boolean => word.length >= 5 && word.endsWith("ly") && !LY_EXCEPTIONS.has(word);

export function dialogueOf(block: BlockInput, facts: BlockFacts): DialogueFacts {
  const none: DialogueFacts = { tags: [], bare: false };
  if (block.role !== "body" || block.note || block.cell) return none;
  const tk = facts.tokens;
  const text = block.text;
  const { marks, spans } = facts.quotes;
  const tags: Tag[] = [];
  const taken = new Set<number>();
  const lower = (i: number): string => fold(tokenText(text, tk, i));

  /** The words that follow token `from`, one space apart: up to six. A
   *  title's full stop (Mr. Ashworth) does not end the run. */
  const run = (from: number): number[] => {
    const out: number[] = [];
    let i = from;
    while (out.length < 6 && i < tk.n && tk.kind[i] === WORD) {
      out.push(i);
      let j = i + 1;
      if (TITLES.has(lower(i)) && j < tk.n && tk.kind[j] === PUNCT && text[tk.start[j]] === ".") j += 1;
      if (j >= tk.n || tk.kind[j] !== SPACE) break;
      i = j + 1;
    }
    return out;
  };

  for (const span of spans) {
    if (span.depth !== 0 || span.close < 0) continue;
    const open = marks[span.open].at;
    const close = marks[span.close].at;
    if (close - open < 2) continue;

    // ---- after the speech: "…," she said softly. / "…," said the old man.
    let i = firstAt(tk, close + 1);
    if (i < tk.n && tk.kind[i] === SPACE) i += 1;
    const words = run(i);
    let found = false;
    for (let p = 0; p < Math.min(words.length, 5) && !found; p += 1) {
      const verb = lower(words[p]);
      const kind = kindOf(verb);
      if (!kind) continue;
      const first = words[0];
      const firstWord = lower(first);
      let subjectEnd = p;
      let adverb: Tag["adverb"];
      if (p >= 2 && adverbLike(lower(words[p - 1]))) {
        subjectEnd = p - 1;
        adverb = [tk.start[words[p - 1]], tk.end[words[p - 1]], lower(words[p - 1])];
      }
      const subject = words.slice(0, subjectEnd);
      const pronoun = subject.length === 1 && PRONOUNS.has(firstWord);
      const names = subject.length >= 1 && subject.length <= 3 && subject.every((t) => (tk.flag[t] & F_CAP) !== 0) && !pronoun;
      const noun = subject.length >= 2 && subject.length <= 4 && (firstWord === "the" || POSSESSIVES.has(firstWord) || firstWord === "a" || firstWord === "an");
      // said Marianne / said the old man: the verb comes first.
      const inverted = p === 0 && kind !== "action" && words.length >= 2;
      if (!pronoun && !names && !noun && !inverted) continue;
      // said softly / said Marianne softly: after the verb, or after who said it.
      for (let q = p + 1; !adverb && q < Math.min(words.length, inverted ? p + 4 : p + 2); q += 1) {
        if (adverbLike(lower(words[q]))) adverb = [tk.start[words[q]], tk.end[words[q]], lower(words[q])];
      }

      const inside = text[close - 1];
      const capital = (tk.flag[first] & F_CAP) !== 0;
      const tag: Tag = { verb, start: tk.start[words[p]], end: tk.end[words[p]], kind, adverb };
      const subjectCapital = pronoun && capital && firstWord !== "i";
      if (kind === "action") {
        // "Go." She smiled. is a beat: a sentence of its own.
        if (inside === "." && capital) break;
        if (inside === ",") {
          const fix = pronoun ? [{ start: close - 1, end: close, text: "." }, ...(capital ? [] : [{ start: tk.start[first], end: tk.start[first] + 1, text: text[tk.start[first]].toUpperCase() }])] : undefined;
          tag.slip = { what: "action", start: close - 1, end: tk.end[words[p]], fix };
        }
      } else if (inside === ".") {
        const fix = [{ start: close - 1, end: close, text: "," }, ...(subjectCapital ? [{ start: tk.start[first], end: tk.start[first] + 1, text: text[tk.start[first]].toLowerCase() }] : [])];
        tag.slip = { what: "stop", start: close - 1, end: tk.end[words[p]], fix };
      } else if (inside === "," && subjectCapital) {
        tag.slip = { what: "capital", start: tk.start[first], end: tk.end[first], fix: [{ start: tk.start[first], end: tk.start[first] + 1, text: text[tk.start[first]].toLowerCase() }] };
      } else if (isLetter(text.codePointAt(close - 1) as number) && !capital) {
        tag.slip = { what: "bare", start: close, end: tk.end[words[p]], fix: [{ start: close, end: close, text: "," }] };
      }
      tags.push(tag);
      taken.add(words[p]);
      found = true;
    }
    if (found) continue;

    // ---- before the speech: She said, "…"
    let b = firstAt(tk, open) - 1;
    if (b >= 0 && tk.kind[b] === SPACE) b -= 1;
    if (b < 0 || tk.kind[b] !== PUNCT || !",:".includes(text[tk.start[b]])) continue;
    b -= 1;
    if (b >= 0 && tk.kind[b] === WORD && adverbLike(lower(b)) && b >= 2 && tk.kind[b - 1] === SPACE) b -= 2;
    if (b < 0 || tk.kind[b] !== WORD || taken.has(b)) continue;
    const verb = lower(b);
    const kind = kindOf(verb);
    if (!kind || kind === "action") continue;
    const after = b + 2 < tk.n && tk.kind[b + 2] === WORD && adverbLike(lower(b + 2)) ? ([tk.start[b + 2], tk.end[b + 2], lower(b + 2)] as Tag["adverb"]) : undefined;
    tags.push({ verb, start: tk.start[b], end: tk.end[b], kind, adverb: after });
    taken.add(b);
  }

  let all = 0;
  let spoken = 0;
  for (let i = 0; i < tk.n; i += 1) {
    if (!isWordy(tk.kind[i])) continue;
    all += 1;
    if (tk.flag[i] & F_SPEECH) spoken += 1;
  }
  return { tags, bare: tags.length === 0 && all > 0 && spoken * 5 >= all * 4 };
}
