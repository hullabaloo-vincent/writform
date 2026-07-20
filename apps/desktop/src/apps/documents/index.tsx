import { FileText } from "lucide-react";

import { onResync } from "../../platform";
import type { WritformApp } from "../../platform";
import { DocumentsView } from "./DocumentsView";
import { activeProvider, installDocumentsWsHandler, useDocuments } from "./store";

export const documentsApp: WritformApp = {
  manifest: {
    id: "writform.documents",
    name: "Writing",
    icon: <FileText size={20} />,
    permissions: ["ui", "commands", "net", "events", "editor"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <DocumentsView />);
    installDocumentsWsHandler();
    onResync(() => {
      const s = useDocuments.getState();
      if (s.loaded) void s.load().catch(() => {});
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
  },
};
