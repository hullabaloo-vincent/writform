import { AlertTriangle, Check, CloudOff, Loader } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The save indicator shared by server and on-device documents. Calm by
 * design: "Saving…" only appears when a save takes longer than a second,
 * "Saved" shows briefly and then shrinks to an icon, and only trouble —
 * offline or not saved — stays loud.
 */

export type SaveIndicator =
  | { kind: "synced" }
  | { kind: "pending" }
  | { kind: "offline"; detail: string }
  | { kind: "error"; message: string };

export interface SaveAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

const SLOW_MS = 1000;
const SAVED_MS = 2000;

export function SyncStatus({
  state,
  where,
  actions = [],
  floating = false,
}: {
  state: SaveIndicator;
  /** Wording: "server" documents vs "device" (on-device) documents. */
  where: "server" | "device";
  /** Recovery choices offered in the error popover. */
  actions?: SaveAction[];
  /** Focus mode: a fixed pill that stays readable while the header fades. */
  floating?: boolean;
}) {
  const [slow, setSlow] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const prevKind = useRef(state.kind);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const prev = prevKind.current;
    prevKind.current = state.kind;
    if (state.kind === "pending") {
      const t = setTimeout(() => setSlow(true), SLOW_MS);
      return () => clearTimeout(t);
    }
    setSlow(false);
    if (state.kind === "synced" && prev === "pending") {
      setJustSaved(true);
      const t = setTimeout(() => setJustSaved(false), SAVED_MS);
      return () => clearTimeout(t);
    }
    if (state.kind !== "error") setOpen(false);
    return undefined;
  }, [state.kind]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (floating && state.kind !== "offline" && state.kind !== "error") return null;

  const savedLabel = where === "device" ? "Saved on this device" : "Saved";
  let body: React.ReactNode;
  let tone = "";
  let title: string;
  if (state.kind === "error") {
    tone = "error";
    title = state.message;
    body = (
      <>
        <AlertTriangle size={13} />
        <span>{where === "device" ? "Couldn't save" : "Not saved"}</span>
      </>
    );
  } else if (state.kind === "offline") {
    tone = "offline";
    title = state.detail;
    body = (
      <>
        <CloudOff size={13} />
        <span>Offline</span>
      </>
    );
  } else if (state.kind === "pending" && slow) {
    title = "Saving your changes";
    body = (
      <>
        <Loader size={13} className="wf-spin" />
        <span>Saving…</span>
      </>
    );
  } else {
    title = savedLabel;
    body = (
      <>
        <Check size={13} />
        {justSaved && <span>{savedLabel}</span>}
      </>
    );
  }

  return (
    <span
      ref={wrapRef}
      className={`wf-sync-status ${tone} ${floating ? "floating" : ""}`}
      aria-live="polite"
    >
      {state.kind === "error" ? (
        <button className="wf-sync-pill" title={title} onClick={() => setOpen((v) => !v)}>
          {body}
        </button>
      ) : (
        <span className="wf-sync-pill" title={title}>
          {body}
        </span>
      )}
      {open && state.kind === "error" && (
        <span className="wf-sync-pop" role="dialog" aria-label="Changes not saved">
          <strong>{where === "device" ? "Couldn't save" : "Changes not saved"}</strong>
          <span className="wf-sync-pop-msg">{state.message}</span>
          <span className="wf-sync-pop-actions">
            {actions.map((a) => (
              <button
                key={a.label}
                className={a.primary ? "wf-primary" : ""}
                onClick={() => {
                  setOpen(false);
                  a.run();
                }}
              >
                {a.label}
              </button>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
