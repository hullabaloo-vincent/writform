import {
  ImageIcon,
  LayoutGrid,
  Mic,
  MicOff,
  FileText,
  MonitorUp,
  PenLine,
  PhoneOff,
  Plus,
  Reply,
  Settings as SettingsIcon,
  SmilePlus,
  Trash2,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { LinkPreview } from "../../bindings/proto/LinkPreview";
import type { Message } from "../../bindings/proto/Message";
import { isCmdError } from "../../lib/backend";
import { fetchLinkPreview, firstUrl } from "../../lib/linkPreview";
import { uploadBlob, uploadPath, type UploadedAttachment } from "../../lib/upload";
import {
  Avatar,
  confirmDialog,
  Modal,
  showLightbox,
  showProfile,
  SkeletonRows,
  toastError,
  usePlatform,
} from "../../platform";
import { useSession } from "../../stores/session";
import { chatApi } from "./api";
import { MessageText } from "./MessageText";
import { useChat, type OutboxEntry } from "./store";
import { VideoStage } from "./VideoStage";
import { canScreenShare, setUserVolume, useVoice, voiceApi } from "./voice";

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
                    if (ok) void chatApi.deleteEmote(group.id, e.id).catch(() => toastError("Couldn't remove the emote."));
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
  const unread = useChat((s) => s.unread);
  const channelGroup = useChat((s) => s.channelGroup);
  const [adding, setAdding] = useState(false);

  const groupUnread = (groupId: number) =>
    Object.entries(unread).reduce(
      (n, [cid, count]) => (channelGroup[Number(cid)] === groupId ? n + count : n),
      0,
    );

  return (
    <>
      {groups.map((g) => {
        const count = groupUnread(g.id);
        return (
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
          {count > 0 && <span className="wf-btn-badge">{count > 99 ? "99+" : count}</span>}
        </button>
        );
      })}
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
    <Modal onClose={onClose}>
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
    </Modal>
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
    <Modal onClose={onClose}>
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
    </Modal>
  );
}

function ChannelList() {
  const channels = useChat((s) => s.channels);
  const activeChannelId = useChat((s) => s.activeChannelId);
  const selectChannel = useChat((s) => s.selectChannel);
  const unread = useChat((s) => s.unread);
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const group = groups.find((g) => g.id === activeGroupId);
  const isAdmin = group?.my_role === "admin";
  const [invite, setInvite] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

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
          .map((c) => {
            const count = unread[c.id] ?? 0;
            if (renamingId === c.id) {
              return (
                <form
                  key={c.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = renameDraft.trim();
                    setRenamingId(null);
                    if (!next || next === c.name) return;
                    void chatApi
                      .updateChannel(c.id, next)
                      .catch(() => toastError("Couldn't rename the channel."));
                  }}
                >
                  <input
                    className="wf-chat-channel-input"
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => setRenamingId(null)}
                    onKeyDown={(e) => e.key === "Escape" && setRenamingId(null)}
                  />
                </form>
              );
            }
            return (
              <div key={c.id} className="wf-chat-channel-row">
                <button
                  className={`wf-chat-channel ${c.id === activeChannelId ? "active" : ""} ${
                    count > 0 ? "unread" : ""
                  }`}
                  onClick={() => void selectChannel(c.id)}
                >
                  # {c.name}
                  {count > 0 && (
                    <span className="wf-unread-pill">{count > 99 ? "99+" : count}</span>
                  )}
                </button>
                {isAdmin && (
                  <span className="wf-chat-channel-tools">
                    <button
                      className="wf-icon"
                      title="Rename channel"
                      onClick={() => {
                        setRenameDraft(c.name ?? "");
                        setRenamingId(c.id);
                      }}
                    >
                      <PenLine size={12} />
                    </button>
                    <button
                      className="wf-icon"
                      title="Delete channel"
                      onClick={() =>
                        void confirmDialog(
                          `Delete #${c.name} and all its messages for everyone? This cannot be undone.`,
                          { title: "Delete channel", confirmLabel: "Delete", danger: true },
                        ).then((ok) => {
                          if (ok) {
                            void chatApi
                              .deleteChannel(c.id)
                              .catch(() => toastError("Couldn't delete the channel."));
                          }
                        })
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </div>
            );
          })}
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
  const remoteMedia = useVoice((s) => s.remoteMedia);
  const cameraOn = useVoice((s) => s.cameraOn);
  const screenOn = useVoice((s) => s.screenOn);
  const userVolumes = useVoice((s) => s.userVolumes);
  const join = useVoice((s) => s.join);
  const loadChannels = useVoice((s) => s.loadChannels);
  const error = useVoice((s) => s.error);
  const me = useSession((s) => s.session?.user);
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
              {(occupants[c.id] ?? []).map((u) => {
                // Media state is only known for the room I'm in (it travels
                // peer-to-peer), so badges appear there alone.
                const inMyRoom = c.id === connectedChannelId;
                const isMe = u.id === me?.id;
                const media = remoteMedia[u.id];
                const hasCamera = inMyRoom && (isMe ? cameraOn : (media?.camera ?? false));
                const hasScreen = inMyRoom && (isMe ? screenOn : (media?.screen ?? false));
                return (
                  <li key={u.id} className={speaking.has(u.id) ? "speaking" : ""}>
                    <span className="wf-voice-dot" />
                    <Avatar
                      name={u.display_name ?? u.username}
                      attachmentId={u.avatar_attachment_id}
                      accentColor={u.accent_color}
                      size={16}
                    />
                    {u.display_name ?? u.username}
                    {hasCamera && <Video size={12} className="wf-voice-media-badge" />}
                    {hasScreen && <MonitorUp size={12} className="wf-voice-media-badge" />}
                    {inMyRoom && !isMe && (
                      <input
                        className="wf-occupant-volume"
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        title={`Volume for ${u.display_name ?? u.username}`}
                        value={userVolumes[u.id] ?? 1}
                        onChange={(e) => setUserVolume(u.id, Number(e.target.value))}
                      />
                    )}
                  </li>
                );
              })}
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
  const cameraOn = useVoice((s) => s.cameraOn);
  const screenOn = useVoice((s) => s.screenOn);
  const stageOpen = useVoice((s) => s.stageOpen);
  const remoteMedia = useVoice((s) => s.remoteMedia);
  const channels = useVoice((s) => s.channels);
  const speaking = useVoice((s) => s.speaking);
  const leave = useVoice((s) => s.leave);
  const toggleMute = useVoice((s) => s.toggleMute);
  const toggleCamera = useVoice((s) => s.toggleCamera);
  const toggleScreenShare = useVoice((s) => s.toggleScreenShare);
  const toggleStage = useVoice((s) => s.toggleStage);
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
  // Live videos I could be watching (peers' cameras and screens, plus mine).
  const videoCount =
    Object.values(remoteMedia).reduce(
      (n, m) => n + (m.camera ? 1 : 0) + (m.screen ? 1 : 0),
      0,
    ) + (cameraOn ? 1 : 0);

  return (
    <>
      <span className={`wf-voice-bar ${talking ? "talking" : ""}`}>
        <Volume2 size={13} />
        <span className="wf-voice-bar-name">{channel?.name ?? "voice"}</span>
        <button title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
          {muted ? <MicOff size={13} /> : <Mic size={13} />}
        </button>
        <button
          className={cameraOn ? "active" : ""}
          title={cameraOn ? "Turn camera off" : "Turn camera on"}
          onClick={() => void toggleCamera()}
        >
          {cameraOn ? <Video size={13} /> : <VideoOff size={13} />}
        </button>
        {canScreenShare() && (
          <button
            className={screenOn ? "active" : ""}
            title={screenOn ? "Stop sharing your screen" : "Share your screen"}
            onClick={() => void toggleScreenShare()}
          >
            <MonitorUp size={13} />
          </button>
        )}
        <button
          className={stageOpen ? "active" : ""}
          title={stageOpen ? "Hide video panel" : "Show video panel"}
          onClick={toggleStage}
        >
          <LayoutGrid size={13} />
          {!stageOpen && videoCount > 0 && <span className="wf-btn-badge">{videoCount}</span>}
        </button>
        <button title="Leave voice" onClick={() => void leave()}>
          <PhoneOff size={13} />
        </button>
      </span>
      <VideoStage />
    </>
  );
}

function MemberList() {
  const members = useChat((s) => s.members);
  const online = useChat((s) => s.online);
  const busy = useChat((s) => s.busy);
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
          <li
            key={m.user.id}
            className={online.has(m.user.id) || busy.has(m.user.id) ? "online" : "offline"}
          >
            <span className={`wf-presence-dot ${busy.has(m.user.id) ? "busy" : ""}`} />
            <button className="wf-user-link" onClick={() => showProfile(m.user.id)}>
              <Avatar
                name={m.user.display_name ?? m.user.username}
                attachmentId={m.user.avatar_attachment_id}
                accentColor={m.user.accent_color}
                size={22}
              />
              <span className="wf-member-name">{m.user.display_name ?? m.user.username}</span>
            </button>
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
const NO_OUTBOX: OutboxEntry[] = [];

function MessagePane() {
  const activeChannelId = useChat((s) => s.activeChannelId);
  const messagesMap = useChat((s) => s.messages);
  // No map entry = history still fetching; an empty array is a real empty
  // channel. Revisited channels have cached entries, so no skeleton flash.
  const loaded = activeChannelId !== null && activeChannelId in messagesMap;
  const messages = (loaded && messagesMap[activeChannelId]) || NO_MESSAGES;
  const outboxAll = useChat((s) => s.outbox);
  const outbox = activeChannelId
    ? outboxAll.filter((o) => o.channelId === activeChannelId)
    : NO_OUTBOX;
  const historyDone = useChat((s) => s.historyDone);
  const loadOlder = useChat((s) => s.loadOlder);
  const markRead = useChat((s) => s.markRead);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const channels = useChat((s) => s.channels);
  const channel = channels.find((c) => c.id === activeChannelId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Whether the user is (visually) at the bottom of the list. */
  const atBottom = useRef(true);
  /** Set before a prepend so the next layout pass restores the position. */
  const restore = useRef<{ height: number; top: number } | null>(null);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    atBottom.current = true;
    setShowJump(false);
  }, [activeChannelId]);

  // Runs after every list change: follow the bottom, restore after a
  // prepend, or surface the "new messages" pill — never yank mid-read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
      return;
    }
    if (atBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    } else if (messages.length > 0) {
      setShowJump(true);
    }
  }, [messages.length, outbox.length, activeChannelId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || activeChannelId === null) return;
    const bottomed = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottom.current = bottomed;
    if (bottomed) {
      setShowJump(false);
      markRead(activeChannelId);
    }
    if (el.scrollTop < 60 && loaded && messages.length > 0 && !historyDone[activeChannelId]) {
      // Capture geometry first: the prepend re-render must not move the view.
      restore.current = { height: el.scrollHeight, top: el.scrollTop };
      void loadOlder(activeChannelId).then((added) => {
        if (added === 0) restore.current = null;
      });
    }
  };

  const jumpToLatest = () => {
    atBottom.current = true;
    setShowJump(false);
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
    if (activeChannelId !== null) markRead(activeChannelId);
  };

  return (
    <>
      <header className="wf-chat-main-header"># {channel?.name}</header>
      <div className="wf-chat-messages" data-msg-scroll ref={scrollRef} onScroll={onScroll}>
        {loaded && messages.length > 0 && historyDone[activeChannelId] && (
          <p className="wf-chat-history-start">This is the beginning of #{channel?.name}.</p>
        )}
        {!loaded ? (
          <SkeletonRows rows={7} avatar />
        ) : (
          messages.map((m, i) => (
            <MessageRow
              key={m.id}
              message={m}
              compact={messages[i - 1]?.author.id === m.author.id}
              onReply={setReplyTo}
            />
          ))
        )}
        {outbox.map((o) => (
          <PendingRow key={o.key} entry={o} />
        ))}
        <div ref={bottomRef} />
      </div>
      {showJump && (
        <button className="wf-jump-latest" onClick={jumpToLatest}>
          New messages ↓
        </button>
      )}
      <Composer />
    </>
  );
}

/** An optimistic (or failed) send, shown after the confirmed history. */
function PendingRow({ entry }: { entry: OutboxEntry }) {
  const retrySend = useChat((s) => s.retrySend);
  const discardSend = useChat((s) => s.discardSend);
  return (
    <div className={`wf-msg wf-msg-pending ${entry.state}`}>
      <div className="wf-msg-content">
        <MessageText text={entry.content} />
      </div>
      {entry.state === "sending" ? (
        <span className="wf-msg-pending-note">sending…</span>
      ) : (
        <span className="wf-msg-pending-note failed">
          couldn't send
          <button onClick={() => void retrySend(entry.key)}>Retry</button>
          <button onClick={() => discardSend(entry.key)}>Discard</button>
        </span>
      )}
    </div>
  );
}

/** Hover-revealed message controls: react, reply, edit, delete. */
export function MessageActions({
  message,
  authorOnly = false,
  onReply,
}: {
  message: Message;
  /** DMs have no group admin — only the author may delete. */
  authorOnly?: boolean;
  /** When set, a reply button appears and hands back the message. */
  onReply?: (message: Message) => void;
}) {
  const me = useSession((s) => s.session?.user);
  const groups = useChat((s) => s.groups);
  const activeGroupId = useChat((s) => s.activeGroupId);
  const setEditing = useChat((s) => s.setEditing);
  const group = groups.find((g) => g.id === activeGroupId);
  const canDelete =
    me && (message.author.id === me.id || (!authorOnly && group?.my_role === "admin"));
  const canEdit = me?.id === message.author.id && message.kind === "text";
  const [pickerOpen, setPickerOpen] = useState(false);

  // Session/document cards are UI affordances rather than conversation, so
  // they get no reaction bar.
  const canReact = message.kind === "text" || message.kind === "shared_note";

  return (
    // `open` keeps the bar visible while the picker is up: it is otherwise
    // only shown on `.wf-msg:hover`, and the picker sits above the row, so
    // reaching for an emoji left the row and closed the drawer.
    <span className={`wf-msg-actions ${pickerOpen ? "open" : ""}`}>
      {onReply && message.kind === "text" && (
        <button className="wf-icon" title="Reply" onClick={() => onReply(message)}>
          <Reply size={13} />
        </button>
      )}
      {canEdit && (
        <button className="wf-icon" title="Edit message" onClick={() => setEditing(message.id)}>
          <PenLine size={13} />
        </button>
      )}
      {canReact && (
        <span className="wf-react-anchor">
          <button
            className="wf-icon"
            title="Add reaction"
            onClick={() => setPickerOpen((v) => !v)}
          >
            <SmilePlus size={13} />
          </button>
          {pickerOpen && (
            <ReactionPicker
              onPick={(emoji) => {
                setPickerOpen(false);
                void chatApi.react(message.id, emoji).catch(() => toastError("Reaction didn't go through."));
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </span>
      )}
      {canDelete && (
        <button
          className="wf-icon wf-msg-delete"
          title="Delete message"
          onClick={() =>
            void confirmDialog("Delete this message for everyone?", {
              title: "Delete message",
              confirmLabel: "Delete",
              danger: true,
            }).then((ok) => {
              if (ok) void chatApi.deleteMessage(message.id).catch(() => toastError("Couldn't delete the message."));
            })
          }
        >
          <Trash2 size={13} />
        </button>
      )}
    </span>
  );
}

/** A small fixed palette — enough to react quickly without a search UI. */
const QUICK_REACTIONS = ["\u{1F44D}", "\u{2764}\u{FE0F}", "\u{1F602}", "\u{1F389}", "\u{1F440}", "\u{1F525}", "\u{1F62E}", "\u{1F622}"];

function ReactionPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [below, setBelow] = useState(false);

  useEffect(() => {
    const close = () => onClose();
    // Deferred so the click that opened the picker doesn't immediately close it.
    const timer = setTimeout(() => window.addEventListener("pointerdown", close), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
    };
  }, [onClose]);

  // The drawer opens upward, but the message list is a scroll container, so
  // near the top it would be clipped. Flip it below when it doesn't fit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest<HTMLElement>("[data-msg-scroll]");
    if (!scroller) return;
    if (el.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
      setBelow(true);
    }
  }, []);

  return (
    <span
      ref={ref}
      className={`wf-react-picker ${below ? "below" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button key={emoji} className="wf-react-option" onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </span>
  );
}

/** Reaction pills under a message; clicking toggles your own reaction. */
function MessageReactions({ message }: { message: Message }) {
  if (message.reactions.length === 0) return null;
  return (
    <div className="wf-reactions">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          className={`wf-reaction ${r.me ? "mine" : ""}`}
          title={r.users.join(", ")}
          onClick={() =>
            void (r.me
              ? chatApi.unreact(message.id, r.emoji)
              : chatApi.react(message.id, r.emoji)
            ).catch(() => toastError("Reaction didn't go through."))
          }
        >
          <span className="wf-reaction-emoji">{r.emoji}</span>
          {r.count}
        </button>
      ))}
    </div>
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

/** Card for a document shared with the group. */
function DocumentShareCard({ content }: { content: string }) {
  const [error, setError] = useState<string | null>(null);
  let card: { document_id?: number; title?: string; access?: string } = {};
  try {
    card = JSON.parse(content) as typeof card;
  } catch {
    // malformed card — render the shell
  }
  return (
    <div className="wf-session-join">
      <FileText size={16} />
      <div className="wf-plugin-info">
        <strong>{card.title ?? "Shared document"}</strong>
        <span className="wf-session-meta">
          {error ??
            (card.access === "write"
              ? "Shared with this group — everyone can edit"
              : "Shared with this group — read only")}
        </span>
      </div>
      <button
        className="wf-primary"
        onClick={() => {
          const id = card.document_id;
          if (id === undefined) return;
          void import("../documents/store").then(({ openDocumentById }) =>
            openDocumentById(id).catch(() =>
              setError("This document is no longer shared with you."),
            ),
          );
        }}
      >
        Open document
      </button>
    </div>
  );
}

/** Quoted parent above a reply; clicking scrolls to the original. */
function ReplyQuote({ message }: { message: Message }) {
  const parent = useChat((s) =>
    message.reply_to_id !== null
      ? s.messages[message.channel_id]?.find((m) => m.id === message.reply_to_id)
      : undefined,
  );
  if (message.reply_to_id === null) return null;
  const jump = () => {
    document
      .getElementById(`wf-msg-${message.reply_to_id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <button className="wf-msg-quote" onClick={jump} title="Jump to the original message">
      <Reply size={11} />
      {parent ? (
        <>
          <span className="wf-msg-quote-author">
            {parent.author.display_name ?? parent.author.username}
          </span>
          <span className="wf-msg-quote-text">{(parent.content ?? "").slice(0, 120)}</span>
        </>
      ) : (
        <span className="wf-msg-quote-text">original message unavailable</span>
      )}
    </button>
  );
}

/** Inline editor swapped in for a message's content while editing. */
function InlineEdit({ message }: { message: Message }) {
  const setEditing = useChat((s) => s.setEditing);
  const [text, setText] = useState(message.content ?? "");
  const commit = () => {
    const content = text.trim();
    setEditing(null);
    if (!content || content === message.content) return;
    void chatApi
      .editMessage(message.id, content)
      .catch(() => toastError("Couldn't save the edit."));
  };
  return (
    <div className="wf-msg-edit">
      <textarea
        autoFocus
        rows={Math.min(6, text.split("\n").length)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setEditing(null);
        }}
      />
      <span className="wf-msg-edit-hint">Enter to save · Escape to cancel</span>
    </div>
  );
}

/** Server-fetched preview card for the first link in a message. */
function MsgLinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  useEffect(() => {
    let live = true;
    fetchLinkPreview(url)
      .then((p) => live && setPreview(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  if (!preview || (!preview.title && !preview.description)) return null;
  let domain = url;
  try {
    domain = new URL(url).host;
  } catch {
    // keep raw url
  }
  return (
    <a className="wf-msg-linkcard" href={url} target="_blank" rel="noreferrer">
      {preview.image_url && <img src={preview.image_url} alt="" />}
      <span className="wf-msg-linkcard-body">
        <span className="wf-msg-linkcard-title">{preview.title ?? domain}</span>
        {preview.description && (
          <span className="wf-msg-linkcard-desc">{preview.description}</span>
        )}
        <span className="wf-msg-linkcard-domain">{domain}</span>
      </span>
    </a>
  );
}

export function MessageRow({
  message,
  compact,
  authorOnly = false,
  onReply,
  sharedNoteCard,
}: {
  message: Message;
  compact: boolean;
  authorOnly?: boolean;
  onReply?: (message: Message) => void;
  /** DM-only renderer for `shared_note` messages (the card lives in Friends). */
  sharedNoteCard?: (content: string) => React.ReactNode;
}) {
  const editing = useChat((s) => s.editingMessageId === message.id);
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const url = message.kind === "text" && message.content ? firstUrl(message.content) : null;
  return (
    <div className={`wf-msg ${compact ? "compact" : ""}`} id={`wf-msg-${message.id}`}>
      <MessageActions message={message} authorOnly={authorOnly} onReply={onReply} />
      {!compact && (
        <div className="wf-msg-meta">
          <button className="wf-user-link" onClick={() => showProfile(message.author.id)}>
            <Avatar
              name={message.author.display_name ?? message.author.username}
              attachmentId={message.author.avatar_attachment_id}
              accentColor={message.author.accent_color}
              size={22}
            />
            <span
              className="wf-msg-author"
              style={
                message.author.accent_color ? { color: message.author.accent_color } : undefined
              }
            >
              {message.author.display_name ?? message.author.username}
            </span>
          </button>
          <span className="wf-msg-time">{time}</span>
        </div>
      )}
      <ReplyQuote message={message} />
      {message.kind === "session" ? (
        <SessionJoinCard content={message.content ?? "{}"} />
      ) : message.kind === "document" ? (
        <DocumentShareCard content={message.content ?? "{}"} />
      ) : message.kind === "shared_note" && sharedNoteCard ? (
        sharedNoteCard(message.content ?? "{}")
      ) : editing ? (
        <InlineEdit message={message} />
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
          onClick={() => showLightbox({ src: attSrc(a.id), name: a.original_name })}
        />
      ))}
      {message.edited_at && !editing && <span className="wf-msg-edited">(edited)</span>}
      {url && !editing && <MsgLinkPreview url={url} />}
      <MessageReactions message={message} />
    </div>
  );
}

interface PendingUpload {
  id: number;
  name: string;
}

function Composer() {
  const activeChannelId = useChat((s) => s.activeChannelId);
  // Drafts live in the store, keyed by channel — surviving channel switches,
  // app switches, and never bleeding into another conversation.
  const draft = useChat((s) =>
    s.activeChannelId !== null ? (s.drafts[s.activeChannelId] ?? "") : "",
  );
  const setDraftStore = useChat((s) => s.setDraft);
  const setDraft = (next: string | ((d: string) => string)) => {
    const id = useChat.getState().activeChannelId;
    if (id === null) return;
    const cur = useChat.getState().drafts[id] ?? "";
    setDraftStore(id, typeof next === "function" ? next(cur) : next);
  };
  const replyTo = useChat((s) => s.replyTo);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const setEditing = useChat((s) => s.setEditing);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const send = useChat((s) => s.send);
  const channels = useChat((s) => s.channels);
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
      {replyTo && (
        <div className="wf-reply-chip">
          <Reply size={12} />
          Replying to{" "}
          <strong>{replyTo.author.display_name ?? replyTo.author.username}</strong>
          <span className="wf-reply-chip-text">{(replyTo.content ?? "").slice(0, 80)}</span>
          <button className="wf-icon" title="Cancel reply" onClick={() => setReplyTo(null)}>
            ×
          </button>
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
            if (e.key === "Escape" && replyTo) {
              setReplyTo(null);
            }
            // Empty composer + ArrowUp = edit my last message (chat idiom).
            if (e.key === "ArrowUp" && draft === "" && activeChannelId !== null) {
              const meId = useSession.getState().session?.user.id;
              const myMessages = (useChat.getState().messages[activeChannelId] ?? []).filter(
                (m) => m.author.id === meId && m.kind === "text",
              );
              const mine = myMessages[myMessages.length - 1];
              if (mine) {
                e.preventDefault();
                setEditing(mine.id);
              }
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
