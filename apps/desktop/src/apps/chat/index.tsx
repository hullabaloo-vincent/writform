import { MessagesSquare } from "lucide-react";
import { onResync } from "../../platform";
import type { WritformApp } from "../../platform";
import { ChatView } from "./ChatView";
import { installChatWsHandler, resyncChat } from "./store";
import { installVoiceWsHandler } from "./voice";

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
    installVoiceWsHandler();
    onResync(() => void resyncChat().catch(() => {}));
    onResync(() => {
      // Voice occupancy may have changed while offline.
      void import("./store").then(({ useChat }) => {
        const groupId = useChat.getState().activeGroupId;
        if (groupId !== null) {
          void import("./voice").then(({ useVoice }) =>
            useVoice.getState().loadChannels(groupId).catch(() => {}),
          );
        }
      });
    });
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
