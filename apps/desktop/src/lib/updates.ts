/** Desktop auto-update plumbing, shared by Settings → Application (manual
 *  check + install) and the once-per-launch background check. */

export interface AvailableUpdate {
  version: string;
  /** Release notes markdown from the GitHub release body, if any. */
  body: string | null;
  downloadAndInstall: () => Promise<void>;
}

const inTauri = "__TAURI_INTERNALS__" in window;

/** Look for a newer release; null = up to date (or not the desktop app). */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!inTauri) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    body: update.body ?? null,
    downloadAndInstall: () => update.downloadAndInstall(),
  };
}

let announced = false;

/** Once per app run: a quiet heads-up when an update is waiting. Installing
 *  stays a deliberate act in Settings — nothing downloads by itself. */
export async function announceUpdateOnLaunch(): Promise<void> {
  if (announced || !inTauri) return;
  announced = true;
  try {
    const update = await checkForUpdate();
    if (!update) return;
    const { toast } = await import("../platform");
    toast(`subScribe ${update.version} is available — install it from Settings → Application.`);
  } catch {
    // Launch checks are best-effort; the manual check surfaces errors.
  }
}
