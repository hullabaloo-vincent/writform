import { STOP_WORDS } from "../data/en/stop";
import { F_CAP, F_UPPER, fold, tokenText, WORD } from "../engine/tokens";
import type { Form, Place } from "../types";
import { issue, type Check } from "./check";

/** How a heading is capitalised, or "" when it cannot be told. */
type Case = "upper" | "title" | "sentence" | "";

const NAMES: Record<Exclude<Case, "">, string> = { upper: "ALL CAPITALS", title: "A Capital on Each Word", sentence: "A capital on the first word" };

/**
 * Headings of one kind capitalised in more than one way: The Long Road
 * Home beside The long road home. A heading of one word, or one whose
 * only words are small ones, says nothing either way.
 */
export const headings: Check<Case> = {
  id: "headings",
  label: "Headings capitalised in more than one way",
  group: "capitals",
  english: true,
  local(block, facts) {
    if (!block.heading || block.role === "caps") return null;
    const tk = facts.tokens;
    const words: number[] = [];
    for (let i = 0; i < tk.n; i += 1) if (tk.kind[i] === WORD) words.push(i);
    if (words.length < 2) return "";
    if (words.every((i) => tk.flag[i] & F_UPPER || tk.end[i] - tk.start[i] === 1) && words.some((i) => tk.flag[i] & F_UPPER)) return "upper";
    // Only the words a title would capitalise say which it is.
    const weighty = words.slice(1).filter((i) => !STOP_WORDS.has(fold(tokenText(block.text, tk, i))) && tk.end[i] - tk.start[i] >= 4);
    if (!weighty.length) return "";
    const capped = weighty.filter((i) => tk.flag[i] & F_CAP).length;
    if (capped === weighty.length) return "title";
    if (capped === 0) return "sentence";
    // One capital among several may be a name: still a sentence.
    return capped === 1 && weighty.length >= 3 ? "sentence" : "";
  },
  reduce({ scan, local }) {
    const kinds = new Map<string, Map<Exclude<Case, "">, Place[]>>();
    local.forEach((how, block) => {
      if (!how) return;
      const kind = scan.blocks[block].heading as string;
      let by = kinds.get(kind);
      if (!by) kinds.set(kind, (by = new Map()));
      const list = by.get(how) ?? [];
      list.push({ block, start: 0, end: scan.blocks[block].text.length, form: how });
      by.set(how, list);
    });
    const out = [];
    for (const [kind, by] of kinds) {
      if (by.size < 2) continue;
      const forms: Form[] = [...by].map(([how, places]) => ({ id: how, label: NAMES[how], count: places.length }));
      const what = /^h\d$/.test(kind) ? `Heading ${kind.slice(1)}` : kind === "chapter" ? "Chapter headings" : kind === "section" ? "Unnumbered chapters" : kind === "part" ? "Part headings" : kind === "subheading" ? "Subheadings" : "Headings";
      out.push(issue(headings, kind, "consistency", `${what} capitalised in more than one way`, "Headings of one kind are capitalised differently. Choose which is meant to list the others.", [...by.values()].flat().sort((a, b) => a.block - b.block), forms));
    }
    return out;
  },
};
