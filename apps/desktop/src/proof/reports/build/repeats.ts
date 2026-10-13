import { ARTICLES, AUXILIARIES, CONJUNCTIONS, PREPOSITIONS } from "../../data/en/stop";
import { scopeBlocks, type StyleAnalysis } from "../analysis";
import { W_BREAK } from "../facts";
import type { Hit, HitGroup, HitItem, ReportResult, Scope } from "../types";
import { V_STOP } from "../vocab";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");

/** How many of each kind a list holds. */
const CLOSE_MOST = 150;
const PHRASE_MOST = 60;
const WORDS_MOST = 25;
/** The places kept for one word or phrase (the count is always the whole). */
const HITS_MOST = 400;
/** A phrase said twice this near is a repeat however long the book. */
const NEAR = 300;

interface Stream {
  /** Every word of the scope in order: its id, block and place in the block. */
  id: Int32Array;
  block: Int32Array;
  w: Int32Array;
  /** 1 where a phrase cannot run on from the word before. */
  cut: Uint8Array;
  n: number;
}

function streamOf(a: StyleAnalysis, from: number, to: number): Stream {
  let n = 0;
  for (let b = from; b < to; b += 1) n += a.style[b].n;
  const s: Stream = { id: new Int32Array(n), block: new Int32Array(n), w: new Int32Array(n), cut: new Uint8Array(n), n };
  let g = 0;
  for (let b = from; b < to; b += 1) {
    const f = a.style[b];
    for (let w = 0; w < f.n; w += 1) {
      s.id[g] = f.ids[w];
      s.block[g] = b;
      s.w[g] = w;
      s.cut[g] = w === 0 || f.flag[w] & W_BREAK ? 1 : 0;
      g += 1;
    }
  }
  return s;
}

/** Phrases of two to six words said again and again. A phrase never
 *  crosses a mark of punctuation, and neither begins nor ends on a small
 *  joining word ("of the" is not a phrase anyone leans on). */
function phrases(a: StyleAnalysis, s: Stream, allowed: Set<string>): HitItem[] {
  const { vocab } = a;
  const W = Math.max(1, s.n / 10_000);
  const least = (n: number): number => (n === 2 ? Math.max(4, Math.ceil(0.6 * W)) : n === 3 ? Math.max(3, Math.ceil(0.4 * W)) : Math.max(3, Math.ceil(0.25 * W)));
  const content = (id: number): boolean => id >= 0 && !(vocab.bits[id] & V_STOP) && !a.name[id];
  const badStart = (id: number): boolean => id < 0 || ARTICLES.has(vocab.word[id]) || CONJUNCTIONS.has(vocab.word[id]);
  const badEnd = (id: number): boolean => id < 0 || ARTICLES.has(vocab.word[id]) || CONJUNCTIONS.has(vocab.word[id]) || PREPOSITIONS.has(vocab.word[id]) || AUXILIARIES.has(vocab.word[id]);

  // Pairs first, by number. Then each frequent phrase is grown a word.
  let level = new Map<string, number[]>();
  for (let g = 0; g + 1 < s.n; g += 1) {
    if (s.cut[g + 1] || s.id[g] < 0 || s.id[g + 1] < 0) continue;
    const key = `${s.id[g]} ${s.id[g + 1]}`;
    const at = level.get(key);
    if (at) at.push(g);
    else level.set(key, [g]);
  }
  const kept: { n: number; ids: number[]; at: number[] }[] = [];
  for (let n = 2; n <= 6; n += 1) {
    const next = new Map<string, number[]>();
    for (const [key, at] of level) {
      if (at.length < 2) continue;
      const ids = key.split(" ").map(Number);
      const near = n >= 4 && at.some((g, i) => i > 0 && g - at[i - 1] <= NEAR);
      const enough = at.length >= least(n) || near;
      const contents = ids.filter(content).length;
      if (enough && !badStart(ids[0]) && !badEnd(ids[n - 1]) && contents >= (n === 2 ? 2 : 1)) kept.push({ n, ids, at });
      if (n === 6) continue;
      for (const g of at) {
        const end = g + n;
        if (end >= s.n || s.cut[end] || s.id[end] < 0) continue;
        const longer = `${key} ${s.id[end]}`;
        const list = next.get(longer);
        if (list) list.push(g);
        else next.set(longer, [g]);
      }
    }
    level = next;
  }
  // A shorter phrase is shown only when it is said at least twice more
  // than the longer one it is part of.
  const longest = [...kept].sort((x, y) => y.n - x.n);
  const shown = kept.filter((p) => !longest.some((q) => q.n > p.n && q.at.length + 2 > p.at.length && ` ${q.ids.join(" ")} `.includes(` ${p.ids.join(" ")} `)));
  // One stretch said again is one finding: a phrase whose every use lies
  // across a phrase already taken (its tail, running a word further) is
  // left out.
  const taken = new Set<number>();
  const apart = shown
    .sort((x, y) => y.at.length * y.n - x.at.length * x.n)
    .filter((p) => {
      const over = (g: number) => {
        for (let k = 0; k < p.n; k += 1) if (taken.has(g + k)) return true;
        return false;
      };
      if (p.at.every(over)) return false;
      for (const g of p.at) for (let k = 0; k < p.n; k += 1) taken.add(g + k);
      return true;
    });
  return apart
    .map((p) => {
      const text = p.ids.map((id) => vocab.word[id]).join(" ");
      const hits: Hit[] = p.at.slice(0, HITS_MOST).map((g) => {
        const f = a.style[s.block[g]];
        return { block: s.block[g], start: f.at[s.w[g]], end: f.end[s.w[g + p.n - 1]] };
      });
      return { key: text, label: `“${text}”`, detail: `${num(p.at.length)} times`, count: p.at.length, hits };
    })
    .filter((item) => !allowed.has(item.key))
    .slice(0, PHRASE_MOST);
}

/**
 * Words and phrases the text comes back to: the same word again within a
 * few lines, a phrase said over and over, the words used most, and a word
 * one chapter leans on far more than the rest of the book. Names and the
 * small words are never counted. `allowed` are words the writer has said
 * are fine.
 */
export function buildRepeats(a: StyleAnalysis, scope: Scope, allowed: Set<string>): ReportResult {
  const [from, to] = scopeBlocks(a, scope);
  const { vocab } = a;
  const groups: HitGroup[] = [];
  const fine = (id: number): boolean => allowed.has(vocab.word[id]);

  // ---- the same word, close by
  const close = a.clusters.filter((c) => c.hits[0].block >= from && c.hits[0].block < to && !fine(c.word));
  const dense = [...close].sort((x, y) => y.hits.length / (y.span + 8) - x.hits.length / (x.span + 8));
  if (dense.length) {
    groups.push({
      id: "close",
      label: "The same word, close by",
      hint: "A word used again within about thirty words. Names and small words are not counted.",
      count: close.length,
      items: dense.slice(0, CLOSE_MOST).map((c) => ({ key: vocab.word[c.word], label: vocab.word[c.word], detail: `${c.hits.length === 2 ? "twice" : `${c.hits.length} times`} in ${num(c.span + 1)} words`, count: c.hits.length, hits: c.hits })),
    });
  }

  // ---- phrases said again
  const stream = streamOf(a, from, to);
  const said = phrases(a, stream, allowed);
  if (said.length) groups.push({ id: "phrases", label: "Phrases said again", hint: "Two to six words in the same order, more often than chance would have it.", count: said.length, items: said });

  // ---- the words used most (by stem, named by the form used most)
  const byStem = new Map<number, { count: number; forms: Map<number, number> }>();
  let words = 0;
  for (let g = 0; g < stream.n; g += 1) {
    const id = stream.id[g];
    words += 1;
    if (id < 0 || vocab.bits[id] & V_STOP || a.name[id] || vocab.word[id].length < 3 || fine(id)) continue;
    const stem = vocab.stemOf[id];
    let entry = byStem.get(stem);
    if (!entry) byStem.set(stem, (entry = { count: 0, forms: new Map() }));
    entry.count += 1;
    entry.forms.set(id, (entry.forms.get(id) ?? 0) + 1);
  }
  const top = [...byStem].sort((x, y) => y[1].count - x[1].count).slice(0, WORDS_MOST);
  if (top.length && top[0][1].count >= 3) {
    const wanted = new Map(top.map(([stem], i) => [stem, i]));
    const hits: Hit[][] = top.map(() => []);
    for (let g = 0; g < stream.n; g += 1) {
      const id = stream.id[g];
      if (id < 0) continue;
      const i = wanted.get(vocab.stemOf[id]);
      if (i === undefined || hits[i].length >= HITS_MOST || a.name[id]) continue;
      const f = a.style[stream.block[g]];
      hits[i].push({ block: stream.block[g], start: f.at[stream.w[g]], end: f.end[stream.w[g]] });
    }
    groups.push({
      id: "most",
      label: "The words used most",
      hint: "Leaving out names and the small words every text is made of.",
      count: top.length,
      items: top.map(([, entry], i) => {
        const form = [...entry.forms].sort((x, y) => y[1] - x[1])[0][0];
        return { key: vocab.word[form], label: vocab.word[form], detail: `${num(entry.count)} times, once every ${num(words / entry.count)} words`, count: entry.count, hits: hits[i] };
      }),
    });
  }

  // ---- a word one chapter leans on
  const spikes: HitItem[] = [];
  if (a.chapters.length >= 2) {
    a.chapters.forEach((chapter, c) => {
      if (chapter.end <= from || chapter.first >= to || a.rolls[c].words < 200) return;
      const here = new Map<number, number>();
      for (let b = chapter.first; b < chapter.end; b += 1) {
        const f = a.style[b];
        for (let w = 0; w < f.n; w += 1) {
          const id = f.ids[w];
          if (id >= 0 && !(vocab.bits[id] & V_STOP) && !a.name[id] && vocab.word[id].length >= 4) here.set(id, (here.get(id) ?? 0) + 1);
        }
      }
      const rest = a.total.words - a.rolls[c].words;
      for (const [id, count] of here) {
        if (count < 6 || fine(id) || rest <= 0) continue;
        const elsewhere = a.uses[id] - count;
        const rate = count / a.rolls[c].words;
        if (rate < 3 * ((elsewhere + 1) / rest)) continue;
        const hits: Hit[] = [];
        for (let b = chapter.first; b < chapter.end && hits.length < HITS_MOST; b += 1) {
          const f = a.style[b];
          for (let w = 0; w < f.n; w += 1) if (f.ids[w] === id) hits.push({ block: b, start: f.at[w], end: f.end[w] });
        }
        spikes.push({ key: vocab.word[id], label: `${vocab.word[id]} in ${chapter.name}`, detail: `${num(count)} times here, ${elsewhere === 0 ? "nowhere else" : `${num(elsewhere)} in the rest of the book`}`, count, hits });
      }
    });
    spikes.sort((x, y) => y.count - x.count);
    if (spikes.length) groups.push({ id: "spikes", label: "A word one chapter leans on", hint: "Used at three times the rate of the rest of the book, six times or more.", count: spikes.length, items: spikes.slice(0, PHRASE_MOST) });
  }

  const perThousand = words ? (close.reduce((n, c) => n + c.hits.length - 1, 0) / words) * 1000 : 0;
  const headline = close.length ? `${num(close.length)} words come again within a few lines.` : "No word comes again within a few lines.";
  return {
    id: "repeats",
    headline,
    summary: words ? [{ id: "close", label: "Close repeats", value: perThousand, text: `${(Math.round(perThousand * 10) / 10).toLocaleString("en-US")} in every 1,000 words` }] : [],
    series: [],
    groups,
    notes: ["Repetition can be meant. This shows where it is, for you to judge."],
  };
}
