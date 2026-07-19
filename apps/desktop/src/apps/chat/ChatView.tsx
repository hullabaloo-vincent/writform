import {
  ImageIcon,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  SmilePlus,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Emote } from "../../bindings/proto/Emote";
import type { Message } from "../../bindings/proto/Message";
import { isCmdError } from "../../lib/backend";
import { confirmDialog } from "../../platform";
import { useSession } from "../../stores/session";
import { chatApi } from "./api";
import { useChat } from "./store";
import { useVoice, voiceApi } from "./voice";

const attSrc = (attachmentId: number) => `writform-att://attachment/${attachmentId}`;

/** Render message text with `:name:` tokens replaced by the group's emotes. */
export function EmoteText({ text }: { text: string }) {
  const emotes = useChat((s) => s.emotes);
  const byName = useMemo(() => {
    const map = new Map<string, Emote>();
    for (const e of emotes) map.set(e.name, e);
    return map;
  }, [emotes]);

  const parts = useMemo(() => {
    const out: React.ReactNode[] = [];
    const re = /:([a-z0-9_]{1,32}):/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
      const emote = byName.get(m[1]);
      if (!emote) continue;
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(
        <img
          key={key++}
          className="wf-emote"
          src={attSrc(emote.attachment_id)}
          alt={`:${emote.name}:`}
          title={`:${emote.name}:`}
        />,
      );
      last = m.index + m[0].length;
    }
    if (out.length === 0) return null; // no emotes — render plain text as-is
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text, byName]);

  return <>{parts ?? text}</>;
}

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
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i += 0x8000) {
        binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      const { backend } = await import("../../lib/backend");
      const res = await backend.uploadAttachment({ dataBase64: btoa(binary), fileName: file.name });
      if (res.status >= 400) throw (res.body ?? { message: "upload failed" }) as Error;
      const meta = res.body as { id: number };
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
          onClick={() => void selectGroup(g.id)}
        >
          {g.name
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w[0]?.toUpperCase())
            .join("")}
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
  const [name, setName] = useState("");

  return (
    <>
      <header className="wf-chat-channels-header">
        <span className="wf-chat-group-name">{group?.name}</span>
        {isAdmin && (
          <button
            title="Create invite"
            onClick={() =>
              void chatApi.createInvite(group!.id).then((i) => setInvite(i.code))
            }
          >
            ✉
          </button>
        )}
      </header>
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
      <VoiceBar />
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

function VoiceBar() {
  const connectedChannelId = useVoice((s) => s.connectedChannelId);
  const joining = useVoice((s) => s.joining);
  const muted = useVoice((s) => s.muted);
  const channels = useVoice((s) => s.channels);
  const leave = useVoice((s) => s.leave);
  const toggleMute = useVoice((s) => s.toggleMute);

  if (joining) {
    return (
      <div className="wf-voice-bar">
        Connecting voice…
        <span className="wf-statusbar-spacer" />
        <button title="Cancel" onClick={() => void leave()}>
          <PhoneOff size={15} />
        </button>
      </div>
    );
  }
  if (connectedChannelId === null) return null;
  const channel = channels.find((c) => c.id === connectedChannelId);

  return (
    <div className="wf-voice-bar">
      <Volume2 size={15} />
      <span className="wf-voice-bar-name">{channel?.name ?? "voice"}</span>
      <button title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
        {muted ? <MicOff size={15} /> : <Mic size={15} />}
      </button>
      <button title="Leave voice" onClick={() => void leave()}>
        <PhoneOff size={15} />
      </button>
    </div>
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

function MessageRow({ message, compact }: { message: Message; compact: boolean }) {
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className={`wf-msg ${compact ? "compact" : ""}`}>
      {!compact && (
        <div className="wf-msg-meta">
          <span className="wf-msg-author">
            {message.author.display_name ?? message.author.username}
          </span>
          <span className="wf-msg-time">{time}</span>
        </div>
      )}
      {message.content && (
        <div className="wf-msg-content">
          <EmoteText text={message.content} />
        </div>
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
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const send = useChat((s) => s.send);
  const channels = useChat((s) => s.channels);
  const activeChannelId = useChat((s) => s.activeChannelId);
  const channel = channels.find((c) => c.id === activeChannelId);

  const uploadBlob = async (blob: Blob, name: string) => {
    setUploading(true);
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i += 0x8000) {
        binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      const { backend } = await import("../../lib/backend");
      const res = await backend.uploadAttachment({ dataBase64: btoa(binary), fileName: name });
      if (res.status < 400) {
        const meta = res.body as { id: number; original_name: string | null };
        setUploads((u) => [...u, { id: meta.id, name: meta.original_name ?? name }]);
      }
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    const content = draft.trim();
    if (!content && uploads.length === 0) return;
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
    <div className="wf-composer-wrap">
      {pickerOpen && <EmotePicker onPick={insertEmote} onClose={() => setPickerOpen(false)} />}
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
            if (file) void uploadBlob(file, file.name);
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
              void uploadBlob(file, "pasted.png");
            }
          }}
          onKeyDown={(e) => {
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
