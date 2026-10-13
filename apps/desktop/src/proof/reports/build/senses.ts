import { SENSES } from "../../data/en/senses";
import { scopeBlocks, type StyleAnalysis } from "../analysis";
import { W_SPEECH } from "../facts";
import type { Hit, HitGroup, ReportResult, Scope } from "../types";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const HITS_MOST = 300;

/**
 * Words that name what a sense takes in, by sense, outside speech. It is a
 * count of words and no more: a page can be full of the sea without one
 * word from the list. There is no right balance, so none is given.
 */
export function buildSenses(a: StyleAnalysis, scope: Scope, allowed: Set<string>): ReportResult {
  const [from, to] = scopeBlocks(a, scope);
  const { vocab } = a;
  /** By vocabulary id: which sense, or undefined. */
  const senseOf = new Map<number, number>();
  SENSES.forEach((sense, s) => {
    for (const word of sense.words) {
      const id = vocab.has(word);
      if (id >= 0 && !allowed.has(word)) senseOf.set(id, s);
    }
  });
  const by: Map<number, Hit[]>[] = SENSES.map(() => new Map());
  const totals = SENSES.map(() => 0);
  if (a.english) {
    for (let b = from; b < to; b += 1) {
      const f = a.style[b];
      for (let w = 0; w < f.n; w += 1) {
        if (f.flag[w] & W_SPEECH) continue;
        const s = senseOf.get(f.ids[w]);
        if (s === undefined) continue;
        totals[s] += 1;
        const list = by[s].get(f.ids[w]) ?? [];
        if (list.length < HITS_MOST) list.push({ block: b, start: f.at[w], end: f.end[w] });
        by[s].set(f.ids[w], list);
      }
    }
  }
  const groups: HitGroup[] = [];
  SENSES.forEach((sense, s) => {
    if (!totals[s]) return;
    const items = [...by[s]].map(([id, hits]) => ({ key: vocab.word[id], label: vocab.word[id], detail: hits.length === 1 ? "once" : `${num(hits.length)} times`, count: hits.length, hits })).sort((x, y) => y.count - x.count);
    groups.push({ id: sense.id, label: sense.label, hint: `Words that name ${sense.label.toLowerCase()}, outside speech.`, count: totals[s], items });
  });
  const all = totals.reduce((n, v) => n + v, 0);
  const least = SENSES.filter((_, s) => totals[s] === 0).map((sense) => sense.label.toLowerCase());
  return {
    id: "senses",
    headline: !a.english ? "This report reads English only." : !all ? "No words from the lists were found." : least.length ? `${num(all)} words name a sense. None name ${least.join(" or ")}.` : `${num(all)} words name a sense.`,
    summary: [],
    series: all ? [{ id: "senses", kind: "bars", label: "Words that name each sense (outside speech)", values: totals, labels: SENSES.map((sense) => sense.label) }] : [],
    groups,
    notes: a.english ? ["A count of words from five short lists. A page can be full of the sea without one of them, and there is no right balance."] : ["This report reads English only."],
  };
}
