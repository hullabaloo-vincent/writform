/**
 * Pure helpers for the document sync engine: bounded batching of queued Yjs
 * updates and classification of send failures. No DOM, no backend — the
 * node harness exercises these directly.
 */

import * as Y from "yjs";

/** Largest merged update one POST carries. Older servers reject anything
 *  over 256 KiB; staying under it keeps every server version happy. */
export const BATCH_BYTES = 192 * 1024;

/**
 * Merge the front of `queue` into one update of at most `limit` bytes.
 * Always takes at least one entry — a single oversized update is sent as-is
 * and the server decides (newer servers accept up to 4 MiB).
 */
export function takeBatch(
  queue: Uint8Array[],
  limit = BATCH_BYTES,
): { update: Uint8Array; count: number } {
  if (queue.length === 0) return { update: new Uint8Array(0), count: 0 };
  let count = 0;
  let size = 0;
  while (count < queue.length) {
    const next = queue[count].byteLength;
    if (count > 0 && size + next > limit) break;
    size += next;
    count += 1;
  }
  // Merging can, rarely, encode larger than its parts; back off until it fits.
  for (;;) {
    const update = count === 1 ? queue[0] : Y.mergeUpdates(queue.slice(0, count));
    if (update.byteLength <= limit || count === 1) return { update, count };
    count -= 1;
  }
}

/** Pack a whole queue into bounded pieces (for the on-disk outbox). */
export function packUpdates(queue: Uint8Array[], limit = BATCH_BYTES): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let rest = queue;
  while (rest.length > 0) {
    const { update, count } = takeBatch(rest, limit);
    pieces.push(update);
    rest = rest.slice(count);
  }
  return pieces;
}

/**
 * Why a send failed, by what to do about it:
 * - temporary: network/server hiccup — back off and retry.
 * - auth: the session is gone — pause until signed in again.
 * - gone / forbidden: the document was deleted, or access was revoked.
 * - too_large: this server refuses an update this big.
 * - rejected: the server refused the update for any other reason.
 */
export type SendErrorKind = "temporary" | "auth" | "gone" | "forbidden" | "too_large" | "rejected";

export function classifySendError(error: unknown): SendErrorKind {
  const e = (error ?? {}) as { code?: unknown; status?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.status === "number" ? e.status : 0;
  if (!status) {
    // Transport-level failures from the Rust core / fetch: no HTTP answer.
    return "temporary";
  }
  if (status === 401) return "auth";
  if (status === 404) return "gone";
  if (status === 403) return "forbidden";
  if (status === 413 || code === "update_too_large") return "too_large";
  if (status === 429 || status >= 500) return "temporary";
  return "rejected";
}

/** Permanent failures stop the retry loop; the rest keep trying. */
export function isPermanent(kind: SendErrorKind): boolean {
  return kind === "gone" || kind === "forbidden" || kind === "too_large" || kind === "rejected";
}

/** The user-facing reason for a permanent failure. */
export function sendErrorMessage(kind: SendErrorKind): string {
  switch (kind) {
    case "gone":
      return "This document was deleted.";
    case "forbidden":
      return "You can no longer edit this document.";
    case "too_large":
      return "A change is too large for this server.";
    case "rejected":
      return "The server refused a change.";
    case "auth":
      return "Signed out — changes will send when you sign back in.";
    default:
      return "Offline — changes are kept on this device and sync when you reconnect.";
  }
}
