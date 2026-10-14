import { useEffect, useRef } from "react";

import type { Hit } from "./search";
import type { PdfSession } from "./session";

/**
 * One page of a PDF on the screen: the page as pdf.js draws it, its words
 * over it (unseen, so they can be selected), and what a search found.
 *
 * A page is drawn only while it is near the part of the document being
 * looked at. Away from it, its canvas is emptied: a long PDF is then no
 * heavier to have open than the few pages in view.
 */

/** The most pixels a page is drawn at (a phone has less to spare). */
const PAGE_PIXELS = 12_000_000;
const PHONE_PIXELS = 5_000_000;
const coarse = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/** Draw page `index` on `canvas`, `width` wide on the screen. Returns a way
 *  to stop. */
export function drawPage(session: PdfSession, index: number, canvas: HTMLCanvasElement, width: number, most = coarse() ? PHONE_PIXELS : PAGE_PIXELS): () => void {
  let stopped = false;
  let task: { cancel(): void; promise: Promise<unknown> } | null = null;
  void (async () => {
    try {
      const page = await session.pdf.getPage(index + 1);
      if (stopped) return;
      const flat = page.getViewport({ scale: 1 });
      const dense = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      let scale = (width / flat.width) * dense;
      if (flat.width * flat.height * scale * scale > most) scale = Math.sqrt(most / (flat.width * flat.height));
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      task = page.render({ canvasContext: ctx, viewport, canvas });
      await task.promise;
    } catch {
      // (Stopped, or a page pdf.js cannot draw: it stays blank.)
    }
  })();
  return () => {
    stopped = true;
    task?.cancel();
  };
}

export function PageFrame({
  session,
  index,
  width,
  stamp,
  near,
  hits,
  current,
  children,
}: {
  session: PdfSession;
  index: number;
  /** How wide it is shown, CSS pixels. */
  width: number;
  /** Changes when this page has to be drawn again. */
  stamp: number;
  /** Near enough to what is being looked at to be drawn. */
  near: boolean;
  hits: Hit[];
  /** Which of `hits` is the one stepped to (-1: none). */
  current: number;
  /** What is laid over the page (marks being made). */
  children?: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const page = session.info.pages[index];
  const height = page ? (width * page.h) / page.w : width * 1.3;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    if (!near) {
      canvas.width = canvas.height = 0;
      return;
    }
    return drawPage(session, index, canvas, width);
  }, [session, index, width, stamp, near, page]);

  // The page's words, laid where they are drawn, for selecting and copying.
  useEffect(() => {
    const holder = textRef.current;
    if (!holder || !near || !page) return;
    let stopped = false;
    let layer: { cancel(): void } | null = null;
    holder.replaceChildren();
    void (async () => {
      try {
        const pdfPage = await session.pdf.getPage(index + 1);
        if (stopped) return;
        const scale = width / pdfPage.getViewport({ scale: 1 }).width;
        holder.style.setProperty("--total-scale-factor", String(scale));
        holder.style.setProperty("--scale-factor", String(scale));
        const made = new session.pdfjs.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: holder, viewport: pdfPage.getViewport({ scale }) });
        layer = made;
        await made.render();
      } catch {
        // (No words to lay: the page can still be read.)
      }
    })();
    return () => {
      stopped = true;
      layer?.cancel();
    };
  }, [session, index, width, stamp, near, page]);

  return (
    <div className="wf-pdf-page" data-page={index} data-points={page?.w} style={{ width, height }}>
      <canvas ref={canvasRef} aria-label={`Page ${index + 1}`} />
      <div ref={textRef} className="wf-pdf-text" />
      {hits.length > 0 && (
        <div className="wf-pdf-hits" aria-hidden>
          {hits.flatMap((hit, k) =>
            hit.rects.map((r, j) => (
              <span key={`${k}-${j}`} className={k === current ? "current" : undefined} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
            )),
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** A small picture of a page, for the list of pages. */
export function Thumb({ session, index, stamp, near }: { session: PdfSession; index: number; stamp: number; near: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const page = session.info.pages[index];
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !near || !page) return;
    return drawPage(session, index, canvas, THUMB_WIDTH, 400_000);
  }, [session, index, stamp, near, page]);
  return <canvas ref={canvasRef} style={{ width: THUMB_WIDTH, height: page ? (THUMB_WIDTH * page.h) / page.w : THUMB_WIDTH * 1.3 }} />;
}

export const THUMB_WIDTH = 104;
