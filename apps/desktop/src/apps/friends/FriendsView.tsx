import {
  Menu, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DmChannel } from "../../bindings/proto/DmChannel";
import type { Friend } from "../../bindings/proto/Friend";
import type { FriendRequests } from "../../bindings/proto/FriendRequests";
import type { Message } from "../../bindings/proto/Message";
import { backend, isCmdError, type CmdError } from "../../lib/backend";
import { useSwipe } from "../../lib/useSwipe";
import {
  Avatar,
  confirmDialog,
  onResync,
  showProfile,
  SkeletonRows,
  toastError,
} from "../../platform";
import { chatApi } from "../chat/api";
import { MessageRow } from "../chat/ChatView";
import { useChat } from "../chat/store";
import { useFriends } from "./store";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await backend.apiFetch(method, path, body);
  if (res.status >= 400) {
    const err = (res.body ?? {}) as Partial<CmdError>;
    throw {
      code: err.code ?? `http_${res.status}`,
      message: err.message ?? `request failed (${res.status})`,
    } satisfies CmdError;
  }
  return res.body as T;
}

export const friendsApi = {
  friends: () => api<Friend[]>("GET", "/api/v1/friends"),
  requests: () => api<FriendRequests>("GET", "/api/v1/friends/requests"),
  send: (username: string) => api<unknown>("POST", "/api/v1/friends/requests", { username }),
  accept: (id: number) => api<unknown>("POST", `/api/v1/friends/requests/${id}/accept`),
  deleteRequest: (id: number) => api<null>("DELETE", `/api/v1/friends/requests/${id}`),
  remove: (userId: number) => api<null>("DELETE", `/api/v1/friends/${userId}`),
  openDm: (userId: number) => api<DmChannel>("POST", `/api/v1/dms/${userId}`),
  dms: () => api<DmChannel[]>("GET", "/api/v1/dms"),
};

function SharedNoteCard({ content }: { content: string }) {
  const [saved, setSaved] = useState(false);
  let note: { title?: string; content_md?: string } = {};
  try {
    note = JSON.parse(content) as typeof note;
  } catch {
    // fall through to empty card
  }
  const title = note.title ?? "shared note";
  return (
    <div className="wf-shared-note">
      <span className="wf-shared-note-title">
        <FileText size={15} /> {title}
      </span>
      <button
        disabled={saved}
        onClick={() => {
          void backend
            .vaultWrite(title, note.content_md ?? "")
            .then(() => setSaved(true))
            .catch(() => {});
        }}
      >
        {saved ? "Saved ✓" : "Save to vault"}
      </button>
    </div>
  );
}

export function FriendsView() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<FriendRequests>({ incoming: [], outgoing: [] });
  const [loaded, setLoaded] = useState(false);
  const [dm, setDm] = useState<DmChannel | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dmUnread = useFriends((s) => s.dmUnread);
  // Mobile-only slide-over for the friends list (mirrors chat's drawer).
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => setSideOpen(false), [dm]);

  const refresh = () => {
    void friendsApi
      .friends()
      .then(setFriends)
      .catch(() => {})
      .finally(() => setLoaded(true));
    void friendsApi.requests().then(setRequests).catch(() => {});
  };
  useEffect(refresh, []);
  useEffect(() => onResync(refresh), []);

  useEffect(
    () =>
      backend.onWsEvent((event) => {
        if (event.ev !== "event") return;
        if (event.kind.startsWith("friend.")) refresh();
        if (event.kind === "presence.update") {
          const { user_id, online, status } = event.data as {
            user_id: number;
            online: boolean;
            status?: string | null;
          };
          setFriends((list) =>
            list.map((f) =>
              f.user.id === user_id ? { ...f, online, status: status ?? null } : f,
            ),
          );
        }
      }),
    [],
  );

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn()
      .then(refresh)
      .catch((e) => setError(isCmdError(e) ? e.message : String(e)));
  };

  // Same drawer gesture as chat: swipe right opens the list, left closes.
  const swipe = useSwipe({
    onRight: () => setSideOpen(true),
    onLeft: () => setSideOpen(false),
  });

  return (
    <div className="wf-friends" {...swipe}>
      <button className="wf-chat-menu-btn" title="Friends list" onClick={() => setSideOpen(true)}>
        <Menu size={19} />
      </button>
      {sideOpen && <div className="wf-chat-side-scrim" onClick={() => setSideOpen(false)} />}
      <div className={`wf-friends-side ${sideOpen ? "open" : ""}`}>
        <h2>Friends</h2>
        {error && <p className="wf-connect-error">{error}</p>}
        <form
          className="wf-connect-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!username.trim()) return;
            act(() => friendsApi.send(username.trim()));
            setUsername("");
          }}
        >
          <input
            placeholder="add by username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button type="submit" disabled={!username.trim()}>
            Add
          </button>
        </form>

        {requests.incoming.length > 0 && (
          <>
            <h3>Requests</h3>
            <ul className="wf-friend-list">
              {requests.incoming.map((r) => (
                <li key={r.id}>
                  <span className="wf-member-name">{r.from.display_name ?? r.from.username}</span>
                  <button onClick={() => act(() => friendsApi.accept(r.id))}>✓</button>
                  <button onClick={() => act(() => friendsApi.deleteRequest(r.id))}>×</button>
                </li>
              ))}
            </ul>
          </>
        )}
        {requests.outgoing.length > 0 && (
          <>
            <h3>Pending</h3>
            <ul className="wf-friend-list wf-friend-dim">
              {requests.outgoing.map((r) => (
                <li key={r.id}>
                  <span className="wf-member-name">{r.to.display_name ?? r.to.username}</span>
                  <button onClick={() => act(() => friendsApi.deleteRequest(r.id))}>×</button>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3>All friends — {friends.length}</h3>
        {!loaded && <SkeletonRows rows={4} avatar />}
        <ul className="wf-friend-list">
          {friends.map((f) => (
            <li key={f.user.id} className={dm?.peer.id === f.user.id ? "active" : ""}>
              <span
                className={`wf-presence-dot ${
                  f.status === "busy" ? "busy" : f.online ? "" : "off"
                }`}
              />
              <button className="wf-user-link" onClick={() => showProfile(f.user.id)}>
                <Avatar
                  name={f.user.display_name ?? f.user.username}
                  attachmentId={f.user.avatar_attachment_id}
                  accentColor={f.user.accent_color}
                  size={22}
                />
              </button>
              <button
                className="wf-friend-open"
                onClick={() =>
                  void friendsApi
                    .openDm(f.user.id)
                    .then(setDm)
                    .catch((e) => setError(isCmdError(e) ? e.message : String(e)))
                }
              >
                {f.user.display_name ?? f.user.username}
                {(dmUnread[f.user.id] ?? 0) > 0 && (
                  <span className="wf-unread-pill">
                    {dmUnread[f.user.id] > 99 ? "99+" : dmUnread[f.user.id]}
                  </span>
                )}
              </button>
              <button
                title="Remove friend"
                onClick={() =>
                  void confirmDialog(`Remove ${f.user.username} from your friends?`, {
                    title: "Remove friend",
                    confirmLabel: "Remove",
                    danger: true,
                  }).then((ok) => {
                    if (!ok) return;
                    if (dm?.peer.id === f.user.id) setDm(null);
                    act(() => friendsApi.remove(f.user.id));
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
          {loaded && friends.length === 0 && (
            <li className="wf-friend-dim">No friends yet — add one above.</li>
          )}
        </ul>
      </div>
      <div className="wf-friends-dm">
        {dm ? (
          <DmPane dm={dm} />
        ) : (
          <div className="wf-sessions-empty">Pick a friend to open a conversation.</div>
        )}
      </div>
    </div>
  );
}

function DmPane({ dm }: { dm: DmChannel }) {
  const messagesMap = useChat((s) => s.messages);
  const messages = messagesMap[dm.channel_id] ?? [];
  // Drafts share the chat store's per-channel map (DM channel ids live in
  // the same id space), so they survive switching conversations and apps.
  const draft = useChat((s) => s.drafts[dm.channel_id] ?? "");
  const setDraft = useChat((s) => s.setDraft);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void backend.wsSub([`channel:${dm.channel_id}`]);
    void chatApi.messages(dm.channel_id).then((history) => {
      useChat.setState((s) => ({ messages: { ...s.messages, [dm.channel_id]: history } }));
    });
  }, [dm.channel_id]);

  // Viewing this conversation clears (and suppresses) its unread count.
  useEffect(() => {
    useFriends.getState().setActiveDmPeer(dm.peer.id);
    return () => useFriends.getState().setActiveDmPeer(null);
  }, [dm.peer.id]);

  useEffect(() => {
    setReplyTo(null);
  }, [dm.channel_id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length]);

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    const replyToId = replyTo?.id ?? null;
    setDraft(dm.channel_id, "");
    setReplyTo(null);
    void chatApi.sendMessage(dm.channel_id, content, [], replyToId).catch(() => {
      // Put the text back so nothing is lost.
      setDraft(dm.channel_id, content);
      toastError("Message didn't send — your text is back in the box.");
    });
  };

  return (
    <>
      <header className="wf-chat-main-header">@ {dm.peer.display_name ?? dm.peer.username}</header>
      <div className="wf-chat-messages" data-msg-scroll>
        {messages.map((m, i) => (
          <MessageRow
            key={m.id}
            message={m}
            compact={messages[i - 1]?.author.id === m.author.id}
            authorOnly
            onReply={setReplyTo}
            sharedNoteCard={(content) => <SharedNoteCard content={content} />}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {replyTo && (
        <div className="wf-reply-chip">
          Replying to{" "}
          <strong>{replyTo.author.display_name ?? replyTo.author.username}</strong>
          <span className="wf-reply-chip-text">{(replyTo.content ?? "").slice(0, 80)}</span>
          <button className="wf-icon" title="Cancel reply" onClick={() => setReplyTo(null)}>
            ×
          </button>
        </div>
      )}
      <form
        className="wf-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          rows={1}
          placeholder={`Message @${dm.peer.username}`}
          value={draft}
          onChange={(e) => setDraft(dm.channel_id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
            if (e.key === "Escape" && replyTo) setReplyTo(null);
          }}
        />
        <button className="wf-primary" type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </>
  );
}
