import { MessagesSquare } from "lucide-react";
import type { WritformApp } from "../../platform";
import { ChatView } from "./ChatView";
import { installChatWsHandler } from "./store";

export const chatApp: WritformApp = {
  manifest: {
    id: "writform.chat",
    name: "Chat",
    icon: <MessagesSquare size={20} />,
    permissions: ["ui", "commands", "net", "events"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <ChatView />);
    installChatWsHandler();
    ctx.commands.register({
      id: "chat.open",
      title: "Chat: Open",
      run: () => {
        // Platform routes by manifest id; imported lazily to avoid a cycle.
        void import("../../platform").then(({ usePlatform }) =>
          usePlatform.getState().setActiveApp("writform.chat"),
        );
      },
    });
  },
};
