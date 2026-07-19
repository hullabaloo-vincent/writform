import type { WritformApp } from "../../platform";
import { NotesView } from "./NotesView";

export const notesApp: WritformApp = {
  manifest: {
    id: "writform.notes",
    name: "Notes",
    icon: "📝",
    permissions: ["ui", "commands", "vault:read", "vault:write", "net"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <NotesView />);
  },
};
