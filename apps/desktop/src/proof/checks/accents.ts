import { matchCase } from "../engine/casing";
import { fold, tokenText, WORD } from "../engine/tokens";
import type { Form, Place } from "../types";
import { issue, swap, type Check } from "./check";

/** [the word without its accents, the word, start, end]. */
type Hit = [string, string, number, number];

const MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const bare = (word: string): string => word.normalize("NFD").replace(MARKS, "");
const NOT_ASCII = new RegExp(`[^${String.fromCharCode(0)}-${String.fromCharCode(0x7f)}]`);
/** Pairs that are two different words: a résumé and to resume. */
const TWO_WORDS = new Set("resume rose expose pate lame pique".split(" "));

/**
 * A word written with its accent in some places and without in others:
 * café and cafe, naïve and naive, Zoë and Zoe. Nothing is looked up: the
 * text is weighed against itself.
 */
export const accents: Check<Hit[]> = {
  id: "accents",
  label: "Accents on some and not on others",
  group: "spelling",
  english: true,
  local(block, facts) {
    if (block.role === "extract") return null;
    const tk = facts.tokens;
    const hits: Hit[] = [];
    for (let i = 0; i < tk.n; i += 1) {
      if (tk.kind[i] !== WORD) continue;
      const word = fold(tokenText(block.text, tk, i));
      // (Only words with an accent are noted here. Their plain twins are
      // looked for once it is known which words those are.)
      if (word.length < 4 || !NOT_ASCII.test(word)) continue;
      const plain = bare(word);
      if (plain !== word && /^[a-z'-]+$/.test(plain) && !TWO_WORDS.has(plain)) hits.push([plain, word, tk.start[i], tk.end[i]]);
    }
    return hits.length ? hits : null;
  },
  reduce({ scan, facts, local }) {
    const marked = new Map<string, { form: string; places: Place[] }>();
    local.forEach((hits, block) => {
      for (const [plain, word, start, end] of hits ?? []) {
        let entry = marked.get(plain);
        if (!entry) marked.set(plain, (entry = { form: word, places: [] }));
        const to = matchCase(scan.blocks[block].text.slice(start, end), plain);
        entry.places.push({ block, start, end, form: "accent", fixes: { plain: swap(start, end, to.text) } });
      }
    });
    if (!marked.size) return [];
    const plainPlaces = new Map<string, Place[]>();
    scan.blocks.forEach((b, block) => {
      if (b.role === "extract") return;
      const tk = facts[block].tokens;
      for (let i = 0; i < tk.n; i += 1) {
        if (tk.kind[i] !== WORD) continue;
        const word = fold(tokenText(b.text, tk, i));
        const entry = marked.get(word);
        if (!entry) continue;
        const to = matchCase(b.text.slice(tk.start[i], tk.end[i]), entry.form);
        const list = plainPlaces.get(word) ?? [];
        list.push({ block, start: tk.start[i], end: tk.end[i], form: "plain", fixes: { accent: swap(tk.start[i], tk.end[i], to.text) } });
        plainPlaces.set(word, list);
      }
    });
    const out = [];
    for (const [plain, entry] of marked) {
      const without = plainPlaces.get(plain);
      if (!without) continue;
      const forms: Form[] = [
        { id: "accent", label: entry.form, count: entry.places.length },
        { id: "plain", label: plain, count: without.length },
      ];
      out.push({ ...issue(accents, plain, "consistency", `${entry.form} and ${plain}`, "With its accent in some places and without in others.", [...entry.places, ...without].sort((a, b) => a.block - b.block || a.start - b.start), forms), terms: [plain, entry.form] });
    }
    return out;
  },
};
