import type { WritformApp } from "../../platform";
import { FriendsView } from "./FriendsView";

export const friendsApp: WritformApp = {
  manifest: {
    id: "writform.friends",
    name: "Friends",
    icon: "👥",
    permissions: ["ui", "commands", "net", "events"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <FriendsView />);
  },
};
