import { PenLine } from "lucide-react";
import { onResync } from "../../platform";
import type { WritformApp } from "../../platform";
import { SessionsView } from "./SessionsView";
import { installSessionsWsHandler, useSessions } from "./store";

export const sessionsApp: WritformApp = {
  manifest: {
    id: "writform.sessions",
    name: "Sessions",
    icon: <PenLine size={20} />,
    permissions: ["ui", "commands", "net", "events", "editor"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <SessionsView />);
    installSessionsWsHandler();
    onResync(() => {
      const s = useSessions.getState();
      void s.refreshDetail().catch(() => {});
      for (const channelId of Object.keys(s.byChannel)) {
        void s.loadChannel(Number(channelId)).catch(() => {});
      }
    });
    ctx.commands.register({
      id: "sessions.open",
      title: "Sessions: Open",
      run: () => {
        void import("../../platform").then(({ usePlatform }) =>
          usePlatform.getState().setActiveApp("writform.sessions"),
        );
      },
    });
  },
};
