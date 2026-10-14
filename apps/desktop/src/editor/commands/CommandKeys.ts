import { Extension } from "@tiptap/core";

import { EDITOR_COMMANDS, keysOf, offered } from "./catalog";
import { runCommand, type CommandCtx } from "./run";

/**
 * The keys the command list binds itself (rows marked `bind`): pressed in
 * the text, each does what its row's runner does. Keys an older extension
 * already binds are left to it.
 */
export const CommandKeys = Extension.create<{ ctx: () => CommandCtx | null }>({
  name: "commandKeys",

  addOptions() {
    return { ctx: () => null };
  },

  addKeyboardShortcuts() {
    const keys: Record<string, () => boolean> = {};
    for (const row of EDITOR_COMMANDS) {
      const key = row.bind ? keysOf(row) : null;
      if (!key) continue;
      keys[key] = () => {
        const ctx = this.options.ctx();
        if (!ctx || !offered(row, ctx.format, ctx.rich?.level ?? 1)) return false;
        return runCommand(row.id, this.editor, ctx);
      };
    }
    return keys;
  },
});
