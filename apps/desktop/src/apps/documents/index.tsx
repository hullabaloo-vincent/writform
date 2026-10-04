import { FileText } from "lucide-react";

import { isWeb } from "../../lib/backend";
import { useSession } from "../../stores/session";
import { onResync } from "../../platform";
import type { WritformApp } from "../../platform";
import { documentsApi } from "./api";
import { DocumentsView } from "./DocumentsView";
import { useLocalDocs } from "./local";
import { openLocalDoc } from "./navigation";
import { drainOutbox } from "./sync/drain";
import { activeProvider, installDocumentsWsHandler, openDocumentById, useDocuments } from "./store";

export const documentsApp: WritformApp = {
  manifest: {
    id: "writform.documents",
    name: "Writing",
    icon: <FileText size={20} />,
    permissions: ["ui", "commands", "net", "events", "editor"],
    offline: true,
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <DocumentsView />);
    installDocumentsWsHandler();
    // Edits left unsent (quit, crash, dropped connection) go out on sign-in,
    // on reconnect, and once a minute while connected.
    useSession.subscribe((s, prev) => {
      if (s.phase === "connected" && prev.phase !== "connected") {
        setTimeout(() => void drainOutbox().catch(() => {}), 1500);
      }
    });
    if (useSession.getState().phase === "connected") void drainOutbox().catch(() => {});
    setInterval(() => {
      if (useSession.getState().phase === "connected") void drainOutbox().catch(() => {});
    }, 60_000);
    onResync(() => {
      void drainOutbox().catch(() => {});
      const s = useDocuments.getState();
      if (s.loaded) {
        void s.load().catch(() => {});
        void s.loadFolders().catch(() => {});
      }
      const provider = activeProvider();
      if (provider) {
        void provider.catchUp();
        void s.refreshThreads();
        void s.refreshVersions();
      }
    });
    ctx.commands.register({
      id: "documents.open",
      title: "Documents: Open",
      run: () => {
        void import("../../platform").then(({ usePlatform }) =>
          usePlatform.getState().setActiveApp("writform.documents"),
        );
      },
    });
    // ⌘K quick switcher: server documents (title+content search) and
    // on-device documents (title match).
    ctx.palette.registerSource({
      id: "documents.docs",
      search: async (q) => {
        const needle = q.toLowerCase();
        const items = [];
        const docs = await documentsApi.search(q).catch(() => []);
        for (const { document } of docs.slice(0, 6)) {
          items.push({
            id: `doc-${document.id}`,
            title: document.title || "Untitled",
            subtitle: "Document",
            run: () => void openDocumentById(document.id).catch(() => {}),
          });
        }
        if (!isWeb) {
          const local = useLocalDocs.getState();
          if (!local.loaded) await local.load().catch(() => {});
          for (const d of useLocalDocs.getState().items) {
            if (!d.title.toLowerCase().includes(needle)) continue;
            items.push({
              id: `localdoc-${d.id}`,
              title: d.title || "Untitled",
              subtitle: "On this device",
              run: () => void openLocalDoc(d.id).catch(() => {}),
            });
          }
        }
        return items.slice(0, 8);
      },
    });
  },
};
