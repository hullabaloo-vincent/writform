/**
 * Which server (and account) the app is talking to — and telling the stores
 * when that changes.
 *
 * Ids are only unique per server: channel 4, board 2, user 7 mean different
 * things on different ones. Every store that keeps server data therefore
 * starts over when the scope changes — on signing in, switching, leaving or
 * an expired session — so nothing from the last server is shown, counted or
 * written to under the new one. What lives on this device is not scoped and
 * is never touched.
 */

import { useSession } from "../stores/session";

/** `addr|userId` while connected, else null. */
export function serverScope(): string | null {
  const { link, session } = useSession.getState();
  return link === "connected" && session ? `${session.addr}|${session.user.id}` : null;
}

type Listener = (scope: string | null, previous: string | null) => void;
const listeners = new Set<Listener>();
let last = serverScope();

useSession.subscribe(() => {
  const scope = serverScope();
  if (scope === last) return;
  const previous = last;
  last = scope;
  for (const cb of [...listeners]) {
    try {
      cb(scope, previous);
    } catch (e) {
      console.error("server-scope listener failed", e);
    }
  }
});

/** Call `cb` whenever the server scope changes. Returns an unsubscribe fn. */
export function onServerScope(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * A store's starting state with fresh (empty) collections — its initial
 * object's own Sets, Maps, arrays and plain objects are never handed back,
 * since code that mutated one in place would poison every later reset.
 */
export function freshState<T extends object>(initial: T): T {
  const out = { ...initial } as Record<string, unknown>;
  for (const [key, value] of Object.entries(initial)) {
    if (value instanceof Set) out[key] = new Set();
    else if (value instanceof Map) out[key] = new Map();
    else if (Array.isArray(value)) out[key] = [];
    else if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) out[key] = {};
  }
  return out as T;
}
