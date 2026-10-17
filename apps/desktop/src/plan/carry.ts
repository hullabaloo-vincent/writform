/**
 * Keeping the plan's ties to chapters where the text is rebuilt rather than
 * edited: a version put back, and documents combined into one. Nothing here
 * needs a window.
 */

import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";

import { chapterIdAttr } from "../editor/nodes/ChapterId";
import { newId } from "./ids";
import { encodeCard, encodeEntry, encodeEvent, encodeLine, LIMITS, planFromSnapshot, type Plan } from "./model";
import { between } from "./order";

const textOf = (node: JSONContent): string => (node.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : textOf(c))).join("");
const keyOfJson = (node: JSONContent): string => `${node.type}|${(node.attrs?.element as string | null) ?? ""}|${textOf(node).trim()}`;
const keyOfNode = (node: PmNode): string => `${node.type.name}|${(node.attrs.element as string | null) ?? ""}|${node.textContent.trim()}`;

/**
 * A version being put back, given the chapter ids the text has now: a
 * heading in it without an id takes the id of the heading of the same kind
 * and words that has one now (an earlier version was saved before its
 * chapter was planned). Otherwise putting it back would take every
 * chapter's cards away.
 */
export function carryChapterIds(current: PmNode, target: JSONContent): JSONContent {
  const byKey = new Map<string, string[]>();
  const inTarget = new Set<string>();
  current.forEach((node) => {
    const cid = chapterIdAttr(node.attrs.cid);
    if (!cid) return;
    const key = keyOfNode(node);
    const list = byKey.get(key);
    if (list) list.push(cid);
    else byKey.set(key, [cid]);
  });
  if (!byKey.size) return target;
  for (const block of target.content ?? []) {
    const cid = chapterIdAttr(block.attrs?.cid);
    if (cid) inTarget.add(cid);
  }
  const content = (target.content ?? []).map((block) => {
    if ((block.type !== "paragraph" && block.type !== "heading") || chapterIdAttr(block.attrs?.cid)) return block;
    const list = byKey.get(keyOfJson(block));
    while (list?.length && inTarget.has(list[0])) list.shift();
    const cid = list?.shift();
    if (!cid) return block;
    inTarget.add(cid);
    return { ...block, attrs: { ...block.attrs, cid } };
  });
  return { ...target, content };
}

export interface CombinePart {
  json: JSONContent;
  /** The source's plan map, as a plain copy. */
  plan?: Record<string, unknown>;
}

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Documents combined into one: each source's chapter ids kept where they
 * are unique (a document combined twice gets new ones the second time, its
 * cards following), or taken out when the result can't hold them (`keepIds`
 * false: a server not yet updated). Their plans become one: plot lines and
 * cast entries of the same name are one, everything else follows in the
 * sources' order. Gives the sources' text and the plan map to start with.
 */
export function combinePlans(parts: CombinePart[], keepIds: boolean): { jsons: JSONContent[]; plan: Record<string, string> | null; left: number } {
  const used = new Set<string>();
  const jsons: JSONContent[] = [];
  const out: Plan = { lines: [], cards: [], cast: [], events: [], chapters: {}, settings: {} };
  let left = 0;
  for (const part of parts) {
    // Chapter ids: kept when new, made anew when already used.
    const ids = new Map<string, string | null>();
    const walk = (node: JSONContent): JSONContent => {
      const cid = chapterIdAttr(node.attrs?.cid);
      let next = node;
      if (cid) {
        let to = ids.get(cid);
        if (to === undefined) {
          to = !keepIds ? null : used.has(cid) ? newId() : cid;
          ids.set(cid, to);
          if (to) used.add(to);
        }
        next = { ...node, attrs: { ...node.attrs, cid: to } };
      }
      return next.content ? { ...next, content: next.content.map(walk) } : next;
    };
    jsons.push(walk(part.json));

    const plan = planFromSnapshot(part.plan);
    const lineMap = new Map<string, string>();
    for (const line of plan.lines) {
      const same = out.lines.find((l) => fold(l.name) === fold(line.name));
      if (same) lineMap.set(line.id, same.id);
      else if (out.lines.length < LIMITS.lines) {
        const id = out.lines.some((l) => l.id === line.id) ? newId() : line.id;
        out.lines.push({ ...line, id, order: between(out.lines.length ? out.lines[out.lines.length - 1].order : null, null) });
        lineMap.set(line.id, id);
      } else left += 1;
    }
    const castMap = new Map<string, string>();
    for (const entry of plan.cast) {
      const same = out.cast.find((e) => fold(e.name) === fold(entry.name));
      if (same) {
        for (const a of entry.aka) if (!same.aka.includes(a) && a !== same.name) same.aka.push(a);
        castMap.set(entry.id, same.id);
      } else if (out.cast.length < LIMITS.cast) {
        const id = out.cast.some((e) => e.id === entry.id) ? newId() : entry.id;
        out.cast.push({ ...entry, id, aka: [...entry.aka], order: between(out.cast.length ? out.cast[out.cast.length - 1].order : null, null) });
        castMap.set(entry.id, id);
      } else left += 1;
    }
    const chapter = (cid: string | null): string | null => (cid ? (ids.has(cid) ? (ids.get(cid) ?? null) : keepIds ? cid : null) : null);
    const cardMap = new Map<string, string>();
    for (const card of plan.cards) {
      if (out.cards.length >= LIMITS.cards) {
        left += 1;
        continue;
      }
      const id = out.cards.some((c) => c.id === card.id) ? newId() : card.id;
      cardMap.set(card.id, id);
      // Unassigned notes of a later source come after the earlier ones'.
      const loose = !card.chapter;
      const order = loose ? between(out.cards.filter((c) => !c.chapter).reduce<string | null>((m, c) => (m === null || c.order > m ? c.order : m), null), null) : card.order;
      out.cards.push({ ...card, id, order, chapter: chapter(card.chapter), line: card.line ? (lineMap.get(card.line) ?? null) : null, cast: card.cast.map((c) => castMap.get(c)).filter((c): c is string => !!c) });
    }
    for (const event of plan.events) {
      if (out.events.length >= LIMITS.events) {
        left += 1;
        continue;
      }
      const id = out.events.some((e) => e.id === event.id) ? newId() : event.id;
      out.events.push({
        ...event,
        id,
        order: between(out.events.length ? out.events[out.events.length - 1].order : null, null),
        chapter: chapter(event.chapter),
        cast: event.cast.map((c) => castMap.get(c)).filter((c): c is string => !!c),
        card: event.card ? (cardMap.get(event.card) ?? null) : null,
      });
    }
    for (const [cid, rec] of Object.entries(plan.chapters)) {
      const to = chapter(cid);
      if (to && !out.chapters[to]) out.chapters[to] = rec;
    }
  }
  if (!out.lines.length && !out.cards.length && !out.cast.length && !out.events.length) return { jsons, plan: null, left };
  const map: Record<string, string> = {};
  for (const l of out.lines) map[`l:${l.id}`] = encodeLine(l);
  for (const c of out.cards) map[`k:${c.id}`] = encodeCard(c);
  for (const e of out.cast) map[`p:${e.id}`] = encodeEntry(e);
  for (const e of out.events) map[`e:${e.id}`] = encodeEvent(e);
  for (const [cid, rec] of Object.entries(out.chapters)) map[`c:${cid}`] = JSON.stringify({ t: rec.title });
  return { jsons, plan: map, left };
}
