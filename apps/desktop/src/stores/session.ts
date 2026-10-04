import { create } from "zustand";

import { backend, setOnUnauthorized, type SessionInfo } from "../lib/backend";
import { toastError } from "../platform/toast";

const logoutHooks = new Set<() => Promise<void>>();

/** Run `hook` (awaited, at most ~2.5s for all hooks) before signing out —
 *  e.g. to send a document's unsent edits while the session still works. */
export function onBeforeLogout(hook: () => Promise<void>): () => void {
  logoutHooks.add(hook);
  return () => {
    logoutHooks.delete(hook);
  };
}

interface SessionState {
  /** "loading" until currentSession() resolves on startup. "offline" is the
   *  no-server mode: local notes/documents and the portable profile only. */
  phase: "loading" | "disconnected" | "connected" | "offline";
  session: SessionInfo | null;
  /** Why the last session ended, for the connect screen's notice. */
  endReason: "expired" | null;
  /** The server whose login should open when endReason is set. */
  endAddr: string | null;
  setConnected: (session: SessionInfo) => void;
  /** Enter the shell without a server (from the connect screen). */
  goOffline: () => void;
  /** Leave offline mode back to the connect screen. */
  leaveOffline: () => void;
  /** The connect screen consumed the expiry notice. */
  clearEndReason: () => void;
  logout: () => Promise<void>;
  /** The server proved our token dead mid-session (REST 401 or WS reject):
   *  one toast, back to the connect screen with the login prefilled. */
  sessionExpired: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  phase: "loading",
  session: null,
  endReason: null,
  endAddr: null,
  setConnected: (session) =>
    set({ phase: "connected", session, endReason: null, endAddr: null }),
  goOffline: () => set({ phase: "offline", session: null }),
  leaveOffline: () => set({ phase: "disconnected", session: null }),
  clearEndReason: () => set({ endReason: null }),
  logout: async () => {
    // Let open work finish sending first (bounded — sign-out must not hang).
    await Promise.race([
      Promise.allSettled([...logoutHooks].map((hook) => hook())),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    await backend.logout();
    set({ phase: "disconnected", session: null, endReason: null, endAddr: null });
  },
  sessionExpired: () => {
    const { phase, session } = get();
    if (phase !== "connected") return; // once-guard: failing refetches burst
    toastError("Your session expired — please sign in again.");
    // Local teardown only; the token is already dead server-side.
    void backend.logout().catch(() => {});
    set({
      phase: "disconnected",
      session: null,
      endReason: "expired",
      endAddr: session?.addr ?? null,
    });
  },
}));

// Any API response that proves the token dead funnels here (REST 401s with
// expired_token/invalid_token — never login's invalid_credentials).
setOnUnauthorized(() => useSession.getState().sessionExpired());

// The WS auth verdict arrives as an error frame; the Rust client stops
// retrying after forwarding it, so this is the only signal.
backend.onWsEvent((event) => {
  if (event.ev === "error" && event.code === "invalid_token") {
    useSession.getState().sessionExpired();
  }
});

// Restore the previous session on startup: in-memory during dev reloads, or
// a remembered token after a real relaunch. A rejected token surfaces as the
// connect screen with a "session expired" notice instead of a silent logout.
void backend
  .currentSession()
  .then(({ session, reason, addr }) => {
    useSession.setState(
      session
        ? { phase: "connected", session }
        : {
            phase: "disconnected",
            endReason: reason === "expired" ? "expired" : null,
            endAddr: addr,
          },
    );
  })
  .catch(() => {
    // Never strand the app on "loading" — the connect screen can retry.
    useSession.setState({ phase: "disconnected" });
  });
