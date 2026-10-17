import type { Editor } from "@tiptap/react";
import { ClipboardPaste, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { pasteChoice, settlePaste, switchPaste, type PasteChoice } from "../format/paste";
import { placeUnder, textWindow } from "./bubblePlace";

/**
 * After a paste from another program: a small strip under it saying how it
 * was taken — matched to this document, by default — with the other way
 * one click off. It is there until the next thing is typed (or Escape, or
 * its ×); see format/paste.ts for what "match" keeps and leaves behind.
 */
export function PasteOptions({ editor }: { editor: Editor }) {
  const [choice, setChoice] = useState<PasteChoice | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [tick, setTick] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      if (editor.isDestroyed) return;
      setChoice(editor.isEditable ? pasteChoice(editor.view) : null);
      setTick((n) => n + 1);
    };
    sync();
    editor.on("transaction", sync);
    editor.on("update", sync);
    return () => {
      editor.off("transaction", sync);
      editor.off("update", sync);
    };
  }, [editor]);

  const shown = !!choice;

  useEffect(() => {
    if (!shown) return;
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return;
    }
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settlePaste(editor.view);
    };
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    dom.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
      dom.removeEventListener("keydown", onKey);
    };
  }, [shown, editor]);

  // Under the end of what was pasted (which is where the caret is).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!choice || !box || editor.isDestroyed) return;
    try {
      const end = editor.view.coordsAtPos(Math.min(choice.to, editor.state.doc.content.size), -1);
      setPlace(placeUnder(end, box.getBoundingClientRect(), textWindow(editor.view.dom)));
    } catch {
      // Not laid out yet: next time.
    }
  }, [choice, tick, editor]);

  if (!choice) return null;
  const matched = choice.mode === "match";
  const stay = (e: { preventDefault(): void }) => e.preventDefault();

  return createPortal(
    <div ref={boxRef} role="status" className="wf-paste-options" style={{ left: place?.left ?? -9999, top: place?.top ?? 0 }}>
      <ClipboardPaste size={14} aria-hidden="true" />
      <span>{matched ? "Pasted to match this document" : "Pasted with its own styling"}</span>
      <button
        type="button"
        title={matched ? "Bring its fonts, sizes, colors and alignment too" : "Leave its look behind: this document’s fonts, sizes and colors"}
        onMouseDown={stay}
        onClick={() => switchPaste(editor.view, matched ? "keep" : "match")}
      >
        {matched ? "Keep its styling" : "Match this document"}
      </button>
      <button type="button" className="wf-paste-close" title="Leave it as it is (Esc)" aria-label="Leave it as it is" onMouseDown={stay} onClick={() => settlePaste(editor.view)}>
        <X size={13} />
      </button>
    </div>,
    document.body,
  );
}
