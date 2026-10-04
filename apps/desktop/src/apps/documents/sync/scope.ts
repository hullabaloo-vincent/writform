import type { SessionInfo } from "../../../lib/backend";
import { useSession } from "../../../stores/session";

/** The server + account an edit belongs to. Document ids are only unique per
 *  server, so every send, replay, and catch-up checks it hasn't changed. */
export function scopeOf(s: { phase: string; session: SessionInfo | null }): string | null {
  return s.phase === "connected" && s.session ? `${s.session.addr}|${s.session.user.id}` : null;
}

export const currentScope = (): string | null => scopeOf(useSession.getState());
