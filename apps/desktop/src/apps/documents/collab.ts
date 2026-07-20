/**
 * Yjs sync for documents over the app's "REST mutates, WS distributes"
 * model. Local edits queue and flush as merged v1 updates via
 * `POST /documents/{id}/updates`; the server assigns a per-document `seq`
 * and fans `document.update` frames out to the `document:{id}` room. All
 * clients (author included) apply incoming frames — updates are idempotent,
 * so echoes and retries are harmless. A seq gap or reconnect triggers
 * `?since=` catch-up; a truncated tail falls back to a full state reload.
 *
 * Awareness (cursors/presence) is ephemeral: throttled POSTs broadcast
 * y-protocols awareness updates that are never persisted.
 */

import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

import type { DocumentDetail } from "../../bindings/proto/DocumentDetail";
import { backend, type WsEvent } from "../../lib/backend";
import { onResync } from "../../platform";
import { documentsApi } from "./api";

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const REMOTE = "remote";
const FLUSH_MS = 300;
const AWARENESS_MS = 150;

export interface DocProviderOptions {
  /** Broadcast local awareness (cursor/presence). Off for board replicas. */
  presence: boolean;
}

export class DocProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  /** True once opened with read-only access — local edits are not sent. */
  readonly = false;

  /** Fires with `true` while local changes are waiting to reach the server. */
  onPending: ((pending: boolean) => void) | null = null;
  /** Fires after any change to the doc (local or remote). */
  onChange: (() => void) | null = null;

  private lastSeq = 0;
  private queue: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessDirty = new Set<number>();
  private retryDelay = 1000;
  private inflight = false;
  private catchingUp = false;
  private closed = false;
  private unsubs: (() => void)[] = [];

  constructor(
    readonly docId: number,
    private readonly opts: DocProviderOptions = { presence: true },
  ) {}

  async open(): Promise<DocumentDetail> {
    const detail = await documentsApi.detail(this.docId);
    this.readonly = detail.my_access === "read";
    if (detail.state_b64) {
      Y.applyUpdate(this.doc, b64decode(detail.state_b64), REMOTE);
    }
    this.lastSeq = detail.seq;
    await backend.wsSub([`document:${this.docId}`]);

    this.doc.on("update", this.onLocalUpdate);
    if (this.opts.presence) {
      this.awareness.on("update", this.onAwarenessUpdate);
    }
    this.unsubs.push(backend.onWsEvent(this.onWsEvent));
    this.unsubs.push(
      onResync(() => {
        void this.catchUp();
      }),
    );
    return detail;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    // Best-effort "I left" so peers drop the caret before the 30s timeout.
    if (this.opts.presence && !this.readonly) {
      try {
        this.awareness.setLocalState(null);
        this.flushAwareness();
      } catch {
        // presence is best-effort
      }
    }
    this.doc.off("update", this.onLocalUpdate);
    this.awareness.destroy();
    for (const u of this.unsubs) u();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    void backend.wsUnsub([`document:${this.docId}`]);
    this.doc.destroy();
  }

  /** Force any queued edits out now (e.g. before closing). */
  async flush(): Promise<void> {
    await this.flushNow();
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    this.onChange?.();
    if (origin === REMOTE || this.readonly || this.closed) return;
    this.queue.push(update);
    this.onPending?.(true);
    this.scheduleFlush(FLUSH_MS);
  };

  private scheduleFlush(ms: number) {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, ms);
  }

  private async flushNow(): Promise<void> {
    if (this.inflight || this.queue.length === 0 || this.closed) return;
    const count = this.queue.length;
    const merged = Y.mergeUpdates(this.queue.slice(0, count));
    this.inflight = true;
    try {
      await documentsApi.appendUpdate(this.docId, b64encode(merged));
      this.queue.splice(0, count);
      this.retryDelay = 1000;
      this.onPending?.(this.queue.length > 0);
      if (this.queue.length > 0) this.scheduleFlush(FLUSH_MS);
    } catch {
      // Keep the queue; updates are idempotent so a duplicate retry is safe.
      this.onPending?.(true);
      this.scheduleFlush(this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    } finally {
      this.inflight = false;
    }
  }

  private onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE || this.closed) return;
    for (const c of [...changes.added, ...changes.updated, ...changes.removed]) {
      this.awarenessDirty.add(c);
    }
    if (this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.flushAwareness();
    }, AWARENESS_MS);
  };

  private flushAwareness() {
    if (this.awarenessDirty.size === 0) return;
    const clients = [...this.awarenessDirty];
    this.awarenessDirty.clear();
    const update = encodeAwarenessUpdate(this.awareness, clients);
    documentsApi.awareness(this.docId, b64encode(update)).catch(() => {
      // Ephemeral; the next cursor move re-broadcasts.
    });
  }

  private onWsEvent = (event: WsEvent) => {
    if (event.ev !== "event" || event.room !== `document:${this.docId}`) return;
    if (event.kind === "document.update") {
      const data = event.data as { seq: number; update_b64: string };
      Y.applyUpdate(this.doc, b64decode(data.update_b64), REMOTE);
      if (data.seq === this.lastSeq + 1) {
        this.lastSeq = data.seq;
      } else if (data.seq > this.lastSeq + 1) {
        void this.catchUp();
      }
    } else if (event.kind === "document.awareness") {
      const data = event.data as { data_b64: string };
      try {
        applyAwarenessUpdate(this.awareness, b64decode(data.data_b64), REMOTE);
      } catch {
        // A malformed frame from a peer must not break the editor.
      }
    }
  };

  /** Fill any seq gap; a compacted-away gap reloads the full state. */
  async catchUp(): Promise<void> {
    if (this.catchingUp || this.closed) return;
    this.catchingUp = true;
    try {
      const batch = await documentsApi.updatesSince(this.docId, this.lastSeq);
      if (batch.truncated) {
        const detail = await documentsApi.detail(this.docId);
        Y.applyUpdate(this.doc, b64decode(detail.state_b64), REMOTE);
        this.lastSeq = detail.seq;
      } else {
        for (const row of batch.updates) {
          Y.applyUpdate(this.doc, b64decode(row.update_b64), REMOTE);
          this.lastSeq = Math.max(this.lastSeq, row.seq);
        }
      }
    } catch {
      // Reconnect fires another resync; the next catch-up retries.
    } finally {
      this.catchingUp = false;
    }
  }
}

// ------------------------------------------------------------- replica cache

/** Refcounted read-only replicas for embedded views (canvas doc cards). */
const replicas = new Map<number, { provider: DocProvider; refs: number; opened: Promise<DocumentDetail> }>();

export function acquireReplica(docId: number): {
  provider: DocProvider;
  opened: Promise<DocumentDetail>;
} {
  let entry = replicas.get(docId);
  if (!entry) {
    const provider = new DocProvider(docId, { presence: false });
    entry = { provider, refs: 0, opened: provider.open() };
    replicas.set(docId, entry);
  }
  entry.refs += 1;
  return { provider: entry.provider, opened: entry.opened };
}

export function releaseReplica(docId: number): void {
  const entry = replicas.get(docId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    replicas.delete(docId);
    entry.provider.destroy();
  }
}
