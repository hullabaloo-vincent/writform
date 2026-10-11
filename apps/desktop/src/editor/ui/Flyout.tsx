import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const PHONE = "(max-width: 767px)";

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}

/**
 * A toolbar button that opens a panel: a menu beside the button on a
 * desktop, a sheet from the bottom on a phone. The panel lives in the body
 * (the toolbar clips and scrolls), closes on Escape, on a click elsewhere,
 * or when an item calls `close`. Pressing the button doesn't take the
 * editor's focus, so the selection the panel acts on stays put.
 */
export function Flyout({
  title,
  icon,
  label,
  active = false,
  disabled = false,
  caret = true,
  className,
  panelClass,
  openSignal,
  children,
}: {
  title: string;
  icon?: ReactNode;
  /** Text beside (or instead of) the icon. */
  label?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  /** The little arrow that says "this opens". */
  caret?: boolean;
  className?: string;
  panelClass?: string;
  /** Open the panel when this number changes (a keyboard shortcut). */
  openSignal?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const seen = useRef(openSignal);
  useEffect(() => {
    if (openSignal === seen.current) return;
    seen.current = openSignal;
    if (openSignal !== undefined) setOpen(true);
  }, [openSignal]);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open || phone) return;
    const position = () => {
      const button = buttonRef.current;
      const panel = panelRef.current;
      if (!button || !panel) return;
      const b = button.getBoundingClientRect();
      const w = panel.offsetWidth;
      const left = Math.max(8, Math.min(b.left, window.innerWidth - w - 8));
      const top = b.bottom + 6;
      setPlace({ left, top, maxHeight: Math.max(160, window.innerHeight - top - 12) });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, phone]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        className={`wf-flyout-button${label ? " labelled" : ""}${active || open ? " active" : ""}${className ? ` ${className}` : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        {label && <span className="wf-flyout-label">{label}</span>}
        {caret && <ChevronDown size={11} className="wf-flyout-caret" />}
      </button>
      {open &&
        createPortal(
          <>
            {phone && <div className="wf-flyout-scrim" onPointerDown={close} />}
            <div
              ref={panelRef}
              role="menu"
              aria-label={title}
              className={`wf-flyout${phone ? " sheet" : ""}${panelClass ? ` ${panelClass}` : ""}`}
              style={phone ? undefined : { left: place?.left ?? -9999, top: place?.top ?? 0, maxHeight: place?.maxHeight }}
              // Buttons in the panel leave the editor's selection alone;
              // fields in it take the focus they need.
              onMouseDown={(e) => {
                if (!(e.target as Element).closest("input, select, textarea")) e.preventDefault();
              }}
            >
              {phone && <div className="wf-flyout-grip" aria-hidden="true" />}
              {children(close)}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/** A row in a flyout menu. */
export function FlyoutItem({
  children,
  onPick,
  checked,
  disabled,
  hint,
}: {
  children: ReactNode;
  onPick: () => void;
  checked?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={`wf-flyout-item${checked ? " checked" : ""}`}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="wf-flyout-check" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      <span className="wf-flyout-text">{children}</span>
      {hint && <span className="wf-flyout-hint">{hint}</span>}
    </button>
  );
}
