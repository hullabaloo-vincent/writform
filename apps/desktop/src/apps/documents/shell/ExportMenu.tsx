import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** The plain Word export's label (other code finds the item by it). */
export const WORD_EXPORT = "Export Word (.docx)";

/** One export the menu offers. `run` builds and saves the file. */
export interface ExportItem {
  label: string;
  title?: string;
  run: () => Promise<unknown>;
  /** Draw a divider above this item (groups book outputs from plain ones). */
  separatorBefore?: boolean;
  disabled?: boolean;
}

/**
 * The editor's Export menu (shared by server and on-device documents): a
 * proper menu — closes on Escape or a click outside, arrow keys move between
 * items — whose items each save through the shared save path.
 */
export function ExportMenu({
  items,
  onError,
}: {
  items: ExportItem[];
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    // Land keyboard focus on the first item so arrows work immediately.
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div className="wf-doc-export-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        title="Export document"
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? "active" : ""}
        onClick={() => setOpen((v) => !v)}
      >
        <Download size={16} />
      </button>
      {open && (
        <div className="wf-doc-export-menu" role="menu" ref={menuRef}>
          {items.map((item) => (
            <div key={item.label} role="none">
              {item.separatorBefore && <hr className="wf-doc-export-sep" />}
              <button
                role="menuitem"
                title={item.title}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  void item.run().catch(onError);
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
