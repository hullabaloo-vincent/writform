/**
 * Camera access, with the macOS gate handled up front.
 *
 * Same shape as microphone.ts: a WKWebView will not raise the system camera
 * prompt by itself, so the Rust core asks AVFoundation first, which shows the
 * real prompt and records the grant. Everything degrades to plain
 * `getUserMedia` on other platforms and in the browser dev preview.
 */

import { backend } from "./backend";
import type { VideoQuality } from "./voiceSettings";

export class CameraError extends Error {
  constructor(
    message: string,
    /** True when the user must change this in OS settings, not in-app. */
    readonly needsSystemSettings: boolean,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

const DENIED_MESSAGE =
  "WritForm doesn't have camera access. Open System Settings → Privacy & Security → Camera and enable WritForm, then try again.";
const RESTRICTED_MESSAGE =
  "Camera access is blocked by a device policy (Screen Time or an MDM profile), so video can't be used on this Mac.";
const NO_DEVICE_MESSAGE = "No camera was found. Connect one and try again.";

/** Authorization state without prompting — for showing status in settings. */
export async function cameraStatus(): Promise<string> {
  try {
    return await backend.cameraStatus();
  } catch {
    return "unknown";
  }
}

/**
 * Ensure the OS-level grant exists, prompting once if the user has not
 * decided. Throws a `CameraError` with actionable wording otherwise.
 */
export async function ensureCameraAccess(): Promise<void> {
  let status: string;
  try {
    status = await backend.cameraStatus();
  } catch {
    return; // No native gate available; let getUserMedia do the asking.
  }

  if (status === "not_determined") {
    // Shows the system prompt and resolves once the user answers.
    status = await backend.requestCameraAccess().catch(() => "unknown");
  }

  if (status === "denied") throw new CameraError(DENIED_MESSAGE, true);
  if (status === "restricted") throw new CameraError(RESTRICTED_MESSAGE, true);
}

/** Capture constraints per quality tier (16:9, 30fps). */
function videoConstraints(deviceId: string | null | undefined, quality: VideoQuality) {
  const size =
    quality === "720p"
      ? { width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 640 }, height: { ideal: 360 } };
  return {
    ...size,
    frameRate: { ideal: 30, max: 30 },
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

/**
 * `getUserMedia` for the camera with the OS grant resolved first and browser
 * rejections translated into messages that say what to actually do.
 */
export async function getCameraStream(
  deviceId: string | null | undefined,
  quality: VideoQuality,
): Promise<MediaStream> {
  await ensureCameraAccess();
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(deviceId, quality),
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new CameraError(DENIED_MESSAGE, true);
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new CameraError(NO_DEVICE_MESSAGE, false);
    }
    throw new CameraError(`Could not open the camera${name ? ` (${name})` : ""}.`, false);
  }
}
