/**
 * "Jump back in": the last things you worked on, whatever kind they are and
 * wherever they live — documents and boards on this device, notes in the
 * vault, and (while connected) documents on the server. Pure: the pieces
 * come from each app's own list, so there's no second record to keep true.
 */

export type RecentKind = "document" | "board" | "note";

export interface Recent {
  kind: RecentKind;
  /** Unique across kinds and places. */
  key: string;
  title: string;
  /** "On this device", "Manuscript · 12,340 words", a server's name. */
  detail: string;
  /** When it was last changed (ms). */
  at: number;
  /** Where it lives. */
  place: "device" | "server";
}

/** Newest first, one entry per thing, at most `limit`. */
export function mergeRecents(lists: Recent[][], limit = 8): Recent[] {
  const byKey = new Map<string, Recent>();
  for (const item of lists.flat()) {
    if (!Number.isFinite(item.at) || item.at <= 0) continue;
    const seen = byKey.get(item.key);
    if (!seen || item.at > seen.at) byKey.set(item.key, item);
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key)).slice(0, Math.max(0, limit));
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", "12 March". */
export function whenLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}

/** A greeting for the time of day (and who, when they've said). */
export function greeting(hour: number, name: string): string {
  const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const who = name.trim();
  return who ? `${part}, ${who}` : part;
}
