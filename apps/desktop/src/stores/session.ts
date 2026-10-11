import { create } from "zustand";

import { backend, isWeb, setAttachmentScope, setOnUnauthorized, type SessionInfo } from "../lib/backend";
import { toastError } from "../platform/toast";
import { INITIAL_LINK, phaseOf, reduceLink, type Link, type LinkEvent, type LinkTarget } from "./sessionMachine";

const logoutHooks = new Set<() => Promise<void>>();

/** Run `hook` (awaited, at most ~2.5s for all hooks) before leaving a
 *  server — e.g. to send a document's unsent edits while the session still
 *  works. */
export function onBeforeLogout(hook: () => Promise<void>): () => void {
  logoutHooks.add(hook);
  return () => {
    logoutHooks.delete(hook);
  };
}

/** What the connect sheet opens at. */
export interface ConnectRequest {
  /** Go straight to this server (its sign-in, or the trust prompt). */
  addr?: string;
  /** Start at "Host on this computer". */
  host?: boolean;
  /** The remembered session was rejected — say so on the sign-in form. */
  expired?: boolean;
}

interface SessionState {
  /**
   * "loading" until launch knows where it stands (a file read on the apps,
   * one request in the browser). After that the apps are always "connected"
   * or "offline" — working on this device, whatever the link says. Only the
   * browser client, which has no device storage, is ever "disconnected":
   * there, signing in comes first.
   */
  phase: "loading" | "disconnected" | "connected" | "offline";
  /** How the app stands with a server (see sessionMachine.ts). */
  link: Link;
  session: SessionInfo | null;
  /** The server a link that isn't connected is about. */
  target: LinkTarget | null;
  /** The connect sheet, when open. */
  connect: ConnectRequest | null;
  /** Why the last session ended, for the browser's sign-in page. */
  endReason: "expired" | null;
  endAddr: string | null;

  setConnected: (session: SessionInfo) => void;
  openConnect: (request?: ConnectRequest) => void;
  closeConnect: () => void;
  /** Leave the server but stay signed in (one click to come back). */
  disconnect: () => Promise<void>;
  /** Sign out: the session is forgotten here and revoked on the server. */
  logout: () => Promise<void>;
  /** Come back to a saved server with its remembered session; opens its
   *  sign-in when there is none (or it no longer stands). */
  resume: (addr: string, name?: string) => Promise<void>;
  /** Try the unreachable server again. */
  retry: () => Promise<void>;
  /** The connect screen consumed the expiry notice. */
  clearEndReason: () => void;
  /** The server proved our token dead mid-session (REST 401 or WS reject):
   *  one toast, and the app carries on with what's on this device. */
  sessionExpired: () => void;
  /** Kept for callers from before the shell was always open. */
  goOffline: () => void;
  leaveOffline: () => void;
}

function apply(event: LinkEvent) {
  useSession.setState((s) => {
    const next = reduceLink({ link: s.link, session: s.session, target: s.target }, event);
    // The browser has nothing to show without a session.
    const phase = isWeb && next.link !== "connected" ? "disconnected" : phaseOf(next.link);
    return { ...next, phase };
  });
}

/** Let open work finish sending (bounded — leaving must not hang). */
async function beforeLeaving() {
  await Promise.race([
    Promise.allSettled([...logoutHooks].map((hook) => hook())),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
}

/** A resume that hasn't answered in this long stops saying "reconnecting". */
const RESUME_PATIENCE_MS = 8000;

let resumeSeq = 0;

async function runResume(ask: () => ReturnType<typeof backend.currentSession>) {
  const mine = ++resumeSeq;
  const slow = setTimeout(() => {
    if (mine === resumeSeq) apply({ type: "resume-slow" });
  }, RESUME_PATIENCE_MS);
  try {
    const { session, reason, addr } = await ask();
    // A late answer still counts — unless the user has moved on since.
    if (mine !== resumeSeq) return;
    if (session) apply({ type: "connected", session });
    else {
      apply({ type: "resume-failed", reason, addr });
      if (reason === "expired") {
        useSession.setState({ endReason: "expired", endAddr: addr });
      }
    }
  } catch {
    if (mine === resumeSeq) apply({ type: "resume-failed", reason: "unreachable", addr: null });
  } finally {
    clearTimeout(slow);
  }
}

export const useSession = create<SessionState>((set, get) => ({
  phase: "loading",
  ...INITIAL_LINK,
  connect: null,
  endReason: null,
  endAddr: null,

  setConnected: (session) => {
    resumeSeq += 1; // a sign-in settles whatever resume was still out
    apply({ type: "connected", session });
    set({ connect: null, endReason: null, endAddr: null });
  },
  openConnect: (request) => set({ connect: request ?? {} }),
  closeConnect: () => set({ connect: null }),

  disconnect: async () => {
    if (get().link !== "connected") return;
    await beforeLeaving();
    await backend.disconnect().catch(() => {});
    apply({ type: "left" });
  },
  logout: async () => {
    await beforeLeaving();
    await backend.logout().catch(() => {});
    resumeSeq += 1;
    apply({ type: "left" });
    set({ endReason: null, endAddr: null });
  },
  resume: async (addr, name) => {
    if (get().link === "connected") {
      // Switching: leave the current server first, still signed in to it.
      await beforeLeaving();
      await backend.disconnect().catch(() => {});
      apply({ type: "left" });
    }
    apply({ type: "boot", target: { addr, name: name ?? addr, username: null } });
    await runResume(() => backend.resumeServer(addr));
    const s = get();
    if (s.link === "expired" && s.target?.addr === addr) set({ connect: { addr, expired: true } });
  },
  retry: async () => {
    const target = get().target;
    if (get().link !== "unreachable" || !target) return;
    apply({ type: "retry" });
    await runResume(() => backend.resumeServer(target.addr));
  },
  clearEndReason: () => set({ endReason: null }),
  sessionExpired: () => {
    const { link, session } = get();
    if (link !== "connected") return; // once-guard: failing refetches burst
    toastError("Your session expired. Sign in again to carry on with the server.");
    // Local teardown only; the token is already dead server-side.
    void backend.logout().catch(() => {});
    apply({ type: "expired" });
    set({ endReason: "expired", endAddr: session?.addr ?? null });
  },
  goOffline: () => set({ connect: null }),
  leaveOffline: () => set({ connect: {} }),
}));

// Rendered attachment addresses are tagged with the server they're from.
useSession.subscribe((s, prev) => {
  if (s.session?.addr !== prev.session?.addr) setAttachmentScope(s.session?.addr ?? null);
});

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

// Launch. The apps open at once on what's on this device: which server to
// resume is a file read, and asking that server happens behind the open app
// (a slow or absent server never holds the window on a spinner). The browser
// client has nothing local, so it waits for its one answer.
async function boot() {
  if (isWeb) {
    try {
      const { session, reason, addr } = await backend.currentSession();
      if (session) apply({ type: "connected", session });
      else {
        useSession.setState({
          phase: "disconnected",
          endReason: reason === "expired" ? "expired" : null,
          endAddr: addr,
        });
      }
    } catch {
      // Never strand the page on "loading" — the sign-in can retry.
      useSession.setState({ phase: "disconnected" });
    }
    return;
  }
  let target: LinkTarget | null = null;
  try {
    const t = await backend.resumeTarget();
    if (t) target = { addr: t.addr, name: t.server_name || t.addr, username: t.last_username };
  } catch {
    // An older core, or nothing saved: ask anyway, below.
  }
  apply({ type: "boot", target });
  // Also finds a session still in memory (a dev reload).
  await runResume(() => backend.currentSession());
}

void boot();
