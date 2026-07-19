import { Presentation } from "lucide-react";

import { onResync } from "../../platform";
import type { WritformApp } from "../../platform";
import { CanvasView } from "./CanvasView";
import { installCanvasWsHandler, useCanvas } from "./store";

export const canvasApp: WritformApp = {
  manifest: {
    id: "writform.canvas",
    name: "Canvas",
    icon: <Presentation size={20} />,
    permissions: ["ui", "commands", "net", "events"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <CanvasView />);
    installCanvasWsHandler();
    onResync(() => {
      const s = useCanvas.getState();
      if (s.activeBoardId !== null) void s.openBoard(s.activeBoardId).catch(() => {});
      for (const groupId of Object.keys(s.byGroup)) {
        void s.loadBoards(Number(groupId)).catch(() => {});
      }
    });
    ctx.commands.register({
      id: "canvas.open",
      title: "Canvas: Open",
      run: () => {
        void import("../../platform").then(({ usePlatform }) =>
          usePlatform.getState().setActiveApp("writform.canvas"),
        );
      },
    });
  },
};
