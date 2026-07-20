import { create } from "zustand";

import type { Document } from "../../bindings/proto/Document";
import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import type { DocumentShare } from "../../bindings/proto/DocumentShare";
import type { DocumentThread } from "../../bindings/proto/DocumentThread";
import type { DocumentThreadMessage } from "../../bindings/proto/DocumentThreadMessage";
import type { DocumentVersionMeta } from "../../bindings/proto/DocumentVersionMeta";
import { backend, isCmdError } from "../../lib/backend";
import { documentsApi } from "./api";
import { DocProvider } from "./collab";

/** The open document's live sync provider (module-level: one at a time). */
let provider: DocProvider | null = null;

export function activeProvider(): DocProvider | null {
  return provider;
}

interface DocumentsState {
  items: DocumentListItem[];
  loaded: boolean;
  activeDocId: number | null;
  meta: Document | null;
  myAccess: string | null;
  versions: DocumentVersionMeta[];
  shares: DocumentShare[];
  threads: DocumentThread[];
  error: string | null;

  load: () => Promise<void>;
  openDocument: (id: number) => Promise<void>;
  closeDocument: () => void;
  refreshVersions: () => Promise<void>;
  refreshShares: () => Promise<void>;
  refreshThreads: () => Promise<void>;
  clearError: () => void;
}

export const useDocuments = create<DocumentsState>((set, get) => ({
  items: [],
  loaded: false,
  activeDocId: null,
  meta: null,
  myAccess: null,
  versions: [],
  shares: [],
  threads: [],
  error: null,

  load: async () => {
    const items = await documentsApi.list();
    set({ items, loaded: true });
  },

  openDocument: async (id) => {
    get().closeDocument();
    const next = new DocProvider(id);
    provider = next;
    set({ activeDocId: id, meta: null, myAccess: null, versions: [], shares: [], threads: [] });
    try {
      const detail = await next.open();
      // A slow open may have been superseded or closed meanwhile.
      if (provider !== next) {
        next.destroy();
        return;
      }
      set({ meta: detail.document, myAccess: detail.my_access });
      void get().refreshThreads();
      void get().refreshVersions();
      if (detail.my_access === "owner") void get().refreshShares();
    } catch (e) {
      if (provider === next) get().closeDocument();
      set({ error: isCmdError(e) ? e.message : String(e) });
      throw e;
    }
  },

  closeDocument: () => {
    provider?.destroy();
    provider = null;
    set({
      activeDocId: null,
      meta: null,
      myAccess: null,
      versions: [],
      shares: [],
      threads: [],
    });
  },

  refreshVersions: async () => {
    const id = get().activeDocId;
    if (id === null) return;
    const versions = await documentsApi.versions(id).catch(() => []);
    if (get().activeDocId === id) set({ versions });
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
      if (state.loaded) void state.load();
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

/** Open the documents app on a specific document (chat cards, canvas). */
export async function openDocumentById(id: number): Promise<void> {
  const { usePlatform } = await import("../../platform");
  usePlatform.getState().setActiveApp("writform.documents");
  await useDocuments.getState().openDocument(id);
}
