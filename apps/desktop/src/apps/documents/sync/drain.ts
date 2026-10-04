/**
 * Background delivery for the outbox: edits to documents that are NOT open
 * (left behind by a quit, a crash, or a dropped connection) go out on
 * sign-in, on reconnect, and once a minute. Open documents replay and send
 * their own entries through their provider.
 */

import { documentsApi } from "../api";
import { b64encode, isDocOpen } from "../collab";
import { classifySendError, isPermanent, sendErrorMessage, type SendErrorKind } from "./batch";
import { outbox, type OutboxEntry } from "./outbox";
import { currentScope } from "./scope";

let draining = false;

async function markError(entry: OutboxEntry, reason: SendErrorKind, pending = entry.pending) {
  await outbox.put({
    ...entry,
    pending,
    error: { reason, message: sendErrorMessage(reason), at: Date.now() },
    updatedAt: Date.now(),
  });
}

export async function drainOutbox(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const scope = currentScope();
    if (!scope) return;
    const entries = (await outbox.all()).filter(
      (e) => e.scope === scope && !e.error && e.pending.length > 0 && !isDocOpen(scope, e.docId),
    );
    if (entries.length === 0) return;
    // One list call checks every target still exists, is the SAME document
    // (a reset server reuses ids), and is still writable.
    const list = await documentsApi.list().catch(() => null);
    if (!list) return;
    const byId = new Map(list.map((item) => [item.document.id, item]));

    for (const entry of entries) {
      if (currentScope() !== scope) return;
      if (isDocOpen(scope, entry.docId)) continue;
      const item = byId.get(entry.docId);
      if (!item || item.document.created_at !== entry.docCreatedAt) {
        await markError(entry, "gone");
        continue;
      }
      if (item.my_access === "read") {
        await markError(entry, "forbidden");
        continue;
      }
      let pending = [...entry.pending];
      while (pending.length > 0) {
        try {
          await documentsApi.appendUpdate(entry.docId, b64encode(pending[0]));
          pending = pending.slice(1);
        } catch (e) {
          const kind = classifySendError(e);
          if (isPermanent(kind)) await markError(entry, kind, pending);
          else await outbox.put({ ...entry, pending, updatedAt: Date.now() });
          // Temporary trouble: stop the whole run; the next trigger retries.
          if (!isPermanent(kind)) return;
          break;
        }
      }
      if (pending.length === 0) await outbox.remove(entry.key);
    }
  } finally {
    draining = false;
  }
}

/** Errored entries for the signed-in server: what the organizer banner lists. */
export async function troubledEntries(): Promise<OutboxEntry[]> {
  const scope = currentScope();
  if (!scope) return [];
  return (await outbox.all())
    .filter((e) => e.scope === scope && e.error)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "Try again" from the banner: clear the error and send. */
export async function retryEntry(entry: OutboxEntry): Promise<void> {
  await outbox.put({ ...entry, error: undefined, updatedAt: Date.now() });
  await drainOutbox();
}
