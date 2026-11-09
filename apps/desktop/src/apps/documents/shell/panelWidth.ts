import { create } from "zustand";

/**
 * How wide each side panel beside the text is, as dragged on this device
 * (shell/PanelResizer.tsx). One width per kind of panel: the outline and the
 * docked preview want different room. A panel with no width of its own here
 * is as wide as the stylesheet makes it.
 */

/** The narrowest a panel is dragged to. Below this its header crowds. */
export const PANEL_MIN = 280;
/** The widest, before the room the text keeps is taken into account. */
export const PANEL_MAX = 960;
/** What the text beside a panel always keeps. */
export const TEXT_KEEPS = 360;
/** From this width the Check panel lays its reports out two abreast. */
export const PANEL_WIDE = 520;
/** What the Check panel's "Make the panel wider" button gives it. */
export const CHECK_WIDE = 640;

const KEY = "wf-panel-widths";
/** The Check panel's own wider-or-not switch, from before panels could be
 *  dragged. It is read once, so the choice is kept. */
const OLD_CHECK_KEY = "wf-proof-wide";

export const clampPanel = (w: number, room = Infinity): number => {
  const most = Math.max(PANEL_MIN, Math.min(PANEL_MAX, room - TEXT_KEEPS));
  return Math.round(Math.min(most, Math.max(PANEL_MIN, w)));
};

/** The widths kept on this device (read once, when the app starts). */
export function loadPanelWidths(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [name, w] of Object.entries(saved as Record<string, unknown>)) {
        if (/^[a-z]{1,24}$/.test(name) && typeof w === "number" && Number.isFinite(w)) out[name] = clampPanel(w);
      }
    }
    if (out.check === undefined && localStorage.getItem(OLD_CHECK_KEY) === "on") out.check = CHECK_WIDE;
  } catch {
    // Unreadable: every panel as the stylesheet makes it.
  }
  return out;
}

interface PanelWidths {
  widths: Record<string, number>;
  /** Give a panel this width, or (null) put it back as it was made. */
  set: (panel: string, w: number | null) => void;
}

export const usePanelWidths = create<PanelWidths>((set, get) => ({
  widths: loadPanelWidths(),
  set: (panel, w) => {
    const widths = { ...get().widths };
    if (w === null) delete widths[panel];
    else widths[panel] = clampPanel(w);
    set({ widths });
    try {
      localStorage.setItem(KEY, JSON.stringify(widths));
      localStorage.removeItem(OLD_CHECK_KEY);
    } catch {
      // A convenience only.
    }
  },
}));

/** The width dragged for this panel, or null when it has none. */
export const usePanelWidth = (panel: string): number | null => usePanelWidths((s) => s.widths[panel] ?? null);

export const setPanelWidth = (panel: string, w: number | null): void => usePanelWidths.getState().set(panel, w);
