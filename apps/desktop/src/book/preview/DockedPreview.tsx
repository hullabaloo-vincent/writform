import type { Editor } from "@tiptap/react";
import { ChevronLeft, ChevronRight, Crosshair, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DisplayList } from "../engine/types";
import type { Book } from "../model/bookMap";
import { pickSource, useSize } from "./BookPreview";
import { PageSvg } from "./PageSvg";
import { mapPosition, pageForBlock, usePreviewLayout } from "./usePreviewLayout";

/**
 * The live book preview, docked beside the manuscript on wide screens: one
 * page fitted to the panel, re-set 800 ms after the writing stops (only the
 * chapter being edited is re-set), keeping your place. "Go to the cursor"
 * finds the page you're writing on; the expand button opens the full
 * preview with spreads.
 */
export function DockedPreview({
  editor,
  format,
  book,
  onExpand,
  onClose,
  onShowSource,
}: {
  editor: Editor;
  format: string;
  book: Book;
  onExpand: () => void;
  onClose: () => void;
  onShowSource: (src: number) => void;
}) {
  const { dl, busy, message, error, retry } = usePreviewLayout(editor, format, book, true, "dock");
  const [at, setAt] = useState(0);
  const [pick, setPick] = useState<{ src: number; x: number; y: number } | null>(null);
  const shown = useRef<DisplayList | null>(null);
  const placed = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useSize(stageRef);

  // Docking needs a wide window; if it narrows, the panel steps aside.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const onChange = () => {
      if (!mq.matches) closeRef.current();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const cursorPage = (layout: DisplayList) => {
    const { from } = editor.state.selection;
    return pageForBlock(layout, editor.state.doc.resolve(from).index(0));
  };

  // A new layout keeps the reading position; the first one opens at the
  // page being written.
  useEffect(() => {
    if (!dl) return;
    const old = shown.current;
    shown.current = dl;
    if (!placed.current) {
      placed.current = true;
      setAt(cursorPage(dl));
    } else if (old) {
      setAt((cur) => mapPosition(old, dl, cur));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per layout
  }, [dl]);

  const count = dl?.pages.length ?? 0;
  const page = dl ? dl.pages[Math.min(at, count - 1)] : null;
  const pageW = dl ? Math.max(40, Math.min(size.w - 28, ((size.h - 20) * dl.trim.w) / dl.trim.h)) : 0;

  return (
    <aside className="wf-doc-panel wf-bp-dock" aria-label="Book preview">
      <header className="wf-doc-panel-header wf-bp-dock-bar">
        <button className="wf-icon" title="Previous page" disabled={!dl || at === 0} onClick={() => setAt(Math.max(0, at - 1))}>
          <ChevronLeft size={16} />
        </button>
        <span className="wf-bp-where">{dl ? `${page?.folio ? `p. ${page.folio}` : "—"} · ${at + 1} of ${count}` : "Book preview"}</span>
        <button
          className="wf-icon"
          title="Next page"
          disabled={!dl || at >= count - 1}
          onClick={() => setAt(Math.min(count - 1, at + 1))}
        >
          <ChevronRight size={16} />
        </button>
        <span className="wf-statusbar-spacer" />
        {busy && dl && <span className="wf-bp-pill inline">Updating…</span>}
        <button className="wf-icon" title="Go to the page you're writing on" disabled={!dl} onClick={() => dl && setAt(cursorPage(dl))}>
          <Crosshair size={15} />
        </button>
        <button className="wf-icon" title="Open the full preview" onClick={onExpand}>
          <Maximize2 size={15} />
        </button>
        <button className="wf-icon" title="Close the preview" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div
        ref={stageRef}
        className="wf-bp-dock-stage"
        onClick={(e) => {
          const p = pickSource(e);
          setPick(p);
        }}
      >
        {!dl && !error && <p className="wf-bp-status">{message || "Setting the book…"}</p>}
        {error && (
          <div className="wf-bp-status">
            <p>{error}</p>
            <button onClick={retry}>Try again</button>
          </div>
        )}
        {dl && page && pageW > 0 && <PageSvg page={page} dl={dl} width={pageW} paper={book.print.paper} />}
      </div>
      {pick && (
        <div className="wf-bp-pick" style={{ left: pick.x, top: pick.y + 14 }}>
          <button
            className="wf-primary"
            onClick={(e) => {
              e.stopPropagation();
              setPick(null);
              onShowSource(pick.src);
            }}
          >
            Edit here
          </button>
        </div>
      )}
    </aside>
  );
}
