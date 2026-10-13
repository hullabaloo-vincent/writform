/**
 * The reports as plain text, for an editor to send to an author: what was
 * counted, chapter by chapter, with the places said in words and not in
 * positions (nobody else has this document's positions). Lines are kept
 * under 78 characters so it reads the same in any mail.
 */

import type { ChapterRow, ReportResult } from "./types";

const WIDTH = 78;
const num = (n: number): string => Math.round(n).toLocaleString("en-US");
const one = (n: number): string => (Math.round(n * 10) / 10).toLocaleString("en-US");

function wrap(text: string, indent = ""): string[] {
  const out: string[] = [];
  let line = indent;
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > WIDTH && line.trim()) {
      out.push(line.trimEnd());
      line = indent;
    }
    line += `${line.trim() ? " " : ""}${word}`;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out;
}

const head = (text: string): string[] => ["", text, "-".repeat(Math.min(WIDTH, text.length))];
const fit = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

export interface ReportPack {
  title: string;
  /** What the reports cover, in words ("The whole book"). */
  scope: string;
  /** The day it was made, in words. */
  date: string;
  reports: ReportResult[];
  rows: ChapterRow[];
}

export function reportText(pack: ReportPack): string {
  const lines: string[] = [];
  const by = (id: string) => pack.reports.find((r) => r.id === id);
  lines.push(`A report on “${pack.title}”`, `${pack.scope}. ${pack.date}.`);

  const overview = by("overview");
  if (overview?.summary.length) {
    lines.push(...head("At a glance"));
    for (const m of overview.summary) lines.push(`${fit(m.label, 22)}${m.text}`);
    for (const m of overview.summary) if (m.guide) lines.push(...wrap(`${m.label}: ${m.guide.note} A guide and not a rule. (${m.guide.source}.)`));
  }

  if (pack.rows.length > 1) {
    lines.push(...head("Chapter by chapter"));
    lines.push(`${fit("Chapter", 34)}${"Words".padStart(8)}${"Speech".padStart(9)}${"Sentence".padStart(10)}`);
    for (const row of pack.rows) lines.push(`${fit(row.name, 34)}${num(row.words).padStart(8)}${`${Math.round(row.speech * 100)}%`.padStart(9)}${one(row.sentence).padStart(10)}`);
    const marked = pack.rows.filter((row) => row.marks.length);
    if (marked.length) {
      lines.push("", "Chapters that stand apart from the rest:");
      for (const row of marked) lines.push(...wrap(`${row.name}: ${row.marks.map((m) => m.text).join(". ")}.`, "  "));
    }
  }

  for (const id of ["sentences", "repeats", "wording", "dialogue"]) {
    const report = by(id);
    if (!report || (!report.groups.length && !report.summary.length)) continue;
    const name = id === "sentences" ? "Sentences" : id === "repeats" ? "Repeats" : id === "wording" ? "Word choice" : "Dialogue";
    lines.push(...head(name));
    lines.push(...wrap(report.headline));
    for (const m of report.summary) lines.push(`${fit(m.label, 22)}${m.text}`);
    for (const group of report.groups) {
      lines.push("", `${group.label} (${num(group.count)})`);
      for (const item of group.items.slice(0, 12)) lines.push(...wrap(`${item.label}${item.detail ? `, ${item.detail}` : ""}`, "  "));
      if (group.items.length > 12) lines.push(`  and ${num(group.items.length - 12)} more`);
    }
  }
  lines.push("", ...wrap("These are counts and not rules. Each is a place to look, for the writer to judge."));
  return `${lines.join("\n")}\n`;
}
