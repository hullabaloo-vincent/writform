/** The shortcut cheat sheet shown by the ⌘/ overlay. Chat and Canvas are
 *  written out here (documentation, not wiring: keep them in step with the
 *  bindings). The Documents sections are made from the editor's own command
 *  list, which a harness holds to the keys that really work. */

import { EDITOR_COMMANDS, isMacLike, keyCaps, keyLabel, keysOf, type CommandGroup } from "../editor/commands/catalog";

export interface ShortcutRow {
  keys: string[];
  what: string;
}

export interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

// (An iPad with a keyboard has a Mac's keys. Windows and Linux have Ctrl,
// never the Windows or Super key, which a tiling window manager keeps.)
const isMac = isMacLike();
const mod = isMac ? "⌘" : "Ctrl";
const shift = isMac ? "⇧" : "Shift";

const DOCUMENT_GROUPS: CommandGroup[] = ["Text", "Paragraph", "Lists", "Insert", "Page and view", "Review", "Find and undo", "While typing"];

/** Every command of the document editor that has a key, by its group. */
export function documentSections(): ShortcutSection[] {
  const out: ShortcutSection[] = [];
  for (const group of DOCUMENT_GROUPS) {
    const rows: ShortcutRow[] = [];
    for (const row of EDITOR_COMMANDS) {
      const key = row.group === group ? keysOf(row, isMac) : null;
      if (key) rows.push({ keys: keyCaps(key, isMac), what: row.label });
    }
    if (rows.length) out.push({ title: `Documents: ${group}`, rows });
  }
  return out;
}

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
    ...documentSections(),
    {
      title: "Canvas",
      rows: [
        { keys: ["F"], what: "Frame the selection (or fit the page)" },
        { keys: [mod, "F"], what: "Find and replace on the board" },
        { keys: [mod, "A"], what: "Select everything on the page" },
        { keys: [mod, "C"], what: "Copy (X cut, V paste, D duplicate)" },
        { keys: [mod, "G"], what: `Group (${keyLabel("Mod-Shift-g", isMac)} ungroups)` },
        { keys: [mod, "Z"], what: `Undo (${keyLabel("Mod-Shift-z", isMac)} redoes)` },
        { keys: [shift, "drag"], what: "Marquee-select / keep proportions" },
        { keys: ["Delete"], what: "Remove the selection" },
      ],
    },
  ];
}
