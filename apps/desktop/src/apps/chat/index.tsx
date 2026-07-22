import { MessagesSquare } from "lucide-react";
import { onResync, usePlatform } from "../../platform";
import type { WritformApp } from "../../platform";
import { useFriends } from "../friends/store";
import { ChatView, GlobalVoiceBar } from "./ChatView";
import {
  installChatPresenceSync,
  installChatWsHandler,
  installUnreadFocusSync,
  resyncChat,
  useChat,
} from "./store";
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
    // Voice controls live in the statusbar so they follow you across apps.
    ctx.ui.addToSlot("statusbar", {
      id: "chat.voicebar",
      render: () => <GlobalVoiceBar />,
    });
    installChatWsHandler();
    installChatPresenceSync();
    installUnreadFocusSync();
    installVoiceWsHandler();
    // Dock badges: total group-channel unread on Chat, DM unread on Friends.
    useChat.subscribe((s) => {
      const total = Object.values(s.unread).reduce((n, c) => n + c, 0);
      usePlatform.getState().setAppBadge("writform.chat", total);
    });
    useFriends.subscribe((s) => {
      const total = Object.values(s.dmUnread).reduce((n, c) => n + c, 0);
      usePlatform.getState().setAppBadge("writform.friends", total);
    });
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
