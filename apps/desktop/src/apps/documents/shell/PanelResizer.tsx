import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { clampPanel, PANEL_MAX, PANEL_MIN, setPanelWidth, usePanelWidth } from "./panelWidth";

/**
 * The edge between the text and the side panel beside it, dragged to make
 * the panel wider or narrower. It sits just before the panel in
 * `.wf-doc-body` and takes no room of its own. The width goes on the body
 * as `--wf-panel-w` (styles.css gives it to the panel that follows), and is
 * kept on this device for that kind of panel.
 *
 * The arrow keys move it too, and a double click puts the panel back as it
 * was made. The stylesheet hides it on a phone, where panels slide over the
 * text, and while no panel follows it (one still loading).
 */
export function PanelResizer({ panel }: { panel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = usePanelWidth(panel);
  const [dragging, setDragging] = useState(false);

  // The body carries the width of the panel open now, and nothing once it
  // closes.
  useLayoutEffect(() => {
    const body = ref.current?.parentElement;
    if (!body) return;
    showWidth(body, width);
    return () => showWidth(body, null);
  }, [width, panel]);

  const panelEl = (): HTMLElement | null => {
    const next = ref.current?.nextElementSibling;
    return next instanceof HTMLElement && next.classList.contains("wf-doc-panel") ? next : null;
  };
  const room = () => ref.current?.parentElement?.clientWidth || Infinity;
  const widthNow = () => width ?? Math.round(panelEl()?.getBoundingClientRect().width || PANEL_MIN);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const body = ref.current?.parentElement;
    const el = panelEl();
    if (!body || !el) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const before = width;
    let w = startW;
    try {
      ref.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // The window's own listeners below still follow the pointer.
    }
    setDragging(true);
    document.documentElement.classList.add("wf-resizing");
    const move = (ev: PointerEvent) => {
      // The edge is on the panel's left: moving it left widens the panel.
      w = clampPanel(startW + (startX - ev.clientX), room());
      showWidth(body, w);
    };
    const end = (keep: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.documentElement.classList.remove("wf-resizing");
      setDragging(false);
      if (keep && Math.abs(w - startW) >= 1) setPanelWidth(panel, w);
      else showWidth(body, before);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = widthNow() + step;
    else if (e.key === "ArrowRight") next = widthNow() - step;
    else if (e.key === "Home") next = PANEL_MIN;
    else if (e.key === "End") next = PANEL_MAX;
    if (next === null) return;
    e.preventDefault();
    setPanelWidth(panel, clampPanel(next, room()));
  };

  return (
    <div
      ref={ref}
      className={`wf-panel-resizer${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Panel width"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title="Drag to change the panel’s width. Double-click to put it back."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setPanelWidth(panel, null)}
    />
  );
}

function showWidth(body: HTMLElement, w: number | null): void {
  if (w === null) {
    body.classList.remove("wf-panel-sized");
    body.style.removeProperty("--wf-panel-w");
  } else {
    body.classList.add("wf-panel-sized");
    body.style.setProperty("--wf-panel-w", `${w}px`);
  }
}
