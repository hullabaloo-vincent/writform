/**
 * What a report says: numbers (`Measure`), things to draw (`Series`), and
 * places in the text grouped by what they are (`HitGroup`). Plain data.
 */

export type ReportId = "overview" | "chapters" | "sentences" | "repeats" | "wording" | "dialogue" | "pace" | "senses";

/** What a report covers: everything, one chapter, or a run of paragraphs. */
export type Scope = { kind: "all" } | { kind: "chapter"; index: number } | { kind: "blocks"; from: number; to: number };

export interface Guide {
  lo: number;
  hi: number;
  state: "in" | "above" | "below";
  /** What the range is ("Clear writing averages 15 to 20 words a sentence."). */
  note: string;
  /** Who says so. */
  source: string;
}

export interface Measure {
  id: string;
  label: string;
  value: number;
  /** The value as it is shown ("14 words"). */
  text: string;
  guide?: Guide;
}

/** A stretch of one block's text. */
export interface Hit {
  block: number;
  start: number;
  end: number;
  /** What Fix would change here, in offsets of the block's text. */
  fix?: { start: number; end: number; text: string }[];
}

export interface Series {
  id: string;
  /** `map`: stretches of the text in order, each one of a few kinds (its
   *  value is which, `labels` their names). */
  kind: "strip" | "histogram" | "bars" | "map";
  label: string;
  values: number[];
  /** A name for each value (bars, histogram). */
  labels?: string[];
  /** Where each value is in the text (a strip): tap to go there. */
  at?: Hit[];
  /** Drawn lighter (a strip's speech). */
  light?: boolean[];
  /** How many things each value stands for (a strip of a long text). */
  per?: number;
}

export interface HitItem {
  /** What it is about, for "this is fine" (a word, in lowercase), or "". */
  key: string;
  label: string;
  detail?: string;
  count: number;
  hits: Hit[];
  /** What each fix would write, when its places can be fixed. */
  to?: string;
}

export interface HitGroup {
  id: string;
  label: string;
  hint: string;
  count: number;
  items: HitItem[];
}

export interface ReportResult {
  id: ReportId;
  /** One line for the list of reports. */
  headline: string;
  summary: Measure[];
  series: Series[];
  groups: HitGroup[];
  notes: string[];
}

/** One row of the chapter table. */
export interface ChapterRow {
  index: number;
  name: string;
  /** The block its heading is (to go there), or its first block. */
  block: number;
  words: number;
  /** Share of the words inside speech, 0 to 1. */
  speech: number;
  /** Words in the average sentence. */
  sentence: number;
  /** Close repeats in every 1,000 words. */
  repeats: number;
  /** Share of sentences over 30 words, 0 to 1. */
  long: number;
  /** What stands out against the rest of the book, the most striking first. */
  marks: { column: "words" | "speech" | "sentence" | "repeats" | "long"; text: string }[];
}
