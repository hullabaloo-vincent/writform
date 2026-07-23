import { useRef } from "react";

interface SwipeHandlers {
  onLeft?: () => void;
  onRight?: () => void;
}

const TRAVEL = 70; // horizontal px that commit the gesture
const DOMINANCE = 1.4; // how much more horizontal than vertical it must be

/**
 * Touch-only horizontal swipe detection for drawers and overlay panels.
 * Spread the returned props on a container; the matching handler fires once
 * per touch, while the finger is still down, as soon as the travel is
 * unambiguously horizontal. Gestures that begin in editable text or inside
 * horizontally scrollable content (code blocks, tables) are ignored — those
 * own their horizontal drags. Mouse and pen pointers never trigger it.
 */
export function useSwipe({ onLeft, onRight }: SwipeHandlers) {
  const gesture = useRef<{ x: number; y: number; done: boolean } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      gesture.current = null; // a second finger makes this a pinch, not a swipe
      return;
    }
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
    for (let n = el; n && n !== e.currentTarget; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1) {
        const { overflowX } = getComputedStyle(n);
        if (overflowX === "auto" || overflowX === "scroll") return;
      }
    }
    const t = e.touches[0];
    gesture.current = { x: t.clientX, y: t.clientY, done: false };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g || g.done || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    // Clearly vertical from the start is a scroll: stop watching this touch,
    // so drifting sideways near the end of a long scroll can't fire.
    if (Math.abs(dy) > 44 && Math.abs(dy) > Math.abs(dx)) {
      g.done = true;
      return;
    }
    if (Math.abs(dx) < TRAVEL || Math.abs(dx) < Math.abs(dy) * DOMINANCE) return;
    g.done = true;
    if (dx > 0) onRight?.();
    else onLeft?.();
  };

  const onTouchEnd = () => {
    gesture.current = null;
  };

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd };
}
