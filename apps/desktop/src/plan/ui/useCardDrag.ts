import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/**
 * Dragging cards between cells and the unassigned list, by mouse, pen or
 * touch. Drop places are elements marked `data-drop` (a cell's key, or
 * "loose"), the cards in them `data-card`. A mouse moves a card once it
 * has moved 6 pixels. A finger first holds still for a moment, so a swipe
 * still scrolls. A press let go without moving is a click.
 */

export interface DropAt {
  /** The `data-drop` of the place. */
  zone: string;
  /** The card it goes before there, or null for the end. */
  before: string | null;
}

export interface CardDrag {
  onPointerDown: (e: ReactPointerEvent, id: string) => void;
  /** The card being dragged, and where the pointer is. */
  dragging: { id: string; x: number; y: number } | null;
  over: DropAt | null;
}

const HOLD_MS = 350;
const MOUSE_SLOP = 6;
const TOUCH_SLOP = 8;
const EDGE = 40;

/** Where a drop at (x, y) lands, among the places in `root`. */
export function dropAt(root: HTMLElement, x: number, y: number, dragged: string): DropAt | null {
  for (const zone of root.querySelectorAll<HTMLElement>("[data-drop]")) {
    const r = zone.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    let before: string | null = null;
    for (const card of zone.querySelectorAll<HTMLElement>("[data-card]")) {
      const id = card.dataset.card ?? "";
      if (id === dragged) continue;
      const c = card.getBoundingClientRect();
      const midY = c.top + c.height / 2;
      // Above its middle, or beside it on its own line (a wrapping list).
      if (y < c.top || (y < midY && x < c.right) || (y >= c.top && y <= c.bottom && x < c.left + c.width / 2)) {
        before = id;
        break;
      }
    }
    return { zone: zone.dataset.drop ?? "", before };
  }
  return null;
}

export function useCardDrag(
  root: RefObject<HTMLElement | null>,
  scroller: RefObject<HTMLElement | null>,
  options: { enabled: boolean; onDrop: (id: string, at: DropAt) => void; onClick: (id: string) => void },
): CardDrag {
  const [dragging, setDragging] = useState<CardDrag["dragging"]>(null);
  const [over, setOver] = useState<DropAt | null>(null);
  const opts = useRef(options);
  useLayoutEffect(() => {
    opts.current = options;
  });
  const press = useRef<{ id: string; x: number; y: number; touch: boolean; armed: boolean; timer: number; pointer: number; el: Element | null } | null>(null);
  const live = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const end = () => {
    const p = press.current;
    if (p) window.clearTimeout(p.timer);
    press.current = null;
    live.current = null;
    cancelAnimationFrame(frame.current);
    setDragging(null);
    setOver(null);
    cleanup.current?.();
    cleanup.current = null;
  };

  const scrollNear = () => {
    const at = live.current;
    const box = scroller.current;
    if (!at || !box || !press.current?.armed) return;
    const r = box.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (at.x < r.left + EDGE) dx = -12;
    else if (at.x > r.right - EDGE) dx = 12;
    if (at.y < r.top + EDGE) dy = -12;
    else if (at.y > r.bottom - EDGE) dy = 12;
    if (dx || dy) {
      box.scrollLeft += dx;
      box.scrollTop += dy;
      if (root.current && press.current) setOver(dropAt(root.current, at.x, at.y, press.current.id));
    }
    frame.current = requestAnimationFrame(scrollNear);
  };

  const arm = () => {
    const p = press.current;
    if (!p || p.armed) return;
    p.armed = true;
    setDragging({ id: p.id, x: live.current?.x ?? p.x, y: live.current?.y ?? p.y });
    frame.current = requestAnimationFrame(scrollNear);
  };

  const onPointerDown = (e: ReactPointerEvent, id: string) => {
    if (!opts.current.enabled || e.button !== 0 || press.current) return;
    if ((e.target as Element).closest("button, input, textarea, select, a, [contenteditable]")) return;
    const touch = e.pointerType === "touch";
    const p = { id, x: e.clientX, y: e.clientY, touch, armed: false, timer: 0, pointer: e.pointerId, el: e.currentTarget as Element };
    press.current = p;
    live.current = { x: e.clientX, y: e.clientY };
    if (touch) p.timer = window.setTimeout(arm, HOLD_MS);

    const onMove = (ev: PointerEvent) => {
      const now = press.current;
      if (!now || ev.pointerId !== now.pointer) return;
      live.current = { x: ev.clientX, y: ev.clientY };
      const moved = Math.hypot(ev.clientX - now.x, ev.clientY - now.y);
      if (!now.armed) {
        if (now.touch) {
          // Moving before the hold is up is a scroll.
          if (moved > TOUCH_SLOP) end();
          return;
        }
        if (moved < MOUSE_SLOP) return;
        arm();
      }
      setDragging({ id: now.id, x: ev.clientX, y: ev.clientY });
      if (root.current) setOver(dropAt(root.current, ev.clientX, ev.clientY, now.id));
    };
    const onUp = (ev: PointerEvent) => {
      const now = press.current;
      if (!now || ev.pointerId !== now.pointer) return;
      if (now.armed) {
        const at = root.current ? dropAt(root.current, ev.clientX, ev.clientY, now.id) : null;
        end();
        if (at) opts.current.onDrop(now.id, at);
      } else {
        const wasTouchHold = now.touch && Math.hypot(ev.clientX - now.x, ev.clientY - now.y) > TOUCH_SLOP;
        end();
        if (!wasTouchHold) opts.current.onClick(now.id);
      }
    };
    const onCancel = () => end();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && press.current?.armed) {
        ev.preventDefault();
        ev.stopPropagation();
        end();
      }
    };
    // Once a finger has started a drag, the page must not scroll under it.
    const onTouchMove = (ev: TouchEvent) => {
      if (press.current?.armed) ev.preventDefault();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    cleanup.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("touchmove", onTouchMove);
    };
  };

  return { onPointerDown, dragging, over };
}
