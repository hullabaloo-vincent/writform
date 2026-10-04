import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useEffect } from "react";

/**
 * Reopen a document where you left off: the cursor and the scroll position,
 * remembered per document on this device (the 50 most recent). Saved as you
 * move and scroll, and when the document closes or the app goes to the
 * background; restored when it opens again — after switching apps, too.
 */

const STORE = "wf-doc-pos";
const KEEP = 50;

interface Saved {
  sel: number;
  top: number;
  at: number;
}

function readAll(): Record<string, Saved> {
  try {
    return (JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, Saved>) ?? {};
  } catch {
    return {};
  }
}

function save(key: string, value: Omit<Saved, "at">) {
  try {
    const all = readAll();
    all[key] = { ...value, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > KEEP) {
      for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - KEEP)) delete all[k];
    }
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // Remembering the place is a convenience.
  }
}

export function useReopenPosition(
  editor: Editor | null,
  key: string,
  scroller: React.RefObject<HTMLElement | null>,
) {
  // Restore once the editor and its text are in place.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const saved = readAll()[key];
    if (!saved) return;
    let frame = requestAnimationFrame(() => {
      // A second frame: the text has laid out (pagination, images).
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const size = editor.state.doc.content.size;
        try {
          const $pos = editor.state.doc.resolve(Math.max(0, Math.min(saved.sel, size)));
          editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near($pos)));
        } catch {
          // The text changed under the saved spot; the scroll still helps.
        }
        if (scroller.current) scroller.current.scrollTop = saved.top;
      });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document
  }, [editor, key]);

  // Save as the writer moves and scrolls, and on the way out.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const el = scroller.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The latest place, kept as it changes: by the time this cleans up, the
    // editor may already be gone.
    let last: Omit<Saved, "at"> | null = null;
    const capture = () => {
      if (!editor.isDestroyed) last = { sel: editor.state.selection.head, top: el?.scrollTop ?? 0 };
    };
    const now = () => {
      capture();
      if (last) save(key, last);
    };
    const soon = () => {
      capture();
      if (timer) clearTimeout(timer);
      timer = setTimeout(now, 800);
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") now();
    };
    editor.on("selectionUpdate", soon);
    el?.addEventListener("scroll", soon, { passive: true });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", now);
    return () => {
      if (timer) clearTimeout(timer);
      now();
      editor.off("selectionUpdate", soon);
      el?.removeEventListener("scroll", soon);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", now);
    };
  }, [editor, key, scroller]);
}
