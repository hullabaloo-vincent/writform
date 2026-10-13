import type { QuoteMark } from "../engine/quotes";
import type { Form, Place, QuoteChars } from "../types";
import { issue, swap, type Check } from "./check";

function curly(mark: QuoteMark, q: QuoteChars): string {
  if (mark.level === 2) return mark.role === "open" ? q.open2 : q.close2;
  if (mark.role === "open") return q.open1;
  return mark.role === "apostrophe" ? "’" : q.close1;
}

/**
 * Straight quote marks mixed with curly ones, and the same for
 * apostrophes. Not counted: the marks for feet and inches after a number.
 */
export const quoteShape: Check<never> = {
  id: "quoteShape",
  label: "Straight and curly quote marks",
  group: "punctuation",
  reduce({ facts, env }) {
    const out = [];
    for (const level of [2, 1] as const) {
      const count = { curly: 0, straight: 0 };
      const places: Place[] = [];
      facts.forEach((f, block) => {
        for (const mark of f.quotes.marks) {
          if (mark.level !== level || mark.role === "prime" || mark.shape === "angle") continue;
          count[mark.shape] += 1;
          const place: Place = { block, start: mark.at, end: mark.at + 1, form: mark.shape };
          if (mark.shape === "curly") place.fixes = { straight: swap(mark.at, mark.at + 1, level === 2 ? '"' : "'") };
          // (French marks stand off from the words by a space: not one for one.)
          else if (!env.quotes.spaced || mark.role === "apostrophe") place.fixes = { curly: swap(mark.at, mark.at + 1, curly(mark, env.quotes)) };
          places.push(place);
        }
      });
      if (!count.curly || !count.straight) continue;
      const forms: Form[] =
        level === 2
          ? [
              { id: "curly", label: "Curly “ ”", count: count.curly },
              { id: "straight", label: 'Straight " "', count: count.straight },
            ]
          : [
              { id: "curly", label: "Curly ’", count: count.curly },
              { id: "straight", label: "Straight '", count: count.straight },
            ];
      out.push(
        level === 2
          ? issue(quoteShape, "double", "consistency", "Straight and curly quote marks", "Both kinds are used. Curly marks are the printed convention.", places, forms)
          : issue(quoteShape, "single", "consistency", "Straight and curly apostrophes", "Both kinds are used. This counts single quote marks too.", places, forms),
      );
    }
    return out;
  },
};
