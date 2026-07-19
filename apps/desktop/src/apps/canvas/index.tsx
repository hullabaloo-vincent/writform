import { Presentation } from "lucide-react";

import type { WritformApp } from "../../platform";
import { CanvasView } from "./CanvasView";
import { installCanvasWsHandler } from "./store";

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
