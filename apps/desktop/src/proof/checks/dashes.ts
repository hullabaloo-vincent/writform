import { isDigit, isLetter, isSpace, NUMBER, PUNCT, SPACE, type Tokens } from "../engine/tokens";
import { DASH_STYLES as STYLES, EM, EN } from "../data/marks";
import type { Form, Place } from "../types";
import { issue, swap, type Check } from "./check";

interface Found {
  /** A range of numbers: [kind (0 hyphen, 1 en dash), offset of the mark]. */
  ranges: [number, number][];
  /** A dash in a sentence: [style, start, end] (with any spaces round it). */
  breaks: [number, number, number][];
}

const numberAt = (tk: Tokens, i: number): boolean => i >= 0 && i < tk.n && tk.kind[i] === NUMBER;

/**
 * Dashes. A range of numbers with a hyphen in some places and an en dash
 * in others (1990-95, 1990–95), and the dash that breaks a sentence drawn
 * more than one way. Left alone: phone numbers and dates (three groups of
 * figures), minus signs, a dash that cuts speech off before the closing
 * mark, verse, and lines in capitals (INT. HOUSE - DAY).
 */
export const dashes: Check<Found> = {
  id: "dashes",
  label: "Dashes drawn more than one way",
  group: "hyphens",
  local(block, facts) {
    if (block.role === "caps" || block.role === "verse" || block.role === "extract") return null;
    const tk = facts.tokens;
    const text = block.text;
    const found: Found = { ranges: [], breaks: [] };
    for (let i = 0; i < tk.n; i += 1) {
      if (tk.kind[i] !== PUNCT) continue;
      const at = tk.start[i];
      const ch = text[at];
      if (ch !== "-" && ch !== EN && ch !== EM) continue;
      // ---- between two numbers
      if (ch !== EM && numberAt(tk, i - 1) && numberAt(tk, i + 1)) {
        // 555-0199-22 and 2026-10-13 are not ranges.
        const more = (j: number) => j >= 0 && j < tk.n && tk.kind[j] === PUNCT && (text[tk.start[j]] === "-" || text[tk.start[j]] === EN);
        if (more(i - 2) || more(i + 2)) continue;
        found.ranges.push([ch === "-" ? 0 : 1, at]);
        continue;
      }
      // ---- breaking a sentence
      const spaceBefore = i > 0 && tk.kind[i - 1] === SPACE;
      let j = i;
      let style = -1;
      if (ch === "-" && text[at + 1] === "-" && !spaceBefore) {
        j = i + 1;
        style = 4;
      } else if (ch === "-") {
        if (spaceBefore && i + 1 < tk.n && tk.kind[i + 1] === SPACE) style = 3;
      } else if (ch === EN) {
        if (spaceBefore && i + 1 < tk.n && tk.kind[i + 1] === SPACE) style = 2;
      } else {
        const spaceAfter = i + 1 < tk.n && tk.kind[i + 1] === SPACE;
        style = spaceBefore && spaceAfter ? 1 : !spaceBefore && !spaceAfter ? 0 : -1;
      }
      if (style < 0) continue;
      const start = style === 0 || style === 4 ? at : tk.start[i - 1];
      const end = style === 0 || style === 4 ? tk.end[j] : tk.end[i + 1];
      // A word must stand each side: not "—" cutting speech off, not a list's dash.
      const left = start > 0 ? text.charCodeAt(start - 1) : 0;
      const right = end < text.length ? (text.codePointAt(end) as number) : 0;
      const wordy = (c: number) => isLetter(c) || isDigit(c);
      if (!wordy(left) || !wordy(right) || isSpace(left)) {
        i = j;
        continue;
      }
      found.breaks.push([style, start, end]);
      i = j;
    }
    return found.ranges.length || found.breaks.length ? found : null;
  },
  reduce({ local }) {
    const out = [];
    const hyphen: Place[] = [];
    const en: Place[] = [];
    const byStyle: Place[][] = STYLES.map(() => []);
    local.forEach((found, block) => {
      for (const [kind, at] of found?.ranges ?? []) {
        if (kind === 0) hyphen.push({ block, start: at, end: at + 1, form: "hyphen", fixes: { en: swap(at, at + 1, EN) } });
        else en.push({ block, start: at, end: at + 1, form: "en", fixes: { hyphen: swap(at, at + 1, "-") } });
      }
      for (const [style, start, end] of found?.breaks ?? []) {
        const fixes: Place["fixes"] = {};
        STYLES.forEach((other, k) => {
          if (k !== style) fixes[other.id] = swap(start, end, other.text);
        });
        byStyle[style].push({ block, start, end, form: STYLES[style].id, fixes });
      }
    });
    if (hyphen.length && en.length) {
      const forms: Form[] = [
        { id: "en", label: `En dash (1990${EN}95)`, count: en.length },
        { id: "hyphen", label: "Hyphen (1990-95)", count: hyphen.length },
      ];
      out.push(issue(dashes, "range", "consistency", "Ranges of numbers with a hyphen and with a dash", "Both are used between two numbers. Print uses the en dash.", [...hyphen, ...en].sort((a, b) => a.block - b.block || a.start - b.start), forms));
    }
    const usedStyles = byStyle.filter((list) => list.length > 0).length;
    if (usedStyles > 1) {
      const forms: Form[] = STYLES.map((style, k) => ({ id: style.id, label: style.label, count: byStyle[k].length })).filter((form) => form.count > 0);
      out.push(issue(dashes, "break", "consistency", "The dash in a sentence, drawn more than one way", "A dash that sets words apart is written differently in different places.", byStyle.flat().sort((a, b) => a.block - b.block || a.start - b.start), forms));
    }
    return out;
  },
};
