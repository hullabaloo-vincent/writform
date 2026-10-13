/**
 * The reports. Each is a view of one reading of the text for its style
 * (analysis.ts), so opening a second one costs next to nothing.
 */

import type { StyleAnalysis } from "./analysis";
import { buildChapters, chapterRows } from "./build/chapters";
import { buildDialogue } from "./build/dialogue";
import { buildOverview } from "./build/overview";
import { buildPace } from "./build/pace";
import { buildRepeats } from "./build/repeats";
import { buildSenses } from "./build/senses";
import { buildSentences } from "./build/sentences";
import { buildWording } from "./build/wording";
import type { ChapterRow, ReportId, ReportResult, Scope } from "./types";

export const REPORTS: { id: ReportId; label: string; about: string }[] = [
  { id: "overview", label: "Overview", about: "The text in a few numbers." },
  { id: "chapters", label: "Chapter by chapter", about: "Each chapter beside the others." },
  { id: "sentences", label: "Sentences", about: "How long they are, how they begin, where they fall into a pattern." },
  { id: "repeats", label: "Repeats", about: "Words and phrases the text comes back to." },
  { id: "wording", label: "Word choice", about: "Likely passives, words in -ly, filter words, worn and wordy phrases." },
  { id: "dialogue", label: "Dialogue", about: "Speech and the tags that carry it." },
  { id: "pace", label: "Pace", about: "Where the text runs quick and where it lingers, by its shape." },
  { id: "senses", label: "Senses", about: "Words that name sight, sound, touch, smell and taste." },
];

/** Kinds of document the reports read. (Verse repeats itself on purpose,
 *  and a script is not prose.) */
export const reportsFor = (format: string): boolean => format === "none" || format === "manuscript";

export interface ReportOptions {
  /** Include what is inside quote marks in the Word choice report. */
  speech?: boolean;
}

export function buildReport(id: ReportId, a: StyleAnalysis, scope: Scope, allowed: Set<string>, rows: ChapterRow[], options: ReportOptions = {}): ReportResult {
  if (id === "chapters") return buildChapters(rows);
  if (id === "wording") return buildWording(a, scope, allowed, options.speech ?? !a.fiction);
  if (id === "dialogue") return buildDialogue(a, scope);
  if (id === "pace") return buildPace(a, scope);
  if (id === "senses") return buildSenses(a, scope, allowed);
  if (id === "sentences") return buildSentences(a, scope);
  if (id === "repeats") return buildRepeats(a, scope, allowed);
  return buildOverview(a, scope);
}

export { chapterRows };
export type { StyleAnalysis };
