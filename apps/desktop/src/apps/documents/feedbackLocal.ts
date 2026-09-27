/** Feedback threads for on-device documents — notes to your future editing
 *  self. Stored as a sidecar JSON file next to the doc (like version
 *  history): prunable, deleted with the doc, and never part of the Yjs
 *  state, so comment churn can't bloat the document itself. Single-user by
 *  definition, so threads carry no author. */

import { backend } from "../../lib/backend";

export interface LocalThreadMessage {
  id: string;
  content: string;
  created_at: number;
}

export interface LocalThread {
  id: string;
  /** Yjs relative positions, exactly as the server threads store them —
   *  null for a whole-document note. */
  anchor_b64: string | null;
  head_b64: string | null;
  excerpt: string | null;
  resolved: boolean;
  created_at: number;
  messages: LocalThreadMessage[];
}

const listeners = new Set<() => void>();

/** Fires after any write; panels re-read. */
export function onLocalFeedbackChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function readLocalFeedback(docId: string): Promise<LocalThread[]> {
  try {
    const raw = await backend.localdocFeedbackRead(docId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { threads?: LocalThread[] };
    return Array.isArray(parsed.threads) ? parsed.threads : [];
  } catch {
    // Corrupt or unreadable sidecar: start empty rather than break the doc.
    return [];
  }
}

async function writeLocalFeedback(docId: string, threads: LocalThread[]): Promise<void> {
  await backend.localdocFeedbackWrite(docId, JSON.stringify({ threads }));
  for (const fn of listeners) fn();
}

async function mutate(
  docId: string,
  change: (threads: LocalThread[]) => LocalThread[],
): Promise<void> {
  const threads = await readLocalFeedback(docId);
  await writeLocalFeedback(docId, change(threads));
}

export async function createLocalThread(
  docId: string,
  input: {
    content: string;
    anchor_b64: string | null;
    head_b64: string | null;
    excerpt: string | null;
  },
): Promise<void> {
  const now = Date.now();
  const thread: LocalThread = {
    id: crypto.randomUUID(),
    anchor_b64: input.anchor_b64,
    head_b64: input.head_b64,
    excerpt: input.excerpt,
    resolved: false,
    created_at: now,
    messages: [{ id: crypto.randomUUID(), content: input.content, created_at: now }],
  };
  await mutate(docId, (threads) => [...threads, thread]);
}

export async function replyLocalThread(
  docId: string,
  threadId: string,
  content: string,
): Promise<void> {
  await mutate(docId, (threads) =>
    threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            messages: [
              ...t.messages,
              { id: crypto.randomUUID(), content, created_at: Date.now() },
            ],
          }
        : t,
    ),
  );
}

export async function setLocalThreadResolved(
  docId: string,
  threadId: string,
  resolved: boolean,
): Promise<void> {
  await mutate(docId, (threads) =>
    threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)),
  );
}

export async function deleteLocalThread(docId: string, threadId: string): Promise<void> {
  await mutate(docId, (threads) => threads.filter((t) => t.id !== threadId));
}
