import { BREAK, isWordy, PUNCT, SPACE, WORD } from "../engine/tokens";
import type { Place } from "../types";
import { issue, swap, type Check } from "./check";

/** Flat [start, end] pairs for each kind of stray space. */
interface Found {
  double: number[];
  before: number[];
  end: number[];
  inside: number[];
  missing: number[];
}

const KINDS: { id: keyof Found; title: string; detail: string }[] = [
  { id: "double", title: "Two spaces in a row", detail: "More than one space between words." },
  { id: "before", title: "A space before punctuation", detail: "A space stands before a comma, a full stop or another mark." },
  { id: "inside", title: "A space inside brackets", detail: "A space just inside an opening or a closing bracket." },
  { id: "missing", title: "No space after punctuation", detail: "A comma or another mark runs straight into the next word." },
  { id: "end", title: "Spaces at the end of a paragraph", detail: "Spaces after the last word of a paragraph or a line." },
];

/**
 * Stray spaces. Left alone: the spaces a poem is indented or spaced with,
 * French spacing before ; : ! ?, the dots of an ellipsis, a file ending
 * (" .txt") and a smiley.
 */
export const spaces: Check<Found> = {
  id: "spaces",
  label: "Stray spaces",
  group: "tidy",
  local(block, facts, env) {
    const tk = facts.tokens;
    const text = block.text;
    const found: Found = { double: [], before: [], end: [], inside: [], missing: [] };
    const french = env.base === "fr";
    const kindAt = (i: number) => (i >= 0 && i < tk.n ? tk.kind[i] : 0);
    const charAt = (i: number) => (kindAt(i) === PUNCT ? text[tk.start[i]] : "");
    let any = false;
    for (let i = 0; i < tk.n; i += 1) {
      const s = tk.start[i];
      const e = tk.end[i];
      if (tk.kind[i] === PUNCT) {
        // word,word
        const ch = text[s];
        if ((ch === "," || ch === "!" || ch === "?") && kindAt(i - 1) === WORD && kindAt(i + 1) === WORD && tk.end[i - 1] - tk.start[i - 1] > 1 && tk.end[i + 1] - tk.start[i + 1] > 1) {
          found.missing.push(e, e);
          any = true;
        }
        continue;
      }
      if (tk.kind[i] !== SPACE) continue;
      const first = i === 0 || kindAt(i - 1) === BREAK;
      const last = i === tk.n - 1 || kindAt(i + 1) === BREAK;
      if (last) {
        found.end.push(s, e);
        any = true;
        continue;
      }
      if (first) continue;
      const next = charAt(i + 1);
      const after = kindAt(i + 2);
      const afterCh = charAt(i + 2);
      let taken = false;
      if (next && ",.;:!?".includes(next)) {
        // A stop, a colon or a semicolon must end something (" .txt" is a
        // file ending). A comma, ! or ? is out of place wherever it is.
        const opensNothing = ",!?".includes(next) || after === 0 || after === SPACE || after === BREAK || (afterCh !== "" && "\"'”’»)]}".includes(afterCh));
        const frenchWay = french && ";:!?".includes(next);
        // :) and ;( are faces, not punctuation.
        const face = (next === ":" || next === ";") && (afterCh === ")" || afterCh === "(");
        if (opensNothing && !frenchWay && !face && !(next === "." && afterCh === ".")) {
          found.before.push(s, e);
          taken = true;
        }
      } else if (next && ")]}".includes(next)) {
        found.inside.push(s, e);
        taken = true;
      }
      const prev = charAt(i - 1);
      if (!taken && prev && "([{".includes(prev) && isWordy(kindAt(i + 1))) {
        found.inside.push(s, e);
        taken = true;
      }
      if (!taken && e - s >= 2 && block.role !== "verse" && !text.slice(s, e).includes("\t")) {
        found.double.push(s, e);
        taken = true;
      }
      any = any || taken;
    }
    return any ? found : null;
  },
  reduce({ local }) {
    return KINDS.flatMap((kind) => {
      const places: Place[] = [];
      local.forEach((found, block) => {
        const at = found?.[kind.id];
        if (!at) return;
        for (let k = 0; k < at.length; k += 2) {
          const text = kind.id === "double" || kind.id === "missing" ? " " : "";
          places.push({ block, start: at[k], end: at[k + 1], form: null, fixes: { "": swap(at[k], at[k + 1], text) } });
        }
      });
      return places.length ? [issue(spaces, kind.id, "rule", kind.title, kind.detail, places)] : [];
    });
  },
};
