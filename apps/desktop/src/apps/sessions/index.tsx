import { PenLine } from "lucide-react";
import type { WritformApp } from "../../platform";
import { SessionsView } from "./SessionsView";
import { installSessionsWsHandler } from "./store";

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
