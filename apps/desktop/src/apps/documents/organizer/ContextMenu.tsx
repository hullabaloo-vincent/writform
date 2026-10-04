import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * A context menu that works from the keyboard as well as the mouse: it
 * opens with focus on its first item, arrow keys / Home / End move between
 * items, Escape (or Tab) closes it and returns focus to whatever opened it.
 * A click anywhere else closes it too.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const blur = () => closeRef.current();
    window.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const close = () => {
    onClose();
    opener.current?.focus?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(buttons.length - 1);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="wf-context-menu"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 228)),
        top: Math.max(8, Math.min(y, window.innerHeight - (items.length * 40 + 16))),
      }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          className={item.danger ? "wf-danger" : ""}
          disabled={item.disabled}
          onClick={() => {
            close();
            item.onClick();
          }}
        >
          {item.icon} {item.label}
        </button>
      ))}
    </div>
  );
}
