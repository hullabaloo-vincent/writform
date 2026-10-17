/**
 * The order things happen in the story against the order the book tells
 * them. The events are in story order (their own order keys). Where a
 * chapter tells an event, that chapter's place gives its book order. The
 * longest run of events whose chapters never go back is the story told
 * straight. An event outside it is told out of order:
 *
 * - "later": told after events that happen after it (a flashback)
 * - "earlier": told before events that happen before it (a flash forward)
 * - "untold": in no chapter
 * - "lost": its chapter is gone from the text
 *
 * Nothing here needs a window.
 */

import { cleanDate, type PlanEvent } from "./model";

export type Told = "inOrder" | "later" | "earlier" | "untold" | "lost";

export interface TimelineRow {
  event: PlanEvent;
  /** Its chapter's column index, or -1. */
  column: number;
  told: Told;
}

/** `columnOf(cid)`: the chapter's column index, or -1 when it is gone. */
export function storyVsBook(events: readonly PlanEvent[], columnOf: (cid: string) => number): TimelineRow[] {
  const rows: TimelineRow[] = events.map((event) => {
    if (!event.chapter) return { event, column: -1, told: "untold" };
    const column = columnOf(event.chapter);
    return { event, column, told: column < 0 ? "lost" : "inOrder" };
  });
  // The longest run, in story order, whose chapters never go back.
  const told = rows.map((r, i) => ({ i, col: r.column })).filter((r) => r.col >= 0);
  const n = told.length;
  const best = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let a = 0; a < n; a += 1) {
    for (let b = 0; b < a; b += 1) {
      if (told[b].col <= told[a].col && best[b] + 1 > best[a]) {
        best[a] = best[b] + 1;
        prev[a] = b;
      }
    }
  }
  let end = -1;
  for (let a = 0; a < n; a += 1) if (end < 0 || best[a] > best[end]) end = a;
  const straight = new Set<number>();
  for (let a = end; a >= 0; a = prev[a]) straight.add(told[a].i);
  for (const t of told) {
    if (straight.has(t.i)) continue;
    // Told after things that happen after it (a flashback), or before
    // things that happen before it (a flash forward).
    const afterLaterOnes = told.some((o) => o.i > t.i && straight.has(o.i) && o.col < t.col);
    const beforeEarlierOnes = told.some((o) => o.i < t.i && straight.has(o.i) && o.col > t.col);
    rows[t.i].told = afterLaterOnes ? "later" : beforeEarlierOnes ? "earlier" : "later";
  }
  return rows;
}

/** A date as a sortable number: year, month, day (a year alone is its
 *  first day). */
export function dateValue(date: string | null): number | null {
  const clean = cleanDate(date);
  if (!clean) return null;
  const neg = clean.startsWith("-");
  const [y, m = "01", d = "01"] = (neg ? clean.slice(1) : clean).split("-");
  const year = Number(y) * (neg ? -1 : 1);
  return year * 10000 + Number(m) * 100 + Number(d);
}

/** The events sorted by their dates. An event without one stays after the
 *  event it followed. Gives the ids in their new order. */
export function sortByDate(events: readonly PlanEvent[]): string[] {
  const dated = events.filter((e) => dateValue(e.date) !== null).sort((a, b) => (dateValue(a.date) as number) - (dateValue(b.date) as number));
  const out: string[] = [];
  const placed = new Set<string>();
  // Undated events follow the dated event they came after.
  const after = new Map<string | null, string[]>();
  let last: string | null = null;
  for (const e of events) {
    if (dateValue(e.date) !== null) last = e.id;
    else {
      const list = after.get(last) ?? [];
      list.push(e.id);
      after.set(last, list);
    }
  }
  for (const id of after.get(null) ?? []) {
    out.push(id);
    placed.add(id);
  }
  for (const e of dated) {
    out.push(e.id);
    for (const id of after.get(e.id) ?? []) if (!placed.has(id)) out.push(id);
  }
  return out;
}
