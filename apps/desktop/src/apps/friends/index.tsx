import { Users } from "lucide-react";
import type { WritformApp } from "../../platform";
import { usePlatform } from "../../platform";
import { friendsApi, FriendsView } from "./FriendsView";
import { useFriends } from "./store";

export const friendsApp: WritformApp = {
  manifest: {
    id: "writform.friends",
    name: "Friends",
    icon: <Users size={20} />,
    permissions: ["ui", "commands", "net", "events"],
  },
  activate(ctx) {
    ctx.ui.registerMainView(() => <FriendsView />);
    // ⌘K quick switcher: open a conversation by friend name.
    ctx.palette.registerSource({
      id: "friends.dms",
      search: async (q) => {
        const needle = q.toLowerCase();
        const friends = await friendsApi.friends().catch(() => []);
        return friends
          .filter(
            (f) =>
              f.user.username.toLowerCase().includes(needle) ||
              (f.user.display_name ?? "").toLowerCase().includes(needle),
          )
          .slice(0, 6)
          .map((f) => ({
            id: `dm-${f.user.id}`,
            title: `@ ${f.user.display_name ?? f.user.username}`,
            subtitle: "Direct message",
            run: () => {
              useFriends.getState().requestDm(f.user.id);
              usePlatform.getState().setActiveApp("writform.friends");
            },
          }));
      },
    });
  },
};
