import { useEffect } from "react";
import { create } from "zustand";

/**
 * In-app confirmation dialog. The webview does not implement native
 * window.confirm()/alert() (they silently return false), so every destructive
 * action routes through this promise-based modal instead.
 */

export interface ConfirmOptions {
  title?: string;
  /** Label for the confirming button (default "Confirm"). */
  confirmLabel?: string;
  /** Style the confirming button as destructive. */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ pending: PendingConfirm | null }>(() => ({
  pending: null,
}));

/** Ask the user to confirm; resolves false on cancel/escape/backdrop click. */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    // A second request while one is open cancels the first — last ask wins.
    useConfirmStore.getState().pending?.resolve(false);
    useConfirmStore.setState({ pending: { message, ...options, resolve } });
  });
}

function answer(ok: boolean) {
  const { pending } = useConfirmStore.getState();
  if (!pending) return;
  pending.resolve(ok);
  useConfirmStore.setState({ pending: null });
}

/** Mounted once at the root; renders the active confirmation, if any. */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  if (!pending) return null;

  return (
    <div className="wf-modal-backdrop" onClick={() => answer(false)}>
      <div className="wf-modal wf-confirm" onClick={(e) => e.stopPropagation()}>
        {pending.title && <h3>{pending.title}</h3>}
        <p className="wf-confirm-message">{pending.message}</p>
        <div className="wf-connect-row wf-confirm-actions">
          <button onClick={() => answer(false)}>Cancel</button>
          <button
            className={pending.danger ? "wf-danger" : "wf-primary"}
            autoFocus
            onClick={() => answer(true)}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
