import { create } from "zustand";

import type { Channel } from "../../bindings/proto/Channel";
import type { Emote } from "../../bindings/proto/Emote";
import type { Group } from "../../bindings/proto/Group";
import type { Member } from "../../bindings/proto/Member";
import type { Message } from "../../bindings/proto/Message";
import type { UserRef } from "../../bindings/proto/UserRef";
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

/** One entry of a channel's pin tally (bodies are fetched on demand).
 *  `pinned_by` is only known from WS tallies, not the REST seed. */
export interface PinInfo {
  message_id: number;
  pinned_by?: number;
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
  /** channel id → name, for EVERY group (drives the ⌘K quick switcher). */
  channelNames: Record<number, string>;
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
  /** Who's typing per channel; entries age out on a short TTL. */
  typing: Record<number, { user: UserRef; until: number }[]>;
  /** Pin tallies per channel (kept fresh by `channel.pins` events). */
  pins: Record<number, PinInfo[]>;
  /** Channels silenced on this device: no notifications, no badge counts. */
  muted: Set<number>;
  /** Read marker as it stood when the channel was opened — where the
   *  "New messages" divider draws. */
  divider: Record<number, number>;
  /** Channels showing a jumped-to window instead of the live tail. */
  detached: Set<number>;
  /** Message to flash + centre after a jump. */
  highlightId: number | null;

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
  /** Tell the channel "I'm typing" (throttled; silent on old servers). */
  sendTyping: (channelId: number) => void;
  toggleMute: (channelId: number) => void;
  /** Jump to a message: swap in a window around it and detach from the tail. */
  openAround: (channelId: number, messageId: number) => Promise<void>;
  /** Leave a jumped-to window and reload the live tail. */
  reattach: (channelId: number) => void;
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

/** Muted channels are per-server too, and purely device-local. */
function mutedKey(): string | null {
  const session = useSession.getState().session;
  return session ? `wf-muted:${session.addr}` : null;
}

function loadMuted(): Set<number> {
  const key = mutedKey();
  if (!key) return new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "number") : []);
  } catch {
    return new Set();
  }
}

function saveMuted(muted: Set<number>) {
  const key = mutedKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify([...muted]));
  } catch {
    // persistence is best-effort
  }
}

/** Is this channel silenced on this device? (used by lib/notifications.ts) */
export function isChannelMuted(channelId: number): boolean {
  return useChat.getState().muted.has(channelId);
}

let outboxSeq = 1;
/** Guards double unread-counting when a DM arrives via two rooms. */
const countedIds = new Set<number>();
/** In-flight older-page fetches, so scroll events don't stack requests. */
const loadingOlder = new Set<number>();
/** Last outbound typing signal per channel (client-side throttle). */
const typingSentAt: Record<number, number> = {};
/** Debounce timers + high-water marks for read-marker PUTs. */
const readSyncTimers: Record<number, ReturnType<typeof setTimeout>> = {};
const readSynced: Record<number, number> = {};

/** Push the local read marker to the server, debounced per channel. The
 *  server is forward-only, so firing blindly can never move it backwards;
 *  failures (old server, offline) simply leave read state device-local. */
function syncReadToServer(channelId: number): void {
  const target = useChat.getState().lastRead[channelId];
  if (!target || (readSynced[channelId] ?? 0) >= target) return;
  clearTimeout(readSyncTimers[channelId]);
  readSyncTimers[channelId] = setTimeout(() => {
    const id = useChat.getState().lastRead[channelId];
    if (!id || (readSynced[channelId] ?? 0) >= id) return;
    readSynced[channelId] = id;
    chatApi.markRead(channelId, id).catch(() => {
      // Retry on the next markRead rather than looping here.
      readSynced[channelId] = 0;
    });
  }, 800);
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
  channelGroup: {},
  channelNames: {},
  lastRead: {},
  unread: {},
  historyDone: {},
  drafts: {},
  outbox: [],
  editingMessageId: null,
  replyTo: null,
  typing: {},
  pins: {},
  muted: new Set(),
  divider: {},
  detached: new Set(),
  highlightId: null,

  loadGroups: async () => {
    const groups = await chatApi.myGroups();
    set({ groups, lastRead: loadLastRead(), muted: loadMuted() });
    // Watch every group room for membership/presence/channel changes.
    await backend.wsSub(groups.map((g) => `group:${g.id}`));
    // Every channel room too — unread counting needs message.created from
    // channels we aren't viewing (they broadcast to channel rooms only).
    const perGroup = await Promise.all(
      groups.map((g) => chatApi.channels(g.id).catch(() => [] as Channel[])),
    );
    const channelGroup: Record<number, number> = {};
    const channelNames: Record<number, string> = {};
    const rooms: string[] = [];
    perGroup.flat().forEach((c) => {
      if (c.kind !== "text" || c.group_id === null) return;
      channelGroup[c.id] = c.group_id;
      channelNames[c.id] = c.name ?? "";
      rooms.push(`channel:${c.id}`);
    });
    set({ channelGroup, channelNames });
    if (rooms.length) await backend.wsSub(rooms);
    await mergeServerReads();

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
    // The divider freezes where the read marker stood on entry, so the
    // "New messages" line stays put while reading marks everything read.
    const entryRead = get().lastRead[channelId] ?? 0;
    set((s) => {
      const detached = new Set(s.detached);
      detached.delete(channelId);
      return {
        activeChannelId: channelId,
        replyTo: null,
        editingMessageId: null,
        divider: { ...s.divider, [channelId]: entryRead },
        detached,
      };
    });
    get().markRead(channelId);
    await backend.wsSub([`channel:${channelId}`]);
    void chatApi
      .pins(channelId)
      .then((pinned) =>
        set((s) => ({
          pins: {
            ...s.pins,
            [channelId]: pinned.map((m) => ({ message_id: m.id })),
          },
        })),
      )
      .catch(() => {}); // older server — pins simply don't exist
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
    // A jumped-to window's newest message isn't "everything read" — the live
    // tail may hold newer ones we've never even fetched.
    if (get().detached.has(channelId)) return;
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
    syncReadToServer(channelId);
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

  sendTyping: (channelId) => {
    const now = Date.now();
    if (now - (typingSentAt[channelId] ?? 0) < 2500) return;
    typingSentAt[channelId] = now;
    // Older servers answer bad_frame; either way nobody needs the result.
    void backend.wsTyping(channelId).catch(() => {});
  },

  toggleMute: (channelId) => {
    set((s) => {
      const muted = new Set(s.muted);
      if (muted.has(channelId)) muted.delete(channelId);
      else muted.add(channelId);
      saveMuted(muted);
      return { muted };
    });
  },

  openAround: async (channelId, messageId) => {
    const window = await chatApi.messagesAround(channelId, messageId);
    await backend.wsSub([`channel:${channelId}`]);
    set((s) => {
      const detached = new Set(s.detached);
      detached.add(channelId);
      return {
        activeChannelId: channelId,
        replyTo: null,
        editingMessageId: null,
        messages: { ...s.messages, [channelId]: window },
        // The window has history on both sides; paging up still works.
        historyDone: { ...s.historyDone, [channelId]: false },
        detached,
        highlightId: messageId,
      };
    });
  },

  reattach: (channelId) => {
    set((s) => {
      const detached = new Set(s.detached);
      detached.delete(channelId);
      const messages = { ...s.messages };
      delete messages[channelId]; // drop the window; selectChannel refetches
      return { detached, messages, highlightId: null };
    });
    void get().selectChannel(channelId);
  },
}));

/** Overlay the server's read markers on the local cache (server wins; the
 *  cache covers channels the server has no row for, and older servers). */
async function mergeServerReads(): Promise<void> {
  let reads;
  try {
    reads = await chatApi.myReads();
  } catch {
    return; // older server — read state stays device-local
  }
  useChat.setState((s) => {
    const lastRead = { ...s.lastRead };
    const unread = { ...s.unread };
    for (const r of reads) {
      lastRead[r.channel_id] = Math.max(lastRead[r.channel_id] ?? 0, r.last_read_message_id);
      readSynced[r.channel_id] = Math.max(
        readSynced[r.channel_id] ?? 0,
        r.last_read_message_id,
      );
      if (
        r.unread_count > 0 &&
        r.channel_id !== s.activeChannelId &&
        (unread[r.channel_id] ?? 0) < r.unread_count
      ) {
        unread[r.channel_id] = r.unread_count;
      }
    }
    saveLastRead(lastRead);
    return { lastRead, unread };
  });
}

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
  const channelNames: Record<number, string> = {};
  const rooms: string[] = [];
  perGroup.flat().forEach((c) => {
    if (c.kind !== "text" || c.group_id === null) return;
    channelGroup[c.id] = c.group_id;
    channelNames[c.id] = c.name ?? "";
    rooms.push(`channel:${c.id}`);
  });
  useChat.setState({ channelGroup, channelNames });
  if (rooms.length) await backend.wsSub(rooms);
  await mergeServerReads();

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
  const { activeChannelId, channelGroup, lastRead, muted } = useChat.getState();
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
      // Muted channels still count (the row shows a dot) — the badge
      // rollups are what filter them out.
      useChat.setState((s) => ({
        unread: {
          ...s.unread,
          [message.channel_id]: (s.unread[message.channel_id] ?? 0) + 1,
        },
      }));
    } else if (!muted.has(message.channel_id)) {
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
  // Typing entries age out here — there is no "stopped typing" event.
  const prune = setInterval(() => {
    const { typing } = useChat.getState();
    const now = Date.now();
    let changed = false;
    const next: typeof typing = {};
    for (const [cid, list] of Object.entries(typing)) {
      const keep = list.filter((t) => t.until > now);
      if (keep.length !== list.length) changed = true;
      if (keep.length > 0) next[Number(cid)] = keep;
    }
    if (changed) useChat.setState({ typing: next });
  }, 1000);

  const off = backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const { kind, data } = event;
    const state = useChat.getState();

    if (kind === "message.created") {
      const message = data as Message;
      useChat.setState((s) => {
        // A jumped-to window must not grow a fake tail; unread still counts.
        if (s.detached.has(message.channel_id)) return s;
        const existing = s.messages[message.channel_id] ?? [];
        if (existing.some((m) => m.id === message.id)) return s;
        return {
          messages: { ...s.messages, [message.channel_id]: [...existing, message] },
        };
      });
      // Their message just landed — they're clearly done typing.
      useChat.setState((s) => {
        const list = s.typing[message.channel_id];
        if (!list?.some((t) => t.user.id === message.author.id)) return s;
        return {
          typing: {
            ...s.typing,
            [message.channel_id]: list.filter((t) => t.user.id !== message.author.id),
          },
        };
      });
      noteUnread([message]);
      // Viewing the channel with focus = read immediately.
      if (message.channel_id === state.activeChannelId && document.hasFocus()) {
        state.markRead(message.channel_id);
      }
    } else if (kind === "chat.typing") {
      const { channel_id, user } = data as { channel_id: number; user: UserRef };
      const meId = useSession.getState().session?.user.id;
      if (user.id !== meId) {
        useChat.setState((s) => {
          const list = (s.typing[channel_id] ?? []).filter((t) => t.user.id !== user.id);
          return {
            typing: {
              ...s.typing,
              [channel_id]: [...list, { user, until: Date.now() + 5000 }],
            },
          };
        });
      }
    } else if (kind === "read.updated") {
      // My own marker moved (this device's PUT echoing back, or another
      // device of mine reading) — converge on the furthest point.
      const { channel_id, last_read_message_id } = data as {
        channel_id: number;
        last_read_message_id: number;
      };
      readSynced[channel_id] = Math.max(readSynced[channel_id] ?? 0, last_read_message_id);
      const meId = useSession.getState().session?.user.id;
      useChat.setState((s) => {
        if (last_read_message_id <= (s.lastRead[channel_id] ?? 0)) return s;
        const lastRead = { ...s.lastRead, [channel_id]: last_read_message_id };
        saveLastRead(lastRead);
        const unread = { ...s.unread };
        const list = s.messages[channel_id];
        const remaining = list
          ? list.filter((m) => m.id > last_read_message_id && m.author.id !== meId).length
          : 0;
        if (remaining > 0) unread[channel_id] = remaining;
        else delete unread[channel_id];
        return { lastRead, unread };
      });
    } else if (kind === "channel.pins") {
      const { channel_id, pins } = data as { channel_id: number; pins: PinInfo[] };
      useChat.setState((s) => ({ pins: { ...s.pins, [channel_id]: pins } }));
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
          channelNames: { ...s.channelNames, [channel.id]: channel.name ?? "" },
        }));
        void backend.wsSub([`channel:${channel.id}`]);
      }
    } else if (kind === "channel.updated") {
      const channel = data as Channel;
      useChat.setState((s) => ({
        channels: s.channels.map((c) => (c.id === channel.id ? channel : c)),
        channelNames: { ...s.channelNames, [channel.id]: channel.name ?? "" },
      }));
    } else if (kind === "channel.deleted") {
      const { channel_id } = data as { channel_id: number };
      useChat.setState((s) => {
        const channelGroup = { ...s.channelGroup };
        delete channelGroup[channel_id];
        const channelNames = { ...s.channelNames };
        delete channelNames[channel_id];
        const messages = { ...s.messages };
        delete messages[channel_id];
        const unread = { ...s.unread };
        delete unread[channel_id];
        const drafts = { ...s.drafts };
        delete drafts[channel_id];
        return {
          channels: s.channels.filter((c) => c.id !== channel_id),
          channelGroup,
          channelNames,
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
    } else if (kind === "group.deleted") {
      const { group_id } = data as { group_id: number };
      useChat.setState((s) => {
        // Purge every cached trace of the group's channels.
        const channelGroup: Record<number, number> = {};
        const channelNames = { ...s.channelNames };
        const messages = { ...s.messages };
        const unread = { ...s.unread };
        const drafts = { ...s.drafts };
        for (const [cidStr, gid] of Object.entries(s.channelGroup)) {
          const cid = Number(cidStr);
          if (gid === group_id) {
            delete channelNames[cid];
            delete messages[cid];
            delete unread[cid];
            delete drafts[cid];
          } else {
            channelGroup[cid] = gid;
          }
        }
        return {
          groups: s.groups.filter((g) => g.id !== group_id),
          channelGroup,
          channelNames,
          messages,
          unread,
          drafts,
          ...(s.activeGroupId === group_id
            ? { channels: [], activeChannelId: null, members: [], emotes: [] }
            : {}),
        };
      });
      // If we were looking at it, land on the next group (or the empty state).
      const after = useChat.getState();
      if (after.activeGroupId === group_id) {
        const next = after.groups[0];
        if (next) void after.selectGroup(next.id);
        else useChat.setState({ activeGroupId: null });
      }
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
  return () => {
    clearInterval(prune);
    off();
  };
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
