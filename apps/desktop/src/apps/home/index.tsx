import { House } from "lucide-react";

import { isMobileApp, isWeb } from "../../lib/backend";
import type { WritformApp } from "../../platform";
import { usePlatform } from "../../platform";
import { useSession } from "../../stores/session";
import { HomeView } from "./HomeView";

export const homeApp: WritformApp = {
  manifest: {
    id: "writform.home",
    name: "Home",
    icon: <House size={20} />,
    permissions: ["ui", "commands"],
    offline: true,
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <HomeView />);
    ctx.commands.register({
      id: "home.open",
      title: "Go Home",
      run: () => usePlatform.getState().setActiveApp("writform.home"),
    });
    ctx.commands.register({
      id: "servers.join",
      title: "Join a Server…",
      available: () => !isWeb,
      run: () => useSession.getState().openConnect(),
    });
    ctx.commands.register({
      id: "servers.host",
      title: "Host a Server on This Computer…",
      available: () => !isMobileApp && !isWeb,
      run: () => useSession.getState().openConnect({ host: true }),
    });
    ctx.commands.register({
      id: "servers.disconnect",
      title: "Disconnect from the Server",
      available: () => !isWeb && useSession.getState().link === "connected",
      run: () => useSession.getState().disconnect(),
    });
  },
};
