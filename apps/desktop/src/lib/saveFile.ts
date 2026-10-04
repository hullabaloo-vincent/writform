/**
 * The one way an export reaches the user's disk. Desktop asks with the native
 * Save panel, iOS drops the file where the Files app shows it, the web
 * downloads — and every outcome ends in the same kind of toast.
 */

import { toast } from "../platform/toast";
import { backend, isMobileApp, SAVE_MIME, type SaveKind, type SaveResult } from "./backend";

const isMac = /Mac/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);

/** Save `bytes` as `fileName`; resolves to the outcome (cancel is not an
 *  error). Shows the confirmation toast itself. */
export async function saveExport(
  fileName: string,
  kind: SaveKind,
  bytes: Uint8Array,
  options: { note?: string } = {},
): Promise<SaveResult> {
  const result = await backend.saveFile(fileName, kind, bytes);
  if (result.status !== "saved") return result;

  const shown = result.path ? baseName(result.path) : fileName;
  const message = `Saved “${shown}”${result.location ? ` to ${result.location}` : ""}${
    options.note ? ` — ${options.note}` : ""
  }`;

  if (result.revealable && result.path) {
    const path = result.path;
    toast(message, "success", {
      action: {
        label: isMac ? "Show in Finder" : "Show in Folder",
        run: () =>
          void import("@tauri-apps/plugin-opener")
            .then(({ revealItemInDir }) => revealItemInDir(path))
            .catch(() => {}),
      },
    });
  } else if (isMobileApp && canShareFile(fileName, kind, bytes)) {
    // The share sheet must open from a tap, so it rides the toast's button.
    toast(message, "success", {
      action: {
        label: "Share…",
        run: () => {
          const file = new File([bytes as BlobPart], shown, { type: SAVE_MIME[kind] });
          void navigator.share({ files: [file] }).catch(() => {});
        },
      },
    });
  } else {
    toast(message, "success");
  }
  return result;
}

function canShareFile(fileName: string, kind: SaveKind, bytes: Uint8Array): boolean {
  try {
    const file = new File([bytes as BlobPart], fileName, { type: SAVE_MIME[kind] });
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
