import { create } from "zustand";

/**
 * How large the page is shown while writing, as chosen on this device (one
 * choice for every document: it is about the screen and the eyes in front
 * of it, not about the text). The print preview has a zoom of its own.
 *
 * At 100% the page is laid out as it always was, and where the window is
 * narrower than the paper it narrows with it. At any other size the page
 * keeps its paper's width and is drawn larger or smaller, and the window
 * scrolls sideways when it must.
 */

export type ZoomMode = "percent" | "width" | "page";

/** The least and most a page is shown at. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** The sizes offered by name, and stepped through by the wheel and a pinch. */
export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];

const KEY = "wf-doc-zoom";

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100 : 1);

function load(): { mode: ZoomMode; z: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { mode?: unknown; z?: unknown } | null;
    if (saved && typeof saved === "object") {
      const mode: ZoomMode = saved.mode === "width" || saved.mode === "page" ? saved.mode : "percent";
      return { mode, z: typeof saved.z === "number" ? clampZoom(saved.z) : 1 };
    }
  } catch {
    // Unreadable: as new.
  }
  return { mode: "percent", z: 1 };
}

interface ZoomState {
  mode: ZoomMode;
  /** The size asked for by number (used while `mode` is "percent"). */
  z: number;
  /** The size the page is at now (a fitted page's is worked out from the
   *  window: the frame around the page says what it came to). */
  shown: number;
  /** Show the page at this size. */
  set: (z: number) => void;
  /** Fit the page's width, or the whole page, to the window. */
  fit: (mode: "width" | "page") => void;
}

export const useDocZoom = create<ZoomState>((set, get) => {
  const keep = (next: { mode: ZoomMode; z: number }) => {
    set(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A convenience only.
    }
  };
  const start = load();
  return {
    ...start,
    shown: start.mode === "percent" ? start.z : 1,
    set: (z) => keep({ mode: "percent", z: clampZoom(z) }),
    fit: (mode) => keep({ mode, z: get().z }),
  };
});

/** The size that fits a paper of `page` px into a window of `room` px
 *  (both as laid out, the window's without its padding). */
export function fitZoom(mode: "width" | "page", room: { w: number; h: number }, page: { w: number; h: number }): number {
  if (!(page.w > 0) || !(page.h > 0) || !(room.w > 0)) return 1;
  const byWidth = room.w / page.w;
  const z = mode === "width" || !(room.h > 0) ? byWidth : Math.min(byWidth, room.h / page.h);
  // (Fitting may go smaller than the least offered by number: a wide sheet
  // in a narrow window has to.)
  return Math.round(Math.min(ZOOM_MAX, Math.max(0.2, z)) * 1000) / 1000;
}

/** The next size up or down the named steps from `z`. */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) {
    for (const step of ZOOM_STEPS) if (step > z + 0.004) return step;
    return ZOOM_MAX;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) if (ZOOM_STEPS[i] < z - 0.004) return ZOOM_STEPS[i];
  return ZOOM_MIN;
}

/** "125%". */
export const zoomLabel = (z: number): string => `${Math.round(z * 100)}%`;
