/**
 * Yjs sync for documents over the app's "REST mutates, WS distributes"
 * model. Local edits queue and flush as merged v1 updates (bounded batches,
 * see sync/batch.ts) via `POST /documents/{id}/updates`, mirrored into the
 * on-device outbox until confirmed; the server assigns a per-document `seq`
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
import {
  classifySendError,
  isPermanent,
  packUpdates,
  sendErrorMessage,
  takeBatch,
  type SendErrorKind,
} from "./sync/batch";
import { INSTANCE_ID, outbox, outboxKey, type OutboxEntry } from "./sync/outbox";
import { currentScope } from "./sync/scope";

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
/** Origin for edits replayed from the outbox: they count as local, so only
 *  the part the server is missing gets queued (Yjs emits the diff). */
const OUTBOX = "outbox";
const FLUSH_MS = 300;
const PERSIST_MS = 500;
const AWARENESS_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the save indicator shows for a server document. */
export type SyncState =
  | { kind: "synced" }
  | { kind: "pending" }
  /** Unsent edits wait: no connection, signed out, or another server. */
  | { kind: "offline"; reason: "temporary" | "auth" | "scope" }
  /** The server refused the edits; sending stopped until `retry()`. */
  | { kind: "error"; reason: SendErrorKind; message: string };

export interface DocProviderOptions {
  /** Broadcast local awareness (cursor/presence). Off for board replicas. */
  presence: boolean;
}

/** `${scope}|${docId}` of every provider currently editing a document, so the
 *  background outbox sender leaves those to their own provider. */
const openDocs = new Set<string>();
export const isDocOpen = (scope: string, docId: number) => openDocs.has(`${scope}|${docId}`);

export class DocProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  /** True once opened with read-only access — local edits are not sent. */
  readonly = false;

  /** Fires after any change to the doc (local or remote). */
  onChange: (() => void) | null = null;

  /** Server + account this document belongs to, fixed at open. */
  private scope: string | null = null;
  private docCreatedAt = 0;
  private title = "";
  private status: SyncState = { kind: "synced" };
  private statusListeners = new Set<(s: SyncState) => void>();
  private lastSeq = 0;
  private queue: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessDirty = new Set<number>();
  private retryDelay = 1000;
  private inflight: Promise<void> | null = null;
  private catchingUp = false;
  private closed = false;
  /** A permanent refusal stops sending until the user retries. */
  private halted = false;
  private unsubs: (() => void)[] = [];

  constructor(
    readonly docId: number,
    private readonly opts: DocProviderOptions = { presence: true },
  ) {}

  async open(): Promise<DocumentDetail> {
    this.scope = currentScope();
    const detail = await documentsApi.detail(this.docId);
    this.readonly = detail.my_access === "read";
    this.docCreatedAt = detail.document.created_at;
    this.title = detail.document.title;
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
        if (!this.halted) void this.flushNow();
      }),
    );
    // Editors (not read-only board replicas) own the document's outbox:
    // whatever didn't reach the server last time goes out now.
    if (this.opts.presence && this.scope) {
      openDocs.add(`${this.scope}|${this.docId}`);
      await this.replayOutbox();
    }
    return detail;
  }

  getStatus(): SyncState {
    return this.status;
  }

  /** Save-indicator updates; returns an unsubscribe fn. */
  subscribe(fn: (s: SyncState) => void): () => void {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  /** True while some edit hasn't been confirmed by the server. */
  hasUnsent(): boolean {
    return this.queue.length > 0;
  }

  /** Clear a refusal and try again (the error popover's "Try Again"). */
  retry(): void {
    this.halted = false;
    this.retryDelay = 1000;
    if (this.queue.length) this.setStatus({ kind: "pending" });
    void this.flushNow();
  }

  /** Send what's queued, giving up after `timeoutMs` (it stays in the outbox). */
  async flush(timeoutMs = 4000): Promise<void> {
    this.persistNow();
    if (!this.queue.length || this.halted) return;
    await Promise.race([this.flushNow(), sleep(timeoutMs)]);
  }

  /** Close the editor's provider: flush within the budget, then tear down.
   *  Anything still unsent is kept in the outbox (with a rescue copy). */
  async close(timeoutMs = 4000): Promise<void> {
    if (this.closed) return;
    if (this.queue.length && !this.halted && currentScope() === this.scope) {
      await Promise.race([this.flushNow(), sleep(timeoutMs)]);
    }
    this.destroy();
  }

  /** Tear down WITHOUT keeping unsent edits — the document is being deleted. */
  discard(): void {
    this.queue = [];
    const scope = this.scope;
    if (scope) {
      void outbox
        .forDoc(scope, this.docId)
        .then((entries) => Promise.all(entries.map((e) => outbox.remove(e.key))))
        .catch(() => {});
    }
    this.destroy();
  }

  destroy(): void {
    if (this.closed) return;
    // Unsent edits outlive the editor: capture them (and a full copy to
    // rebuild from) before the Y.Doc goes away.
    if (this.queue.length > 0) this.persistNow(true);
    this.closed = true;
    if (this.scope) openDocs.delete(`${this.scope}|${this.docId}`);
    // Best-effort "I left" so peers drop the caret before the 30s timeout —
    // only to the server this document lives on.
    if (this.opts.presence && !this.readonly && currentScope() === this.scope) {
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
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.statusListeners.clear();
    void backend.wsUnsub([`document:${this.docId}`]);
    this.doc.destroy();
  }

  private setStatus(next: SyncState) {
    const prev = this.status;
    if (
      prev.kind === next.kind &&
      ("reason" in prev ? prev.reason : "") === ("reason" in next ? next.reason : "")
    ) {
      return;
    }
    this.status = next;
    for (const fn of [...this.statusListeners]) fn(next);
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    this.onChange?.();
    if (origin === REMOTE || this.readonly || this.closed) return;
    this.queue.push(update);
    this.schedulePersist();
    if (!this.halted && this.status.kind !== "offline") this.setStatus({ kind: "pending" });
    if (!this.halted) this.scheduleFlush(FLUSH_MS);
  };

  private scheduleFlush(ms: number) {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, ms);
  }

  /** One send loop at a time; callers share it. */
  private flushNow(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.queue.length === 0 || this.halted) return Promise.resolve();
    const run = this.sendLoop().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async sendLoop(): Promise<void> {
    while (this.queue.length > 0 && !this.halted) {
      // Never send one server's edits to another: ids repeat across servers.
      if (!this.scope || currentScope() !== this.scope) {
        this.setStatus({ kind: "offline", reason: "scope" });
        this.persistNow();
        return;
      }
      const { update, count } = takeBatch(this.queue);
      try {
        await documentsApi.appendUpdate(this.docId, b64encode(update));
      } catch (e) {
        const kind = classifySendError(e);
        if (isPermanent(kind)) {
          this.halted = true;
          this.setStatus({ kind: "error", reason: kind, message: sendErrorMessage(kind) });
          this.persistNow(!this.closed, { reason: kind, message: sendErrorMessage(kind), at: Date.now() });
          return;
        }
        this.setStatus({ kind: "offline", reason: kind === "auth" ? "auth" : "temporary" });
        this.persistNow();
        // Signed out: the session listener retires this provider; the outbox
        // sends the rest after the next sign-in.
        if (kind !== "auth") {
          this.scheduleFlush(this.retryDelay);
          this.retryDelay = Math.min(this.retryDelay * 2, 5000);
        }
        return;
      }
      // Entries only ever join at the back, so the front `count` are the
      // ones just sent.
      this.queue.splice(0, count);
      this.retryDelay = 1000;
    }
    if (this.queue.length === 0 && !this.halted) {
      this.setStatus({ kind: "synced" });
      this.persistNow();
    }
  }

  private schedulePersist() {
    if (this.persistTimer || this.closed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_MS);
  }

  /**
   * Mirror the unsent queue into the outbox (or clear it when everything
   * landed). Captures synchronously — callable right before the doc is
   * destroyed — and writes in the background.
   */
  private persistNow(withRescue = false, error?: OutboxEntry["error"]): void {
    if (!this.scope || !this.opts.presence || this.readonly) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const key = outboxKey(this.scope, this.docId);
    if (this.queue.length === 0 && !error) {
      void outbox.remove(key).catch(() => {});
      return;
    }
    let pending: Uint8Array[];
    let rescue: Uint8Array | undefined;
    try {
      pending = packUpdates(this.queue);
      rescue = withRescue && !this.closed ? Y.encodeStateAsUpdate(this.doc) : undefined;
    } catch {
      return;
    }
    const entry: OutboxEntry = {
      key,
      scope: this.scope,
      docId: this.docId,
      docCreatedAt: this.docCreatedAt,
      title: this.title,
      instance: INSTANCE_ID,
      pending,
      rescue,
      error,
      updatedAt: Date.now(),
    };
    void outbox.put(entry).catch(() => {});
  }

  /** Re-apply edits a previous session couldn't send. Only entries made for
   *  THIS document (same creation time) count — a reset server reuses ids. */
  private async replayOutbox(): Promise<void> {
    if (!this.scope) return;
    const entries = (await outbox.forDoc(this.scope, this.docId).catch(() => [])).filter(
      (e) => e.docCreatedAt === this.docCreatedAt,
    );
    if (entries.length === 0) return;
    if (this.readonly) {
      this.setStatus({
        kind: "error",
        reason: "forbidden",
        message: "You can no longer edit this document — your unsent changes are kept on this device.",
      });
      return;
    }
    for (const entry of entries) {
      for (const update of entry.rescue ? [entry.rescue, ...entry.pending] : entry.pending) {
        try {
          Y.applyUpdate(this.doc, update, OUTBOX);
        } catch {
          // A damaged entry can't be helped; the rest still apply.
        }
      }
    }
    // Our own copy is now the authoritative one; drop the replayed entries.
    this.persistNow();
    const mine = outboxKey(this.scope, this.docId);
    for (const entry of entries) {
      if (entry.key !== mine) await outbox.remove(entry.key).catch(() => {});
    }
    if (this.queue.length) void this.flushNow();
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
    if (currentScope() !== this.scope) {
      this.awarenessDirty.clear();
      return;
    }
    const clients = [...this.awarenessDirty];
    this.awarenessDirty.clear();
    const update = encodeAwarenessUpdate(this.awareness, clients);
    documentsApi.awareness(this.docId, b64encode(update)).catch(() => {
      // Ephemeral; the next cursor move re-broadcasts.
    });
  }

  private onWsEvent = (event: WsEvent) => {
    if (event.ev !== "event" || event.room !== `document:${this.docId}`) return;
    // After a server switch the same room name means another document.
    if (currentScope() !== this.scope) return;
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
    if (currentScope() !== this.scope) return;
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
