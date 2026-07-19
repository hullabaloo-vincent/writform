import { ImageIcon, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Message } from "../../bindings/proto/Message";
import { isCmdError } from "../../lib/backend";
import { confirmDialog } from "../../platform";
import { useSession } from "../../stores/session";
import { chatApi } from "./api";
import { useChat } from "./store";

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
      </nav>
    </>
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
      {message.content && <div className="wf-msg-content">{message.content}</div>}
      {message.attachments.map((a) => (
        <img
          key={a.id}
          className="wf-msg-image"
          src={`writform-att://attachment/${a.id}`}
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
  const fileRef = useRef<HTMLInputElement>(null);
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

  return (
    <div className="wf-composer-wrap">
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
        <textarea
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
