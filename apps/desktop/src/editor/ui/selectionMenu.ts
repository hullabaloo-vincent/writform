import { create } from "zustand";

/**
 * What the selection menu holds, as chosen on this device: which of its
 * tools are shown, and whether the menu appears at all. Changed from the
 * menu's own "Customise" button, and from Settings ▸ Writing.
 */

/** Every tool the menu can show, in the order it shows them. */
export const SELECTION_TOOLS = [
  { id: "bold", label: "Bold" },
  { id: "italic", label: "Italic" },
  { id: "underline", label: "Underline" },
  { id: "strike", label: "Strikethrough" },
  { id: "sub", label: "Subscript", rich: true },
  { id: "super", label: "Superscript", rich: true },
  { id: "code", label: "Inline code" },
  { id: "color", label: "Text color", rich: true },
  { id: "highlight", label: "Highlight", rich: true },
  { id: "link", label: "Link" },
  { id: "comment", label: "Comment" },
  { id: "clear", label: "Clear formatting", rich: true },
] as const satisfies readonly { id: string; label: string; rich?: boolean }[];

export type SelectionTool = (typeof SELECTION_TOOLS)[number]["id"];

/** What it starts with: the commonest few. */
export const DEFAULT_SELECTION_TOOLS: SelectionTool[] = ["bold", "italic", "underline", "color", "highlight", "link", "comment", "clear"];

const KEY = "wf-selection-menu";
const known = new Set<string>(SELECTION_TOOLS.map((t) => t.id));

function load(): { off: boolean; tools: SelectionTool[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { off?: unknown; tools?: unknown } | null;
    if (saved && typeof saved === "object") {
      const tools = Array.isArray(saved.tools) ? (saved.tools.filter((t) => typeof t === "string" && known.has(t)) as SelectionTool[]) : DEFAULT_SELECTION_TOOLS;
      return { off: saved.off === true, tools };
    }
  } catch {
    // Unreadable: as new.
  }
  return { off: false, tools: DEFAULT_SELECTION_TOOLS };
}

function save(state: { off: boolean; tools: SelectionTool[] }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ off: state.off, tools: state.tools }));
  } catch {
    // A convenience only.
  }
}

interface SelectionMenuState {
  /** The menu doesn't appear at all. */
  off: boolean;
  tools: SelectionTool[];
  toggle: (tool: SelectionTool) => void;
  setOff: (off: boolean) => void;
  reset: () => void;
}

export const useSelectionMenu = create<SelectionMenuState>((set, get) => ({
  ...load(),
  toggle: (tool) => {
    const has = get().tools.includes(tool);
    // Kept in the menu's own order, whatever order they were ticked in.
    const tools = SELECTION_TOOLS.map((t) => t.id).filter((id) => (id === tool ? !has : get().tools.includes(id)));
    set({ tools });
    save({ off: get().off, tools });
  },
  setOff: (off) => {
    set({ off });
    save({ off, tools: get().tools });
  },
  reset: () => {
    set({ off: false, tools: DEFAULT_SELECTION_TOOLS });
    save({ off: false, tools: DEFAULT_SELECTION_TOOLS });
  },
}));
