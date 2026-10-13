import { scopeRoll, type StyleAnalysis } from "../analysis";
import { sentenceGuide } from "../guides";
import type { Measure, ReportResult, Scope } from "../types";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const one = (n: number): string => (Math.round(n * 10) / 10).toLocaleString("en-US");

/** The Flesch-Kincaid grade: a United States school year. A public
 *  formula of sentence length and syllables. */
export function readingGrade(words: number, sentences: number, syllables: number): number {
  if (!words || !sentences) return 0;
  return Math.max(0, 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59);
}

/** The text in a few numbers. */
export function buildOverview(a: StyleAnalysis, scope: Scope): ReportResult {
  const r = scopeRoll(a, scope);
  const average = r.sentences ? r.sentenceWords / r.sentences : 0;
  const summary: Measure[] = [
    { id: "words", label: "Words", value: r.words, text: num(r.words) },
    { id: "sentences", label: "Sentences", value: r.sentences, text: num(r.sentences) },
    { id: "paragraphs", label: "Paragraphs", value: r.paragraphs, text: num(r.paragraphs) },
  ];
  if (r.sentences) summary.push({ id: "sentence", label: "Average sentence", value: average, text: `${one(average)} words`, guide: sentenceGuide(average, a.fiction) });
  const notes: string[] = [];
  if (a.english && r.sentences) {
    const grade = readingGrade(r.sentenceWords, r.sentences, r.words ? (r.syllables * r.sentenceWords) / r.words : 0);
    summary.push({ id: "grade", label: "Reading grade", value: grade, text: one(grade) });
    notes.push("The reading grade is the Flesch-Kincaid formula, a school year in the United States. It knows how long the sentences are and how many syllables the words have, and nothing else.");
  }
  if (r.words) summary.push({ id: "speech", label: "Inside quote marks", value: r.speech / r.words, text: `${Math.round((r.speech / r.words) * 100)}%` });
  if (a.fiction) notes.push("No usual range is given for fiction. Compare your chapters with each other.");
  return { id: "overview", headline: r.words ? `${num(r.words)} words in ${num(r.sentences)} sentences.` : "Nothing to count yet.", summary, series: [], groups: [], notes };
}
