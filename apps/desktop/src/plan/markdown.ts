/**
 * A plan written out as Markdown: the plot lines, each chapter's cards by
 * line, the unassigned notes, the cast and world with where each appears,
 * and the timeline in story order. For pasting elsewhere, and for the
 * exports. Nothing here needs a window.
 */

import type { JSONContent } from "@tiptap/core";
import type * as Y from "yjs";

import { buildNameIndex, mentionsByColumn, type Mentions } from "./mentions";
import { isEmptyPlan, type Card, type Plan } from "./model";
import { readPlan } from "./planMap";
import { cellKey, columnNoun, placeCards, planColumns, type Columns } from "./resolve";
import { storyVsBook } from "./timeline";

export interface PlanSource {
  plan: Plan;
  columns: Columns | null;
  /** "chapter", "scene" or "section". */
  noun: string;
}

const line = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
/** A sentence after `text`: a full stop between them unless it ends in one. */
const then = (text: string, more: string) => `${text}${/[.!?…]$/.test(text) ? " " : ". "}${more}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function planToMarkdown(source: PlanSource, mentions: Mentions | null = null): string {
  const { plan, columns, noun } = source;
  const out: string[] = ["# Plan", ""];
  const castName = (id: string) => plan.cast.find((e) => e.id === id)?.name ?? "";
  const cardLine = (card: Card) => {
    const bits = [`- **${line(card.title) || "Untitled card"}**`];
    if (card.text) bits.push(`: ${line(card.text)}`);
    const cast = card.cast.map(castName).filter(Boolean);
    if (cast.length) bits.push(` (${cast.join(", ")})`);
    if (card.done) bits.push(" [written]");
    return bits.join("");
  };

  if (plan.lines.length) {
    out.push("## Plot lines", "");
    for (const l of plan.lines) out.push(`- ${l.name}`);
    out.push("");
  }

  const placed = columns ? placeCards(columns, plan) : null;
  if (columns && placed) {
    for (const column of columns.columns) {
      const rows = placed.rows.filter((r) => (placed.cells.get(cellKey(r.line?.id ?? null, column.key)) ?? []).length);
      if (!rows.length) continue;
      out.push(`## ${column.name}`, "");
      for (const row of rows) {
        if (placed.rows.length > 1 || row.line) out.push(`### ${row.line ? row.line.name : "No plot line"}`, "");
        for (const card of placed.cells.get(cellKey(row.line?.id ?? null, column.key)) ?? []) out.push(cardLine(card));
        out.push("");
      }
    }
  }
  const loose = placed ? placed.loose : plan.cards.filter((c) => !c.chapter);
  if (loose.length) {
    out.push("## Unassigned planning notes", "");
    for (const card of loose) out.push(cardLine(card));
    out.push("");
  }
  if (placed?.lost.length) {
    out.push(`## Cards whose ${noun} was deleted`, "");
    for (const card of placed.lost) out.push(`${cardLine(card)}${card.lostTitle ? ` (was in “${line(card.lostTitle)}”)` : ""}`);
    out.push("");
  }

  if (plan.cast.length) {
    out.push("## Cast and world", "");
    for (const [kind, heading] of [
      ["person", "People"],
      ["place", "Places"],
      ["thing", "Things"],
    ] as const) {
      const entries = plan.cast.filter((e) => e.kind === kind);
      if (!entries.length) continue;
      out.push(`### ${heading}`, "");
      for (const e of entries) {
        let text = `- **${e.name}**`;
        if (e.aka.length) text += ` (also called ${e.aka.join(", ")})`;
        if (e.note) text += `: ${line(e.note)}`;
        const m = mentions?.byEntry.get(e.id);
        if (m && columns && m.cols.size) {
          const where = [...m.cols.keys()].sort((a, b) => a - b).map((i) => columns.columns[i]?.name ?? "");
          text = then(text, `In ${where.filter(Boolean).join(", ")}.`);
        }
        out.push(text);
      }
      out.push("");
    }
  }

  if (plan.events.length) {
    const columnOf = (cid: string) => columns?.columns.findIndex((c) => c.cid === cid) ?? -1;
    out.push("## Timeline", "");
    storyVsBook(plan.events, columnOf).forEach((row, i) => {
      const e = row.event;
      let text = `${i + 1}. **${line(e.title) || "Untitled event"}**`;
      if (e.when || e.date) text += ` (${[e.when, e.date].filter(Boolean).join(", ")})`;
      if (e.text) text += `: ${line(e.text)}`;
      if (row.column >= 0 && columns) text = then(text, `Told in ${columns.columns[row.column].name}.`);
      else if (row.told === "untold") text = then(text, `Not in a ${noun}.`);
      if (row.told === "later") text += " Told out of order, later than it happens.";
      if (row.told === "earlier") text += " Told out of order, before it happens.";
      out.push(text);
    });
    out.push("");
  }

  if (out.length === 2) out.push(`${cap(noun)}s, cards and notes will appear here once the plan has some.`, "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** The plan of a document as stored (its Yjs state read into `ydoc`, its
 *  text as `json`), as Markdown. Null when it has none. */
export async function planMarkdownOf(ydoc: Y.Doc, json: JSONContent, format: string): Promise<string | null> {
  const plan = readPlan(ydoc);
  if (isEmptyPlan(plan)) return null;
  const [{ contentSchema }, { readBook }, { presetDesign }] = await Promise.all([import("../editor/schema/content"), import("../book/model/bookMap"), import("../book/model/presets")]);
  let columns: Columns | null = null;
  try {
    const doc = contentSchema().nodeFromJSON(json);
    columns = planColumns(doc, format, format === "manuscript" ? readBook(ydoc).design : presetDesign("classic"));
    const found = columns && plan.cast.length ? mentionsByColumn(doc, columns.columns, buildNameIndex(plan.cast)) : null;
    return planToMarkdown({ plan, columns, noun: columnNoun(format) }, found);
  } catch {
    return planToMarkdown({ plan, columns, noun: columnNoun(format) }, null);
  }
}
