import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

import { usePlatform } from "../../platform";

/** Focus-mode preferences that survive restarts (typewriter is a taste). */
interface FocusPrefs {
  typewriter: boolean;
}

const KEY = "wf-focus-prefs";

function loadPrefs(): FocusPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<FocusPrefs>;
    return { typewriter: parsed.typewriter === true };
  } catch {
    return { typewriter: false };
  }
}

/**
 * Focus mode for a document editor: hides the shell chrome (rail, statusbar,
 * side panels) via the platform's immersive flag, and leaves on Escape —
 * unless a modal is open, whose own Escape handling must win.
 */
export function useFocusMode(): {
  focus: boolean;
  setFocus: (on: boolean) => void;
  typewriter: boolean;
  setTypewriter: (on: boolean) => void;
} {
  const [focus, setFocusState] = useState(false);
  const [typewriter, setTypewriterState] = useState(() => loadPrefs().typewriter);

  const setFocus = (on: boolean) => {
    setFocusState(on);
    usePlatform.getState().setImmersive(on);
  };

  // Leaving the editor (unmount) must give the chrome back.
  useEffect(() => () => usePlatform.getState().setImmersive(false), []);

  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".wf-modal-backdrop")) return; // modal wins
      setFocusState(false);
      usePlatform.getState().setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const setTypewriter = (on: boolean) => {
    setTypewriterState(on);
    try {
      localStorage.setItem(KEY, JSON.stringify({ typewriter: on }));
    } catch {
      // preference still applies this session
    }
  };

  return { focus, setFocus, typewriter, setTypewriter };
}

/**
 * Typewriter scrolling: while active, keep the caret riding at ~45% of the
 * page height as you type. Instant, not smooth — smooth scrolling fights the
 * keystroke rhythm.
 */
export function useTypewriterScroll(editor: Editor | null, active: boolean): void {
  useEffect(() => {
    if (!editor || !active) return;
    let raf = 0;
    const center = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>(".wf-doc-scroll");
        if (!scroller) return;
        try {
          const coords = editor.view.coordsAtPos(editor.state.selection.head);
          const rect = scroller.getBoundingClientRect();
          const delta = coords.top - (rect.top + rect.height * 0.45);
          if (Math.abs(delta) > 4) scroller.scrollTop += delta;
        } catch {
          // the position can be unmapped mid-transaction; next event centres
        }
      });
    };
    editor.on("selectionUpdate", center);
    editor.on("update", center);
    return () => {
      cancelAnimationFrame(raf);
      editor.off("selectionUpdate", center);
      editor.off("update", center);
    };
  }, [editor, active]);
}
