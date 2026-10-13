import { IRREGULAR_PARTICIPLES } from "../../data/en/verbs";
import { scopeBlocks, type StyleAnalysis } from "../analysis";
import { W_SPEECH } from "../facts";
import type { Hit, HitItem, Measure, ReportResult, Scope, Series } from "../types";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A stretch is paragraphs gathered until they come to this many words. */
export const SEGMENT_WORDS = 300;
/** This many words with no speech is a stretch to look at. */
const NO_SPEECH = 1000;

const THOUGHT = new Set("thought remembered wondered knew realised realized considered supposed imagined recalled believed understood reflected".split(" "));
const STATE = new Set("was were had seemed been".split(" "));

interface Segment {
  first: number;
  end: number;
  words: number;
  speech: number;
  sentences: number;
  paragraphs: number;
  /** "had" and a participle: the story looking back. */
  back: number;
  thought: number;
  state: number;
  band: 0 | 1 | 2;
  why: string[];
}

/**
 * The pace of the text, told from its shape alone: how much is speech,
 * how long the sentences and paragraphs are, how often it looks back
 * ("had gone") or goes inside a head ("she wondered"). It knows nothing of
 * tension or of meaning, so a stretch is named for what was measured and
 * never called slow.
 */
export function buildPace(a: StyleAnalysis, scope: Scope): ReportResult {
  const [from, to] = scopeBlocks(a, scope);
  const { vocab } = a;
  const segments: Segment[] = [];
  let open: Segment | null = null;
  const close = () => {
    if (open && open.words > 0) segments.push(open);
    open = null;
  };
  let chapter = -2;
  for (let b = from; b < to; b += 1) {
    const f = a.style[b];
    if (f.kind !== 2 || f.n === 0) continue;
    // (A stretch never runs from one chapter into the next.)
    if (a.chapterOf[b] !== chapter) {
      close();
      chapter = a.chapterOf[b];
    }
    if (!open) open = { first: b, end: b + 1, words: 0, speech: 0, sentences: 0, paragraphs: 0, back: 0, thought: 0, state: 0, band: 1, why: [] };
    const seg: Segment = open;
    seg.end = b + 1;
    seg.words += f.n;
    seg.speech += f.speech;
    seg.sentences += f.sWords.length;
    seg.paragraphs += 1;
    if (a.english) {
      for (let w = 0; w < f.n; w += 1) {
        const id = f.ids[w];
        if (id < 0 || f.flag[w] & W_SPEECH) continue;
        const word = vocab.word[id];
        if (THOUGHT.has(word)) seg.thought += 1;
        if (STATE.has(word)) seg.state += 1;
        if (word === "had" && w + 1 < f.n && f.ids[w + 1] >= 0) {
          const next = vocab.word[f.ids[w + 1]];
          if (IRREGULAR_PARTICIPLES.has(next) || (next.length > 4 && next.endsWith("ed"))) seg.back += 1;
        }
      }
    }
    if (seg.words >= SEGMENT_WORDS) close();
  }
  close();

  for (const seg of segments) {
    const share = seg.speech / seg.words;
    const sentence = seg.sentences ? seg.words / seg.sentences : seg.words;
    const paragraph = seg.words / seg.paragraphs;
    const per = (n: number) => (n / seg.words) * 100;
    if (share >= 0.5 || (sentence <= 10 && paragraph <= 45)) {
      seg.band = 0;
      continue;
    }
    if (share > 0.05) continue;
    if (paragraph >= 90) seg.why.push("long paragraphs");
    if (sentence >= 20) seg.why.push("long sentences");
    if (per(seg.back) >= 1.5) seg.why.push(`looks back ${num(seg.back)} times`);
    if (per(seg.thought) >= 1.5) seg.why.push(`inside a head ${num(seg.thought)} times`);
    if (per(seg.state) >= 7) seg.why.push("many was and had");
    if (seg.why.length >= 2) seg.band = 2;
  }

  // ---- stretches to look at
  const items: HitItem[] = [];
  const startOf = (block: number): Hit => {
    const f = a.style[block];
    const words = Math.min(f.n, 6);
    return { block, start: f.at[0], end: f.end[words - 1] };
  };
  let run: Segment[] = [];
  const endRun = () => {
    if (run.length >= 3) {
      const words = run.reduce((n, s) => n + s.words, 0);
      const why = [...new Set(run.flatMap((s) => s.why))];
      items.push({ key: "", label: `${num(words)} words with little or no speech`, detail: why.join(", "), count: words, hits: [startOf(run[0].first)] });
    }
    run = [];
  };
  let quiet: Segment[] = [];
  let longest = 0;
  const endQuiet = () => {
    const words = quiet.reduce((n, s) => n + s.words, 0);
    longest = Math.max(longest, words);
    if (words >= NO_SPEECH && !items.some((item) => item.hits[0].block === quiet[0].first)) items.push({ key: "", label: `${num(words)} words without speech`, count: words, hits: [startOf(quiet[0].first)] });
    quiet = [];
  };
  let was = -2;
  for (const seg of segments) {
    const ch = a.chapterOf[seg.first];
    if (ch !== was) {
      endRun();
      endQuiet();
      was = ch;
    }
    if (seg.band === 2) run.push(seg);
    else endRun();
    if (seg.speech === 0) quiet.push(seg);
    else endQuiet();
  }
  endRun();
  endQuiet();
  items.sort((x, y) => y.count - x.count);

  const series: Series[] = segments.length ? [{ id: "pace", kind: "map", label: `The text in order, in stretches of about ${SEGMENT_WORDS} words`, values: segments.map((s) => s.band), labels: ["Quick", "Steady", "Slow-leaning"], at: segments.map((s) => startOf(s.first)) }] : [];
  const counts = [0, 1, 2].map((band) => segments.filter((s) => s.band === band).length);
  const summary: Measure[] = [];
  if (segments.length) {
    summary.push({ id: "quick", label: "Quick stretches", value: counts[0], text: `${num(counts[0])} of ${num(segments.length)}` });
    summary.push({ id: "slow", label: "Slow-leaning stretches", value: counts[2], text: `${num(counts[2])} of ${num(segments.length)}` });
    if (a.fiction) summary.push({ id: "quiet", label: "Longest run without speech", value: longest, text: `${num(longest)} words` });
  }
  const notes = [
    "Quick: half or more is speech, or the sentences and paragraphs are short. Slow-leaning: almost no speech, and at least two of long paragraphs, long sentences, looking back (had gone), going inside a head (she wondered), many was and had.",
    "This looks at the shape of the text and not its meaning. A quiet stretch can be exactly right.",
  ];
  return {
    id: "pace",
    headline: !segments.length ? "Nothing to measure yet." : items.length ? `${num(items.length)} ${items.length === 1 ? "stretch" : "stretches"} to look at.` : "No long stretch stands out.",
    summary,
    series,
    groups: items.length ? [{ id: "stretches", label: "Stretches to look at", hint: "Three or more slow-leaning stretches in a row, or a thousand words without speech. Named for what was measured.", count: items.length, items }] : [],
    notes,
  };
}
