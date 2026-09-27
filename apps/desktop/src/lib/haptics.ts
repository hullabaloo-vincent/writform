/** Native touch feedback, on the platforms that have hardware for it.
 *  Everywhere else every call is a silent no-op, so callers sprinkle these
 *  at interaction points without platform checks. Best-effort by design —
 *  feedback must never break the action it decorates. */

import { isMobileApp } from "./backend";

type Tap = "light" | "medium" | "success" | "error" | "selection";

export function haptic(kind: Tap = "light"): void {
  if (!isMobileApp) return;
  void (async () => {
    try {
      const h = await import("@tauri-apps/plugin-haptics");
      if (kind === "selection") await h.selectionFeedback();
      else if (kind === "success") await h.notificationFeedback("success");
      else if (kind === "error") await h.notificationFeedback("error");
      else await h.impactFeedback(kind);
    } catch {
      // Plugin missing or the OS refused — the action itself already happened.
    }
  })();
}
