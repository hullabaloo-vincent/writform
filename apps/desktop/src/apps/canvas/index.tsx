import { Presentation } from "lucide-react";

import { isWeb } from "../../lib/backend";
import { onResync, usePlatform } from "../../platform";
import type { WritformApp } from "../../platform";
import { useChat } from "../chat/store";
import { canvasApi } from "./api";
import { CanvasView } from "./CanvasView";
import { useLocalBoards } from "./local";
import { installCanvasWsHandler, useCanvas } from "./store";

export const canvasApp: WritformApp = {
  manifest: {
    id: "writform.canvas",
    name: "Canvas",
    icon: <Presentation size={20} />,
    permissions: ["ui", "commands", "net", "events"],
    // Boards on this device need no server; group boards appear when connected.
    offline: true,
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
    // ⌘K quick switcher: boards in every group, plus boards on this device.
    ctx.palette.registerSource({
      id: "canvas.boards",
      search: async (q) => {
        const needle = q.toLowerCase();
        const items = [];
        const groups = useChat.getState().groups;
        const lists = await Promise.all(
          groups.map((g) =>
            canvasApi.boards(g.id).then(
              (boards) => boards.map((board) => ({ board, group: g })),
              () => [],
            ),
          ),
        );
        for (const { board, group } of lists.flat()) {
          if (!board.name.toLowerCase().includes(needle)) continue;
          items.push({
            id: `board-${board.id}`,
            title: board.name,
            subtitle: group.name,
            run: async () => {
              usePlatform.getState().setActiveApp("writform.canvas");
              await useCanvas.getState().openBoard(board.id);
            },
          });
        }
        if (!isWeb) {
          const local = useLocalBoards.getState();
          if (!local.loaded) await local.load().catch(() => {});
          for (const b of useLocalBoards.getState().items) {
            if (!b.name.toLowerCase().includes(needle)) continue;
            items.push({
              id: `board-${b.id}`,
              title: b.name,
              subtitle: "On this device",
              run: async () => {
                usePlatform.getState().setActiveApp("writform.canvas");
                await useCanvas.getState().openBoard(b.id);
              },
            });
          }
        }
        return items.slice(0, 8);
      },
    });
  },
};
