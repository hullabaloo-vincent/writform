import { MessagesSquare } from "lucide-react";
import { onResync, usePlatform } from "../../platform";
import type { WritformApp } from "../../platform";
import { useSession } from "../../stores/session";
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
    // Muted channels keep their counts but never reach a badge.
    useChat.subscribe((s) => {
      const total = Object.entries(s.unread).reduce(
        (n, [cid, c]) => (s.muted.has(Number(cid)) ? n : n + c),
        0,
      );
      usePlatform.getState().setAppBadge("writform.chat", total);
    });
    useFriends.subscribe((s) => {
      const total = Object.values(s.dmUnread).reduce((n, c) => n + c, 0);
      usePlatform.getState().setAppBadge("writform.friends", total);
    });
    // Mirror the active group's accent into a CSS variable so platform
    // chrome (the app-rail stripe) can show it without importing app code.
    const syncGroupAccent = () => {
      const s = useChat.getState();
      const accent =
        useSession.getState().phase === "connected"
          ? (s.groups.find((g) => g.id === s.activeGroupId)?.accent_color ?? null)
          : null;
      if (accent) document.documentElement.style.setProperty("--wf-group-accent", accent);
      else document.documentElement.style.removeProperty("--wf-group-accent");
    };
    useChat.subscribe(syncGroupAccent);
    useSession.subscribe(syncGroupAccent);
    syncGroupAccent();
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
    // ⌘K quick switcher: groups and every text channel across all groups.
    ctx.palette.registerSource({
      id: "chat.places",
      search: async (q) => {
        const s = useChat.getState();
        const needle = q.toLowerCase();
        const items = [];
        for (const g of s.groups) {
          if (!g.name.toLowerCase().includes(needle)) continue;
          items.push({
            id: `group-${g.id}`,
            title: g.name,
            subtitle: "Group",
            run: async () => {
              usePlatform.getState().setActiveApp("writform.chat");
              await useChat.getState().selectGroup(g.id);
            },
          });
        }
        for (const [cidStr, name] of Object.entries(s.channelNames)) {
          if (!name.toLowerCase().includes(needle)) continue;
          const cid = Number(cidStr);
          const gid = s.channelGroup[cid];
          items.push({
            id: `channel-${cid}`,
            title: `# ${name}`,
            subtitle: s.groups.find((g) => g.id === gid)?.name,
            run: async () => {
              usePlatform.getState().setActiveApp("writform.chat");
              const chat = useChat.getState();
              if (chat.activeGroupId !== gid) await chat.selectGroup(gid);
              await chat.selectChannel(cid);
            },
          });
        }
        return items;
      },
    });
  },
};
