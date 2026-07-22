import { NotebookPen } from "lucide-react";
import type { WritformApp } from "../../platform";
import { NotesView } from "./NotesView";

export const notesApp: WritformApp = {
  manifest: {
    id: "writform.notes",
    name: "Notes",
    icon: <NotebookPen size={20} />,
    permissions: ["ui", "commands", "vault:read", "vault:write", "net"],
    offline: true,
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <NotesView />);
  },
};
