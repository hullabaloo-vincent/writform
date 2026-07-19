import { backend } from "../lib/backend";

/**
 * Reconnect catch-up: "REST is truth, WS is invalidation". While the socket
 * is down we may have missed fan-out events, so when it comes back every
 * registered store re-fetches what it is currently showing.
 */

const callbacks = new Set<() => void>();

/** Register a catch-up callback; returns an unsubscribe fn. */
export function onResync(cb: () => void): () => void {
  callbacks.add(cb);
  return () => {
    callbacks.delete(cb);
  };
}

/** Installed once at startup. */
export function installResync(): () => void {
  let wasDown = false;
  return backend.onWsStatus((connected) => {
    if (!connected) {
      wasDown = true;
      return;
    }
    if (!wasDown) return; // initial connect — stores load normally
    wasDown = false;
    for (const cb of [...callbacks]) cb();
  });
}
