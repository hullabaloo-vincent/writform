/**
 * The organizer's one item model: server documents and documents on this
 * device listed, sorted, searched and acted on the same way.
 */

import type { DocumentListItem } from "../../../bindings/proto/DocumentListItem";
import type { UserRef } from "../../../bindings/proto/UserRef";
import { cleanCard } from "../card";
import { FORMAT_LABELS } from "../formats/elements";
import type { LocalDocMeta } from "../local";

export type SortKey = "modified" | "created" | "name";

export interface OrgItem {
  /** Unique across both kinds ("s:12", "l:uuid"). */
  key: string;
  kind: "server" | "local";
  id: number | string;
  title: string;
  format: string;
  updated: number;
  created: number;
  words: number;
  excerpt: string;
  /** The text around a search match. */
  snippet: string | null;
  /** A server folder's number, or the id of a folder on this device. */
  folderId: number | string | null;
  access: "owner" | "write" | "read";
  /** Shared documents show whose they are. */
  owner: UserRef | null;
  /** What its card shows beside the words (card.ts). */
  synopsis: string;
  cover: string | null;
  tags: string[];
}

export function serverItem(i: DocumentListItem): OrgItem {
  return {
    key: `s:${i.document.id}`,
    kind: "server",
    id: i.document.id,
    title: i.document.title,
    format: i.document.format,
    updated: i.document.updated_at,
    created: i.document.created_at,
    words: i.word_count ?? 0,
    excerpt: i.excerpt ?? "",
    snippet: i.snippet ?? null,
    folderId: i.document.folder_id,
    access: i.my_access === "write" || i.my_access === "read" ? i.my_access : "owner",
    owner: i.my_access === "owner" ? null : i.document.owner,
    ...cardFields(i.card),
  };
}

function cardFields(value: unknown): Pick<OrgItem, "synopsis" | "cover" | "tags"> {
  const card = cleanCard(value);
  return { synopsis: card.synopsis, cover: card.cover, tags: card.tags };
}

export function localItem(d: LocalDocMeta, folderId: string | null = null, snippet: string | null = null): OrgItem {
  return {
    key: `l:${d.id}`,
    kind: "local",
    id: d.id,
    title: d.title,
    format: d.format,
    updated: d.updated_at,
    created: d.updated_at,
    words: d.words ?? 0,
    excerpt: d.excerpt ?? "",
    snippet,
    folderId,
    access: "owner",
    owner: null,
    ...cardFields(d.card),
  };
}

/** A folder in the organizer, wherever it lives. */
export interface OrgFolder {
  key: string;
  kind: "server" | "local";
  id: number | string;
  name: string;
  count: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** "Chapter 2" before "Chapter 10"; ties fall back to the name. */
export function sortItems(items: OrgItem[], key: SortKey): OrgItem[] {
  return [...items].sort((a, b) => {
    if (key === "name") return collator.compare(a.title, b.title);
    const diff = key === "created" ? b.created - a.created : b.updated - a.updated;
    return diff || collator.compare(a.title, b.title);
  });
}

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

const SORT_STORE = "wf-doc-sort";

export function loadSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORE);
    return v === "created" || v === "name" ? v : "modified";
  } catch {
    return "modified";
  }
}

export function saveSort(key: SortKey) {
  try {
    localStorage.setItem(SORT_STORE, key);
  } catch {
    // Remembering the sort is a convenience.
  }
}

export function shortDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Manuscript · 98,412 words · Oct 3". */
export function metaLine(item: OrgItem): string {
  const parts = [FORMAT_LABELS[item.format] ?? item.format];
  if (item.words > 0) parts.push(`${item.words.toLocaleString()} word${item.words === 1 ? "" : "s"}`);
  const date = shortDate(item.updated);
  if (date) parts.push(date);
  return parts.join(" · ");
}

export const TRASH_DAYS = 30;

/** Whole days until Recently Deleted lets go of a document. */
export function daysLeft(deletedAt: number, now = Date.now()): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * day - now) / day));
}

/** A search over documents on this device, as far as the list alone can
 *  answer it: titles and opening words. (Their text is searched on disk.) */
export function matchesLocal(item: OrgItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !!q && (item.title.toLowerCase().includes(q) || item.excerpt.toLowerCase().includes(q));
}
