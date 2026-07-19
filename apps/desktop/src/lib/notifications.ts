import { usePlatform } from "../platform/registry";
import { useSession } from "../stores/session";
import { backend } from "./backend";

/**
 * OS notifications for things that happen while you're not looking:
 * DMs and shared notes, @mentions in group chat, new writing sessions,
 * prompt timers starting, and friend requests.
 *
 * Delivery is client-side off the WebSocket — the server pushes nothing when
 * you're offline (no third-party push infra on a self-hosted server).
 */

const inTauri = "__TAURI_INTERNALS__" in window;

async function deliver(title: string, body: string): Promise<void> {
  try {
    if (inTauri) {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } else if ("Notification" in window) {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    }
  } catch {
    // Notifications are best-effort; never break the app over them.
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `content` @-mention `username`? (word-boundary aware, case-insensitive) */
export function mentionsUser(content: string, username: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])@${escapeRegex(username)}(?![A-Za-z0-9_-])`, "i").test(
    content,
  );
}

function preview(content: string | null): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

interface MessageLike {
  channel_id: number;
  author: { id: number; username: string; display_name: string | null };
  kind: string;
  content: string | null;
}

/** Is the user actively looking at this app (window focused + app active)? */
function viewing(appId: string): boolean {
  return document.hasFocus() && usePlatform.getState().activeAppId === appId;
}

export function installNotifications(): () => void {
  return backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const me = useSession.getState().session?.user;
    if (!me) return;
    const { room, kind, data } = event;

    if (kind === "message.created") {
      const msg = data as MessageLike;
      if (msg.author.id === me.id) return;
      const author = msg.author.display_name ?? msg.author.username;

      if (room === `user:${me.id}`) {
        // Direct message (or a note shared over DM).
        if (viewing("writform.friends")) return;
        if (msg.kind === "shared_note") {
          let title = "a note";
          try {
            title = (JSON.parse(msg.content ?? "{}") as { title?: string }).title ?? title;
          } catch {
            // malformed share payload — generic wording
          }
          void deliver(author, `shared "${title}" with you`);
        } else {
          void deliver(author, preview(msg.content));
        }
        return;
      }

      // Group chat: only @mentions notify (everything else would be noise).
      if (msg.content && mentionsUser(msg.content, me.username)) {
        void import("../apps/chat/store").then(({ useChat }) => {
          const chat = useChat.getState();
          if (
            viewing("writform.chat") &&
            chat.activeChannelId === msg.channel_id
          ) {
            return; // already reading it
          }
          const channel = chat.channels.find((c) => c.id === msg.channel_id);
          void deliver(
            `${author} mentioned you${channel ? ` in #${channel.name}` : ""}`,
            preview(msg.content),
          );
        });
      }
      return;
    }

    if (kind === "session.created") {
      const session = data as {
        title: string;
        creator: { id: number; username: string; display_name: string | null };
      };
      if (session.creator.id === me.id) return;
      const who = session.creator.display_name ?? session.creator.username;
      void deliver("New writing session", `${who} started "${session.title}"`);
      return;
    }

    if (kind === "prompt.started") {
      // Only reaches subscribers of the open session; useful when tabbed away.
      if (document.hasFocus()) return;
      void deliver("Writing started", "A prompt is running in your session.");
      return;
    }

    if (kind === "friend.request") {
      const req = data as { from: { username: string; display_name: string | null } };
      void deliver(
        "Friend request",
        `${req.from.display_name ?? req.from.username} wants to be your friend`,
      );
      return;
    }

    if (kind === "friend.accepted") {
      const req = data as {
        from: { id: number; username: string; display_name: string | null };
        to: { id: number; username: string; display_name: string | null };
      };
      // The event goes to both sides; name the *other* person.
      const other = req.from.id === me.id ? req.to : req.from;
      if (other.id === me.id) return;
      void deliver(
        "Friend request accepted",
        `You and ${other.display_name ?? other.username} are now friends`,
      );
    }
  });
}
