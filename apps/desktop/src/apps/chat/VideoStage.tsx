import { MicOff, MonitorUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Avatar } from "../../platform";
import { useSession } from "../../stores/session";
import { setUserVolume, useVoice } from "./voice";

/**
 * Floating video stage: a draggable, resizable tile panel for the connected
 * voice room. Mounted from the statusbar's voice bar but positioned fixed, so
 * it follows you into Canvas/Documents — video accompanies the work instead
 * of replacing it.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RECT_KEY = "wf-stage-rect";
const MIN_W = 260;
const MIN_H = 180;

function defaultRect(): Rect {
  return {
    x: Math.max(12, window.innerWidth - 420),
    y: Math.max(12, window.innerHeight - 360),
    w: 400,
    h: 300,
  };
}

function loadRect(): Rect {
  try {
    const raw = localStorage.getItem(RECT_KEY);
    if (!raw) return defaultRect();
    const r = JSON.parse(raw) as Partial<Rect>;
    if ([r.x, r.y, r.w, r.h].some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      return defaultRect();
    }
    return clampRect(r as Rect);
  } catch {
    return defaultRect();
  }
}

/** Keep the panel reachable: header on-screen, size sane. */
function clampRect(r: Rect): Rect {
  const w = Math.min(Math.max(r.w, MIN_W), window.innerWidth);
  const h = Math.min(Math.max(r.h, MIN_H), window.innerHeight);
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, 8 - w + 80), window.innerWidth - 80),
    y: Math.min(Math.max(r.y, 8), window.innerHeight - 60),
  };
}

/** A live <video> for a MediaStream. Muted: audio plays via the mesh. */
function VideoTile({ stream, mirrored }: { stream: MediaStream; mirrored: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="wf-stage-video"
      style={mirrored ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}

interface Tile {
  key: string;
  userId: number;
  name: string;
  /** Name without the "(you)" suffix — what the avatar initial comes from. */
  rawName: string;
  avatarAttachmentId: number | null;
  accentColor: string | null;
  stream: MediaStream | null;
  kind: "camera" | "screen";
  mirrored: boolean;
  micMuted: boolean;
  sharingScreen: boolean;
}

export function VideoStage() {
  const connectedChannelId = useVoice((s) => s.connectedChannelId);
  const stageOpen = useVoice((s) => s.stageOpen);
  const toggleStage = useVoice((s) => s.toggleStage);
  const occupants = useVoice((s) => s.occupants);
  const localCamera = useVoice((s) => s.localCamera);
  const localScreen = useVoice((s) => s.localScreen);
  const remoteVideo = useVoice((s) => s.remoteVideo);
  const remoteMedia = useVoice((s) => s.remoteMedia);
  const muted = useVoice((s) => s.muted);
  const screenOn = useVoice((s) => s.screenOn);
  const speaking = useVoice((s) => s.speaking);
  const userVolumes = useVoice((s) => s.userVolumes);
  const channels = useVoice((s) => s.channels);
  const me = useSession((s) => s.session?.user);

  const [rect, setRect] = useState<Rect>(loadRect);
  const [focused, setFocused] = useState<string | null>(null);
  const dragState = useRef<{ mode: "move" | "resize"; startX: number; startY: number; start: Rect } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(RECT_KEY, JSON.stringify(rect));
    } catch {
      // persistence is a nicety
    }
  }, [rect]);

  if (connectedChannelId === null || !stageOpen || !me) return null;

  const room = occupants[connectedChannelId] ?? [];
  const channel = channels.find((c) => c.id === connectedChannelId);

  const tiles: Tile[] = [];
  for (const u of room) {
    const isMe = u.id === me.id;
    const media = remoteMedia[u.id];
    const name = u.display_name ?? u.username;
    const base = {
      userId: u.id,
      name: isMe ? `${name} (you)` : name,
      rawName: name,
      avatarAttachmentId: u.avatar_attachment_id,
      accentColor: u.accent_color,
      micMuted: isMe ? muted : (media?.micMuted ?? false),
      sharingScreen: isMe ? screenOn : (media?.screen ?? false),
    };
    tiles.push({
      ...base,
      key: `${u.id}:camera`,
      kind: "camera",
      mirrored: isMe,
      stream: isMe ? localCamera : ((media?.camera && remoteVideo[u.id]?.camera) || null),
    });
    // Screen tiles while a share is live — including my own, so I can see
    // exactly what's going out. (Sharing the WritForm window itself will
    // mirror-tunnel; that's inherent to self-preview.)
    const screenStream = isMe
      ? screenOn
        ? localScreen
        : null
      : media?.screen
        ? (remoteVideo[u.id]?.screen ?? null)
        : null;
    if (screenStream) {
      tiles.push({
        ...base,
        key: `${u.id}:screen`,
        kind: "screen",
        mirrored: false,
        stream: screenStream,
      });
    }
  }

  const focusedTile = tiles.find((t) => t.key === focused) ?? null;
  const gridTiles = focusedTile ? tiles.filter((t) => t.key !== focused) : tiles;

  const startDrag = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.preventDefault();
    dragState.current = { mode, startX: e.clientX, startY: e.clientY, start: rect };
    const onMove = (ev: PointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      setRect(
        clampRect(
          d.mode === "move"
            ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy }
            : { ...d.start, w: d.start.w + dx, h: d.start.h + dy },
        ),
      );
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const renderTile = (t: Tile, large: boolean) => (
    <div
      key={t.key}
      className={`wf-stage-tile ${t.kind === "screen" ? "screen" : ""} ${
        speaking.has(t.userId) && !t.micMuted ? "speaking" : ""
      } ${large ? "focused" : ""}`}
      onClick={() => setFocused(focused === t.key ? null : t.key)}
      title={large ? "Click to return to the grid" : "Click to enlarge"}
    >
      {t.stream ? (
        <VideoTile stream={t.stream} mirrored={t.mirrored} />
      ) : (
        <div className="wf-stage-avatar">
          <Avatar
            name={t.rawName}
            attachmentId={t.avatarAttachmentId}
            accentColor={t.accentColor}
            size={large ? 72 : 44}
            singleInitial
          />
        </div>
      )}
      <span className="wf-stage-name">
        {t.micMuted && <MicOff size={11} />}
        {t.sharingScreen && t.kind === "camera" && <MonitorUp size={11} />}
        {t.kind === "screen" ? `${t.name} — screen` : t.name}
      </span>
      {t.userId !== me.id && t.kind === "camera" && (
        <input
          className="wf-stage-volume"
          type="range"
          min={0}
          max={1.5}
          step={0.05}
          title="Volume for this person"
          value={userVolumes[t.userId] ?? 1}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setUserVolume(t.userId, Number(e.target.value))}
        />
      )}
    </div>
  );

  return (
    <div className="wf-stage" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div className="wf-stage-header" onPointerDown={(e) => startDrag(e, "move")}>
        <span className="wf-stage-title">{channel?.name ?? "voice"}</span>
        <button
          className="wf-icon"
          title="Hide video panel"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleStage}
        >
          <X size={13} />
        </button>
      </div>
      <div className="wf-stage-body">
        {focusedTile && renderTile(focusedTile, true)}
        <div className={`wf-stage-grid ${focusedTile ? "strip" : ""}`}>
          {gridTiles.map((t) => renderTile(t, false))}
        </div>
      </div>
      <span className="wf-stage-resize" onPointerDown={(e) => startDrag(e, "resize")} />
    </div>
  );
}
