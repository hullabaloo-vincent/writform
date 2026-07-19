import { create } from "zustand";

import type { SessionDetail } from "../../bindings/proto/SessionDetail";
import type { WritingSession } from "../../bindings/proto/WritingSession";
import { backend } from "../../lib/backend";
import { sessionApi } from "./api";

interface SessionsState {
  /** Sessions per channel id. */
  byChannel: Record<number, WritingSession[]>;
  activeSessionId: number | null;
  detail: SessionDetail | null;
  /** user ids who saved recently, per prompt (live "writing" indicators). */
  writers: Record<number, Record<number, number>>;

  loadChannel: (channelId: number) => Promise<void>;
  openSession: (sessionId: number) => Promise<void>;
  closeSession: () => void;
  refreshDetail: () => Promise<void>;
}

export const useSessions = create<SessionsState>((set, get) => ({
  byChannel: {},
  activeSessionId: null,
  detail: null,
  writers: {},

  loadChannel: async (channelId) => {
    const sessions = await sessionApi.list(channelId);
    set((s) => ({ byChannel: { ...s.byChannel, [channelId]: sessions } }));
  },

  openSession: async (sessionId) => {
    set({ activeSessionId: sessionId, detail: null });
    await backend.wsSub([`session:${sessionId}`]);
    const detail = await sessionApi.detail(sessionId);
    // Also watch the side chat so it flows into the chat store's buckets.
    await backend.wsSub([`channel:${detail.session.chat_channel_id}`]);
    set({ detail });
  },

  closeSession: () => {
    const { activeSessionId } = get();
    if (activeSessionId !== null) {
      void backend.wsUnsub([`session:${activeSessionId}`]);
    }
    set({ activeSessionId: null, detail: null });
  },

  refreshDetail: async () => {
    const { activeSessionId } = get();
    if (activeSessionId === null) return;
    const detail = await sessionApi.detail(activeSessionId);
    set({ detail });
  },
}));

/** Apply session WS events. Installed once by the sessions app. */
export function installSessionsWsHandler(): () => void {
  return backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const { kind, data } = event;
    const state = useSessions.getState();

    if (kind === "prompt.created" || kind === "prompt.started" || kind === "prompt.ended") {
      // Structure changed → refetch detail (REST is truth).
      const { session_id } = data as { session_id: number };
      if (session_id === state.activeSessionId) void state.refreshDetail();
    } else if (kind === "session.ended") {
      const { session_id } = data as { session_id: number };
      if (session_id === state.activeSessionId) void state.refreshDetail();
    } else if (kind === "session.deleted") {
      const { session_id } = data as { session_id: number };
      useSessions.setState((s) => {
        const byChannel: typeof s.byChannel = {};
        for (const [cid, list] of Object.entries(s.byChannel)) {
          byChannel[Number(cid)] = list.filter((sess) => sess.id !== session_id);
        }
        return { byChannel };
      });
      if (state.activeSessionId === session_id) state.closeSession();
    } else if (kind === "session.created") {
      const session = data as WritingSession;
      useSessions.setState((s) => ({
        byChannel: {
          ...s.byChannel,
          [session.channel_id]: [session, ...(s.byChannel[session.channel_id] ?? [])],
        },
      }));
    } else if (kind === "submission.updated") {
      const { prompt_id, user_id, updated_at } = data as {
        prompt_id: number;
        user_id: number;
        updated_at: number;
      };
      useSessions.setState((s) => ({
        writers: {
          ...s.writers,
          [prompt_id]: { ...(s.writers[prompt_id] ?? {}), [user_id]: updated_at },
        },
      }));
    }
  });
}
