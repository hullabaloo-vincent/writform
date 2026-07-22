import { useEffect, useRef } from "react";

/**
 * Shared modal shell: backdrop-click and Escape both dismiss, Tab is trapped
 * inside, and entry is animated. Every dialog should render through this —
 * ad-hoc `wf-modal-backdrop` divs each re-implemented (or forgot) dismissal.
 */

/**
 * Escape must close only the TOPMOST modal, but window-level key listeners
 * don't know about DOM stacking — so open modals register here and a single
 * listener pops the top of the stack.
 */
const escapeStack: (() => void)[] = [];

function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || escapeStack.length === 0) return;
  e.stopPropagation();
  escapeStack[escapeStack.length - 1]();
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  onClose,
  className,
  boxClass = "wf-modal",
  children,
}: {
  onClose: () => void;
  /** Extra classes for the dialog box (e.g. "wf-confirm", "wf-notes-help"). */
  className?: string;
  /** Base box class; override for non-standard shells (e.g. wf-profile-card). */
  boxClass?: string;
  children: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    escapeStack.push(onClose);
    if (escapeStack.length === 1) window.addEventListener("keydown", onEscape);
    return () => {
      const i = escapeStack.lastIndexOf(onClose);
      if (i >= 0) escapeStack.splice(i, 1);
      if (escapeStack.length === 0) window.removeEventListener("keydown", onEscape);
    };
  }, [onClose]);

  // Focus the first control unless the dialog already placed focus (autoFocus).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (!box.contains(document.activeElement)) {
      box.querySelectorAll<HTMLElement>(FOCUSABLE)[0]?.focus();
    }
  }, []);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !boxRef.current) return;
    const focusable = [...boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="wf-modal-backdrop" onClick={onClose}>
      <div
        ref={boxRef}
        className={`${boxClass} ${className ?? ""}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>
  );
}
