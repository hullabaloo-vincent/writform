import { create } from "zustand";

/**
 * Cross-cutting friends/DM state. The chat WS handler feeds DM unread counts
 * here (DM messages arrive in the always-subscribed `user:{id}` room), and
 * notifications consult `activeDmPeerId` so pings are suppressed only for the
 * conversation actually on screen — not whenever the Friends app is open.
 */

interface FriendsState {
  /** Peer whose DM pane is currently visible, if any. */
  activeDmPeerId: number | null;
  /** Unread DM counts keyed by peer user id. */
  dmUnread: Record<number, number>;

  setActiveDmPeer: (peerId: number | null) => void;
  noteIncoming: (peerId: number) => void;
}

export const useFriends = create<FriendsState>((set, get) => ({
  activeDmPeerId: null,
  dmUnread: {},

  setActiveDmPeer: (peerId) =>
    set((s) => {
      if (peerId === null) return { activeDmPeerId: null };
      const dmUnread = { ...s.dmUnread };
      delete dmUnread[peerId];
      return { activeDmPeerId: peerId, dmUnread };
    }),

  noteIncoming: (peerId) => {
    // Viewing the conversation (window focused) means it's already read.
    if (get().activeDmPeerId === peerId && document.hasFocus()) return;
    set((s) => ({ dmUnread: { ...s.dmUnread, [peerId]: (s.dmUnread[peerId] ?? 0) + 1 } }));
  },
}));
