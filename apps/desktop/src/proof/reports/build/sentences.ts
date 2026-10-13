import { ING_NOUNS, LY_OTHERS, OPEN_DETERMINERS, OPEN_LEADS, OPEN_LINKS, OPEN_PRONOUNS } from "../../data/en/openers";
import { LONG_SENTENCE, scopeBlocks, type StyleAnalysis } from "../analysis";
import { sentenceGuide } from "../guides";
import type { Hit, HitGroup, HitItem, Measure, ReportResult, Scope, Series } from "../types";

const one = (n: number): string => (Math.round(n * 10) / 10).toLocaleString("en-US");
const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** A chart is never wider than this many columns. */
export const STRIP_MAX = 120;
/** How many of a kind a list holds. */
const MOST = 200;

/** A paragraph of more words than this is a long one. */
const longParagraph = (fiction: boolean): number => (fiction ? 150 : 200);

interface Sent {
  block: number;
  s: number;
  words: number;
  speech: boolean;
  /** The id of its first word. */
  first: number;
  /** It follows straight on from the sentence before (no heading, list or
   *  table between). */
  joins: boolean;
}

const BINS: [number, string][] = [
  [5, "1 to 5"],
  [10, "6 to 10"],
  [15, "11 to 15"],
  [20, "16 to 20"],
  [30, "21 to 30"],
  [40, "31 to 40"],
  [Infinity, "Over 40"],
];

const OPENERS = ["A name", "He, she, they", "The, a, this", "And, but, then", "When, as, in", "An -ing word", "An -ly word", "There or it", "Something else"];

function openerOf(a: StyleAnalysis, sent: Sent): number {
  const f = a.style[sent.block];
  const w = f.sFirst[sent.s];
  const id = sent.first;
  if (id < 0) return 8;
  const word = a.vocab.word[id];
  if (a.name[id]) return 0;
  if ((word === "there" || word === "it") && w + 1 < f.n && f.ids[w + 1] >= 0 && /^(?:is|was|were|are|had|has|would|will|seemed)$/.test(a.vocab.word[f.ids[w + 1]])) return 7;
  if (OPEN_PRONOUNS.has(word)) return 1;
  if (OPEN_DETERMINERS.has(word)) return 2;
  if (OPEN_LINKS.has(word)) return 3;
  if (OPEN_LEADS.has(word)) return 4;
  if (word.length >= 5 && word.endsWith("ing") && !ING_NOUNS.has(word)) return 5;
  if (word.length >= 5 && word.endsWith("ly") && !LY_OTHERS.has(word)) return 6;
  return 8;
}

/** How long the sentences are, how they begin, and where they fall into a
 *  pattern. Speech is left out of the patterns: people talk as they talk. */
export function buildSentences(a: StyleAnalysis, scope: Scope): ReportResult {
  const [from, to] = scopeBlocks(a, scope);
  const sents: Sent[] = [];
  const paragraphs: { block: number; words: number; first: number; joins: boolean }[] = [];
  let joined = false;
  for (let b = from; b < to; b += 1) {
    const f = a.style[b];
    if (f.kind !== 2 || f.n === 0) {
      // (An empty paragraph is no break in the prose. Anything else is.)
      if (f.kind !== 2) joined = false;
      continue;
    }
    paragraphs.push({ block: b, words: f.n, first: f.ids[0], joins: joined });
    for (let s = 0; s < f.sWords.length; s += 1) {
      sents.push({ block: b, s, words: f.sWords[s], speech: f.sSpeech[s] === 1, first: f.ids[f.sFirst[s]], joins: joined });
      joined = true;
    }
    joined = true;
  }
  const hitOf = (sent: Sent): Hit => ({ block: sent.block, start: a.style[sent.block].sFrom[sent.s], end: a.style[sent.block].sTo[sent.s] });
  const firstWord = (sent: Sent): Hit => {
    const f = a.style[sent.block];
    const w = f.sFirst[sent.s];
    return { block: sent.block, start: f.at[w], end: f.end[w] };
  };

  // ---- the numbers
  const lengths = sents.map((s) => s.words).sort((x, y) => x - y);
  const total = lengths.reduce((n, v) => n + v, 0);
  const average = lengths.length ? total / lengths.length : 0;
  const at = (p: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * p))] ?? 0;
  const summary: Measure[] = [];
  if (lengths.length) {
    summary.push({ id: "sentence", label: "Average sentence", value: average, text: `${one(average)} words`, guide: sentenceGuide(average, a.fiction) });
    summary.push({ id: "spread", label: "Most run from", value: at(0.9) - at(0.1), text: `${at(0.1)} to ${at(0.9)} words` });
    summary.push({ id: "longest", label: "Longest", value: lengths[lengths.length - 1], text: `${lengths[lengths.length - 1]} words` });
  }

  // ---- the charts
  const series: Series[] = [];
  if (sents.length) {
    const per = Math.ceil(sents.length / STRIP_MAX);
    const values: number[] = [];
    const where: Hit[] = [];
    const light: boolean[] = [];
    for (let i = 0; i < sents.length; i += per) {
      const bin = sents.slice(i, i + per);
      const sorted = bin.map((s) => s.words).sort((x, y) => x - y);
      values.push(per === 1 ? bin[0].words : sorted[Math.floor(sorted.length / 2)]);
      where.push(hitOf(bin[0]));
      light.push(bin.filter((s) => s.speech).length * 2 > bin.length);
    }
    series.push({ id: "lengths", kind: "strip", label: per === 1 ? "Each sentence, in order" : `The text in order, ${per} sentences a bar`, values, at: where, light, per });
    const bins = BINS.map(() => 0);
    for (const s of sents) bins[BINS.findIndex(([most]) => s.words <= most)] += 1;
    series.push({ id: "histogram", kind: "histogram", label: "Sentences by length, in words", values: bins, labels: BINS.map(([, label]) => label) });
    if (a.english) {
      const openers = OPENERS.map(() => 0);
      for (const s of sents) if (!s.speech) openers[openerOf(a, s)] += 1;
      if (openers.some((v) => v > 0)) series.push({ id: "openers", kind: "bars", label: "How sentences begin (outside speech)", values: openers, labels: OPENERS });
    }
  }

  // ---- the patterns
  const groups: HitGroup[] = [];
  const group = (id: string, label: string, hint: string, items: HitItem[]) => {
    if (items.length) groups.push({ id, label, hint, count: items.length, items: items.slice(0, MOST) });
  };
  /** Runs of sentences outside speech that follow one another. */
  const runs = (same: (run: Sent[], next: Sent) => boolean, least: number): Sent[][] => {
    const out: Sent[][] = [];
    let run: Sent[] = [];
    const end = () => {
      if (run.length >= least) out.push(run);
      run = [];
    };
    for (const s of sents) {
      if (s.speech) {
        end();
        continue;
      }
      if (run.length && (!s.joins || !same(run, s))) end();
      if (!run.length && !same([], s)) continue;
      run.push(s);
    }
    end();
    return out;
  };

  const sameStart = runs((run, next) => next.first >= 0 && (!run.length || run[0].first === next.first), 3);
  group(
    "start",
    "Sentences that begin the same way",
    "Three or more in a row, outside speech, that open with the same word.",
    sameStart.map((run) => ({ key: "", label: `${cap(a.vocab.word[run[0].first])} begins ${run.length} sentences in a row`, count: run.length, hits: run.map(firstWord) })),
  );

  const paraRuns: (typeof paragraphs)[] = [];
  let pr: typeof paragraphs = [];
  for (const para of paragraphs) {
    if (pr.length && (!para.joins || para.first < 0 || para.first !== pr[0].first)) {
      if (pr.length >= 3) paraRuns.push(pr);
      pr = [];
    }
    if (para.first >= 0) pr.push(para);
  }
  if (pr.length >= 3) paraRuns.push(pr);
  group(
    "paragraphs",
    "Paragraphs that begin the same way",
    "Three or more in a row that open with the same word.",
    paraRuns.map((run) => ({ key: "", label: `${cap(a.vocab.word[run[0].first])} begins ${run.length} paragraphs in a row`, count: run.length, hits: run.map((para) => ({ block: para.block, start: a.style[para.block].at[0], end: a.style[para.block].end[0] })) })),
  );

  const even = runs((run, next) => {
    if (next.words < 6) return false;
    const all = [...run, next].map((s) => s.words);
    return Math.max(...all) - Math.min(...all) <= 3;
  }, 5);
  group(
    "even",
    "Sentences all of a length",
    "Five or more in a row within three words of each other. The ear hears the beat.",
    even.map((run) => {
      const all = run.map((s) => s.words);
      const least = Math.min(...all);
      const most = Math.max(...all);
      return { key: "", label: `${run.length} sentences in a row of ${least === most ? least : `${least} to ${most}`} words`, count: run.length, hits: run.map(hitOf) };
    }),
  );

  const short = runs((_, next) => next.words <= 5, 5);
  group(
    "short",
    "Runs of very short sentences",
    "Five or more in a row of five words or fewer.",
    short.map((run) => ({ key: "", label: `${run.length} short sentences in a row`, count: run.length, hits: run.map(hitOf) })),
  );

  const long = sents.filter((s) => s.words > LONG_SENTENCE).sort((x, y) => y.words - x.words);
  group(
    "long",
    "Long sentences",
    `Over ${LONG_SENTENCE} words. The longest come first.`,
    long.map((s) => ({ key: "", label: `${s.words} words`, count: 1, hits: [hitOf(s)] })),
  );

  const most = longParagraph(a.fiction);
  const bigParas = paragraphs.filter((para) => para.words > most).sort((x, y) => y.words - x.words);
  group(
    "paragraph",
    "Long paragraphs",
    `Over ${most} words. The longest come first.`,
    bigParas.map((para) => {
      const f = a.style[para.block];
      return { key: "", label: `${para.words} words`, count: 1, hits: [{ block: para.block, start: f.at[0], end: f.end[f.n - 1] }] };
    }),
  );

  const headline = lengths.length ? `Sentences average ${one(average)} words and mostly run from ${at(0.1)} to ${at(0.9)}.` : "No sentences to measure yet.";
  return { id: "sentences", headline, summary, series, groups, notes: a.fiction ? ["No usual range is given for fiction. Compare your chapters with each other."] : [] };
}
