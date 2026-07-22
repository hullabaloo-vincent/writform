import { create } from "zustand";

import type { UserRef } from "../../bindings/proto/UserRef";
import type { VoiceChannel } from "../../bindings/proto/VoiceChannel";
import type { VoiceChannelInfo } from "../../bindings/proto/VoiceChannelInfo";
import type { VoiceJoinResponse } from "../../bindings/proto/VoiceJoinResponse";
import { backend, isCmdError, type CmdError } from "../../lib/backend";
import { CameraError, getCameraStream } from "../../lib/camera";
import { getMicrophoneStream } from "../../lib/microphone";
import { loadVoiceSettings, onVoiceSettingsChange } from "../../lib/voiceSettings";
import { useSession } from "../../stores/session";

/**
 * Voice & video: a WebRTC mesh. The server relays signaling and tracks who
 * is in which room; media flows directly between peers (DTLS-SRTP).
 *
 * Topology: the JOINER initiates a peer connection to every member already
 * in the room (learned from the join response); existing members never
 * initiate, so there is no offer glare.
 *
 * Video without renegotiation: every connection pre-allocates three
 * transceivers in fixed m-line order — [0] audio, [1] camera, [2] screen.
 * Turning video on/off is `sender.replaceTrack(track|null)` on the
 * pre-allocated slot, so no SDP is ever re-offered (renegotiation glare
 * cannot happen, and old WKWebViews without rollback support work).
 * Incoming tracks are routed by m-line index; on/off state travels as
 * `media-state` messages over the same opaque signal relay.
 */

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

export const voiceApi = {
  list: (groupId: number) => api<VoiceChannelInfo[]>("GET", `/api/v1/groups/${groupId}/voice`),
  create: (groupId: number, name: string) =>
    api<VoiceChannel>("POST", `/api/v1/groups/${groupId}/voice`, { name }),
  deleteChannel: (channelId: number) => api<null>("DELETE", `/api/v1/voice/${channelId}`),
  join: (channelId: number) => api<VoiceJoinResponse>("POST", `/api/v1/voice/${channelId}/join`),
  leave: () => api<null>("POST", "/api/v1/voice/leave"),
  signal: (channelId: number, to: number, data: unknown) =>
    api<null>("POST", `/api/v1/voice/${channelId}/signal`, { to, data }),
};

/** A peer's self-reported media state (authoritative for tile visibility). */
export interface PeerMediaState {
  camera: boolean;
  screen: boolean;
  micMuted: boolean;
}

interface VoiceState {
  /** Voice channels of the active group. */
  channels: VoiceChannel[];
  /** Everyone currently in each room (live via voice.joined/left). */
  occupants: Record<number, UserRef[]>;
  /** The room I'm connected to, if any. */
  connectedChannelId: number | null;
  joining: boolean;
  muted: boolean;
  /** User ids currently speaking (includes self). */
  speaking: Set<number>;
  error: string | null;

  /** My camera / screen-share state. */
  cameraOn: boolean;
  screenOn: boolean;
  /** Whether the floating video stage panel is shown. */
  stageOpen: boolean;
  /** My camera stream, for the local preview tile. */
  localCamera: MediaStream | null;
  /** Incoming video, one stream per peer per kind. */
  remoteVideo: Record<number, { camera?: MediaStream; screen?: MediaStream }>;
  /** Peers' self-reported media state. */
  remoteMedia: Record<number, PeerMediaState>;

  loadChannels: (groupId: number) => Promise<void>;
  join: (channel: VoiceChannel) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleStage: () => void;
}

/** Screen capture is engine-dependent (macOS WKWebView lacks it entirely). */
export function canScreenShare(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// --- mesh internals (module state, not react state) ---
const peers = new Map<number, RTCPeerConnection>();
const audioEls = new Map<number, HTMLAudioElement>();
const analysers = new Map<number, AnalyserNode>();
/** Per-peer video senders, indexed by the pre-allocated slot. */
const videoSenders = new Map<number, { camera: RTCRtpSender; screen: RTCRtpSender }>();
let localStream: MediaStream | null = null;
/** Post-gain stream actually sent to peers. */
let sendStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let inputGainNode: GainNode | null = null;
let audioCtx: AudioContext | null = null;
let speakingTimer: ReturnType<typeof setInterval> | null = null;
/** The stage auto-opens once per join when remote video first appears. */
let stageAutoOpened = false;

/** m-line slots — the fixed transceiver order every connection uses. */
const SLOT_AUDIO = 0;
const SLOT_CAMERA = 1;
const SLOT_SCREEN = 2;

// Gain/volume changes apply live; the input device applies on the next join.
onVoiceSettingsChange((settings) => {
  if (inputGainNode) inputGainNode.gain.value = settings.inputGain;
  for (const el of audioEls.values()) el.volume = settings.outputVolume;
});

function myId(): number | null {
  return useSession.getState().session?.user.id ?? null;
}

function watchSpeaking(userId: number, stream: MediaStream) {
  try {
    audioCtx ??= new AudioContext();
    // WKWebView starts AudioContexts suspended; a suspended graph reads pure
    // silence, which kept every speaking indicator dark.
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analysers.set(userId, analyser);
  } catch {
    // speaking indicators are cosmetic — ignore analyser failures
  }
}

function startSpeakingLoop() {
  if (speakingTimer) return;
  const buf = new Uint8Array(512);
  speakingTimer = setInterval(() => {
    const speaking = new Set<number>();
    for (const [userId, analyser] of analysers) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      if (Math.sqrt(sum / buf.length) > 0.04) speaking.add(userId);
    }
    const prev = useVoice.getState().speaking;
    if (prev.size !== speaking.size || [...speaking].some((id) => !prev.has(id))) {
      useVoice.setState({ speaking });
    }
  }, 250);
}

function attachAudio(peerId: number, stream: MediaStream) {
  let el = audioEls.get(peerId);
  if (!el) {
    el = new Audio();
    el.autoplay = true;
    audioEls.set(peerId, el);
  }
  el.volume = loadVoiceSettings().outputVolume;
  el.srcObject = stream;
  void el.play().catch(() => {});
  watchSpeaking(peerId, stream);
}

function sendSignal(peerId: number, data: unknown) {
  const channelId = useVoice.getState().connectedChannelId;
  if (channelId === null) return;
  void voiceApi.signal(channelId, peerId, data).catch(() => {});
}

/** Tell one peer (or everyone) whether my camera/screen/mic are live. */
function sendMediaState(peerId?: number) {
  const { cameraOn, screenOn, muted } = useVoice.getState();
  const msg = { type: "media-state", camera: cameraOn, screen: screenOn, micMuted: muted };
  if (peerId !== undefined) sendSignal(peerId, msg);
  else for (const id of peers.keys()) sendSignal(id, msg);
}

/**
 * Bitrate/degradation caps, applied after every replaceTrack. Best-effort —
 * an engine that rejects the parameters just streams uncapped.
 */
function applyVideoParams(sender: RTCRtpSender, kind: "camera" | "screen") {
  const quality = loadVoiceSettings().videoQuality;
  const maxBitrate =
    kind === "screen" ? 2_500_000 : quality === "720p" ? 1_800_000 : 800_000;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.degradationPreference =
      kind === "screen" ? "maintain-resolution" : "maintain-framerate";
    void sender.setParameters(params).catch(() => {});
  } catch {
    // caps are an optimization, never a requirement
  }
}

/**
 * Adopt a connection's transceivers in the fixed slot order and attach
 * whatever local media is currently live. The initiator creates the
 * transceivers (defining the m-line order); the answerer adopts the ones the
 * offer created. Either way the connection ends up with the same three
 * slots, so later toggles are pure replaceTrack — no renegotiation.
 */
function wireTransceivers(peerId: number, pc: RTCPeerConnection, initiator: boolean) {
  if (initiator) {
    const audioTrack = (sendStream ?? localStream)?.getAudioTracks()[0];
    const audioStreams = sendStream ?? localStream;
    if (audioTrack && audioStreams) {
      pc.addTransceiver(audioTrack, { direction: "sendrecv", streams: [audioStreams] });
    } else {
      pc.addTransceiver("audio", { direction: "sendrecv" });
    }
    const camTrack = cameraStream?.getVideoTracks()[0];
    pc.addTransceiver(camTrack ?? "video", { direction: "sendrecv" });
    const screenTrack = screenStream?.getVideoTracks()[0];
    pc.addTransceiver(screenTrack ?? "video", { direction: "sendrecv" });
  }
  const ts = pc.getTransceivers();
  const cam = ts[SLOT_CAMERA];
  const screen = ts[SLOT_SCREEN];
  // A stale audio-only client offers a single m-line; that pair simply
  // stays audio-only.
  if (!cam || !screen) return;
  if (!initiator) {
    cam.direction = "sendrecv";
    screen.direction = "sendrecv";
    const audio = ts[SLOT_AUDIO];
    const audioTrack = (sendStream ?? localStream)?.getAudioTracks()[0];
    if (audio && audioTrack) void audio.sender.replaceTrack(audioTrack).catch(() => {});
    const camTrack = cameraStream?.getVideoTracks()[0];
    if (camTrack) void cam.sender.replaceTrack(camTrack).catch(() => {});
    const screenTrack = screenStream?.getVideoTracks()[0];
    if (screenTrack) void screen.sender.replaceTrack(screenTrack).catch(() => {});
  }
  videoSenders.set(peerId, { camera: cam.sender, screen: screen.sender });
  if (cameraStream) applyVideoParams(cam.sender, "camera");
  if (screenStream) applyVideoParams(screen.sender, "screen");
}

/** Record an incoming video stream and auto-open the stage the first time. */
function setRemoteVideo(peerId: number, kind: "camera" | "screen", stream?: MediaStream) {
  useVoice.setState((s) => {
    const entry = { ...s.remoteVideo[peerId], [kind]: stream };
    const remoteVideo = { ...s.remoteVideo, [peerId]: entry };
    let { stageOpen } = s;
    if (stream && !stageAutoOpened) {
      stageAutoOpened = true;
      stageOpen = true;
    }
    return { remoteVideo, stageOpen };
  });
}

async function createPeer(peerId: number, initiator: boolean): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(peerId, pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { type: "ice", candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    if (e.track.kind === "audio") {
      attachAudio(peerId, e.streams[0] ?? new MediaStream([e.track]));
      return;
    }
    // Video routes by m-line slot; refs stored at wire time are too late
    // here, because ontrack fires inside setRemoteDescription.
    const slot = pc.getTransceivers().indexOf(e.transceiver);
    if (slot === SLOT_CAMERA || slot === SLOT_SCREEN) {
      setRemoteVideo(
        peerId,
        slot === SLOT_CAMERA ? "camera" : "screen",
        new MediaStream([e.track]),
      );
    }
  };
  if (initiator) {
    wireTransceivers(peerId, pc, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peerId, { type: "offer", sdp: { type: offer.type, sdp: offer.sdp } });
    sendMediaState(peerId);
  }
  return pc;
}

function closePeer(peerId: number) {
  peers.get(peerId)?.close();
  peers.delete(peerId);
  videoSenders.delete(peerId);
  const el = audioEls.get(peerId);
  if (el) {
    el.srcObject = null;
    audioEls.delete(peerId);
  }
  analysers.delete(peerId);
  useVoice.setState((s) => {
    const remoteVideo = { ...s.remoteVideo };
    const remoteMedia = { ...s.remoteMedia };
    delete remoteVideo[peerId];
    delete remoteMedia[peerId];
    return { remoteVideo, remoteMedia };
  });
}

/// Bumped on every teardown so an in-flight join (e.g. a mic-permission
/// prompt the user never answered) aborts instead of resurrecting the room.
let joinGeneration = 0;

function teardown() {
  joinGeneration += 1;
  for (const id of [...peers.keys()]) closePeer(id);
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  sendStream = null;
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  inputGainNode = null;
  analysers.clear();
  videoSenders.clear();
  stageAutoOpened = false;
  if (speakingTimer) {
    clearInterval(speakingTimer);
    speakingTimer = null;
  }
  useVoice.setState({
    connectedChannelId: null,
    joining: false,
    muted: false,
    speaking: new Set(),
    cameraOn: false,
    screenOn: false,
    stageOpen: false,
    localCamera: null,
    remoteVideo: {},
    remoteMedia: {},
  });
}

async function handleSignal(from: number, data: Record<string, unknown>) {
  try {
    if (data.type === "offer") {
      const pc = peers.get(from) ?? (await createPeer(from, false));
      await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
      // The offer's m-lines created our transceivers; adopt them and attach
      // whatever local media is already live.
      wireTransceivers(from, pc, false);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { type: "answer", sdp: { type: answer.type, sdp: answer.sdp } });
      sendMediaState(from);
    } else if (data.type === "answer") {
      await peers.get(from)?.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
    } else if (data.type === "ice") {
      await peers.get(from)?.addIceCandidate(data.candidate as RTCIceCandidateInit);
    } else if (data.type === "media-state") {
      useVoice.setState((s) => ({
        remoteMedia: {
          ...s.remoteMedia,
          [from]: {
            camera: data.camera === true,
            screen: data.screen === true,
            micMuted: data.micMuted === true,
          },
        },
      }));
    }
  } catch (e) {
    tracingWarn(`voice signal handling failed: ${String(e)}`);
  }
}

function tracingWarn(msg: string) {
  console.warn(msg);
}

export const useVoice = create<VoiceState>((set, get) => ({
  channels: [],
  occupants: {},
  connectedChannelId: null,
  joining: false,
  muted: false,
  speaking: new Set(),
  error: null,
  cameraOn: false,
  screenOn: false,
  stageOpen: false,
  localCamera: null,
  remoteVideo: {},
  remoteMedia: {},

  loadChannels: async (groupId) => {
    const info = await voiceApi.list(groupId);
    const occupants: Record<number, UserRef[]> = { ...get().occupants };
    for (const i of info) occupants[i.channel.id] = i.participants;
    set({ channels: info.map((i) => i.channel), occupants });
  },

  join: async (channel) => {
    const { connectedChannelId, joining } = get();
    if (joining || connectedChannelId === channel.id) return;
    set({ joining: true, error: null });
    const generation = joinGeneration;
    try {
      if (connectedChannelId !== null) {
        // Switching rooms: tear down the old mesh first (keeps the mic and
        // camera; the new room's peers get wired with the live tracks).
        for (const id of [...peers.keys()]) closePeer(id);
        stageAutoOpened = false;
      }
      const settings = loadVoiceSettings();
      // Resolves the macOS permission gate first: a WKWebView never raises
      // the system prompt on its own, so without this the call just fails.
      const stream = localStream ?? (await getMicrophoneStream(settings.inputDeviceId));
      if (generation !== joinGeneration) {
        // Cancelled while waiting on the mic prompt.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStream = stream;
      // Input volume: mic → gain → the stream peers actually receive.
      try {
        audioCtx ??= new AudioContext();
        if (audioCtx.state === "suspended") void audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(stream);
        inputGainNode = audioCtx.createGain();
        inputGainNode.gain.value = settings.inputGain;
        const destination = audioCtx.createMediaStreamDestination();
        source.connect(inputGainNode);
        inputGainNode.connect(destination);
        sendStream = destination.stream;
      } catch {
        sendStream = stream; // gain unavailable — send the raw mic
      }
      const me = myId();
      if (me !== null && sendStream) watchSpeaking(me, sendStream);
      startSpeakingLoop();

      const res = await voiceApi.join(channel.id);
      if (generation !== joinGeneration) {
        void voiceApi.leave().catch(() => {});
        return;
      }
      set({ connectedChannelId: channel.id, joining: false, muted: false });
      // The joiner initiates to everyone already present.
      for (const p of res.participants) {
        await createPeer(p.id, true);
      }
    } catch (e) {
      teardown();
      set({
        error: isCmdError(e)
          ? e.message
          : e instanceof DOMException
            ? "microphone access was denied"
            : String(e),
      });
    }
  },

  leave: async () => {
    teardown();
    await voiceApi.leave().catch(() => {});
  },

  toggleMute: () => {
    const muted = !get().muted;
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    set({ muted });
    // Peers show a muted badge on my tile; without this they only hear
    // silence and can't tell why.
    sendMediaState();
  },

  toggleCamera: async () => {
    const { connectedChannelId, cameraOn } = get();
    if (connectedChannelId === null) return;

    if (cameraOn) {
      for (const { camera } of videoSenders.values()) {
        void camera.replaceTrack(null).catch(() => {});
      }
      cameraStream?.getTracks().forEach((t) => t.stop());
      cameraStream = null;
      set({ cameraOn: false, localCamera: null });
      sendMediaState();
      return;
    }

    const generation = joinGeneration;
    try {
      const settings = loadVoiceSettings();
      const stream = await getCameraStream(settings.videoInputDeviceId, settings.videoQuality);
      if (generation !== joinGeneration || get().connectedChannelId === null) {
        // Left the room while the permission prompt was up.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      cameraStream = stream;
      const track = stream.getVideoTracks()[0];
      track.contentHint = "motion";
      for (const { camera } of videoSenders.values()) {
        void camera.replaceTrack(track).catch(() => {});
        applyVideoParams(camera, "camera");
      }
      set({ cameraOn: true, localCamera: stream, error: null });
      sendMediaState();
    } catch (e) {
      set({ error: e instanceof CameraError ? e.message : String(e) });
    }
  },

  toggleScreenShare: async () => {
    const { connectedChannelId, screenOn } = get();
    if (connectedChannelId === null || !canScreenShare()) return;

    if (screenOn) {
      for (const { screen } of videoSenders.values()) {
        void screen.replaceTrack(null).catch(() => {});
      }
      screenStream?.getTracks().forEach((t) => t.stop());
      screenStream = null;
      set({ screenOn: false });
      sendMediaState();
      return;
    }

    const generation = joinGeneration;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return; // user dismissed the OS picker — not an error
    }
    if (generation !== joinGeneration || get().connectedChannelId === null) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    screenStream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = "detail";
    // Stopping the share from the OS/browser UI ends the track directly.
    track.onended = () => {
      if (useVoice.getState().screenOn) void useVoice.getState().toggleScreenShare();
    };
    for (const { screen } of videoSenders.values()) {
      void screen.replaceTrack(track).catch(() => {});
      applyVideoParams(screen, "screen");
    }
    set({ screenOn: true });
    sendMediaState();
  },

  toggleStage: () => set((s) => ({ stageOpen: !s.stageOpen })),
}));

/** Apply voice WS events. Installed once by the chat app. */
export function installVoiceWsHandler(): () => void {
  const unsubWs = backend.onWsEvent((event) => {
    if (event.ev !== "event") return;
    const { kind, data } = event;
    const state = useVoice.getState();

    if (kind === "voice.joined") {
      const { channel_id, user } = data as { channel_id: number; user: UserRef };
      useVoice.setState((s) => {
        const room = s.occupants[channel_id] ?? [];
        if (room.some((u) => u.id === user.id)) return s;
        return { occupants: { ...s.occupants, [channel_id]: [...room, user] } };
      });
      // Existing members wait for the joiner's offer — nothing else to do.
    } else if (kind === "voice.left") {
      const { channel_id, user_id } = data as { channel_id: number; user_id: number };
      useVoice.setState((s) => ({
        occupants: {
          ...s.occupants,
          [channel_id]: (s.occupants[channel_id] ?? []).filter((u) => u.id !== user_id),
        },
      }));
      if (state.connectedChannelId === channel_id && user_id !== myId()) {
        closePeer(user_id);
      }
    } else if (kind === "voice.signal") {
      const { channel_id, from, data: payload } = data as {
        channel_id: number;
        from: number;
        data: Record<string, unknown>;
      };
      if (channel_id === state.connectedChannelId) void handleSignal(from, payload);
    } else if (kind === "voice.channel.created") {
      const channel = data as VoiceChannel;
      useVoice.setState((s) =>
        s.channels.some((c) => c.id === channel.id)
          ? s
          : { channels: [...s.channels, channel] },
      );
    } else if (kind === "voice.channel.deleted") {
      const { channel_id } = data as { channel_id: number };
      if (state.connectedChannelId === channel_id) teardown();
      useVoice.setState((s) => ({
        channels: s.channels.filter((c) => c.id !== channel_id),
      }));
    }
  });

  // Logging out (or losing the session) kills the mic and the mesh.
  const unsubSession = useSession.subscribe((s) => {
    if (s.phase !== "connected" && useVoice.getState().connectedChannelId !== null) {
      teardown();
    }
  });

  return () => {
    unsubWs();
    unsubSession();
  };
}
