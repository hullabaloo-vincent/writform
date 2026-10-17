/**
 * What a story plan holds, as the app reads it. Everything is read through
 * the cleaners here: a value that isn't what it should be is left out, text
 * is trimmed and cut to its length, and fields this build doesn't know are
 * kept (`extra`) so that a newer build's data survives an older one's
 * changes.
 *
 * Stored in the document's `plan` map (plan/planMap.ts), one key a thing,
 * each value a short JSON string:
 *
 *   l:<id>   a plot line   {n name, c color, o order}
 *   k:<id>   a card        {t title, n text, l line, ch chapter, o order, p cast, done}
 *   p:<id>   cast or world {k kind, n name, a other names, x note, c color, o order, ac any case}
 *   e:<id>   an event      {t title, n text, o story order, w when, d date, ch chapter, p cast, k card}
 *   c:<cid>  a chapter     {t last title}
 *   s.<name> a setting     (a plain value)
 *
 * Nothing here needs a window.
 */

import { isPlanId } from "./ids";
import { byOrder } from "./order";

export type PlanColor = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
export const PLAN_COLORS: readonly PlanColor[] = ["a", "b", "c", "d", "e", "f", "g", "h"];
export const COLOR_NAMES: Record<PlanColor, string> = { a: "Red", b: "Orange", c: "Yellow", d: "Green", e: "Teal", f: "Blue", g: "Purple", h: "Gray" };

export type CastKind = "person" | "place" | "thing";
export const CAST_KINDS: readonly CastKind[] = ["person", "place", "thing"];

type Extra = Record<string, unknown>;

export interface PlotLine {
  id: string;
  name: string;
  color: PlanColor | null;
  order: string;
  extra?: Extra;
}

export interface Card {
  id: string;
  title: string;
  text: string;
  /** Its plot line, or null. */
  line: string | null;
  /** Its chapter's hidden id, or null (not in a chapter yet). */
  chapter: string | null;
  order: string;
  /** Cast and world entries it names. */
  cast: string[];
  done: boolean;
  extra?: Extra;
}

export interface CastEntry {
  id: string;
  kind: CastKind;
  name: string;
  /** Other names it goes by. */
  aka: string[];
  note: string;
  color: PlanColor | null;
  order: string;
  /** Found in the text whatever its capitals. */
  anyCase: boolean;
  extra?: Extra;
}

export interface PlanEvent {
  id: string;
  title: string;
  text: string;
  /** Where it falls in the story (the timeline's own order). */
  order: string;
  /** When it happens, in the writer's words ("Day 3", "That winter"). */
  when: string;
  /** A date to sort by: a year, year-month or year-month-day. */
  date: string | null;
  chapter: string | null;
  cast: string[];
  /** The card it was put on the timeline from. */
  card: string | null;
  extra?: Extra;
}

export interface ChapterRec {
  /** The chapter's title when last seen. */
  title: string;
}

export type Primitive = string | number | boolean;

export interface Plan {
  lines: PlotLine[];
  cards: Card[];
  cast: CastEntry[];
  events: PlanEvent[];
  chapters: Record<string, ChapterRec>;
  settings: Record<string, Primitive>;
}

export const LIMITS = { lines: 40, cards: 1200, cast: 400, events: 600, chapters: 600, settings: 20 } as const;
export const LENGTHS = { name: 80, title: 200, cardText: 2000, note: 4000, eventText: 1000, when: 40, aka: 12, cast: 30 } as const;
/** The longest JSON value read for one thing. */
export const VALUE_MAX = 20000;

export const emptyPlan = (): Plan => ({ lines: [], cards: [], cast: [], events: [], chapters: {}, settings: {} });

// ------------------------------------------------------------ cleaning

/** Text as kept: no control characters (but line breaks in longer text),
 *  trimmed, cut to `max`. */
export function cleanText(value: unknown, max: number, lines = false): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 && !(lines && ch === "\n")) continue;
    if (code === 127) continue;
    out += ch;
  }
  out = out.trim();
  if (out.length > max) out = out.slice(0, max).trimEnd();
  return out;
}

const color = (value: unknown): PlanColor | null => (typeof value === "string" && (PLAN_COLORS as readonly string[]).includes(value) ? (value as PlanColor) : null);
const ref = (value: unknown): string | null => (isPlanId(value) ? value : null);
const order = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= 200 && /^[0-9A-Za-z]+$/.test(value) ? value : null);
const ids = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) if (isPlanId(v) && !out.includes(v) && out.length < max) out.push(v);
  return out;
};
const DATE = /^-?\d{1,6}(-\d\d(-\d\d)?)?$/;
export const cleanDate = (value: unknown): string | null => (typeof value === "string" && DATE.test(value) ? value : null);

/** What `raw` holds beyond `known` keys. */
const extraOf = (raw: Record<string, unknown>, known: readonly string[]): Extra | undefined => {
  let out: Extra | undefined;
  for (const [k, v] of Object.entries(raw)) {
    if (known.includes(k)) continue;
    (out ??= {})[k] = v;
  }
  return out;
};

const LINE_KEYS = ["n", "c", "o"] as const;
const CARD_KEYS = ["t", "n", "l", "ch", "o", "p", "done"] as const;
const CAST_KEYS = ["k", "n", "a", "x", "c", "o", "ac"] as const;
const EVENT_KEYS = ["t", "n", "o", "w", "d", "ch", "p", "k"] as const;

export function decodeLine(id: string, raw: Record<string, unknown>): PlotLine | null {
  const name = cleanText(raw.n, LENGTHS.name);
  const o = order(raw.o);
  if (!name || !o) return null;
  return { id, name, color: color(raw.c), order: o, extra: extraOf(raw, LINE_KEYS) };
}

export function decodeCard(id: string, raw: Record<string, unknown>): Card | null {
  const o = order(raw.o);
  if (!o) return null;
  return {
    id,
    title: cleanText(raw.t, LENGTHS.title),
    text: cleanText(raw.n, LENGTHS.cardText, true),
    line: ref(raw.l),
    chapter: ref(raw.ch),
    order: o,
    cast: ids(raw.p, LENGTHS.cast),
    done: raw.done === true,
    extra: extraOf(raw, CARD_KEYS),
  };
}

export function decodeEntry(id: string, raw: Record<string, unknown>): CastEntry | null {
  const name = cleanText(raw.n, LENGTHS.name);
  const o = order(raw.o);
  if (!name || !o) return null;
  const kind = (CAST_KINDS as readonly unknown[]).includes(raw.k) ? (raw.k as CastKind) : "person";
  const aka: string[] = [];
  if (Array.isArray(raw.a)) {
    for (const a of raw.a) {
      const clean = cleanText(a, LENGTHS.name);
      if (clean && clean !== name && !aka.includes(clean) && aka.length < LENGTHS.aka) aka.push(clean);
    }
  }
  return { id, kind, name, aka, note: cleanText(raw.x, LENGTHS.note, true), color: color(raw.c), order: o, anyCase: raw.ac === true, extra: extraOf(raw, CAST_KEYS) };
}

export function decodeEvent(id: string, raw: Record<string, unknown>): PlanEvent | null {
  const o = order(raw.o);
  if (!o) return null;
  return {
    id,
    title: cleanText(raw.t, LENGTHS.title),
    text: cleanText(raw.n, LENGTHS.eventText, true),
    order: o,
    when: cleanText(raw.w, LENGTHS.when),
    date: cleanDate(raw.d),
    chapter: ref(raw.ch),
    cast: ids(raw.p, LENGTHS.cast),
    card: ref(raw.k),
    extra: extraOf(raw, EVENT_KEYS),
  };
}

// ------------------------------------------------------------ writing

/** Drop empty and default fields: the stored value stays small. */
const tidy = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
};

export const encodeLine = (l: PlotLine): string => JSON.stringify(tidy({ ...l.extra, n: cleanText(l.name, LENGTHS.name), c: l.color, o: l.order }));

export const encodeCard = (c: Card): string =>
  JSON.stringify(
    tidy({ ...c.extra, t: cleanText(c.title, LENGTHS.title), n: cleanText(c.text, LENGTHS.cardText, true), l: c.line, ch: c.chapter, o: c.order, p: c.cast.slice(0, LENGTHS.cast), done: c.done }),
  );

export const encodeEntry = (e: CastEntry): string =>
  JSON.stringify(
    tidy({
      ...e.extra,
      k: e.kind === "person" ? null : e.kind,
      n: cleanText(e.name, LENGTHS.name),
      a: e.aka.map((a) => cleanText(a, LENGTHS.name)).filter(Boolean).slice(0, LENGTHS.aka),
      x: cleanText(e.note, LENGTHS.note, true),
      c: e.color,
      o: e.order,
      ac: e.anyCase,
    }),
  );

export const encodeEvent = (e: PlanEvent): string =>
  JSON.stringify(
    tidy({
      ...e.extra,
      t: cleanText(e.title, LENGTHS.title),
      n: cleanText(e.text, LENGTHS.eventText, true),
      o: e.order,
      w: cleanText(e.when, LENGTHS.when),
      d: cleanDate(e.date),
      ch: e.chapter,
      p: e.cast.slice(0, LENGTHS.cast),
      k: e.card,
    }),
  );

// ------------------------------------------------------------ settings

/** Shared settings, each with what it may be. (A person's own choices, such
 *  as how wide a column is, stay on their device.) */
const SETTINGS: Record<string, (v: unknown) => Primitive | undefined> = {};

export function cleanSetting(name: string, value: unknown): Primitive | undefined {
  return SETTINGS[name]?.(value);
}

// ------------------------------------------------------------ reading

/** The plan in a plain copy of its map. Every client reads the same things
 *  in the same way: keys in order, at most so many of each kind. */
export function planFromSnapshot(snapshot: Record<string, unknown> | undefined): Plan {
  const out = emptyPlan();
  const keys = Object.keys(snapshot ?? {}).sort();
  const parse = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== "string" || value.length > VALUE_MAX) return null;
    try {
      const raw = JSON.parse(value) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  let chapters = 0;
  let settings = 0;
  for (const key of keys) {
    const value = (snapshot as Record<string, unknown>)[key];
    if (key.startsWith("s.")) {
      if (settings >= LIMITS.settings) continue;
      const clean = cleanSetting(key.slice(2), value);
      if (clean !== undefined) {
        out.settings[key.slice(2)] = clean;
        settings += 1;
      }
      continue;
    }
    const kind = key.slice(0, 2);
    const id = key.slice(2);
    if (!isPlanId(id)) continue;
    const raw = parse(value);
    if (!raw) continue;
    if (kind === "l:" && out.lines.length < LIMITS.lines) {
      const line = decodeLine(id, raw);
      if (line) out.lines.push(line);
    } else if (kind === "k:" && out.cards.length < LIMITS.cards) {
      const card = decodeCard(id, raw);
      if (card) out.cards.push(card);
    } else if (kind === "p:" && out.cast.length < LIMITS.cast) {
      const entry = decodeEntry(id, raw);
      if (entry) out.cast.push(entry);
    } else if (kind === "e:" && out.events.length < LIMITS.events) {
      const event = decodeEvent(id, raw);
      if (event) out.events.push(event);
    } else if (kind === "c:" && chapters < LIMITS.chapters) {
      out.chapters[id] = { title: cleanText(raw.t, LENGTHS.title) };
      chapters += 1;
    }
  }
  // A card or event names only lines and entries that are there.
  const lines = new Set(out.lines.map((l) => l.id));
  const cast = new Set(out.cast.map((e) => e.id));
  for (const card of out.cards) {
    if (card.line && !lines.has(card.line)) card.line = null;
    card.cast = card.cast.filter((id) => cast.has(id));
  }
  const cards = new Set(out.cards.map((c) => c.id));
  for (const event of out.events) {
    event.cast = event.cast.filter((id) => cast.has(id));
    if (event.card && !cards.has(event.card)) event.card = null;
  }
  out.lines.sort(byOrder);
  out.cards.sort(byOrder);
  out.cast.sort(byOrder);
  out.events.sort(byOrder);
  return out;
}

export const isEmptyPlan = (plan: Plan): boolean => !plan.lines.length && !plan.cards.length && !plan.cast.length && !plan.events.length;
