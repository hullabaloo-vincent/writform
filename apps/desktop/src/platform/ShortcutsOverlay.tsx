import { useEffect } from "react";

import { Modal } from "./Modal";
import { usePlatform } from "./registry";
import { shortcutSections } from "./shortcuts";

/** ⌘/ keyboard cheat sheet; also reachable from the command palette. */
export function ShortcutsOverlay() {
  const open = usePlatform((s) => s.shortcutsOpen);
  const setOpen = usePlatform((s) => s.setShortcutsOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        usePlatform.getState().setShortcutsOpen(!usePlatform.getState().shortcutsOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <Modal onClose={() => setOpen(false)} boxClass="wf-modal wf-shortcuts">
      <h3>Keyboard shortcuts</h3>
      <div className="wf-shortcuts-grid">
        {shortcutSections().map((sec) => (
          <section key={sec.title}>
            <h4>{sec.title}</h4>
            <ul>
              {sec.rows.map((r) => (
                <li key={r.what}>
                  <span className="wf-shortcut-keys">
                    {r.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  <span className="wf-shortcut-what">{r.what}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
