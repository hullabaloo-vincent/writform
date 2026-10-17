/**
 * A document's story plan, where it is kept: `Y.Map("plan")`, beside the
 * text and not in it. Everyone who writes the document shares it, it
 * travels with every copy (apps/documents/docMaps.ts), and an older app
 * simply never looks here.
 *
 * One thing a key (plan/model.ts), so two people changing different cards
 * at once both keep their change. The same card changed by two people at
 * once keeps the later change.
 *
 * Changes here are not part of the text's undo. Each write gives back an
 * `undo` that puts back what it changed, unless someone has changed that
 * since: the delete toasts offer it.
 */

import * as Y from "yjs";

import { newId } from "./ids";
import {
  cleanSetting,
  emptyPlan,
  encodeCard,
  encodeEntry,
  encodeEvent,
  encodeLine,
  LIMITS,
  planFromSnapshot,
  type Card,
  type CastEntry,
  type Plan,
  type PlanEvent,
  type PlotLine,
  type Primitive,
} from "./model";
import { between, byOrder, ORDER_LONG, spread } from "./order";

export const PLAN_MAP = "plan";

export function readPlan(doc: Y.Doc | null | undefined): Plan {
  if (!doc) return emptyPlan();
  return planFromSnapshot(doc.getMap(PLAN_MAP).toJSON() as Record<string, unknown>);
}

export function onPlanChange(doc: Y.Doc, fn: () => void): () => void {
  const map = doc.getMap(PLAN_MAP);
  map.observe(fn);
  return () => map.unobserve(fn);
}

export type Undo = () => void;
const nothing: Undo = () => {};

/** Run `fn`'s writes in one transaction, and give back their undo. */
function change(doc: Y.Doc, fn: (set: (key: string, value: string | Primitive | null) => void) => void): Undo {
  const map = doc.getMap(PLAN_MAP);
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  doc.transact(() => {
    fn((key, value) => {
      if (!before.has(key)) before.set(key, map.get(key));
      if (value === null) {
        if (map.has(key)) map.delete(key);
      } else if (map.get(key) !== value) map.set(key, value);
      after.set(key, map.get(key));
    });
  });
  return () => {
    doc.transact(() => {
      for (const [key, was] of before) {
        // Someone has changed it since: theirs stands.
        if (map.get(key) !== after.get(key)) continue;
        if (was === undefined) map.delete(key);
        else map.set(key, was as string);
      }
    });
  };
}

/** The writes. Each returns its undo, or null when it was refused (a
 *  limit reached). */
export function planOps(doc: Y.Doc) {
  const plan = () => readPlan(doc);

  /** Order keys for `items` grew long: spread them out again. */
  const respread = (set: (key: string, value: string) => void, items: { id: string; order: string }[], encode: (order: string, id: string) => string | null) => {
    const keys = spread(items.length);
    items.forEach((item, i) => {
      const value = encode(keys[i], item.id);
      if (value) set(item.id, value);
    });
  };

  const ops = {
    // -------------------------------------------------------- plot lines
    addLine(name: string, color: PlotLine["color"] = null): { id: string; undo: Undo } | null {
      const now = plan();
      if (now.lines.length >= LIMITS.lines) return null;
      const id = newId();
      const line: PlotLine = { id, name, color, order: between(now.lines.length ? now.lines[now.lines.length - 1].order : null, null) };
      return { id, undo: change(doc, (set) => set(`l:${id}`, encodeLine(line))) };
    },
    updateLine(line: PlotLine): Undo {
      return change(doc, (set) => set(`l:${line.id}`, encodeLine(line)));
    },
    /** Move a line to `index` among the lines. */
    moveLine(id: string, index: number): Undo {
      const lines = plan().lines;
      const line = lines.find((l) => l.id === id);
      if (!line) return nothing;
      const rest = lines.filter((l) => l.id !== id);
      const i = Math.max(0, Math.min(index, rest.length));
      const order = between(i > 0 ? rest[i - 1].order : null, i < rest.length ? rest[i].order : null);
      return change(doc, (set) => {
        if (order.length > ORDER_LONG) {
          const all = [...rest.slice(0, i), line, ...rest.slice(i)];
          respread((k, v) => set(`l:${k}`, v), all, (o, lid) => {
            const l = all.find((x) => x.id === lid);
            return l ? encodeLine({ ...l, order: o }) : null;
          });
        } else set(`l:${id}`, encodeLine({ ...line, order }));
      });
    },
    /** Delete a line. Its cards go with it, or (`keepCards`) stay without a
     *  line. */
    removeLine(id: string, keepCards: boolean): Undo {
      const now = plan();
      return change(doc, (set) => {
        set(`l:${id}`, null);
        for (const card of now.cards) {
          if (card.line !== id) continue;
          if (keepCards) set(`k:${card.id}`, encodeCard({ ...card, line: null }));
          else set(`k:${card.id}`, null);
        }
      });
    },

    // -------------------------------------------------------- cards
    /** A new card at `index` of the cell (line and chapter) it goes in. */
    addCard(fields: Partial<Omit<Card, "id" | "order">> & { line: string | null; chapter: string | null }, index = Infinity): { id: string; undo: Undo } | null {
      const now = plan();
      if (now.cards.length >= LIMITS.cards) return null;
      const id = newId();
      const cell = now.cards.filter((c) => c.line === fields.line && c.chapter === fields.chapter);
      const i = Math.max(0, Math.min(index, cell.length));
      const card: Card = {
        id,
        title: fields.title ?? "",
        text: fields.text ?? "",
        line: fields.line,
        chapter: fields.chapter,
        order: between(i > 0 ? cell[i - 1].order : null, i < cell.length ? cell[i].order : null),
        cast: fields.cast ?? [],
        done: fields.done ?? false,
      };
      return { id, undo: change(doc, (set) => set(`k:${id}`, encodeCard(card))) };
    },
    updateCard(card: Card): Undo {
      return change(doc, (set) => set(`k:${card.id}`, encodeCard(card)));
    },
    /** Move a card to a cell (line and chapter), before the card `before`
     *  there (null: at the cell's end). */
    moveCard(id: string, to: { line: string | null; chapter: string | null }, before: string | null = null): Undo {
      const now = plan();
      const card = now.cards.find((c) => c.id === id);
      if (!card) return nothing;
      const cell = now.cards.filter((c) => c.id !== id && c.line === to.line && c.chapter === to.chapter).sort(byOrder);
      const at = before ? cell.findIndex((c) => c.id === before) : -1;
      const i = at < 0 ? cell.length : at;
      const order = between(i > 0 ? cell[i - 1].order : null, i < cell.length ? cell[i].order : null);
      return change(doc, (set) => {
        if (order.length > ORDER_LONG) {
          const all = [...cell.slice(0, i), card, ...cell.slice(i)];
          respread((k, v) => set(`k:${k}`, v), all, (o, cid) => {
            const c = all.find((x) => x.id === cid);
            return c ? encodeCard({ ...c, ...(cid === id ? to : {}), order: o }) : null;
          });
        } else set(`k:${id}`, encodeCard({ ...card, ...to, order }));
      });
    },
    removeCard(id: string): Undo {
      const now = plan();
      return change(doc, (set) => {
        set(`k:${id}`, null);
        // An event put on the timeline from it stays, without it.
        for (const event of now.events) if (event.card === id) set(`e:${event.id}`, encodeEvent({ ...event, card: null }));
      });
    },

    // -------------------------------------------------------- cast and world
    addEntry(fields: Partial<Omit<CastEntry, "id" | "order">> & { name: string }): { id: string; undo: Undo } | null {
      const now = plan();
      if (now.cast.length >= LIMITS.cast) return null;
      const id = newId();
      const entry: CastEntry = {
        id,
        kind: fields.kind ?? "person",
        name: fields.name,
        aka: fields.aka ?? [],
        note: fields.note ?? "",
        color: fields.color ?? null,
        order: between(now.cast.length ? now.cast[now.cast.length - 1].order : null, null),
        anyCase: fields.anyCase ?? false,
      };
      return { id, undo: change(doc, (set) => set(`p:${id}`, encodeEntry(entry))) };
    },
    updateEntry(entry: CastEntry): Undo {
      return change(doc, (set) => set(`p:${entry.id}`, encodeEntry(entry)));
    },
    /** Delete an entry, and take it off the cards and events that name it. */
    removeEntry(id: string): Undo {
      const now = plan();
      return change(doc, (set) => {
        set(`p:${id}`, null);
        for (const card of now.cards) if (card.cast.includes(id)) set(`k:${card.id}`, encodeCard({ ...card, cast: card.cast.filter((c) => c !== id) }));
        for (const event of now.events) if (event.cast.includes(id)) set(`e:${event.id}`, encodeEvent({ ...event, cast: event.cast.filter((c) => c !== id) }));
      });
    },

    // -------------------------------------------------------- timeline
    /** A new event at `index` in story order. */
    addEvent(fields: Partial<Omit<PlanEvent, "id" | "order">>, index = Infinity): { id: string; undo: Undo } | null {
      const now = plan();
      if (now.events.length >= LIMITS.events) return null;
      const id = newId();
      const i = Math.max(0, Math.min(index, now.events.length));
      const event: PlanEvent = {
        id,
        title: fields.title ?? "",
        text: fields.text ?? "",
        order: between(i > 0 ? now.events[i - 1].order : null, i < now.events.length ? now.events[i].order : null),
        when: fields.when ?? "",
        date: fields.date ?? null,
        chapter: fields.chapter ?? null,
        cast: fields.cast ?? [],
        card: fields.card ?? null,
      };
      return { id, undo: change(doc, (set) => set(`e:${id}`, encodeEvent(event))) };
    },
    updateEvent(event: PlanEvent): Undo {
      return change(doc, (set) => set(`e:${event.id}`, encodeEvent(event)));
    },
    /** Move an event to `index` in story order. */
    moveEvent(id: string, index: number): Undo {
      const events = plan().events;
      const event = events.find((e) => e.id === id);
      if (!event) return nothing;
      const rest = events.filter((e) => e.id !== id);
      const i = Math.max(0, Math.min(index, rest.length));
      const order = between(i > 0 ? rest[i - 1].order : null, i < rest.length ? rest[i].order : null);
      return change(doc, (set) => {
        if (order.length > ORDER_LONG) {
          const all = [...rest.slice(0, i), event, ...rest.slice(i)];
          respread((k, v) => set(`e:${k}`, v), all, (o, eid) => {
            const e = all.find((x) => x.id === eid);
            return e ? encodeEvent({ ...e, order: o }) : null;
          });
        } else set(`e:${id}`, encodeEvent({ ...event, order }));
      });
    },
    /** Put the events in the order `ids` gives (a sort by date). */
    reorderEvents(ids: string[]): Undo {
      const events = plan().events;
      const keys = spread(ids.length);
      return change(doc, (set) => {
        ids.forEach((id, i) => {
          const event = events.find((e) => e.id === id);
          if (event && event.order !== keys[i]) set(`e:${id}`, encodeEvent({ ...event, order: keys[i] }));
        });
      });
    },
    removeEvent(id: string): Undo {
      return change(doc, (set) => set(`e:${id}`, null));
    },

    // -------------------------------------------------------- chapters
    /** Remember a chapter's title, for when its heading is gone. */
    noteChapter(cid: string, title: string): void {
      const value = JSON.stringify({ t: title.slice(0, 200) });
      const map = doc.getMap(PLAN_MAP);
      if (map.get(`c:${cid}`) !== value) map.set(`c:${cid}`, value);
    },
    /** Forget chapters nothing in the plan is in any more. */
    prune(): void {
      const now = plan();
      const used = new Set<string>();
      for (const c of now.cards) if (c.chapter) used.add(c.chapter);
      for (const e of now.events) if (e.chapter) used.add(e.chapter);
      const map = doc.getMap(PLAN_MAP);
      const stale = [...map.keys()].filter((k) => k.startsWith("c:") && !used.has(k.slice(2)));
      if (stale.length) doc.transact(() => stale.forEach((k) => map.delete(k)));
    },

    setting(name: string, value: Primitive | null): Undo {
      const clean = value === null ? null : (cleanSetting(name, value) ?? null);
      return change(doc, (set) => set(`s.${name}`, clean));
    },
  };
  return ops;
}

export type PlanOps = ReturnType<typeof planOps>;

/** Whether the plan has a record of this chapter id (the chapter id guard
 *  asks: a heading pasted back keeps its id only then). */
export const knowsChapter = (doc: Y.Doc, cid: string): boolean => doc.getMap(PLAN_MAP).has(`c:${cid}`);
