import { create } from "zustand";

import type { Channel } from "../../bindings/proto/Channel";
import type { Emote } from "../../bindings/proto/Emote";
import type { Group } from "../../bindings/proto/Group";
import type { Member } from "../../bindings/proto/Member";
import type { Message } from "../../bindings/proto/Message";
import { backend } from "../../lib/backend";
import { toastError } from "../../platform";
import { useSession } from "../../stores/session";
import { useFriends } from "../friends/store";
import { chatApi } from "./api";

/** A message the server hasn't confirmed yet (or failed to accept). */
export interface OutboxEntry {
  key: string;
  channelId: number;
  content: string;
  attachmentIds: number[];
  replyToId: number | null;
  state: "sending" | "failed";
}

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

  /** channel id → group id, for EVERY group (drives unread classification). */
  channelGroup: Record<number, number>;
  /** Highest message id considered read per channel (persisted locally). */
  lastRead: Record<number, number>;
  /** Live unread counts per channel (this app run; local-only by design). */
  unread: Record<number, number>;
  /** Channels whose full history has been paged to the top. */
  historyDone: Record<number, boolean>;
  /** Composer drafts by channel id — survive channel and app switches. */
  drafts: Record<number, string>;
  /** Pending/failed sends, rendered after the message list. */
  outbox: OutboxEntry[];
  /** Message being edited inline (set by actions or ArrowUp). */
  editingMessageId: number | null;
  /** Message the composer is replying to. */
  replyTo: Message | null;

  loadGroups: () => Promise<void>;
  selectGroup: (groupId: number) => Promise<void>;
  selectChannel: (channelId: number) => Promise<void>;
  send: (content: string, attachmentIds?: number[]) => Promise<void>;
  retrySend: (key: string) => Promise<void>;
  discardSend: (key: string) => void;
  /** Load an older page of history; resolves to how many were prepended. */
  loadOlder: (channelId: number) => Promise<number>;
  markRead: (channelId: number) => void;
  setDraft: (channelId: number, text: string) => void;
  setEditing: (messageId: number | null) => void;
  setReplyTo: (message: Message | null) => void;
}

/** lastRead is per-server: message ids from different servers don't mix. */
function lastReadKey(): string | null {
  const session = useSession.getState().session;
  return session ? `wf-last-read:${session.addr}` : null;
}

function loadLastRead(): Record<number, number> {
  const key = lastReadKey();
  if (!key) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number") out[Number(k)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveLastRead(lastRead: Record<number, number>) {
  const key = lastReadKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(lastRead));
  } catch {
    // persistence is best-effort
  }
}

let outboxSeq = 1;
/** Guards double unread-counting when a DM arrives via two rooms. */
const countedIds = new Set<number>();
/** In-flight older-page fetches, so scroll events don't stack requests. */
const loadingOlder = new Set<number>();

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
  channelGroup: {},
  lastRead: {},
  unread: {},
  historyDone: {},
  drafts: {},
  outbox: [],
  editingMessageId: null,
  replyTo: null,

  loadGroups: async () => {
    const groups = await chatApi.myGroups();
    set({ groups, lastRead: loadLastRead() });
    // Watch every group room for membership/presence/channel changes.
    await backend.wsSub(groups.map((g) => `group:${g.id}`));
    // Every channel room too — unread counting needs message.created from
    // channels we aren't viewing (they broadcast to channel rooms only).
    const perGroup = await Promise.all(
      groups.map((g) => chatApi.channels(g.id).catch(() => [] as Channel[])),
    );
    const channelGroup: Record<number, number> = {};
    const rooms: string[] = [];
    perGroup.flat().forEach((c) => {
      if (c.kind !== "text" || c.group_id === null) return;
      channelGroup[c.id] = c.group_id;
      rooms.push(`channel:${c.id}`);
    });
    set({ channelGroup });
    if (rooms.length) await backend.wsSub(rooms);

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
      replyTo: null,
      editingMessageId: null,
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
    set({ activeChannelId: channelId, replyTo: null, editingMessageId: null });
    get().markRead(channelId);
    await backend.wsSub([`channel:${channelId}`]);
    if (channelId in get().messages) return; // cached — WS keeps it current
    const history = await chatApi.messages(channelId);
    set((s) => ({
      messages: { ...s.messages, [channelId]: history },
      historyDone: { ...s.historyDone, [channelId]: history.length < 50 },
    }));
    get().markRead(channelId);
  },

  send: async (content, attachmentIds = []) => {
    const { activeChannelId, replyTo } = get();
    if (activeChannelId === null) return;
    const key = `out-${outboxSeq++}`;
    const entry: OutboxEntry = {
      key,
      channelId: activeChannelId,
      content,
      attachmentIds,
      replyToId: replyTo?.id ?? null,
      state: "sending",
    };
    set((s) => ({ outbox: [...s.outbox, entry], replyTo: null }));
    await deliver(entry);
  },

  retrySend: async (key) => {
    const entry = get().outbox.find((o) => o.key === key);
    if (!entry || entry.state === "sending") return;
    set((s) => ({
      outbox: s.outbox.map((o) => (o.key === key ? { ...o, state: "sending" } : o)),
    }));
    await deliver({ ...entry, state: "sending" });
  },

  discardSend: (key) => {
    set((s) => ({ outbox: s.outbox.filter((o) => o.key !== key) }));
  },

  loadOlder: async (channelId) => {
    const s = get();
    const list = s.messages[channelId];
    if (!list?.length || s.historyDone[channelId] || loadingOlder.has(channelId)) return 0;
    loadingOlder.add(channelId);
    try {
      const older = await chatApi.messages(channelId, list[0].id);
      if (older.length === 0) {
        set((cur) => ({ historyDone: { ...cur.historyDone, [channelId]: true } }));
        return 0;
      }
      let added = 0;
      set((cur) => {
        const current = cur.messages[channelId] ?? [];
        const known = new Set(current.map((m) => m.id));
        const fresh = older.filter((m) => !known.has(m.id));
        added = fresh.length;
        return {
          messages: { ...cur.messages, [channelId]: [...fresh, ...current] },
          historyDone: { ...cur.historyDone, [channelId]: older.length < 50 },
        };
      });
      return added;
    } finally {
      loadingOlder.delete(channelId);
    }
  },

  markRead: (channelId) => {
    set((s) => {
      const list = s.messages[channelId];
      const latest = list?.[list.length - 1]?.id;
      const lastRead =
        latest !== undefined && latest !== s.lastRead[channelId]
          ? { ...s.lastRead, [channelId]: latest }
          : s.lastRead;
      if (lastRead !== s.lastRead) saveLastRead(lastRead);
      if ((s.unread[channelId] ?? 0) === 0 && lastRead === s.lastRead) return s;
      const unread = { ...s.unread };
      delete unread[channelId];
      return { lastRead, unread };
    });
  },

  setDraft: (channelId, text) => {
    set((s) => {
      if ((s.drafts[channelId] ?? "") === text) return s;
      const drafts = { ...s.drafts };
      if (text) drafts[channelId] = text;
      else delete drafts[channelId];
      return { drafts };
    });
  },

  setEditing: (messageId) => set({ editingMessageId: messageId }),
  setReplyTo: (message) => set({ replyTo: message, editingMessageId: null }),
}));

/** POST an outbox entry; success swaps it for the real message, failure keeps it. */
async function deliver(entry: OutboxEntry): Promise<void> {
  try {
    const message = await chatApi.sendMessage(
      entry.channelId,
      entry.content,
      entry.attachmentIds,
      entry.replyToId,
    );
    useChat.setState((s) => {
      const existing = s.messages[entry.channelId] ?? [];
      const messages = existing.some((m) => m.id === message.id)
        ? s.messages
        : { ...s.messages, [entry.channelId]: [...existing, message] };
      return { outbox: s.outbox.filter((o) => o.key !== entry.key), messages };
    });
    useChat.getState().markRead(entry.channelId);
  } catch {
    useChat.setState((s) => ({
      outbox: s.outbox.map((o) => (o.key === entry.key ? { ...o, state: "failed" } : o)),
    }));
    toastError("Message didn't send — retry or discard it below.");
  }
}

/** Focus returning to the window reads the channel you're looking at. */
export function installUnreadFocusSync(): () => void {
  const onFocus = () => {
    const { activeChannelId, markRead } = useChat.getState();
    if (activeChannelId !== null) markRead(activeChannelId);
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}

/** Reconnect catch-up: refresh group/member state and pull missed messages. */
export async function resyncChat(): Promise<void> {
  const state = useChat.getState();
  const groups = await chatApi.myGroups();
  useChat.setState({ groups });
  await backend.wsSub(groups.map((g) => `group:${g.id}`));

  // Channel topology may have changed while offline; re-derive the map and
  // room subscriptions (unread counting depends on them).
  const perGroup = await Promise.all(
    groups.map((g) => chatApi.channels(g.id).catch(() => [] as Channel[])),
  );
  const channelGroup: Record<number, number> = {};
  const rooms: string[] = [];
  perGroup.flat().forEach((c) => {
    if (c.kind !== "text" || c.group_id === null) return;
    channelGroup[c.id] = c.group_id;
    rooms.push(`channel:${c.id}`);
  });
  useChat.setState({ channelGroup });
  if (rooms.length) await backend.wsSub(rooms);

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
      noteUnread(fresh);
    } catch {
      // channel may be gone (kicked, deleted) — the next selection reloads
    }
  }
}

/** Count messages that arrived un-viewed (WS or resync catch-up). */
function noteUnread(incoming: Message[]): void {
  const meId = useSession.getState().session?.user.id;
  const { activeChannelId, channelGroup, lastRead } = useChat.getState();
  for (const message of incoming) {
    if (countedIds.has(message.id)) continue;
    countedIds.add(message.id);
    if (message.author.id === meId) continue;
    if ((lastRead[message.channel_id] ?? 0) >= message.id) continue;

    const isGroupChannel = message.channel_id in channelGroup;
    const viewing =
      message.channel_id === activeChannelId && document.hasFocus();
    if (isGroupChannel) {
      if (viewing) continue;
      useChat.setState((s) => ({
        unread: {
          ...s.unread,
          [message.channel_id]: (s.unread[message.channel_id] ?? 0) + 1,
        },
      }));
    } else {
      // Not one of my group channels → a DM (they land in `user:{id}` rooms).
      useFriends.getState().noteIncoming(message.author.id);
    }
  }
  // The counted-id guard only needs to cover in-flight double delivery.
  if (countedIds.size > 4000) {
    const drop = [...countedIds].slice(0, 2000);
    for (const id of drop) countedIds.delete(id);
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
      noteUnread([message]);
      // Viewing the channel with focus = read immediately.
      if (message.channel_id === state.activeChannelId && document.hasFocus()) {
        state.markRead(message.channel_id);
      }
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
      if (channel.kind === "text" && channel.group_id !== null) {
        const groupId = channel.group_id;
        useChat.setState((s) => ({
          channelGroup: { ...s.channelGroup, [channel.id]: groupId },
        }));
        void backend.wsSub([`channel:${channel.id}`]);
      }
    } else if (kind === "channel.updated") {
      const channel = data as Channel;
      useChat.setState((s) => ({
        channels: s.channels.map((c) => (c.id === channel.id ? channel : c)),
      }));
    } else if (kind === "channel.deleted") {
      const { channel_id } = data as { channel_id: number };
      useChat.setState((s) => {
        const channelGroup = { ...s.channelGroup };
        delete channelGroup[channel_id];
        const messages = { ...s.messages };
        delete messages[channel_id];
        const unread = { ...s.unread };
        delete unread[channel_id];
        const drafts = { ...s.drafts };
        delete drafts[channel_id];
        return {
          channels: s.channels.filter((c) => c.id !== channel_id),
          channelGroup,
          messages,
          unread,
          drafts,
        };
      });
      // If the open channel just vanished, land on the next text channel.
      const after = useChat.getState();
      if (after.activeChannelId === channel_id) {
        const next = after.channels.find((c) => c.kind === "text");
        if (next) void after.selectChannel(next.id);
        else useChat.setState({ activeChannelId: null });
      }
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
    } else if (kind === "message.reactions") {
      // The server sends the full tally for the message, so clients converge
      // even if they missed an earlier add/remove. `me` is per-viewer and is
      // derived here from the user id list.
      const { channel_id, message_id, reactions } = data as {
        channel_id: number;
        message_id: number;
        reactions: { emoji: string; count: number; user_ids: number[]; users: string[] }[];
      };
      const meId = useSession.getState().session?.user.id;
      useChat.setState((s) => {
        const list = s.messages[channel_id];
        if (!list) return s;
        return {
          messages: {
            ...s.messages,
            [channel_id]: list.map((m) =>
              m.id === message_id
                ? {
                    ...m,
                    reactions: reactions.map((r) => ({
                      emoji: r.emoji,
                      count: r.count,
                      me: meId !== undefined && r.user_ids.includes(meId),
                      users: r.users,
                    })),
                  }
                : m,
            ),
          },
        };
      });
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

/** Re-fetch presence whenever the socket comes up. */
/*
 * Presence is the one piece of state whose correctness depends on OTHER
 * users' live sockets, and the snapshot in `selectGroup` is fetched while our
 * own `sub` may still be in flight — `wsSub` only queues the rooms. Any
 * `presence.update` broadcast in that window goes to a room we have not
 * joined yet and is lost for good, leaving that member grey until something
 * else forces a refetch. `onResync` deliberately skips the very first
 * connect, so this cannot rely on it.
 */
export function installChatPresenceSync(): () => void {
  return backend.onWsStatus((connected) => {
    if (!connected) return;
    const { activeGroupId } = useChat.getState();
    if (activeGroupId === null) return;
    void chatApi
      .presence(activeGroupId)
      .then((presence) => {
        // Still the same group after the round-trip?
        if (useChat.getState().activeGroupId !== activeGroupId) return;
        useChat.setState({
          online: new Set(presence.online),
          busy: new Set(presence.busy ?? []),
        });
      })
      .catch(() => {
        // Presence is cosmetic; a failed refresh retries on the next connect.
      });
  });
}
