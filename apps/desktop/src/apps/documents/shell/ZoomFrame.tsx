import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { useIsPhone } from "../../../editor/ui/Flyout";
import { clampZoom, fitZoom, stepZoom, useDocZoom } from "./zoom";

const PX_PER_IN = 96;

/** "zoom" draws the page with the browser's own page zoom in place of a
 *  transform. A way back for one release, should a webview draw a scaled
 *  page badly: set `wf-doc-zoom-how` to `zoom` in the app's storage. */
function zoomHow(): "scale" | "zoom" {
  try {
    return localStorage.getItem("wf-doc-zoom-how") === "zoom" ? "zoom" : "scale";
  } catch {
    return "scale";
  }
}

/**
 * The page (and the notes under it) at the size the writer chose.
 *
 * At 100% it is two plain boxes and nothing else: the page lays out as it
 * always has. At another size the page keeps its paper's width, the inner
 * box is drawn scaled from its top left corner, and the outer box is given
 * the room the scaled page takes, so the window scrolls over exactly that.
 * The text inside never knows: it is laid out once, at its own size, and a
 * change of zoom moves no line.
 *
 * Code that measures the page must know of it: see editor/ui/scale.ts.
 */
export function ZoomFrame({
  scroller,
  paper,
  children,
}: {
  /** The scrolling area the page sits in. */
  scroller: RefObject<HTMLElement | null>;
  /** The paper, inches. */
  paper: { w: number; h: number };
  children: ReactNode;
}) {
  const phone = useIsPhone();
  const mode = useDocZoom((s) => s.mode);
  const asked = useDocZoom((s) => s.z);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const how = useRef(zoomHow()).current;

  // A fitted page goes by the window: watch it.
  const fitted = !phone && mode !== "percent";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!fitted || !el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      // (As much of the height as shows a whole page under the top padding,
      // with a little of the desk under it.)
      const h = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - 16;
      setRoom((was) => (was && was.w === w && was.h === h ? was : { w, h }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitted, scroller]);

  const k = phone
    ? 1
    : mode === "percent"
      ? asked
      : room
        ? fitZoom(mode, room, { w: paper.w * PX_PER_IN, h: paper.h * PX_PER_IN })
        : 1;
  const on = Math.abs(k - 1) > 0.004;

  useEffect(() => {
    if (useDocZoom.getState().shown !== k) useDocZoom.setState({ shown: k });
  }, [k]);

  // The outer box takes the room the scaled page does, and keeps to it as
  // the text grows.
  useLayoutEffect(() => {
    const outer = box.current;
    const el = inner.current;
    if (!outer || !el) return;
    if (!on || how === "zoom") {
      outer.style.width = "";
      outer.style.height = "";
      return;
    }
    const size = () => {
      outer.style.width = `${el.offsetWidth * k}px`;
      outer.style.height = `${el.offsetHeight * k}px`;
    };
    size();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(size);
    ro.observe(el);
    return () => ro.disconnect();
  }, [k, on, how]);

  // What was under the pointer (or in the middle of the window) stays there.
  const last = useRef(k);
  const anchor = useRef<{ x: number; y: number; ux: number } | null>(null);
  useLayoutEffect(() => {
    const was = last.current;
    last.current = k;
    const at = anchor.current;
    anchor.current = null;
    const sc = scroller.current;
    const outer = box.current;
    if (!sc || !outer || was === k || !(was > 0)) return;
    const r = outer.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const y = at ? at.y : s.top + sc.clientHeight / 2;
    sc.scrollTop += (y - r.top) * (k / was - 1);
    if (at) sc.scrollLeft += r.left + at.ux * k - at.x;
    else sc.scrollLeft = Math.max(0, (sc.scrollWidth - sc.clientWidth) / 2);
  }, [k, scroller]);

  // Ctrl or ⌘ with the wheel, and a pinch on a trackpad.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || phone) return;
    const note = (x: number, y: number, now: number) => {
      const outer = box.current;
      if (outer) anchor.current = { x, y, ux: (x - outer.getBoundingClientRect().left) / now };
    };
    // The size to go on from: the one last asked for (what is drawn
    // follows a moment later, and a wheel can turn twice in that moment).
    const current = () => {
      const state = useDocZoom.getState();
      return state.mode === "percent" ? state.z : state.shown;
    };
    // A pinch arrives as many small steps: they are added up unrounded.
    let fine: number | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const shown = current();
      const { set } = useDocZoom.getState();
      let next: number;
      if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50) {
        // A wheel's notch: one named size.
        fine = null;
        next = stepZoom(shown, e.deltaY < 0 ? 1 : -1);
      } else {
        fine = (fine ?? shown) * Math.exp(-e.deltaY * 0.01);
        next = clampZoom(fine);
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => (fine = null), 250);
      }
      if (next === shown) return;
      note(e.clientX, e.clientY, shown);
      set(next);
    };
    // WebKit's own pinch events (it sends no wheel for one).
    type Pinch = Event & { scale: number; clientX: number; clientY: number };
    let from = 1;
    const onPinchStart = (e: Event) => {
      e.preventDefault();
      from = current();
    };
    const onPinch = (e: Event) => {
      e.preventDefault();
      const p = e as Pinch;
      const shown = current();
      const { set } = useDocZoom.getState();
      const next = clampZoom(from * (p.scale > 0 ? p.scale : 1));
      if (next === shown) return;
      note(p.clientX, p.clientY, shown);
      set(next);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    sc.addEventListener("gesturestart", onPinchStart);
    sc.addEventListener("gesturechange", onPinch);
    return () => {
      if (settle) clearTimeout(settle);
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("gesturestart", onPinchStart);
      sc.removeEventListener("gesturechange", onPinch);
    };
  }, [scroller, phone]);

  // (`--wf-zoom` tells code that measures the page what it was asked for:
  // editor/ui/scale.ts.)
  const style: CSSProperties | undefined = on
    ? { ...(how === "zoom" ? { zoom: k } : { transform: `scale(${k})` }), ["--wf-zoom" as string]: String(k) }
    : undefined;
  return (
    <div ref={box} className={`wf-zoom-box${on ? " on" : ""}`}>
      <div ref={inner} className="wf-zoom" style={style}>
        {children}
      </div>
    </div>
  );
}
