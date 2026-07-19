import { create } from "zustand";

import type { Channel } from "../../bindings/proto/Channel";
import type { Emote } from "../../bindings/proto/Emote";
import type { Group } from "../../bindings/proto/Group";
import type { Member } from "../../bindings/proto/Member";
import type { Message } from "../../bindings/proto/Message";
import { backend } from "../../lib/backend";
import { chatApi } from "./api";

interface ChatState {
  groups: Group[];
  activeGroupId: number | null;
  channels: Channel[];
  activeChannelId: number | null;
  messages: Record<number, Message[]>;
  members: Member[];
  online: Set<number>;
  /** Members whose status is "busy" (subset semantics like `online`). */
  busy: Set<number>;
  /** Custom emotes of the active group. */
  emotes: Emote[];

  loadGroups: () => Promise<void>;
  selectGroup: (groupId: number) => Promise<void>;
  selectChannel: (channelId: number) => Promise<void>;
  send: (content: string, attachmentIds?: number[]) => Promise<void>;
}

export const useChat = create<ChatState>((set, get) => ({
  groups: [],
  activeGroupId: null,
  channels: [],
  activeChannelId: null,
  messages: {},
  members: [],
  online: new Set(),
  busy: new Set(),
  emotes: [],

  loadGroups: async () => {
    const groups = await chatApi.myGroups();
    set({ groups });
    // Watch every group room for membership/presence/channel changes.
    await backend.wsSub(groups.map((g) => `group:${g.id}`));
    const { activeGroupId } = get();
    if (activeGroupId === null && groups.length > 0) {
      await get().selectGroup(groups[0].id);
    }
  },

  selectGroup: async (groupId) => {
    set({
      activeGroupId: groupId,
      channels: [],
      activeChannelId: null,
      members: [],
      emotes: [],
    });
    const [channels, members, presence, emotes] = await Promise.all([
      chatApi.channels(groupId),
      chatApi.members(groupId),
      chatApi.presence(groupId),
      chatApi.emotes(groupId),
    ]);
    set({
      channels,
      members,
      online: new Set(presence.online),
      busy: new Set(presence.busy ?? []),
      emotes,
    });
    const first = channels.find((c) => c.kind === "text");
    if (first) await get().selectChannel(first.id);
  },

  selectChannel: async (channelId) => {
    set({ activeChannelId: channelId });
    await backend.wsSub([`channel:${channelId}`]);
    const history = await chatApi.messages(channelId);
    set((s) => ({ messages: { ...s.messages, [channelId]: history } }));
  },

  send: async (content, attachmentIds = []) => {
    const { activeChannelId } = get();
    if (activeChannelId === null) return;
    await chatApi.sendMessage(activeChannelId, content, attachmentIds);
    // The message lands via ws fan-out; nothing else to do.
  },
}));

/** Reconnect catch-up: refresh group/member state and pull missed messages. */
export async function resyncChat(): Promise<void> {
  const state = useChat.getState();
  const groups = await chatApi.myGroups();
  useChat.setState({ groups });
  await backend.wsSub(groups.map((g) => `group:${g.id}`));

  if (state.activeGroupId !== null && groups.some((g) => g.id === state.activeGroupId)) {
    const [channels, members, presence, emotes] = await Promise.all([
      chatApi.channels(state.activeGroupId),
      chatApi.members(state.activeGroupId),
      chatApi.presence(state.activeGroupId),
      chatApi.emotes(state.activeGroupId),
    ]);
    useChat.setState({
      channels,
      members,
      online: new Set(presence.online),
      busy: new Set(presence.busy ?? []),
      emotes,
    });
  }

  // `?after=` catch-up for every channel we hold history for.
  for (const [cid, existing] of Object.entries(state.messages)) {
    const channelId = Number(cid);
    const last = existing[existing.length - 1];
    try {
      const fresh = last
        ? await chatApi.messagesAfter(channelId, last.id)
        : await chatApi.messages(channelId);
      if (fresh.length === 0) continue;
      useChat.setState((s) => {
        const current = s.messages[channelId] ?? [];
        const known = new Set(current.map((m) => m.id));
        const additions = fresh.filter((m) => !known.has(m.id));
        if (additions.length === 0) return s;
        return { messages: { ...s.messages, [channelId]: [...current, ...additions] } };
      });
    } catch {
      // channel may be gone (kicked, deleted) — the next selection reloads
    }
  }
}

/** Apply WS events to the store. Installed once from the chat app. */
export function installChatWsHandler(): () => void {
  return backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const { kind, data } = event;
    const state = useChat.getState();

    if (kind === "message.created") {
      const message = data as Message;
      useChat.setState((s) => {
        const existing = s.messages[message.channel_id] ?? [];
        if (existing.some((m) => m.id === message.id)) return s;
        return {
          messages: { ...s.messages, [message.channel_id]: [...existing, message] },
        };
      });
    } else if (kind === "message.deleted") {
      const { message_id, channel_id } = data as { message_id: number; channel_id: number };
      useChat.setState((s) => ({
        messages: {
          ...s.messages,
          [channel_id]: (s.messages[channel_id] ?? []).filter((m) => m.id !== message_id),
        },
      }));
    } else if (kind === "message.edited") {
      const { message_id, channel_id, content, edited_at } = data as {
        message_id: number;
        channel_id: number;
        content: string;
        edited_at: number;
      };
      useChat.setState((s) => ({
        messages: {
          ...s.messages,
          [channel_id]: (s.messages[channel_id] ?? []).map((m) =>
            m.id === message_id ? { ...m, content, edited_at } : m,
          ),
        },
      }));
    } else if (kind === "channel.created") {
      const channel = data as Channel;
      if (channel.group_id === state.activeGroupId) {
        useChat.setState((s) => ({ channels: [...s.channels, channel] }));
      }
    } else if (kind === "channel.deleted") {
      const { channel_id } = data as { channel_id: number };
      useChat.setState((s) => ({ channels: s.channels.filter((c) => c.id !== channel_id) }));
    } else if (kind === "group.updated") {
      const { group_id, name, icon_attachment_id, accent_color } = data as {
        group_id: number;
        name: string;
        icon_attachment_id: number | null;
        accent_color: string | null;
      };
      useChat.setState((s) => ({
        groups: s.groups.map((g) =>
          g.id === group_id ? { ...g, name, icon_attachment_id, accent_color } : g,
        ),
      }));
    } else if (kind === "emote.created") {
      const emote = data as Emote;
      if (emote.group_id === state.activeGroupId) {
        useChat.setState((s) =>
          s.emotes.some((e) => e.id === emote.id) ? s : { emotes: [...s.emotes, emote] },
        );
      }
    } else if (kind === "emote.deleted") {
      const { emote_id } = data as { emote_id: number };
      useChat.setState((s) => ({ emotes: s.emotes.filter((e) => e.id !== emote_id) }));
    } else if (kind === "presence.update") {
      const { user_id, online, status } = data as {
        user_id: number;
        online: boolean;
        status?: string | null;
      };
      useChat.setState((s) => {
        const nextOnline = new Set(s.online);
        const nextBusy = new Set(s.busy);
        nextOnline.delete(user_id);
        nextBusy.delete(user_id);
        if (online) {
          if (status === "busy") nextBusy.add(user_id);
          else nextOnline.add(user_id);
        }
        return { online: nextOnline, busy: nextBusy };
      });
    } else if (kind === "member.joined" || kind === "member.left") {
      const { group_id } = data as { group_id: number };
      if (group_id === state.activeGroupId) {
        void chatApi.members(group_id).then((members) => useChat.setState({ members }));
      }
    } else if (kind === "group.removed") {
      void state.loadGroups();
    }
  });
}
