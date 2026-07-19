import { create } from "zustand";

import { backend, type SessionInfo } from "../lib/backend";

interface SessionState {
  /** "loading" until currentSession() resolves on startup. */
  phase: "loading" | "disconnected" | "connected";
  session: SessionInfo | null;
  setConnected: (session: SessionInfo) => void;
  logout: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  phase: "loading",
  session: null,
  setConnected: (session) => set({ phase: "connected", session }),
  logout: async () => {
    await backend.logout();
    set({ phase: "disconnected", session: null });
  },
}));

// Restore an in-flight session (e.g. webview reload during dev).
void backend.currentSession().then((session) => {
  useSession.setState(session ? { phase: "connected", session } : { phase: "disconnected" });
});
