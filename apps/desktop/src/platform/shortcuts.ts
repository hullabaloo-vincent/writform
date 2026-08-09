/** The curated shortcut cheat sheet shown by the ⌘/ overlay. Keep this in
 *  step with the actual bindings — it is documentation, not wiring. */

export interface ShortcutRow {
  keys: string[];
  what: string;
}

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const isMac = navigator.platform.toUpperCase().includes("MAC");
const mod = isMac ? "⌘" : "Ctrl";
const shift = isMac ? "⇧" : "Shift";

export function shortcutSections(): ShortcutSection[] {
  return [
    {
      title: "Everywhere",
      rows: [
        { keys: [mod, "K"], what: "Jump anywhere / run a command" },
        { keys: [mod, "/"], what: "This cheat sheet" },
        { keys: ["Esc"], what: "Close the topmost dialog" },
      ],
    },
    {
      title: "Chat",
      rows: [
        { keys: ["Enter"], what: "Send (Shift+Enter for a new line)" },
        { keys: ["↑"], what: "Edit your last message (empty composer)" },
        { keys: ["/"], what: "Slash commands" },
        { keys: ["Tab"], what: "Complete @mention or #channel" },
      ],
    },
    {
      title: "Documents",
      rows: [
        { keys: [mod, "F"], what: "Find in the document" },
        { keys: [mod, "B"], what: "Bold — I italic, U underline" },
        { keys: ["Tab"], what: "Indent list / cycle the element type" },
        { keys: [mod, "1–6"], what: "Element type (writing formats)" },
      ],
    },
    {
      title: "Canvas",
      rows: [
        { keys: ["F"], what: "Frame the selection (or fit the page)" },
        { keys: [mod, "F"], what: "Find and replace on the board" },
        { keys: [mod, "A"], what: "Select everything on the page" },
        { keys: [mod, "C"], what: "Copy — X cut, V paste, D duplicate" },
        { keys: [mod, "G"], what: `Group (${mod}${shift}G ungroups)` },
        { keys: [mod, "Z"], what: `Undo (${mod}${shift}Z redoes)` },
        { keys: [shift, "drag"], what: "Marquee-select / keep proportions" },
        { keys: ["Delete"], what: "Remove the selection" },
      ],
    },
  ];
}
