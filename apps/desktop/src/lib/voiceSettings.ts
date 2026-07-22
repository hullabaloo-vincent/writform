/**
 * Voice device/volume preferences, persisted locally and applied live by the
 * voice mesh (input gain, output volume) or on the next join (input device).
 */

export type VideoQuality = "360p" | "720p";

export interface VoiceSettings {
  /** Preferred microphone deviceId; null = system default. */
  inputDeviceId: string | null;
  /** Microphone gain multiplier, 0..2 (1 = unchanged). */
  inputGain: number;
  /** Playback volume for other participants, 0..1. */
  outputVolume: number;
  /** Preferred camera deviceId; null = system default. */
  videoInputDeviceId: string | null;
  /** Camera capture quality; applies the next time the camera starts. */
  videoQuality: VideoQuality;
}

const KEY = "wf-voice-settings";
const DEFAULTS: VoiceSettings = {
  inputDeviceId: null,
  inputGain: 1,
  outputVolume: 1,
  videoInputDeviceId: null,
  videoQuality: "360p",
};

const listeners = new Set<(s: VoiceSettings) => void>();

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      inputDeviceId: typeof parsed.inputDeviceId === "string" ? parsed.inputDeviceId : null,
      inputGain: clamp(parsed.inputGain, 0, 2, 1),
      outputVolume: clamp(parsed.outputVolume, 0, 1, 1),
      videoInputDeviceId:
        typeof parsed.videoInputDeviceId === "string" ? parsed.videoInputDeviceId : null,
      videoQuality: parsed.videoQuality === "720p" ? "720p" : "360p",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full/blocked — settings still apply for this session
  }
  for (const cb of [...listeners]) cb(settings);
}

/** Subscribe to changes (for live gain/volume updates); returns unsubscribe. */
export function onVoiceSettingsChange(cb: (s: VoiceSettings) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}
