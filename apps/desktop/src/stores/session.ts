import { create } from "zustand";

import { backend, type SessionInfo } from "../lib/backend";

interface SessionState {
  /** "loading" until currentSession() resolves on startup. "offline" is the
   *  no-server mode: local notes/documents and the portable profile only. */
  phase: "loading" | "disconnected" | "connected" | "offline";
  session: SessionInfo | null;
  setConnected: (session: SessionInfo) => void;
  /** Enter the shell without a server (from the connect screen). */
  goOffline: () => void;
  /** Leave offline mode back to the connect screen. */
  leaveOffline: () => void;
  logout: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  phase: "loading",
  session: null,
  setConnected: (session) => set({ phase: "connected", session }),
  goOffline: () => set({ phase: "offline", session: null }),
  leaveOffline: () => set({ phase: "disconnected", session: null }),
  logout: async () => {
    await backend.logout();
    set({ phase: "disconnected", session: null });
  },
}));

// Restore an in-flight session (e.g. webview reload during dev).
void backend.currentSession().then((session) => {
  useSession.setState(session ? { phase: "connected", session } : { phase: "disconnected" });
});
