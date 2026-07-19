import {
  ImageIcon,
  Mic,
  MicOff,
  PenLine,
  PhoneOff,
  Plus,
  Settings as SettingsIcon,
  SmilePlus,
  Trash2,
  UserPlus,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Message } from "../../bindings/proto/Message";
import { isCmdError } from "../../lib/backend";
import { uploadBlob, uploadPath, type UploadedAttachment } from "../../lib/upload";
import { Avatar, confirmDialog, usePlatform } from "../../platform";
import { useSession } from "../../stores/session";
import { chatApi } from "./api";
import { MessageText } from "./MessageText";
import { useChat } from "./store";
import { useVoice, voiceApi } from "./voice";

const attSrc = (attachmentId: number) => `writform-att://attachment/${attachmentId}`;

/** Emote grid popup: insert on click; admins can add and remove emotes. */
function EmotePicker({
  onPick,
  onClose,
}: {
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const emotes = useChat((s) => s.emotes);
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const group = groups.find((g) => g.id === activeGroupId);
  const isAdmin = group?.my_role === "admin";
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingAttachment, setPendingAttachment] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const meta = await uploadBlob(file, file.name);
      setPendingAttachment(meta.id);
      setName(file.name.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9_]/g, "_"));
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (!group || pendingAttachment === null || !name.trim()) return;
    setError(null);
    chatApi
      .createEmote(group.id, name.trim(), pendingAttachment)
      .then(() => {
        setPendingAttachment(null);
        setName("");
      })
      .catch((e) => setError(isCmdError(e) ? e.message : String(e)));
  };

  return (
    <div className="wf-emote-picker" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <span>Emotes{group ? ` — ${group.name}` : ""}</span>
        <button onClick={onClose}>×</button>
      </header>
      {error && <p className="wf-connect-error">{error}</p>}
      <div className="wf-emote-grid">
        {emotes.map((e) => (
          <span key={e.id} className="wf-emote-tile">
            <button title={`:${e.name}:`} onClick={() => onPick(e.name)}>
              <img src={attSrc(e.attachment_id)} alt={e.name} />
            </button>
            {isAdmin && group && (
              <button
                className="wf-emote-remove"
                title="Remove emote"
                onClick={() =>
                  void confirmDialog(`Remove :${e.name}: for everyone in ${group.name}?`, {
                    title: "Remove emote",
                    confirmLabel: "Remove",
                    danger: true,
                  }).then((ok) => {
                    if (ok) void chatApi.deleteEmote(group.id, e.id).catch(() => {});
                  })
                }
              >
                <Trash2 size={11} />
              </button>
            )}
          </span>
        ))}
        {emotes.length === 0 && (
          <p className="wf-friend-dim">
            No custom emotes yet{isAdmin ? " — add one below." : "."}
          </p>
        )}
      </div>
      {isAdmin && (
        <div className="wf-emote-add">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          {pendingAttachment === null ? (
            <button disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? "Uploading…" : "+ Add emote (upload image)"}
            </button>
          ) : (
            <div className="wf-connect-row">
              <input
                placeholder="emote_name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value.toLowerCase())}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <button className="wf-primary" disabled={!name.trim()} onClick={create}>
                Add
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatView() {
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const loadGroups = useChat((s) => s.loadGroups);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  return (
    <div className="wf-chat">
      <aside className="wf-chat-groups">
        <GroupList />
      </aside>
      {activeGroupId === null ? (
        <div className="wf-chat-empty">
          {groups.length === 0 ? <FirstGroup /> : <p>Select a group</p>}
        </div>
      ) : (
        <>
          <aside className="wf-chat-channels">
            <ChannelList />
          </aside>
          <main className="wf-chat-main">
            <MessagePane />
          </main>
          <aside className="wf-chat-members">
            <MemberList />
          </aside>
        </>
      )}
    </div>
  );
}

function GroupList() {
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const selectGroup = useChat((s) => s.selectGroup);
  const [adding, setAdding] = useState(false);

  return (
    <>
      {groups.map((g) => (
        <button
          key={g.id}
          className={`wf-chat-group-icon ${g.id === activeGroupId ? "active" : ""}`}
          title={g.name}
          style={
            g.icon_attachment_id == null && g.accent_color
              ? { background: g.accent_color, color: "rgba(0,0,0,0.75)" }
              : undefined
          }
          onClick={() => void selectGroup(g.id)}
        >
          {g.icon_attachment_id != null ? (
            <img
              className="wf-chat-group-img"
              src={`writform-att://attachment/${g.icon_attachment_id}`}
              alt={g.name}
              draggable={false}
            />
          ) : (
            g.name
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase())
              .join("")
          )}
        </button>
      ))}
      <button className="wf-chat-group-icon wf-chat-group-add" title="Create or join a group"
        onClick={() => setAdding(true)}>
        +
      </button>
      {adding && <AddGroupDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function FirstGroup() {
  const [open, setOpen] = useState(false);
  return (
    <div className="wf-chat-first">
      <h2>No groups yet</h2>
      <p>Create a group for your circle, or join one with an invite code.</p>
      <button className="wf-primary" onClick={() => setOpen(true)}>
        Create or join
      </button>
      {open && <AddGroupDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function AddGroupDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const loadGroups = useChat((s) => s.loadGroups);
  const selectGroup = useChat((s) => s.selectGroup);

  const run = async (fn: () => Promise<{ id: number }>) => {
    setError(null);
    try {
      const group = await fn();
      await loadGroups();
      await selectGroup(group.id);
      onClose();
    } catch (e) {
      setError(isCmdError(e) ? e.message : String(e));
    }
  };

  return (
    <div className="wf-modal-backdrop" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Create a group</h3>
        {error && <p className="wf-connect-error">{error}</p>}
        <div className="wf-connect-row">
          <input
            placeholder="group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button
            className="wf-primary"
            disabled={!name.trim()}
            onClick={() => void run(() => chatApi.createGroup(name.trim()))}
          >
            Create
          </button>
        </div>
        <h3>…or join with an invite code</h3>
        <div className="wf-connect-row">
          <input placeholder="invite code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button
            disabled={!code.trim()}
            onClick={() => void run(() => chatApi.redeemInvite(code.trim()))}
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}

/** Admin dialog: rename the group, upload an icon, pick an accent color. */
function GroupSettingsDialog({
  group,
  onClose,
}: {
  group: NonNullable<ReturnType<typeof useChat.getState>["groups"][number]>;
  onClose: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [iconId, setIconId] = useState<number | null>(group.icon_attachment_id);
  const [color, setColor] = useState(group.accent_color ?? "#8ab6e8");
  const [useColor, setUseColor] = useState(group.accent_color !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
    setError(null);
    setBusy(true);
    chatApi
      .updateGroup(group.id, {
        name: name.trim() || null,
        icon_attachment_id: iconId,
        accent_color: useColor ? color : null,
      })
      .then((updated) => {
        useChat.setState((s) => ({
          groups: s.groups.map((g) => (g.id === group.id ? { ...g, ...updated } : g)),
        }));
        onClose();
      })
      .catch((e) => setError(isCmdError(e) ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="wf-modal-backdrop" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Group settings</h3>
        {error && <p className="wf-connect-error">{error}</p>}
        <label className="wf-field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <div className="wf-field">
          Icon
          <div className="wf-connect-row" style={{ alignItems: "center" }}>
            {iconId !== null ? (
              <img className="wf-group-icon-preview" src={attSrc(iconId)} alt="group icon" />
            ) : (
              <span className="wf-session-meta">initials</span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setBusy(true);
                  uploadBlob(file, file.name)
                    .then((meta) => setIconId(meta.id))
                    .catch((err) => setError(isCmdError(err) ? err.message : String(err)))
                    .finally(() => setBusy(false));
                }
                e.target.value = "";
              }}
            />
            <button disabled={busy} onClick={() => fileRef.current?.click()}>
              Upload image
            </button>
            {iconId !== null && <button onClick={() => setIconId(null)}>Remove</button>}
          </div>
        </div>
        <label className="wf-field wf-field-row">
          <input
            type="checkbox"
            checked={useColor}
            onChange={(e) => setUseColor(e.target.checked)}
          />
          Accent color
          <input
            type="color"
            value={color}
            disabled={!useColor}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <div className="wf-connect-row">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="wf-primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? "…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChannelList() {
  const channels = useChat((s) => s.channels);
  const activeChannelId = useChat((s) => s.activeChannelId);
  const selectChannel = useChat((s) => s.selectChannel);
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const group = groups.find((g) => g.id === activeGroupId);
  const isAdmin = group?.my_role === "admin";
  const [invite, setInvite] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState("");

  return (
    <>
      <header className="wf-chat-channels-header">
        <span className="wf-chat-group-name">{group?.name}</span>
        {isAdmin && (
          <>
            <button
              title="Group settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon size={14} />
            </button>
            <button
              className="wf-invite-btn"
              title="Invite people — generate a temporary invite code"
              onClick={() =>
                void chatApi.createInvite(group!.id).then((i) => setInvite(i.code))
              }
            >
              <UserPlus size={13} /> Invite
            </button>
          </>
        )}
      </header>
      {settingsOpen && group && (
        <GroupSettingsDialog group={group} onClose={() => setSettingsOpen(false)} />
      )}
      {invite && (
        <div className="wf-chat-invite" onClick={() => setInvite(null)} title="Click to dismiss">
          invite code: <code>{invite}</code>
        </div>
      )}
      <nav>
        {channels
          .filter((c) => c.kind === "text")
          .map((c) => (
            <button
              key={c.id}
              className={`wf-chat-channel ${c.id === activeChannelId ? "active" : ""}`}
              onClick={() => void selectChannel(c.id)}
            >
              # {c.name}
            </button>
          ))}
        {isAdmin && !newChannel && (
          <button className="wf-chat-channel wf-chat-channel-add" onClick={() => setNewChannel(true)}>
            + new channel
          </button>
        )}
        {newChannel && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !group) return;
              void chatApi.createChannel(group.id, name.trim()).then(() => {
                setName("");
                setNewChannel(false);
              });
            }}
          >
            <input
              className="wf-chat-channel-input"
              placeholder="channel-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNewChannel(false)}
            />
          </form>
        )}
        {group && <VoiceSection groupId={group.id} isAdmin={!!isAdmin} />}
      </nav>
    </>
  );
}

function VoiceSection({ groupId, isAdmin }: { groupId: number; isAdmin: boolean }) {
  const channels = useVoice((s) => s.channels);
  const occupants = useVoice((s) => s.occupants);
  const connectedChannelId = useVoice((s) => s.connectedChannelId);
  const speaking = useVoice((s) => s.speaking);
  const join = useVoice((s) => s.join);
  const loadChannels = useVoice((s) => s.loadChannels);
  const error = useVoice((s) => s.error);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    void loadChannels(groupId).catch(() => {});
  }, [groupId, loadChannels]);

  return (
    <div className="wf-voice-section">
      <span className="wf-voice-heading">Voice</span>
      {error && <p className="wf-connect-error">{error}</p>}
      {channels.map((c) => (
        <div key={c.id}>
          <button
            className={`wf-chat-channel wf-voice-channel ${c.id === connectedChannelId ? "active" : ""}`}
            title={c.id === connectedChannelId ? "Connected" : "Join voice"}
            onClick={() => void join(c)}
          >
            <Volume2 size={14} /> {c.name}
          </button>
          {(occupants[c.id] ?? []).length > 0 && (
            <ul className="wf-voice-occupants">
              {(occupants[c.id] ?? []).map((u) => (
                <li key={u.id} className={speaking.has(u.id) ? "speaking" : ""}>
                  <span className="wf-voice-dot" />
                  <Avatar
                    name={u.display_name ?? u.username}
                    attachmentId={u.avatar_attachment_id}
                    accentColor={u.accent_color}
                    size={16}
                  />
                  {u.display_name ?? u.username}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {isAdmin && !adding && (
        <button className="wf-chat-channel wf-chat-channel-add" onClick={() => setAdding(true)}>
          + new voice channel
        </button>
      )}
      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void voiceApi
              .create(groupId, name.trim())
              .then(() => {
                setName("");
                setAdding(false);
              })
              .catch(() => setAdding(false));
          }}
        >
          <input
            className="wf-chat-channel-input"
            placeholder="voice channel name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setAdding(false)}
          />
        </form>
      )}
    </div>
  );
}

/**
 * Voice status + controls, mounted in the statusbar slot so the connection
 * follows you everywhere in the app (the audio mesh itself is app-global).
 */
export function GlobalVoiceBar() {
  const connectedChannelId = useVoice((s) => s.connectedChannelId);
  const joining = useVoice((s) => s.joining);
  const muted = useVoice((s) => s.muted);
  const channels = useVoice((s) => s.channels);
  const speaking = useVoice((s) => s.speaking);
  const leave = useVoice((s) => s.leave);
  const toggleMute = useVoice((s) => s.toggleMute);
  const me = useSession((s) => s.session?.user);

  if (joining) {
    return (
      <span className="wf-voice-bar">
        Connecting voice…
        <button title="Cancel" onClick={() => void leave()}>
          <PhoneOff size={13} />
        </button>
      </span>
    );
  }
  if (connectedChannelId === null) return null;
  const channel = channels.find((c) => c.id === connectedChannelId);
  const talking = me !== undefined && speaking.has(me.id) && !muted;

  return (
    <span className={`wf-voice-bar ${talking ? "talking" : ""}`}>
      <Volume2 size={13} />
      <span className="wf-voice-bar-name">{channel?.name ?? "voice"}</span>
      <button title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
        {muted ? <MicOff size={13} /> : <Mic size={13} />}
      </button>
      <button title="Leave voice" onClick={() => void leave()}>
        <PhoneOff size={13} />
      </button>
    </span>
  );
}

function MemberList() {
  const members = useChat((s) => s.members);
  const online = useChat((s) => s.online);
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const session = useSession((s) => s.session);
  const group = groups.find((g) => g.id === activeGroupId);
  const isAdmin = group?.my_role === "admin";

  return (
    <>
      <header className="wf-chat-members-header">Members — {members.length}</header>
      <ul>
        {members.map((m) => (
          <li key={m.user.id} className={online.has(m.user.id) ? "online" : "offline"}>
            <span className="wf-presence-dot" />
            <Avatar
              name={m.user.display_name ?? m.user.username}
              attachmentId={m.user.avatar_attachment_id}
              accentColor={m.user.accent_color}
              size={22}
            />
            <span className="wf-member-name">{m.user.display_name ?? m.user.username}</span>
            {m.role === "admin" && <span className="wf-member-badge">admin</span>}
            {isAdmin && m.user.id !== session?.user.id && (
              <button
                className="wf-member-kick"
                title="Kick"
                onClick={() =>
                  void confirmDialog(`Kick ${m.user.username} from ${group?.name}?`, {
                    title: "Kick member",
                    confirmLabel: "Kick",
                    danger: true,
                  }).then((ok) => {
                    if (ok && group) void chatApi.kick(group.id, m.user.id);
                  })
                }
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

const NO_MESSAGES: Message[] = [];

function MessagePane() {
  const activeChannelId = useChat((s) => s.activeChannelId);
  const messagesMap = useChat((s) => s.messages);
  const messages = (activeChannelId !== null && messagesMap[activeChannelId]) || NO_MESSAGES;
  const channels = useChat((s) => s.channels);
  const channel = channels.find((c) => c.id === activeChannelId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages.length, activeChannelId]);

  return (
    <>
      <header className="wf-chat-main-header"># {channel?.name}</header>
      <div className="wf-chat-messages">
        {messages.map((m, i) => (
          <MessageRow key={m.id} message={m} compact={messages[i - 1]?.author.id === m.author.id} />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer />
    </>
  );
}

/** Hover-revealed delete control; shown to the author or a group admin. */
export function MessageActions({
  message,
  authorOnly = false,
}: {
  message: Message;
  /** DMs have no group admin — only the author may delete. */
  authorOnly?: boolean;
}) {
  const me = useSession((s) => s.session?.user);
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const group = groups.find((g) => g.id === activeGroupId);
  const canDelete =
    me && (message.author.id === me.id || (!authorOnly && group?.my_role === "admin"));
  if (!canDelete) return null;
  return (
    <span className="wf-msg-actions">
      <button
        title="Delete message"
        onClick={() =>
          void confirmDialog("Delete this message for everyone?", {
            title: "Delete message",
            confirmLabel: "Delete",
            danger: true,
          }).then((ok) => {
            if (ok) void chatApi.deleteMessage(message.id).catch(() => {});
          })
        }
      >
        <Trash2 size={13} />
      </button>
    </span>
  );
}

/** Join card for a writing session announced in the channel. */
function SessionJoinCard({ content }: { content: string }) {
  const [error, setError] = useState<string | null>(null);
  let card: { session_id?: number; title?: string } = {};
  try {
    card = JSON.parse(content) as typeof card;
  } catch {
    // malformed card — render the shell
  }
  return (
    <div className="wf-session-join">
      <PenLine size={16} />
      <div className="wf-plugin-info">
        <strong>{card.title ?? "Writing session"}</strong>
        <span className="wf-session-meta">
          {error ?? "A writing session in this channel"}
        </span>
      </div>
      <button
        className="wf-primary"
        onClick={() => {
          const id = card.session_id;
          if (id === undefined) return;
          void import("../sessions/store").then(({ useSessions }) =>
            useSessions
              .getState()
              .openSession(id)
              .then(() => {
                void import("../../platform").then(({ usePlatform }) =>
                  usePlatform.getState().setActiveApp("writform.sessions"),
                );
              })
              .catch(() => setError("This session no longer exists.")),
          );
        }}
      >
        Open session
      </button>
    </div>
  );
}

function MessageRow({ message, compact }: { message: Message; compact: boolean }) {
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className={`wf-msg ${compact ? "compact" : ""}`}>
      <MessageActions message={message} />
      {!compact && (
        <div className="wf-msg-meta">
          <Avatar
            name={message.author.display_name ?? message.author.username}
            attachmentId={message.author.avatar_attachment_id}
            accentColor={message.author.accent_color}
            size={22}
          />
          <span
            className="wf-msg-author"
            style={message.author.accent_color ? { color: message.author.accent_color } : undefined}
          >
            {message.author.display_name ?? message.author.username}
          </span>
          <span className="wf-msg-time">{time}</span>
        </div>
      )}
      {message.kind === "session" ? (
        <SessionJoinCard content={message.content ?? "{}"} />
      ) : (
        message.content && (
          <div className="wf-msg-content">
            <MessageText text={message.content} />
          </div>
        )
      )}
      {message.attachments.map((a) => (
        <img
          key={a.id}
          className="wf-msg-image"
          src={attSrc(a.id)}
          alt={a.original_name ?? "attachment"}
        />
      ))}
      {message.edited_at && <span className="wf-msg-edited">(edited)</span>}
    </div>
  );
}

interface PendingUpload {
  id: number;
  name: string;
}

function Composer() {
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const send = useChat((s) => s.send);
  const channels = useChat((s) => s.channels);
  const activeChannelId = useChat((s) => s.activeChannelId);
  const channel = channels.find((c) => c.id === activeChannelId);

  const addUpload = async (upload: Promise<UploadedAttachment>, fallbackName: string) => {
    setUploading(true);
    try {
      const meta = await upload;
      setUploads((u) => [...u, { id: meta.id, name: meta.original_name ?? fallbackName }]);
    } catch {
      // upload failed — chip simply doesn't appear
    } finally {
      setUploading(false);
    }
  };
  const uploadBlobToChips = (blob: Blob, name: string) => addUpload(uploadBlob(blob, name), name);

  // Native drag & drop: Tauri intercepts OS file drags, so listen to its
  // drag-drop events and upload by path through the pinned Rust client.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") setDragging(true);
          else if (event.payload.type === "drop") {
            setDragging(false);
            for (const path of event.payload.paths) {
              const name = path.split(/[/\\]/).pop() ?? "file";
              void addUpload(uploadPath(path), name);
            }
          } else setDragging(false);
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // @mention / #channel autocomplete on the draft's trailing token.
  const members = useChat((s) => s.members);
  const mentionMatch = /(^|\s)@([A-Za-z0-9_-]*)$/.exec(draft);
  const channelRefMatch = /(^|\s)#([a-z0-9_-]*)$/.exec(draft);
  const mentionSuggestions = mentionMatch
    ? members
        .filter((mm) =>
          mm.user.username.toLowerCase().startsWith(mentionMatch[2].toLowerCase()),
        )
        .slice(0, 6)
    : [];
  const channelSuggestions = channelRefMatch
    ? channels
        .filter((c) => c.kind === "text" && (c.name ?? "").startsWith(channelRefMatch[2]))
        .slice(0, 6)
    : [];
  const completeMention = (username: string) => {
    setDraft((d) => d.replace(/@[A-Za-z0-9_-]*$/, `@${username} `));
    draftRef.current?.focus();
  };
  const completeChannelRef = (name: string) => {
    setDraft((d) => d.replace(/#[a-z0-9_-]*$/, `#${name} `));
    draftRef.current?.focus();
  };

  // Slash commands: "/name args" runs a registered chat command instead of
  // sending a message. A menu of matches shows while the draft starts with /.
  const chatCommands = usePlatform((s) => s.chatCommands);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const isCommandDraft = draft.startsWith("/") && !draft.includes("\n");
  const commandQuery = isCommandDraft ? draft.slice(1).split(" ")[0].toLowerCase() : "";
  const commandMatches = isCommandDraft
    ? Object.values(chatCommands)
        .filter((c) => c.name.startsWith(commandQuery))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const runCommand = (content: string): boolean => {
    if (!content.startsWith("/")) return false;
    const space = content.indexOf(" ");
    const name = (space === -1 ? content.slice(1) : content.slice(1, space)).toLowerCase();
    const args = space === -1 ? "" : content.slice(space + 1).trim();
    const cmd = usePlatform.getState().chatCommands[name];
    if (!cmd) {
      setCmdError(`Unknown command /${name}`);
      return true;
    }
    if (activeChannelId === null) return true;
    setDraft("");
    setCmdError(null);
    const ctx = {
      channelId: activeChannelId,
      groupId: useChat.getState().activeGroupId,
      send: async (text: string) => {
        await chatApi.sendMessage(activeChannelId, text);
      },
    };
    Promise.resolve(cmd.run(args, ctx)).catch((e) =>
      setCmdError(`/${name}: ${isCmdError(e) ? e.message : String(e)}`),
    );
    return true;
  };

  const submit = () => {
    const content = draft.trim();
    if (!content && uploads.length === 0) return;
    if (runCommand(content)) return;
    const attachmentIds = uploads.map((u) => u.id);
    setDraft("");
    setUploads([]);
    void send(content, attachmentIds);
  };

  const insertEmote = (name: string) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}:${name}: `);
    draftRef.current?.focus();
  };

  return (
    <div
      className={`wf-composer-wrap ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        for (const file of e.dataTransfer.files) {
          void uploadBlobToChips(file, file.name);
        }
      }}
    >
      {pickerOpen && <EmotePicker onPick={insertEmote} onClose={() => setPickerOpen(false)} />}
      {cmdError && (
        <p className="wf-connect-error wf-cmd-error" onClick={() => setCmdError(null)}>
          {cmdError}
        </p>
      )}
      {mentionSuggestions.length > 0 && (
        <div className="wf-cmd-menu">
          {mentionSuggestions.map((mm) => (
            <button key={mm.user.id} onClick={() => completeMention(mm.user.username)}>
              <Avatar
                name={mm.user.display_name ?? mm.user.username}
                attachmentId={mm.user.avatar_attachment_id}
                accentColor={mm.user.accent_color}
                size={18}
              />
              <code>@{mm.user.username}</code>
              {mm.user.display_name && <span>{mm.user.display_name}</span>}
            </button>
          ))}
        </div>
      )}
      {channelSuggestions.length > 0 && (
        <div className="wf-cmd-menu">
          {channelSuggestions.map((c) => (
            <button key={c.id} onClick={() => completeChannelRef(c.name ?? "")}>
              <code>#{c.name}</code>
            </button>
          ))}
        </div>
      )}
      {isCommandDraft && commandMatches.length > 0 && (
        <div className="wf-cmd-menu">
          {commandMatches.slice(0, 8).map((c) => (
            <button
              key={c.name}
              onClick={() => {
                setDraft(`/${c.name} `);
                draftRef.current?.focus();
              }}
            >
              <code>/{c.name}</code>
              <span>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {uploads.length > 0 && (
        <div className="wf-upload-chips">
          {uploads.map((u) => (
            <span key={u.id} className="wf-upload-chip">
              <ImageIcon size={13} /> {u.name}
              <button onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="wf-composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadBlobToChips(file, file.name);
            e.target.value = "";
          }}
        />
        <button
          className="wf-composer-attach"
          title="Attach image"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? "…" : <Plus size={18} />}
        </button>
        <button
          className="wf-composer-attach"
          title="Emotes"
          onClick={() => setPickerOpen((v) => !v)}
        >
          <SmilePlus size={18} />
        </button>
        <textarea
          ref={draftRef}
          rows={1}
          placeholder={`Message #${channel?.name ?? ""}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
            const file = item?.getAsFile();
            if (file) {
              e.preventDefault();
              void uploadBlobToChips(file, "pasted.png");
            }
          }}
          onKeyDown={(e) => {
            if (
              (e.key === "Enter" || e.key === "Tab") &&
              (mentionSuggestions.length > 0 || channelSuggestions.length > 0)
            ) {
              e.preventDefault();
              if (mentionSuggestions.length > 0) {
                completeMention(mentionSuggestions[0].user.username);
              } else {
                completeChannelRef(channelSuggestions[0].name ?? "");
              }
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="wf-primary"
          disabled={(!draft.trim() && uploads.length === 0) || uploading}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </div>
  );
}
