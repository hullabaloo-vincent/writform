/**
 * App lifecycle moments that put unsaved work at risk — backgrounding (iOS
 * can kill a backgrounded app without warning), closing the window, leaving
 * the web page. Stores with unsent work register here; each moment pushes
 * that work out, within a short budget.
 */

import { isDevPreview, isMobileApp, isWeb } from "../lib/backend";

export interface FlushSource {
  /** True while something hasn't been saved/sent yet. */
  pending(): boolean;
  /** Save/send it now (should settle quickly; callers bound the wait). */
  flush(): Promise<void>;
}

const sources = new Set<FlushSource>();

export function onFlush(source: FlushSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

function anyPending(): boolean {
  for (const s of sources) {
    try {
      if (s.pending()) return true;
    } catch {
      // a broken source must not block the others
    }
  }
  return false;
}

async function flushAll(timeoutMs: number): Promise<void> {
  await Promise.race([
    Promise.allSettled([...sources].map((s) => s.flush())),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

let installed = false;

/** Installed once at startup. */
export function installLifecycle(): void {
  if (installed) return;
  installed = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAll(2000);
  });
  window.addEventListener("pagehide", () => void flushAll(1000));

  if (isWeb || isDevPreview) {
    // A browser tab can't wait on async work while closing — ask instead.
    window.addEventListener("beforeunload", (e) => {
      if (!anyPending()) return;
      e.preventDefault();
      e.returnValue = "";
    });
  } else if (!isMobileApp) {
    // Desktop: closing the window waits (≤2s) for unsent work; Tauri closes
    // the window once this handler resolves.
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested(async () => {
          if (anyPending()) await flushAll(2000);
        }),
      )
      .catch(() => {});
  }
}
