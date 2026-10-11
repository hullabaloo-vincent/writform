import { useCallback, useEffect, useRef, useState } from "react";

import { useSession } from "./session";

/**
 * For actions that need a server ("Publish to a server…"): the returned
 * function runs `run` at once when connected. When not, it opens the connect
 * sheet and runs it once a server is connected — or never, if the sheet is
 * closed without one (a server that's being reconnected to is waited for).
 */
export function useWhenConnected<T>(run: (what: T) => void): (what: T) => void {
  const [waiting, setWaiting] = useState<{ what: T } | null>(null);
  const link = useSession((s) => s.link);
  const sheetOpen = useSession((s) => s.connect !== null);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    if (!waiting) return;
    if (link === "connected") {
      setWaiting(null);
      runRef.current(waiting.what);
    } else if (!sheetOpen && link !== "resuming") {
      setWaiting(null);
    }
  }, [waiting, link, sheetOpen]);

  return useCallback((what: T) => {
    const session = useSession.getState();
    if (session.link === "connected") {
      runRef.current(what);
      return;
    }
    session.openConnect();
    setWaiting({ what });
  }, []);
}
