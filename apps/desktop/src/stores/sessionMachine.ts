/**
 * How the app stands with a server, as a small pure machine.
 *
 * The workspace on this device is always there; a server is something you
 * are (or aren't) linked to on top of it:
 *
 *   local        no server in play
 *   resuming     launch found a remembered session and is asking the server
 *   connected    signed in, live
 *   unreachable  a remembered session, but the server didn't answer
 *   expired      the server no longer accepts the remembered session
 *
 * Only `connected` has a session. The other four all mean "working on this
 * device"; they differ in what the shell says and offers (retry, sign in).
 */

import type { SessionInfo } from "../lib/backend";

export type Link = "local" | "resuming" | "connected" | "unreachable" | "expired";

/** The server a link that isn't `connected` is about. */
export interface LinkTarget {
  addr: string;
  name: string;
  username: string | null;
}

export interface LinkState {
  link: Link;
  session: SessionInfo | null;
  target: LinkTarget | null;
}

export type LinkEvent =
  /** Launch read which server (if any) it will resume. */
  | { type: "boot"; target: LinkTarget | null }
  /** The server accepted a session (resume, sign-in, or registration). */
  | { type: "connected"; session: SessionInfo }
  /** A resume came back without one. */
  | { type: "resume-failed"; reason: "expired" | "unreachable" | null; addr: string | null }
  /** The resume is taking too long: stop saying "reconnecting". */
  | { type: "resume-slow" }
  /** A live session was rejected (a 401, or the socket's auth error). */
  | { type: "expired" }
  /** The user left: Disconnect (still signed in) or Sign out. */
  | { type: "left" }
  /** The user asked to try the unreachable server again. */
  | { type: "retry" };

export const INITIAL_LINK: LinkState = { link: "local", session: null, target: null };

export function reduceLink(state: LinkState, event: LinkEvent): LinkState {
  switch (event.type) {
    case "boot":
      return event.target ? { link: "resuming", session: null, target: event.target } : INITIAL_LINK;
    case "connected":
      return { link: "connected", session: event.session, target: null };
    case "resume-failed": {
      // Signing in elsewhere in the meantime wins over a late failure.
      if (state.link === "connected") return state;
      if (!event.reason) return INITIAL_LINK;
      const target: LinkTarget =
        state.target && (!event.addr || state.target.addr === event.addr)
          ? state.target
          : { addr: event.addr ?? "", name: event.addr ?? "the server", username: null };
      return { link: event.reason, session: null, target };
    }
    case "resume-slow":
      return state.link === "resuming" ? { ...state, link: "unreachable" } : state;
    case "expired": {
      if (state.link !== "connected" || !state.session) return state;
      const { addr, user } = state.session;
      return { link: "expired", session: null, target: { addr, name: addr, username: user.username } };
    }
    case "left":
      return INITIAL_LINK;
    case "retry":
      return state.link === "unreachable" && state.target ? { ...state, link: "resuming" } : state;
    default:
      return state;
  }
}

/** The older two-way view of the same thing, which much of the app reads:
 *  "connected", or working on this device ("offline"). */
export function phaseOf(link: Link): "connected" | "offline" {
  return link === "connected" ? "connected" : "offline";
}
