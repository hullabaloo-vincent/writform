/**
 * The outbox: edits to server documents that haven't reached the server yet,
 * kept on this device so closing the document, quitting, a crash, or a dead
 * connection can never lose them.
 *
 * Entries are keyed by `scope|docId|instance` — scope pins them to the server
 * AND account they were typed on (an id means nothing on another server), and
 * the per-app-instance part keeps two windows from overwriting each other.
 * Updates are CRDT deltas, so replaying an entry that partly (or fully)
 * reached the server is harmless: Yjs integrates only what's missing.
 *
 * Stored in IndexedDB (binary-friendly, roomy, available on desktop, iOS and
 * web); an in-memory map stands in when IndexedDB is unavailable.
 */

import type { SendErrorKind } from "./batch";

export interface OutboxEntry {
  key: string;
  /** `${addr}|${userId}` of the session the edits belong to. */
  scope: string;
  docId: number;
  /** The document's creation time — guards against a reset server reusing ids. */
  docCreatedAt: number;
  title: string;
  instance: string;
  /** Unsent updates, packed into bounded pieces. */
  pending: Uint8Array[];
  /** Full document state, kept when sending failed permanently or the doc
   *  closed with edits still unsent — enough to rebuild a copy. */
  rescue?: Uint8Array;
  error?: { reason: SendErrorKind; message: string; at: number };
  updatedAt: number;
}

/** This app instance (window/tab), for the entry key. */
export const INSTANCE_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `i${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export const outboxKey = (scope: string, docId: number, instance = INSTANCE_ID) =>
  `${scope}|${docId}|${instance}`;

const DB_NAME = "wf-sync";
const STORE = "outbox";

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, OutboxEntry>();
const listeners = new Set<() => void>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function request<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (!db) {
          resolve(undefined);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const req = run(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error ?? new Error("outbox write failed"));
          tx.onabort = () => reject(tx.error ?? new Error("outbox write aborted"));
        } catch (e) {
          reject(e);
        }
      }),
  );
}

function notify() {
  for (const fn of [...listeners]) fn();
}

export const outbox = {
  async put(entry: OutboxEntry): Promise<void> {
    const db = await openDb();
    if (!db) memory.set(entry.key, entry);
    else await request("readwrite", (s) => s.put(entry));
    notify();
  },

  async remove(key: string): Promise<void> {
    const db = await openDb();
    if (!db) memory.delete(key);
    else await request("readwrite", (s) => s.delete(key));
    notify();
  },

  async all(): Promise<OutboxEntry[]> {
    const db = await openDb();
    if (!db) return [...memory.values()];
    return ((await request("readonly", (s) => s.getAll())) as OutboxEntry[] | undefined) ?? [];
  },

  async forDoc(scope: string, docId: number): Promise<OutboxEntry[]> {
    return (await outbox.all()).filter((e) => e.scope === scope && e.docId === docId);
  },

  /** Fires after any change made from this window. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
