import type { Editor } from "@tiptap/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { canStepChapter, chapterFocus, showEverything, stepChapter, type ChapterFocusState } from "../../editor/ChapterFocus";
import { reveal } from "../../editor/ui/reveal";

/** The chapter shown on its own, or null when the whole text is (kept as
 *  the same object while it stays the same chapter). */
export function useChapterFocus(editor: Editor | null): ChapterFocusState | null {
  const [focus, setFocus] = useState<ChapterFocusState | null>(() => (editor ? chapterFocus(editor.state) : null));
  useEffect(() => {
    if (!editor) return;
    const read = () =>
      setFocus((prev) => {
        const now = chapterFocus(editor.state);
        if (prev && now && prev.from === now.from && prev.to === now.to && prev.label === now.label) return prev;
        return now;
      });
    read();
    editor.on("transaction", read);
    return () => {
      editor.off("transaction", read);
    };
  }, [editor]);

  // A chapter newly shown: the caret's place in view (what was above it is
  // hidden now, so the page has moved under it).
  const from = focus?.from ?? null;
  const was = useRef(from);
  useEffect(() => {
    if (was.current === from) return;
    was.current = from;
    if (!editor || editor.isDestroyed) return;
    reveal(editor.view, editor.state.selection.from);
  }, [editor, from]);
  return focus;
}

/** Over the page while one chapter is shown: which, the ones either side,
 *  and the way back to the whole text. */
export function ChapterBar({ editor, focus, noun }: { editor: Editor; focus: ChapterFocusState; noun: string }) {
  return (
    <div className="wf-chapter-bar" role="region" aria-label={`Only this ${noun}`}>
      <button type="button" className="wf-icon" title={`Show the ${noun} before`} aria-label={`Show the ${noun} before`} disabled={!canStepChapter(editor, -1)} onClick={() => stepChapter(editor, -1)}>
        <ChevronLeft size={15} />
      </button>
      <span className="wf-chapter-bar-name" title={focus.label}>
        {focus.label}
      </span>
      <button type="button" className="wf-icon" title={`Show the ${noun} after`} aria-label={`Show the ${noun} after`} disabled={!canStepChapter(editor, 1)} onClick={() => stepChapter(editor, 1)}>
        <ChevronRight size={15} />
      </button>
      <button type="button" className="wf-chapter-bar-all" onClick={() => showEverything(editor)}>
        Show everything
      </button>
    </div>
  );
}
