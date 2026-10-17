import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";

import { docSettingsMap, pageDims, updateDocSettings, type DocSettings } from "../../apps/documents/docSettings";
import { regionUnit } from "../../lib/units";
import { setBlockAttrs } from "../format/ParaFormat";
import { encodeTabs, parseTabs, type TabKind, type TabStop } from "../schema/sanitize";
import { dragIndent, ptToX, snapPt, ticks, xToPt, type RulerFrame } from "./rulerGeometry";

const KEY = "wf-doc-ruler";

/** Whether the ruler is shown over a Document's page (this device's choice). */
export const useRulerShown = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: (() => {
    try {
      return localStorage.getItem(KEY) === "on";
    } catch {
      return false;
    }
  })(),
  set: (on) => {
    set({ on });
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // A convenience only.
    }
  },
}));

/** Settings written from the ruler: one step each in the undo history. */
const RULER = Symbol("wf-ruler");

/** What the ruler shows of the paragraph at the caret: points from the
 *  paper's left edge. */
interface Para {
  colLeft: number;
  colRight: number;
  first: number;
  left: number;
  right: number;
  /** Its indents as attributes would say them (for a drag to start from). */
  indL: number;
  indR: number;
  indF: number;
  /** Its stops (from the column's left), and whether they are its own
   *  (else its style's). */
  stops: TabStop[];
  own: boolean;
}

type Mark = "ml" | "mr" | "first" | "left" | "right" | "tab";

interface Drag {
  mark: Mark;
  /** A tab's index in the paragraph's stops (-1: a new one). */
  index: number;
  /** Where it is now, points from the paper's edge. */
  at: number;
  /** Pulled down off the ruler: a tab stop let go of there is removed. */
  off: boolean;
}

const KIND_NAME: Record<TabKind, string> = { l: "left", c: "center", r: "right", d: "decimal" };

/**
 * The ruler over a Document's page (desktop): the page's margins, the
 * paragraph's indents and its tab stops, each to drag. A click on the
 * ruler between the margins sets a left tab stop there. Drag a stop down
 * off the ruler to take it away.
 *
 * Margins are the document's settings, written so that one drag is one
 * step of Undo. Indents and stops are the paragraphs', as the Layout tab
 * sets them. Marks settle to a sixteenth of an inch or a quarter of a
 * centimetre (hold Alt for none).
 */
export function Ruler({ editor, ydoc, settings, styleStops }: { editor: Editor; ydoc: Y.Doc; settings: DocSettings; styleStops: (node: import("@tiptap/pm/model").Node) => TabStop[] | null }) {
  const unit = useMemo(() => regionUnit(), []);
  const box = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<RulerFrame | null>(null);
  const [para, setPara] = useState<Para | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const paper = pageDims(settings).w * 72;
  const ml = (settings.ml + settings.gutter) * 72;
  const mr = paper - settings.mr * 72;

  const measure = useCallback(() => {
    if (editor.isDestroyed) return;
    const sheet = (editor.view.dom as HTMLElement).closest(".wf-page") as HTMLElement | null;
    const own = box.current;
    if (!sheet || !own) return;
    const s = sheet.getBoundingClientRect();
    const r = own.getBoundingClientRect();
    if (!(s.width > 0)) return;
    const f: RulerFrame = { left: s.left - r.left, pxPerPt: s.width / paper, paper };
    setFrame(f);
    const { $from } = editor.state.selection;
    const block = $from.parent;
    if (!block.isTextblock || $from.depth < 1) {
      setPara(null);
      return;
    }
    const dom = editor.view.nodeDOM($from.before($from.depth));
    if (!(dom instanceof HTMLElement)) {
      setPara(null);
      return;
    }
    const toPt = (x: number) => (x - s.left) / f.pxPerPt;
    const cell = dom.closest("td, th") as HTMLElement | null;
    let colLeft = ml;
    let colRight = mr;
    if (cell) {
      const cr = cell.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      const k = cr.width / (cell.offsetWidth || cr.width || 1);
      colLeft = toPt(cr.left + (parseFloat(cs.paddingLeft) || 0) * k);
      colRight = toPt(cr.right - (parseFloat(cs.paddingRight) || 0) * k);
    }
    const pr = dom.getBoundingClientRect();
    const ps = getComputedStyle(dom);
    const k = pr.width / (dom.offsetWidth || pr.width || 1);
    const left = toPt(pr.left + (parseFloat(ps.paddingLeft) || 0) * k);
    const right = toPt(pr.right - (parseFloat(ps.paddingRight) || 0) * k);
    const first = left + ((parseFloat(ps.textIndent) || 0) * k) / f.pxPerPt;
    const own_ = parseTabs(block.attrs.tabs);
    const stops = Array.isArray(own_) ? own_ : own_ === "none" ? [] : (styleStops(block) ?? []);
    setPara({ colLeft, colRight, first, left, right, indL: Math.max(0, left - colLeft), indR: Math.max(0, colRight - right), indF: first - left, stops, own: Array.isArray(own_) });
  }, [editor, paper, ml, mr, styleStops]);

  useEffect(() => {
    let frameId = 0;
    const soon = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };
    soon();
    editor.on("transaction", soon);
    window.addEventListener("resize", soon);
    const scroller = box.current?.closest(".wf-doc-scroll");
    scroller?.addEventListener("scroll", soon, { passive: true });
    const sheet = (editor.view.dom as HTMLElement).closest(".wf-page");
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(soon) : null;
    if (sheet) ro?.observe(sheet);
    return () => {
      cancelAnimationFrame(frameId);
      editor.off("transaction", soon);
      window.removeEventListener("resize", soon);
      scroller?.removeEventListener("scroll", soon);
      ro?.disconnect();
    };
  }, [editor, measure]);

  const ptAt = (e: React.PointerEvent | PointerEvent): number => {
    const r = box.current!.getBoundingClientRect();
    return snapPt(xToPt(frame!, e.clientX - r.left), unit, e.altKey);
  };

  const begin = (e: React.PointerEvent, mark: Mark, index = -1) => {
    if (!frame || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ mark, index, at: ptAt(e), off: false });
  };

  const move = (e: React.PointerEvent) => {
    if (!drag || !frame) return;
    const r = box.current!.getBoundingClientRect();
    const off = drag.mark === "tab" && e.clientY - r.bottom > 18;
    setDrag({ ...drag, at: ptAt(e), off });
  };

  const end = () => {
    const d = drag;
    setDrag(null);
    if (!d || !frame) return;
    if (d.mark === "ml" || d.mark === "mr") {
      // The other margin and the text between keep an inch at the least.
      const inches = d.mark === "ml" ? Math.max(0, Math.min(d.at, mr - 72) / 72 - settings.gutter) : Math.max(0, (paper - Math.max(d.at, ml + 72)) / 72);
      writeSettings(editor, ydoc, { [d.mark]: Math.round(inches * 1000) / 1000 });
      return;
    }
    if (!para) return;
    if (d.mark === "tab") {
      const stops = para.stops.filter((_, i) => i !== d.index);
      const at = Math.round((d.at - para.colLeft) * 10) / 10;
      const kept = d.index >= 0 ? para.stops[d.index] : { pt: at, kind: "l" as const, leader: null };
      const next = d.off || at <= 0 ? stops : [...stops, { ...kept, pt: at }];
      // (Taking away a style's last stop says the paragraph has none.)
      setBlockAttrs(editor, { tabs: encodeTabs(next) ?? (para.own || !para.stops.length ? null : "none") }, false);
      return;
    }
    const now = { indL: para.indL, indR: para.indR, indF: para.indF };
    const next = dragIndent(d.mark, d.at, para.colLeft, para.colRight, now);
    setBlockAttrs(editor, { indL: next.indL || null, indR: next.indR || null, indF: next.indF || null }, false);
  };

  // A click on the ruler between the column's edges: a left stop there.
  const onRulerDown = (e: React.PointerEvent) => {
    if (!frame || !para || e.button !== 0 || editor.isEditable === false) return;
    const at = ptAt(e);
    if (at <= para.colLeft || at >= para.colRight) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ mark: "tab", index: -1, at, off: false });
  };

  if (!frame) return <div className="wf-ruler" ref={box} aria-hidden />;
  const x = (pt: number) => ptToX(frame, pt) - frame.left;
  const shown = (mark: Mark, index = -1, at: number) => (drag && drag.mark === mark && drag.index === index ? drag.at : at);
  const editable = editor.isEditable;
  return (
    <div className="wf-ruler" ref={box} role="group" aria-label="Ruler" onPointerMove={move} onPointerUp={end} onPointerCancel={() => setDrag(null)}>
      <div className="wf-ruler-paper" style={{ left: frame.left, width: paper * frame.pxPerPt }} onPointerDown={editable ? onRulerDown : undefined}>
        <div className="wf-ruler-margin" style={{ left: 0, width: x(shown("ml", -1, ml)) }} />
        <div className="wf-ruler-margin" style={{ left: x(shown("mr", -1, mr)), right: 0 }} />
        {ticks(paper, ml, unit).map((t) => (
          <span key={t.pt} className={`wf-ruler-tick ${t.size}`} style={{ left: x(t.pt) }}>
            {t.label && <i>{t.label}</i>}
          </span>
        ))}
        {editable && (
          <>
            <button type="button" className="wf-ruler-edge" title="Left margin" aria-label="Left margin" style={{ left: x(shown("ml", -1, ml)) }} onPointerDown={(e) => begin(e, "ml")} />
            <button type="button" className="wf-ruler-edge" title="Right margin" aria-label="Right margin" style={{ left: x(shown("mr", -1, mr)) }} onPointerDown={(e) => begin(e, "mr")} />
          </>
        )}
        {para && (
          <>
            <button type="button" className="wf-ruler-indent first" title="First line" aria-label="First line indent" disabled={!editable} style={{ left: x(shown("first", -1, para.first)) }} onPointerDown={(e) => begin(e, "first")} />
            <button type="button" className="wf-ruler-indent left" title="Left indent" aria-label="Left indent" disabled={!editable} style={{ left: x(shown("left", -1, para.left)) }} onPointerDown={(e) => begin(e, "left")} />
            <button type="button" className="wf-ruler-indent right" title="Right indent" aria-label="Right indent" disabled={!editable} style={{ left: x(shown("right", -1, para.right)) }} onPointerDown={(e) => begin(e, "right")} />
            {para.stops.map((s, i) => (
              <button
                key={`${s.pt}:${i}`}
                type="button"
                className={`wf-ruler-tab ${s.kind}${drag?.mark === "tab" && drag.index === i && drag.off ? " off" : ""}`}
                title={`A ${KIND_NAME[s.kind]} tab stop. Drag it down off the ruler to take it away.`}
                aria-label={`${KIND_NAME[s.kind]} tab stop`}
                disabled={!editable}
                style={{ left: x(shown("tab", i, para.colLeft + s.pt)) }}
                onPointerDown={(e) => begin(e, "tab", i)}
              />
            ))}
            {drag?.mark === "tab" && drag.index === -1 && !drag.off && <span className="wf-ruler-tab l new" style={{ left: x(drag.at) }} />}
          </>
        )}
      </div>
    </div>
  );
}

/** Write settings so that the change is one step of Undo (the settings
 *  panel's own changes are not undone: they are written without this). */
function writeSettings(editor: Editor, ydoc: Y.Doc, patch: Partial<DocSettings>): void {
  const manager = (yUndoPluginKey.getState(editor.state) as { undoManager?: Y.UndoManager } | undefined)?.undoManager;
  if (manager) {
    manager.addToScope(docSettingsMap(ydoc));
    manager.addTrackedOrigin(RULER);
    manager.stopCapturing();
  }
  updateDocSettings(ydoc, patch, RULER);
  manager?.stopCapturing();
}
