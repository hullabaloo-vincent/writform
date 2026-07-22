import { create } from "zustand";

/**
 * Transient feedback toasts. Before this, failed actions mostly disappeared
 * into `.catch(() => {})` — the user saw nothing. Use `toast()` for outcomes
 * of USER-INITIATED actions (send/delete/share/create failures, copied
 * confirmations); background refetches should stay silent.
 */

export type ToastKind = "error" | "info" | "success";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  /** Set while animating out, right before removal. */
  leaving: boolean;
}

const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

let nextId = 1;
const LEAVE_MS = 180;

function dismiss(id: number) {
  const { toasts } = useToasts.getState();
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  useToasts.setState({
    toasts: toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
  });
  setTimeout(() => {
    useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, LEAVE_MS);
}

/** Show a toast. Errors linger a little longer than confirmations. */
export function toast(message: string, kind: ToastKind = "info") {
  const id = nextId++;
  useToasts.setState((s) => ({
    // Cap the stack; the oldest gives way.
    toasts: [...s.toasts.slice(-3), { id, message, kind, leaving: false }],
  }));
  setTimeout(() => dismiss(id), kind === "error" ? 6500 : 4000);
}

export const toastError = (message: string) => toast(message, "error");

/** Mounted once at the root. */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="wf-toasts">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`wf-toast ${t.kind} ${t.leaving ? "leaving" : ""}`}
          title="Dismiss"
          onClick={() => dismiss(t.id)}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
