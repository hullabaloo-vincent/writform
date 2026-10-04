import { create } from "zustand";

import type { Document } from "../../bindings/proto/Document";
import type { DocumentActivity } from "../../bindings/proto/DocumentActivity";
import type { DocumentFolder } from "../../bindings/proto/DocumentFolder";
import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import type { DocumentShare } from "../../bindings/proto/DocumentShare";
import type { DocumentThread } from "../../bindings/proto/DocumentThread";
import type { DocumentThreadMessage } from "../../bindings/proto/DocumentThreadMessage";
import type { DocumentVersionMeta } from "../../bindings/proto/DocumentVersionMeta";
import { backend, isCmdError } from "../../lib/backend";
import { onFlush } from "../../platform/lifecycle";
import { onBeforeLogout, useSession } from "../../stores/session";
import { documentsApi } from "./api";
import { DocProvider } from "./collab";
import { scopeOf } from "./sync/scope";

/** The open document's live sync provider (module-level: one at a time). */
let provider: DocProvider | null = null;

export function activeProvider(): DocProvider | null {
  return provider;
}

/**
 * Providers on their way out: closing is instant for the user while the
 * provider sends what's left in the background (anything it can't send stays
 * in the outbox). Reopening the same document waits briefly for it.
 */
const retiring = new Map<number, Promise<void>>();
const RETIRE_MS = 4000;
const REOPEN_WAIT_MS = 2000;

function retire(old: DocProvider, opts: { discard?: boolean } = {}) {
  if (opts.discard) {
    old.discard();
    return;
  }
  const done = old.close(RETIRE_MS).finally(() => {
    if (retiring.get(old.docId) === done) retiring.delete(old.docId);
    // The list's dates and order moved while the document was open.
    const s = useDocuments.getState();
    if (s.loaded) void s.load().catch(() => {});
  });
  retiring.set(old.docId, done);
}

const EMPTY_DOC_STATE = {
  activeDocId: null,
  meta: null,
  myAccess: null,
  versions: [],
  activities: [],
  shares: [],
  threads: [],
};

interface DocumentsState {
  items: DocumentListItem[];
  folders: DocumentFolder[];
  loaded: boolean;
  /** Recently Deleted on the server. */
  trash: DocumentListItem[];
  /** Whether the server keeps deleted documents (null until asked; false on
   *  servers that predate Recently Deleted — deleting is then permanent). */
  trashSupported: boolean | null;
  /** The last list load failed (shown with "Try again"). */
  loadError: string | null;
  /** Panel the editor should open with (set by "Version history" etc.). */
  pendingPanel: "history" | "feedback" | null;
  activeDocId: number | null;
  meta: Document | null;
  myAccess: string | null;
  versions: DocumentVersionMeta[];
  activities: DocumentActivity[];
  shares: DocumentShare[];
  threads: DocumentThread[];
  error: string | null;

  load: () => Promise<void>;
  loadFolders: () => Promise<void>;
  loadTrash: () => Promise<void>;
  openDocument: (id: number) => Promise<void>;
  /** `discard`: the document is gone (deleted) — drop unsent edits. */
  closeDocument: (opts?: { discard?: boolean }) => void;
  refreshVersions: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  refreshShares: () => Promise<void>;
  refreshThreads: () => Promise<void>;
  clearError: () => void;
}

export const useDocuments = create<DocumentsState>((set, get) => ({
  items: [],
  folders: [],
  loaded: false,
  trash: [],
  trashSupported: null,
  loadError: null,
  pendingPanel: null,
  ...EMPTY_DOC_STATE,
  error: null,

  load: async () => {
    try {
      const items = await documentsApi.list();
      set({ items, loaded: true, loadError: null });
    } catch (e) {
      set({ loadError: isCmdError(e) ? e.message : String(e) });
      throw e;
    }
  },

  loadFolders: async () => {
    const folders = await documentsApi.listFolders();
    set({ folders });
  },

  loadTrash: async () => {
    try {
      set({ trash: await documentsApi.trash(), trashSupported: true });
    } catch (e) {
      if ((e as { status?: number }).status === 404) set({ trash: [], trashSupported: false });
      else throw e;
    }
  },

  openDocument: async (id) => {
    get().closeDocument();
    const next = new DocProvider(id);
    provider = next;
    set({ ...EMPTY_DOC_STATE, activeDocId: id });
    try {
      // The previous provider for this document may still be sending.
      const leaving = retiring.get(id);
      if (leaving) {
        await Promise.race([leaving, new Promise((r) => setTimeout(r, REOPEN_WAIT_MS))]);
      }
      if (provider !== next) return;
      const detail = await next.open();
      // A slow open may have been superseded or closed meanwhile.
      if (provider !== next) {
        void next.close(RETIRE_MS);
        return;
      }
      set({ meta: detail.document, myAccess: detail.my_access });
      void get().refreshThreads();
      void get().refreshVersions();
      void get().refreshActivity();
      if (detail.my_access === "owner") void get().refreshShares();
    } catch (e) {
      if (provider === next) get().closeDocument();
      set({ error: isCmdError(e) ? e.message : String(e) });
      throw e;
    }
  },

  closeDocument: (opts) => {
    const old = provider;
    provider = null;
    if (old) retire(old, opts);
    set(EMPTY_DOC_STATE);
  },

  refreshVersions: async () => {
    const id = get().activeDocId;
    if (id === null) return;
    const versions = await documentsApi.versions(id).catch(() => []);
    if (get().activeDocId === id) set({ versions });
  },

  refreshActivity: async () => {
    const id = get().activeDocId;
    if (id === null) return;
    const activities = await documentsApi.activity(id).catch(() => []);
    if (get().activeDocId === id) set({ activities });
  },

  refreshShares: async () => {
    const id = get().activeDocId;
    if (id === null) return;
    const shares = await documentsApi.shares(id).catch(() => []);
    if (get().activeDocId === id) set({ shares });
  },

  refreshThreads: async () => {
    const id = get().activeDocId;
    if (id === null) return;
    const threads = await documentsApi.threads(id).catch(() => []);
    if (get().activeDocId === id) set({ threads });
  },

  clearError: () => set({ error: null }),
}));

/** Apply documents WS events (meta/list/version/thread — the provider owns
 *  `document.update`/`document.awareness`). Installed once by the app. */
export function installDocumentsWsHandler(): () => void {
  return backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const { kind, data } = event;
    const state = useDocuments.getState();

    if (kind === "document.meta") {
      const doc = data as Document;
      useDocuments.setState((s) => ({
        meta: s.activeDocId === doc.id ? doc : s.meta,
        items: s.items.map((i) => (i.document.id === doc.id ? { ...i, document: doc } : i)),
      }));
    } else if (kind === "document.deleted") {
      const { doc_id } = data as { doc_id: number };
      if (state.activeDocId === doc_id) state.closeDocument();
      useDocuments.setState((s) => ({
        items: s.items.filter((i) => i.document.id !== doc_id),
      }));
    } else if (kind === "document.listchanged") {
      if (state.loaded) void state.load().catch(() => {});
      if (state.trashSupported) void state.loadTrash().catch(() => {});
    } else if (kind === "document.folders") {
      void state.loadFolders().catch(() => {});
    } else if (kind === "document.version") {
      const meta = data as DocumentVersionMeta;
      if (state.activeDocId === meta.doc_id) {
        useDocuments.setState((s) => ({
          versions: s.versions.some((v) => v.id === meta.id) ? s.versions : [meta, ...s.versions],
        }));
      }
    } else if (kind === "document.thread.created" || kind === "document.thread.updated") {
      const thread = data as DocumentThread;
      if (state.activeDocId === thread.doc_id) {
        useDocuments.setState((s) => {
          const exists = s.threads.some((t) => t.id === thread.id);
          return {
            threads: exists
              ? s.threads.map((t) => (t.id === thread.id ? thread : t))
              : [...s.threads, thread],
          };
        });
      }
    } else if (kind === "document.thread.replied") {
      const { doc_id, message } = data as { doc_id: number; message: DocumentThreadMessage };
      if (state.activeDocId === doc_id) {
        useDocuments.setState((s) => ({
          threads: s.threads.map((t) =>
            t.id === message.thread_id && !t.messages.some((m) => m.id === message.id)
              ? { ...t, messages: [...t.messages, message] }
              : t,
          ),
        }));
      }
    } else if (kind === "document.thread.deleted") {
      const { doc_id, thread_id } = data as { doc_id: number; thread_id: number };
      if (state.activeDocId === doc_id) {
        useDocuments.setState((s) => ({
          threads: s.threads.filter((t) => t.id !== thread_id),
        }));
      }
    }
  });
}

/** Open the documents app on a specific document (chat cards, canvas, ⌘K). */
export async function openDocumentById(id: number): Promise<void> {
  const { openServerDoc } = await import("./navigation");
  await openServerDoc(id);
}

// Leaving a server — sign-out, expiry, or switching servers — retires the
// open document (its unsent edits stay in the outbox, pinned to the server
// they belong to) and forgets this server's lists.
let lastScope = scopeOf(useSession.getState());
useSession.subscribe((s) => {
  const scope = scopeOf(s);
  if (scope === lastScope) return;
  lastScope = scope;
  const old = provider;
  provider = null;
  if (old) retire(old);
  useDocuments.setState({
    ...EMPTY_DOC_STATE,
    items: [],
    folders: [],
    trash: [],
    trashSupported: null,
    loaded: false,
    loadError: null,
    pendingPanel: null,
    error: null,
  });
});

// Signing out waits (briefly) for the open document to send what it has.
onBeforeLogout(async () => {
  await provider?.flush(2000);
});

// Backgrounding, closing the window or quitting: push unsent edits now.
onFlush({
  pending: () => provider?.hasUnsent() ?? false,
  flush: () => provider?.flush(1800) ?? Promise.resolve(),
});
