import { toast } from "../platform";

/**
 * Per-document word-count goals, kept on this device (localStorage). The key
 * carries the server address (or `local`) so ids from different servers never
 * collide.
 */

const key = (docKey: string) => `wf-doc-goal:${docKey}`;

export function loadGoal(docKey: string): number | null {
  try {
    const raw = localStorage.getItem(key(docKey));
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

export function saveGoal(docKey: string, target: number | null): void {
  try {
    if (target === null) localStorage.removeItem(key(docKey));
    else localStorage.setItem(key(docKey), String(Math.floor(target)));
  } catch {
    // best-effort persistence
  }
}

const celebrated = new Set<string>();

/** One quiet cheer per document per app run, the first time the goal is met. */
export function noteGoalProgress(docKey: string, words: number, target: number): void {
  if (words < target || celebrated.has(docKey)) return;
  celebrated.add(docKey);
  toast(`Goal reached — ${target.toLocaleString()} words`);
}
