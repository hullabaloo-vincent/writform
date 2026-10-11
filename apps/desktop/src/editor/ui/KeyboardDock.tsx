import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useIsPhone } from "./Flyout";

/** Anything less is browser chrome coming and going, not a keyboard. */
const KEYBOARD_MIN = 120;

/**
 * The on-screen keyboard's height in CSS pixels (0 while it's away), read
 * from the visual viewport: where the keyboard covers the page rather than
 * resizing it (an embedded webview, Safari), that's how far the visible part
 * stops short of the window. Where the window itself shrinks, this stays 0 —
 * and nothing needs to move.
 */
function useKeyboardHeight(enabled: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setHeight(0);
      return;
    }
    const read = () => {
      // Zoomed in, the visible part is small for another reason.
      const zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
      const gap = zoomed ? 0 : Math.round(window.innerHeight - vv.height - vv.offsetTop);
      setHeight(gap >= KEYBOARD_MIN ? gap : 0);
    };
    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
    };
  }, [enabled]);
  return height;
}

/** The element the document's text is typed in (none before it's mounted). */
function textOf(editor: Editor): HTMLElement | null {
  try {
    return editor.isDestroyed ? null : editor.view.dom;
  } catch {
    return null;
  }
}

/**
 * On a phone, a document's toolbar belongs where the thumbs are: while the
 * keyboard is up for the text, this holds its children in a strip sitting
 * on the keyboard; otherwise they stay where they are in the page. Nothing
 * is unmounted either way (a menu opened from the strip stays open), and
 * the editor is told how tall the strip is so its text ends above it.
 */
export function KeyboardDock({ editor, children }: { editor: Editor; children: ReactNode }) {
  const phone = useIsPhone();
  const keyboard = useKeyboardHeight(phone);
  const ref = useRef<HTMLDivElement>(null);
  // Whether the keyboard is up for the document's text (not for a title, a
  // comment, a search field — the strip would sit on what's being typed).
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (!phone) {
      setTyping(false);
      return;
    }
    const sync = () => {
      const active = document.activeElement;
      // Nothing focused: the keyboard is on its way out and takes the strip.
      if (!active || active === document.body) return;
      if (textOf(editor)?.contains(active)) setTyping(true);
      // A field in one of the strip's own menus (a font search) isn't leaving.
      else if (!active.closest(".wf-flyout, .wf-kbdock")) setTyping(false);
    };
    sync();
    document.addEventListener("focusin", sync);
    return () => document.removeEventListener("focusin", sync);
  }, [editor, phone]);

  const docked = phone && keyboard > 0 && typing;

  // The keyboard's height for the strip and for sheets opened from it, and
  // the strip's own for the text behind it.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!docked) return;
    root.style.setProperty("--wf-kb", `${keyboard}px`);
    root.style.setProperty("--wf-kbdock-h", `${ref.current?.offsetHeight ?? 0}px`);
    return () => {
      root.style.removeProperty("--wf-kb");
      root.style.removeProperty("--wf-kbdock-h");
    };
  }, [docked, keyboard]);

  return (
    <div ref={ref} className={`wf-kbdock${docked ? " docked" : ""}`}>
      {children}
    </div>
  );
}
