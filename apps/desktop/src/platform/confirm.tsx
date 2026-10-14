import { create } from "zustand";

import { Modal } from "./Modal";

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

/** One way forward, where there is more than one. */
export interface Choice {
  id: string;
  label: string;
}

interface PendingConfirm extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
  /** Asked as a choice: the ways forward (the first is the usual one), and
   *  where the one picked goes. */
  choices?: Choice[];
  pick?: (id: string | null) => void;
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

/**
 * Ask which of several ways to go on. Resolves to the id of the one picked,
 * or null on cancel, escape or a click outside: nothing is done then.
 */
export function chooseDialog(message: string, choices: Choice[], options: { title?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    useConfirmStore.getState().pending?.resolve(false);
    useConfirmStore.setState({ pending: { message, ...options, choices, pick: resolve, resolve: (ok) => (ok ? undefined : resolve(null)) } });
  });
}

function answer(ok: boolean, choice?: string) {
  const { pending } = useConfirmStore.getState();
  if (!pending) return;
  if (choice !== undefined) pending.pick?.(choice);
  else pending.resolve(ok);
  useConfirmStore.setState({ pending: null });
}

/** Mounted once at the root; renders the active confirmation, if any. */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  if (!pending) return null;

  return (
    <Modal className="wf-confirm" onClose={() => answer(false)}>
      {pending.title && <h3>{pending.title}</h3>}
      <p className="wf-confirm-message">{pending.message}</p>
      <div className="wf-connect-row wf-confirm-actions">
        {/* A destructive ask focuses Cancel: a reflexive Enter must never
            delete anything. */}
        <button autoFocus={pending.danger} onClick={() => answer(false)}>
          Cancel
        </button>
        {pending.choices ? (
          // (Last in the row is the usual one, as the confirming button is.)
          [...pending.choices].reverse().map((choice, i, all) => (
            <button key={choice.id} className={i === all.length - 1 ? "wf-primary" : ""} autoFocus={i === all.length - 1} onClick={() => answer(true, choice.id)}>
              {choice.label}
            </button>
          ))
        ) : (
          <button
            className={pending.danger ? "wf-danger-solid" : "wf-primary"}
            autoFocus={!pending.danger}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        )}
      </div>
    </Modal>
  );
}
