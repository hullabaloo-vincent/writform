import type { StyleAnalysis } from "../analysis";
import type { ChapterRow, ReportResult } from "../types";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const one = (n: number): string => (Math.round(n * 10) / 10).toLocaleString("en-US");

function quartiles(values: number[]): { q1: number; median: number; q3: number } {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    return v[lo] + (v[Math.min(v.length - 1, lo + 1)] - v[lo]) * (i - lo);
  };
  return { q1: at(0.25), median: at(0.5), q3: at(0.75) };
}

/** A chapter too short to judge by: its rates swing on a few words. */
const SMALL = 200;
/** With fewer chapters than this there is no "rest of the book". */
const FEWEST = 4;

/**
 * One row a chapter, each number set against the same number for the
 * other chapters. A row is marked where it stands well apart: outside the
 * book's usual spread for its length, its sentences and its share of
 * speech, or at half as much again as the book's middle chapter for
 * repeats and long sentences.
 */
export function chapterRows(a: StyleAnalysis): ChapterRow[] {
  const rows: ChapterRow[] = a.chapters.map((chapter, index) => {
    const r = a.rolls[index];
    return {
      index,
      name: chapter.name,
      block: chapter.heading >= 0 ? chapter.heading : chapter.first,
      words: r.words,
      speech: r.words ? r.speech / r.words : 0,
      sentence: r.sentences ? r.sentenceWords / r.sentences : 0,
      repeats: r.words ? (r.repeats / r.words) * 1000 : 0,
      long: r.sentences ? r.long / r.sentences : 0,
      marks: [],
    };
  });
  const judged = rows.filter((row) => row.words >= SMALL);
  if (judged.length < FEWEST) return rows;
  const spread = (pick: (row: ChapterRow) => number) => quartiles(judged.map(pick));
  const words = spread((row) => row.words);
  const speech = spread((row) => row.speech);
  const sentence = spread((row) => row.sentence);
  const repeats = spread((row) => row.repeats);
  const long = spread((row) => row.long);
  for (const row of judged) {
    const marks: { column: ChapterRow["marks"][number]["column"]; text: string; far: number }[] = [];
    const fence = (column: "words" | "speech" | "sentence", value: number, q: { q1: number; median: number; q3: number }, say: (high: boolean) => string) => {
      const reach = Math.max(1e-9, q.q3 - q.q1) * 1.5;
      if (value > q.q3 + reach) marks.push({ column, text: say(true), far: (value - q.q3) / reach });
      else if (value < q.q1 - reach) marks.push({ column, text: say(false), far: (q.q1 - value) / reach });
    };
    fence("words", row.words, words, (high) => `${num(row.words)} words, ${high ? "far more" : "far fewer"} than the usual ${num(words.median)}`);
    fence("sentence", row.sentence, sentence, (high) => `Sentences average ${one(row.sentence)} words, ${high ? "longer" : "shorter"} than the usual ${one(sentence.median)}`);
    if (a.fiction) fence("speech", row.speech, speech, (high) => `${Math.round(row.speech * 100)}% inside quote marks, ${high ? "far more" : "far less"} than the usual ${Math.round(speech.median * 100)}%`);
    const times = (column: "repeats" | "long", value: number, median: number, what: string) => {
      if (median > 0 && value >= median * 1.5) marks.push({ column, text: `${one(value / median)} times the book’s ${what}`, far: value / median / 1.5 });
    };
    times("repeats", row.repeats, repeats.median, "close repeats");
    times("long", row.long, long.median, "long sentences");
    row.marks = marks.sort((x, y) => y.far - x.far).map(({ column, text }) => ({ column, text }));
  }
  return rows;
}

/** The chapter table as a report (its rows travel beside it). */
export function buildChapters(rows: ChapterRow[]): ReportResult {
  const marked = rows.filter((row) => row.marks.length).length;
  const headline = rows.length < 2 ? "This text is one chapter." : marked ? `${num(rows.length)} chapters. ${num(marked)} stand apart from the rest.` : `${num(rows.length)} chapters, much alike.`;
  const notes = ["A chapter is marked where a number stands well apart from the same number in the other chapters. That is a place to look, not a fault."];
  if (rows.length < FEWEST) notes.push("With fewer than four chapters there is too little to compare.");
  return { id: "chapters", headline, summary: [], series: [], groups: [], notes };
}
