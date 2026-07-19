import { create } from "zustand";

import type { UserRef } from "../../bindings/proto/UserRef";
import type { VoiceChannel } from "../../bindings/proto/VoiceChannel";
import type { VoiceChannelInfo } from "../../bindings/proto/VoiceChannelInfo";
import type { VoiceJoinResponse } from "../../bindings/proto/VoiceJoinResponse";
import { backend, isCmdError, type CmdError } from "../../lib/backend";
import { useSession } from "../../stores/session";

/**
 * Voice: audio-only WebRTC mesh. The server relays signaling and tracks who
 * is in which room; audio flows directly between peers (DTLS-SRTP).
 *
 * Topology: the JOINER initiates a peer connection to every member already
 * in the room (learned from the join response); existing members never
 * initiate, so there is no offer glare.
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

  loadChannels: (groupId: number) => Promise<void>;
  join: (channel: VoiceChannel) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// --- mesh internals (module state, not react state) ---
const peers = new Map<number, RTCPeerConnection>();
const audioEls = new Map<number, HTMLAudioElement>();
const analysers = new Map<number, AnalyserNode>();
let localStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let speakingTimer: ReturnType<typeof setInterval> | null = null;

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
  el.srcObject = stream;
  void el.play().catch(() => {});
  watchSpeaking(peerId, stream);
}

function sendSignal(peerId: number, data: unknown) {
  const channelId = useVoice.getState().connectedChannelId;
  if (channelId === null) return;
  void voiceApi.signal(channelId, peerId, data).catch(() => {});
}

async function createPeer(peerId: number, initiator: boolean): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(peerId, pc);
  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { type: "ice", candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    if (e.streams[0]) attachAudio(peerId, e.streams[0]);
  };
  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peerId, { type: "offer", sdp: { type: offer.type, sdp: offer.sdp } });
  }
  return pc;
}

function closePeer(peerId: number) {
  peers.get(peerId)?.close();
  peers.delete(peerId);
  const el = audioEls.get(peerId);
  if (el) {
    el.srcObject = null;
    audioEls.delete(peerId);
  }
  analysers.delete(peerId);
}

/// Bumped on every teardown so an in-flight join (e.g. a mic-permission
/// prompt the user never answered) aborts instead of resurrecting the room.
let joinGeneration = 0;

function teardown() {
  joinGeneration += 1;
  for (const id of [...peers.keys()]) closePeer(id);
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  analysers.clear();
  if (speakingTimer) {
    clearInterval(speakingTimer);
    speakingTimer = null;
  }
  useVoice.setState({
    connectedChannelId: null,
    joining: false,
    muted: false,
    speaking: new Set(),
  });
}

async function handleSignal(from: number, data: Record<string, unknown>) {
  try {
    if (data.type === "offer") {
      const pc = peers.get(from) ?? (await createPeer(from, false));
      await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { type: "answer", sdp: { type: answer.type, sdp: answer.sdp } });
    } else if (data.type === "answer") {
      await peers.get(from)?.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
    } else if (data.type === "ice") {
      await peers.get(from)?.addIceCandidate(data.candidate as RTCIceCandidateInit);
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
        // Switching rooms: tear down the old mesh first (keeps the mic).
        for (const id of [...peers.keys()]) closePeer(id);
      }
      const stream =
        localStream ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
      if (generation !== joinGeneration) {
        // Cancelled while waiting on the mic prompt.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStream = stream;
      const me = myId();
      if (me !== null) watchSpeaking(me, localStream);
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
  },
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
