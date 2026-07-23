/**
 * Microphone access, with the macOS gate handled up front.
 *
 * A WKWebView will not raise the system microphone prompt by itself, so on a
 * fresh macOS install `getUserMedia` simply rejects and the user never sees
 * anything — voice looks broken rather than blocked. The Rust core asks
 * AVFoundation first, which shows the real prompt and records the grant.
 *
 * Everything here degrades to plain `getUserMedia` on other platforms and in
 * the browser dev preview, where the engine does its own prompting.
 */

import { backend } from "./backend";

export class MicrophoneError extends Error {
  constructor(
    message: string,
    /** True when the user must change this in OS settings, not in-app. */
    readonly needsSystemSettings: boolean,
  ) {
    super(message);
    this.name = "MicrophoneError";
  }
}

const DENIED_MESSAGE =
  "subScribe doesn't have microphone access. Open System Settings → Privacy & Security → Microphone and enable subScribe, then try again.";
const RESTRICTED_MESSAGE =
  "Microphone access is blocked by a device policy (Screen Time or an MDM profile), so voice can't be used on this Mac.";
const NO_DEVICE_MESSAGE = "No microphone was found. Connect one and try again.";

/** Authorization state without prompting — for showing status in settings. */
export async function microphoneStatus(): Promise<string> {
  try {
    return await backend.microphoneStatus();
  } catch {
    return "unknown";
  }
}

/**
 * Ensure the OS-level grant exists, prompting once if the user has not
 * decided. Throws a `MicrophoneError` with actionable wording otherwise.
 */
export async function ensureMicrophoneAccess(): Promise<void> {
  let status: string;
  try {
    status = await backend.microphoneStatus();
  } catch {
    return; // No native gate available; let getUserMedia do the asking.
  }

  if (status === "not_determined") {
    // Shows the system prompt and resolves once the user answers.
    status = await backend.requestMicrophoneAccess().catch(() => "unknown");
  }

  if (status === "denied") throw new MicrophoneError(DENIED_MESSAGE, true);
  if (status === "restricted") throw new MicrophoneError(RESTRICTED_MESSAGE, true);
}

/**
 * `getUserMedia` with the OS grant resolved first and browser rejections
 * translated into messages that say what to actually do about them.
 */
export async function getMicrophoneStream(deviceId?: string | null): Promise<MediaStream> {
  await ensureMicrophoneAccess();
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneError(DENIED_MESSAGE, true);
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new MicrophoneError(NO_DEVICE_MESSAGE, false);
    }
    throw new MicrophoneError(
      `Could not open the microphone${name ? ` (${name})` : ""}.`,
      false,
    );
  }
}
