/**
 * The plan laid against the text: the chapters (or scenes, or sections) as
 * columns, the parts or acts above them as bands, and every card in its
 * place. Columns always come from the text as it is now. A card names its
 * chapter by the heading's hidden id (editor/nodes/ChapterId.ts), so it
 * follows the chapter wherever the chapter goes.
 *
 * Nothing here needs a window.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { scanStructure, type EntryKind, type StructureEntry } from "../book/model/structure";
import type { BookDesign } from "../book/model/presets";
import { chapterIdAttr } from "../editor/nodes/ChapterId";
import type { Card, Plan, PlotLine } from "./model";
import { byOrder } from "./order";

export type PlanFormat = "manuscript" | "screenplay" | "stageplay" | "none";

/** Whether a document of this format has a plan. */
export const hasPlan = (format: string): format is PlanFormat => format === "manuscript" || format === "screenplay" || format === "stageplay" || format === "none";

/** What a column is called. */
export function columnNoun(format: string): string {
  if (format === "manuscript") return "chapter";
  if (format === "screenplay" || format === "stageplay") return "scene";
  return "section";
}

export interface PlanColumn {
  /** Stable while the heading has an id, else its place. */
  key: string;
  cid: string | null;
  /** Where the heading starts, and its top-level block. */
  pos: number;
  index: number;
  endIndex: number;
  kind: EntryKind;
  /** "Chapter Three · The fall", as the outline says it. */
  name: string;
  /** "Chapter Three", or "". */
  label: string;
  /** "The fall", or "". */
  title: string;
  words: number;
  /** The band it is under, or -1. */
  band: number;
  entry: StructureEntry;
}

export interface PlanBand {
  key: string;
  name: string;
  pos: number;
  /** The columns under it: from, to (exclusive). */
  from: number;
  to: number;
}

export interface Columns {
  columns: PlanColumn[];
  bands: PlanBand[];
  /** Words in the whole text. */
  total: number;
}

type Design = Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">;

const nameOf = (entry: StructureEntry): string => {
  const name = entry.title || (entry.literal === null ? entry.text : "") || "Untitled";
  if (entry.label && (entry.kind === "chapter" || entry.kind === "part")) return entry.literal !== null && !entry.title ? entry.label : `${entry.label} · ${name}`;
  return name;
};

/** The text's columns and bands. Null for a format without a plan. */
export function planColumns(doc: PmNode, format: string, design: Design): Columns | null {
  if (!hasPlan(format)) return null;
  const { entries, total } = scanStructure(doc, format, design, { words: true });
  let level = 1;
  if (format === "none") {
    // A Document: the shallowest heading level used twice, else the
    // shallowest there is.
    const counts = new Map<number, number>();
    for (const e of entries) counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
    const levels = [...counts.keys()].sort((a, b) => a - b);
    level = levels.find((l) => (counts.get(l) ?? 0) >= 2) ?? levels[0] ?? 0;
  }
  const bandLevel = format === "manuscript" || format === "stageplay" ? 0 : -1;
  const bands: PlanBand[] = [];
  const columns: PlanColumn[] = [];
  let band: { entry: StructureEntry; at: number } | null = null;
  for (const entry of entries) {
    if (entry.level === bandLevel && entry.level !== level) {
      if (band) bands.push({ key: `b${band.entry.index}`, name: nameOf(band.entry), pos: band.entry.pos, from: band.at, to: columns.length });
      band = { entry, at: columns.length };
      continue;
    }
    if (entry.level !== level) continue;
    const node = doc.child(entry.index);
    const cid = chapterIdAttr(node.attrs.cid);
    const inBand = band && entry.index < band.entry.endIndex ? bands.length : -1;
    columns.push({
      key: cid ?? `p${entry.index}`,
      cid,
      pos: entry.pos,
      index: entry.index,
      endIndex: entry.endIndex,
      kind: entry.kind,
      name: nameOf(entry),
      label: entry.label,
      title: entry.title || (entry.literal === null ? entry.text : ""),
      words: entry.words,
      band: inBand,
      entry,
    });
  }
  if (band) bands.push({ key: `b${band.entry.index}`, name: nameOf(band.entry), pos: band.entry.pos, from: band.at, to: columns.length });
  // A band with nothing under it says nothing.
  const kept = bands.filter((b) => b.to > b.from);
  if (kept.length !== bands.length) {
    for (const c of columns) c.band = c.band < 0 ? -1 : kept.indexOf(bands[c.band]);
  }
  // If two headings carry one id (two documents combined, say), the first
  // keeps it here.
  const seen = new Set<string>();
  for (const c of columns) {
    if (!c.cid) continue;
    if (seen.has(c.cid)) {
      c.cid = null;
      c.key = `p${c.index}`;
    } else seen.add(c.cid);
  }
  return { columns, bands: kept, total };
}

/** A card whose chapter is gone, with the chapter's name when last seen. */
export interface LostCard extends Card {
  lostTitle: string;
}

export interface Placed {
  /** The rows: the plot lines, and "no plot line" when a card has none. */
  rows: { line: PlotLine | null; key: string }[];
  /** `row key|column key` → the cards there, in order. */
  cells: Map<string, Card[]>;
  /** Cards not in a chapter. */
  loose: Card[];
  /** Cards whose chapter isn't in the text any more. */
  lost: LostCard[];
  /** Cards in each column. */
  perColumn: Map<string, number>;
}

export const cellKey = (line: string | null, column: string): string => `${line ?? ""}|${column}`;

/** Every card in its place. */
export function placeCards(columns: Columns, plan: Plan): Placed {
  const byCid = new Map<string, PlanColumn>();
  for (const c of columns.columns) if (c.cid) byCid.set(c.cid, c);
  const cells = new Map<string, Card[]>();
  const loose: Card[] = [];
  const lost: LostCard[] = [];
  const perColumn = new Map<string, number>();
  let lineless = false;
  for (const card of [...plan.cards].sort(byOrder)) {
    if (!card.chapter) {
      loose.push(card);
      continue;
    }
    const column = byCid.get(card.chapter);
    if (!column) {
      lost.push({ ...card, lostTitle: plan.chapters[card.chapter]?.title ?? "" });
      continue;
    }
    if (!card.line) lineless = true;
    const key = cellKey(card.line, column.key);
    const list = cells.get(key);
    if (list) list.push(card);
    else cells.set(key, [card]);
    perColumn.set(column.key, (perColumn.get(column.key) ?? 0) + 1);
  }
  const rows: Placed["rows"] = plan.lines.map((line) => ({ line, key: line.id }));
  if (lineless) rows.push({ line: null, key: "" });
  return { rows, cells, loose, lost, perColumn };
}

/** Chapters whose remembered title is not their title now (renamed in
 *  the text): cid and title, to remember again. */
export function staleTitles(columns: Columns, plan: Plan): [string, string][] {
  const out: [string, string][] = [];
  for (const c of columns.columns) {
    if (!c.cid) continue;
    const rec = plan.chapters[c.cid];
    const title = c.title || c.name;
    if (rec && rec.title !== title) out.push([c.cid, title]);
  }
  return out;
}

/** Lost cards whose chapter's name is a column's title now: where they
 *  likely belong (a book published to an older server and back). */
export function attachByTitle(columns: Columns, lost: LostCard[]): Map<string, PlanColumn> {
  const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const byTitle = new Map<string, PlanColumn | null>();
  for (const c of columns.columns) {
    for (const name of [c.title, c.name]) {
      const key = fold(name);
      if (!key) continue;
      byTitle.set(key, byTitle.has(key) && byTitle.get(key) !== c ? null : c);
    }
  }
  const out = new Map<string, PlanColumn>();
  for (const card of lost) {
    const column = byTitle.get(fold(card.lostTitle));
    if (column) out.set(card.id, column);
  }
  return out;
}

/** Whether a card matches a search (words in its title, its text, its plot
 *  line's name or its cast's names), ignoring case and accents. */
export function cardMatches(card: Card, query: string, plan: Plan): boolean {
  const words = foldSearch(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const line = plan.lines.find((l) => l.id === card.line)?.name ?? "";
  const cast = card.cast.map((id) => plan.cast.find((e) => e.id === id)?.name ?? "").join(" ");
  const hay = foldSearch(`${card.title} ${card.text} ${line} ${cast}`);
  return words.every((w) => hay.includes(w));
}

/** Accents, once letters are taken apart from them. */
const MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

export function foldSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
