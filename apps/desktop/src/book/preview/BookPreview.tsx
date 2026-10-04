import type { Editor } from "@tiptap/react";
import { AlertTriangle, ChevronLeft, ChevronRight, Columns2, Download, RectangleVertical, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useSwipe } from "../../lib/useSwipe";
import type { Book } from "../model/bookMap";
import { PageSvg } from "./PageSvg";
import { sectionAt, spreadOf, usePreviewLayout } from "./usePreviewLayout";

const PX_PER_PT = 96 / 72;
const ZOOMS = [50, 75, 100, 150, 200] as const;
/** Chapters inside a part are indented in the chapter list. */
const INDENT = String.fromCharCode(160).repeat(4);

const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

/** Track an element's size. */
export function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Where a click on a line of text came from in the manuscript. */
export function pickSource(e: React.MouseEvent): { src: number; x: number; y: number } | null {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return null; // selecting text, not picking
  const el = (e.target as Element).closest?.("text[data-src]");
  const src = el ? Number(el.getAttribute("data-src")) : NaN;
  return Number.isFinite(src) && src >= 0 ? { src, x: e.clientX, y: e.clientY } : null;
}

/**
 * The book as it will print: facing pages on a desk, page 1 alone on the
 * right. Arrow keys, Page Up/Down and swipes turn pages; jump to a chapter
 * or drag through the book; zoom from fit to 200 %. Click any line for
 * "Edit here", which closes the preview at that paragraph. On phones it's
 * one page at a time, fitted to the width; a tap shows or hides the
 * controls.
 */
export function BookPreview({
  editor,
  format,
  book,
  onClose,
  onShowSource,
  onExport,
}: {
  editor: Editor;
  format: string;
  book: Book;
  onClose: () => void;
  /** Put the cursor in a manuscript block (top-level index). */
  onShowSource: (src: number) => void;
  onExport: () => void;
}) {
  const { dl, busy, message, error, retry } = usePreviewLayout(editor, format, book, false, "overlay");
  const phone = isPhone();
  const [spreads, setSpreads] = useState(!phone);
  const [at, setAt] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [pick, setPick] = useState<{ src: number; x: number; y: number } | null>(null);
  const [chrome, setChrome] = useState(true);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useSize(stageRef);

  const count = dl?.pages.length ?? 0;
  const spread = spreads && !phone;
  const visible: (number | null)[] = spread ? spreadOf(at, count) : [at];

  const go = useCallback(
    (dir: 1 | -1) => {
      setPick(null);
      setAt((cur) => {
        if (!count) return 0;
        if (!spread) return Math.max(0, Math.min(count - 1, cur + dir));
        const [verso] = spreadOf(cur, count);
        if (dir > 0) return Math.min(count - 1, verso === null ? 1 : verso + 2);
        return verso === null || verso <= 1 ? 0 : verso - 2;
      });
    },
    [count, spread],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.("select, input")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (pick) setPick(null);
        else onClose();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Home") {
        setAt(0);
      } else if (e.key === "End") {
        setAt(Math.max(0, count - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, count, pick]);

  const swipe = useSwipe({ onLeft: () => go(1), onRight: () => go(-1) });

  // Page size: fit the spread (or page) to the stage, or a zoom where 100 %
  // is the printed size.
  let pageW = 0;
  if (dl) {
    const across = spread ? 2 : 1;
    const fit = Math.min((size.w - (phone ? 16 : 64)) / (across * dl.trim.w), (size.h - (phone ? 16 : 48)) / dl.trim.h);
    pageW = dl.trim.w * Math.max(0.05, zoom === "fit" ? fit : (zoom / 100) * PX_PER_PT);
  }

  const current = dl ? sectionAt(dl, visible.find((v) => v !== null) ?? 0) : -1;
  const label = (() => {
    if (!dl) return "";
    const shown = visible.filter((v): v is number => v !== null).map((i) => i + 1);
    return shown.length > 1 ? `Pages ${shown[0]}–${shown[1]} of ${count}` : `Page ${shown[0] ?? 1} of ${count}`;
  })();
  const warnings = dl?.warnings ?? [];

  return (
    <div className={`wf-bp-overlay${chrome ? "" : " wf-bp-bare"}`} role="dialog" aria-label="Book preview">
      <header className="wf-bp-bar">
        <button className="wf-icon" title="Close preview (Esc)" onClick={onClose}>
          <X size={17} />
        </button>
        <strong className="wf-bp-title">Book preview</strong>
        {dl && (
          <>
            <button className="wf-icon" title="Previous (←)" disabled={at === 0} onClick={() => go(-1)}>
              <ChevronLeft size={17} />
            </button>
            <span className="wf-bp-where">{label}</span>
            <button className="wf-icon" title="Next (→)" disabled={at >= count - 1} onClick={() => go(1)}>
              <ChevronRight size={17} />
            </button>
            <select
              className="wf-bp-chapter"
              title="Go to a chapter"
              value={current}
              onChange={(e) => {
                const s = dl.sections[Number(e.target.value)];
                if (s) setAt(s.firstPage);
              }}
            >
              {current < 0 && <option value={-1}>Front matter</option>}
              {dl.sections.map((s, i) => (
                <option key={s.id} value={i}>
                  {s.level ? `${INDENT}${s.title}` : s.title}
                </option>
              ))}
            </select>
            <input
              className="wf-bp-slider"
              type="range"
              min={0}
              max={Math.max(0, count - 1)}
              value={at}
              aria-label="Page"
              onChange={(e) => setAt(Number(e.target.value))}
            />
            {!phone && (
              <>
                <select
                  className="wf-bp-zoom"
                  title="Zoom"
                  value={String(zoom)}
                  onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))}
                >
                  <option value="fit">Fit</option>
                  {ZOOMS.map((z) => (
                    <option key={z} value={z}>
                      {z} %
                    </option>
                  ))}
                </select>
                <button
                  className="wf-icon"
                  title={spread ? "One page at a time" : "Facing pages"}
                  onClick={() => setSpreads(!spreads)}
                >
                  {spread ? <RectangleVertical size={16} /> : <Columns2 size={16} />}
                </button>
              </>
            )}
            {warnings.length > 0 && (
              <button
                className={`wf-bp-warn${warningsOpen ? " active" : ""}`}
                title="Things to check before printing"
                onClick={() => setWarningsOpen(!warningsOpen)}
              >
                <AlertTriangle size={14} /> {warnings.length}
              </button>
            )}
          </>
        )}
        <span className="wf-statusbar-spacer" />
        <button className="wf-primary wf-bp-export" onClick={onExport}>
          <Download size={14} /> Export PDF…
        </button>
      </header>

      {warningsOpen && warnings.length > 0 && (
        <div className="wf-bp-warnings">
          <ul>
            {warnings.slice(0, 50).map((w, i) => (
              <li key={i}>
                <span>{w.message}</span>
                {w.src !== undefined && (
                  <button className="wf-link-button" onClick={() => onShowSource(w.src!)}>
                    Show
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        ref={stageRef}
        className="wf-bp-stage"
        {...swipe}
        onClick={(e) => {
          const p = pickSource(e);
          if (p) setPick(p);
          else if (pick) setPick(null);
          else if (phone) setChrome(!chrome);
        }}
      >
        {!dl && !error && <p className="wf-bp-status">{message || "Setting the book…"}</p>}
        {error && (
          <div className="wf-bp-status">
            <p>{error}</p>
            <button onClick={retry}>Try again</button>
          </div>
        )}
        {dl && pageW > 0 && (
          <div className="wf-bp-spread">
            {visible.map((index, slot) =>
              index === null ? (
                <div key={`empty-${slot}`} className="wf-bp-slot" style={{ width: pageW }} />
              ) : (
                <div key={index} className={`wf-bp-slot ${dl.pages[index].side}`}>
                  <PageSvg page={dl.pages[index]} dl={dl} width={pageW} paper={book.print.paper} />
                </div>
              ),
            )}
          </div>
        )}
        {busy && dl && <span className="wf-bp-pill">{message || "Updating…"}</span>}
      </div>

      {pick && (
        <div className="wf-bp-pick" style={{ left: pick.x, top: pick.y + 14 }}>
          <button
            className="wf-primary"
            onClick={(e) => {
              e.stopPropagation();
              onShowSource(pick.src);
            }}
          >
            Edit here
          </button>
        </div>
      )}
    </div>
  );
}
