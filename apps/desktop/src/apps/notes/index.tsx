import { NotebookPen } from "lucide-react";
import { backend, isWeb } from "../../lib/backend";
import type { WritformApp } from "../../platform";
import { usePlatform } from "../../platform";
import { NotesView } from "./NotesView";
import { useNotesPending } from "./pending";

export const notesApp: WritformApp = {
  manifest: {
    id: "writform.notes",
    name: "Notes",
    icon: <NotebookPen size={20} />,
    permissions: ["ui", "commands", "vault:read", "vault:write", "net"],
    offline: true,
    web: false,
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <NotesView />);
    // ⌘K quick switcher: vault notes by name or content (desktop only —
    // the vault itself is desktop-only).
    if (!isWeb) {
      ctx.palette.registerSource({
        id: "notes.vault",
        search: async (q) => {
          const hits = await backend.vaultSearch(q).catch(() => []);
          return hits.slice(0, 6).map((h) => ({
            id: `note-${h.name}`,
            title: h.name,
            subtitle: "Note",
            run: () => {
              useNotesPending.getState().request(h.name);
              usePlatform.getState().setActiveApp("writform.notes");
            },
          }));
        },
      });
    }
  },
};
