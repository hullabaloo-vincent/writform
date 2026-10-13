import { STOP_WORDS } from "../data/en/stop";
import { F_CAP, fold, isWordy, SPACE, WORD } from "../engine/tokens";
import type { Form, Place } from "../types";
import { issue, kept, stampOf, type Check } from "./check";
import { findPhrases, indexPhrases } from "./phraseMatch";

/** [the words in italic, start, end]. */
type Hit = [string, number, number];

const within = (spans: number[], start: number, end: number): boolean => {
  for (let k = 0; k < spans.length; k += 2) if (start >= spans[k] && end <= spans[k + 1]) return true;
  return false;
};

/**
 * A title or a name set in italic in some places and left plain in
 * others: the Marianne, The Times. Only a phrase with a capital in it, or
 * of two words or more, is weighed. A single plain word in italic is
 * stress, and stress comes and goes. The fix changes formatting, so it is
 * made directly even in Suggesting mode.
 */
export const italics: Check<Hit[]> = {
  id: "italics",
  label: "Italic in some places and not in others",
  group: "italics",
  local(block, facts) {
    if (!block.italic.length || block.role === "extract") return null;
    const tk = facts.tokens;
    const hits: Hit[] = [];
    for (let k = 0; k < block.italic.length; k += 2) {
      const from = block.italic[k];
      const to = block.italic[k + 1];
      const words: number[] = [];
      for (let i = 0; i < tk.n; i += 1) if (tk.start[i] >= from && tk.end[i] <= to && isWordy(tk.kind[i])) words.push(i);
      if (!words.length || words.length > 6) continue;
      const start = tk.start[words[0]];
      const end = tk.end[words[words.length - 1]];
      const said = block.text.slice(start, end);
      // A word of stress ("she DID say so") is not a title.
      const titled = words.length >= 2 || (tk.kind[words[0]] === WORD && (tk.flag[words[0]] & F_CAP) !== 0 && !STOP_WORDS.has(fold(said)));
      if (titled && !/[.!?]/.test(said)) hits.push([said, start, end]);
    }
    return hits.length ? hits : null;
  },
  reduce({ scan, facts, local }) {
    const italic = new Map<string, Place[]>();
    local.forEach((hits, block) => {
      for (const [said, start, end] of hits ?? []) {
        const list = italic.get(said) ?? [];
        list.push({ block, start, end, form: "italic", fixes: { plain: { mark: "italic", add: false, start, end } } });
        italic.set(said, list);
      }
    });
    if (!italic.size) return [];
    const index = indexPhrases([...italic.keys()].map((find) => ({ find, exact: true, what: find })));
    const plain = new Map<string, Place[]>();
    const stamp = stampOf(italic.keys());
    scan.blocks.forEach((b, block) => {
      if (b.role === "extract") return;
      const found = kept(facts[block], "italics:plain", stamp, () => {
        const tk = facts[block].tokens;
        const out: [string, number, number][] = [];
        findPhrases(b.text, tk, index, (first, last, said) => {
          const start = tk.start[first];
          const end = tk.end[last];
          // (In italic already, alone or as part of a longer italic passage.)
          if (within(b.italic, start, end)) return;
          // The words must stand whole: one space between each.
          for (let i = first + 1; i < last; i += 1) if (tk.kind[i] === SPACE && tk.end[i] - tk.start[i] !== 1) return false;
          out.push([said, start, end]);
        });
        return out;
      });
      for (const [said, start, end] of found) {
        const list = plain.get(said) ?? [];
        list.push({ block, start, end, form: "plain", fixes: { italic: { mark: "italic", add: true, start, end } } });
        plain.set(said, list);
      }
    });
    const out = [];
    for (const [said, set] of italic) {
      const bare = plain.get(said);
      if (!bare) continue;
      // Mostly italic, or plain only a few times: then the plain ones are slips.
      if (!(set.length >= bare.length || bare.length <= 3)) continue;
      const forms: Form[] = [
        { id: "italic", label: "In italic", count: set.length },
        { id: "plain", label: "Plain", count: bare.length },
      ];
      out.push({ ...issue(italics, said, "consistency", `“${said}” in italic and plain`, "In italic in some places and plain in others. Formatting is changed directly, also in Suggesting mode.", [...set, ...bare].sort((a, b) => a.block - b.block || a.start - b.start), forms), terms: [said.toLowerCase()] });
    }
    return out;
  },
};
