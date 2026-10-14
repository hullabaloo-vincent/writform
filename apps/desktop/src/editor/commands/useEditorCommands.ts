import type { Editor } from "@tiptap/core";
import { useEffect, useRef } from "react";

import { registerCommands } from "../../platform/registry";
import type { Command } from "../../platform/types";
import { keyLabel, keysOf, offered } from "./catalog";
import { canRun, runCommand, RUNNABLE, type CommandCtx } from "./run";

/**
 * While a document is open, its editor's commands are in the command
 * palette (⌘K): there from when the editor mounts until it closes. The
 * palette asks each time it opens which of them can be done just now.
 *
 * `ctx` is read when a command is looked at or run, so it may be made anew
 * on every render.
 */
export function useEditorCommands(editor: Editor | null, ctx: CommandCtx): void {
  const latest = useRef(ctx);
  useEffect(() => {
    latest.current = ctx;
  });
  const format = ctx.format;
  useEffect(() => {
    if (!editor) return;
    const commands: Omit<Command, "appId">[] = RUNNABLE.map((row) => {
      const key = keysOf(row);
      return {
        id: row.id,
        title: row.label,
        keywords: `${row.group} ${row.keywords ?? ""}`.toLowerCase(),
        keybinding: key ? keyLabel(key) : undefined,
        // (Dozens of them: offered once something is typed, not as a list to read through.)
        typed: true,
        available: () => {
          const now = latest.current;
          return !editor.isDestroyed && offered(row, now.format, now.rich?.level ?? 1) && canRun(row.id, editor, now);
        },
        run: () => void runCommand(row.id, editor, latest.current),
      };
    });
    return registerCommands("documents", commands);
  }, [editor, format]);
}
