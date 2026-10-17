/**
 * Everything on this device, in one zip: your documents (as Word, with
 * their pictures, and as lossless JSON), your boards (with their pictures),
 * your notes (the Markdown files they already are) and your profile. For a
 * backup, for moving to another machine, or simply for knowing that nothing
 * here is locked in.
 */

import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import type { JSONContent } from "@tiptap/core";
import * as Y from "yjs";

import { attProtocolUrl, backend, localProfileImageUrl, type SaveResult } from "../../lib/backend";
import { saveExport } from "../../lib/saveFile";
import { b64decode } from "../documents/collab";
import { readDocStyles } from "../../editor/styles/docStyles";
import { readDocSettings } from "../documents/docSettings";
import { encodeAutoCorrect, useAutoCorrect } from "../../editor/autocorrect/store";
import { encodeRulesFile, RULES_FILE_EXT } from "../../proof/rules/file";
import { globalRules } from "../../proof/rules/globalRules";

export interface DeviceExportSummary {
  result: SaveResult;
  documents: number;
  boards: number;
  notes: number;
  /** Things that couldn't be read and were left out. */
  skipped: number;
}

const sanitize = (name: string): string =>
  name
    .replace(/[/\\:*?"<>|\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Untitled";

export async function exportDevice(onProgress: (message: string) => void = () => {}): Promise<DeviceExportSummary> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  const unique = (path: string, ext: string): string => {
    let candidate = `${path}.${ext}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${path} (${n}).${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
  let skipped = 0;

  // ---- documents
  const docs = await backend.localdocList().catch(() => []);
  let documents = 0;
  // Folders become folders in the zip.
  const folderNames = new Map<string, string>();
  const placeOf = new Map<string, string>();
  try {
    const raw = await backend.localdocFoldersRead();
    const file = (raw ? JSON.parse(raw) : {}) as { folders?: { id: string; name: string }[]; docs?: Record<string, string> };
    for (const f of file.folders ?? []) folderNames.set(f.id, f.name);
    for (const [doc, folder] of Object.entries(file.docs ?? {})) placeOf.set(doc, folder);
  } catch {
    // Without them the documents are still all there, side by side.
  }
  if (docs.length) {
    const { buildDocx } = await import("../documents/export");
    for (const meta of docs) {
      onProgress(`Documents: ${meta.title || "Untitled"}`);
      const ydoc = new Y.Doc();
      try {
        const file = JSON.parse(await backend.localdocRead(meta.id)) as { state_b64?: string };
        if (file.state_b64) Y.applyUpdate(ydoc, b64decode(file.state_b64));
        const json = yDocToProsemirrorJSON(ydoc, "default") as JSONContent;
        const folder = folderNames.get(placeOf.get(meta.id) ?? "");
        const base = `Documents/${folder ? `${sanitize(folder)}/` : ""}${sanitize(meta.title)}`;
        const settings = meta.format === "none" ? readDocSettings(ydoc) : undefined;
        const word = await buildDocx(json, meta.title || "Untitled", meta.format, settings, readDocStyles(ydoc));
        zip.file(unique(base, "docx"), word.bytes);
        zip.file(unique(base, "json"), JSON.stringify({ title: meta.title, format: meta.format, content: json }, null, 2));
        documents += 1;
      } catch {
        skipped += 1;
      } finally {
        ydoc.destroy();
      }
    }
  }

  // ---- boards, and the pictures on them
  const boards = await backend.localboardList().catch(() => []);
  let boardCount = 0;
  const media = new Set<string>();
  for (const meta of boards) {
    onProgress(`Boards: ${meta.name}`);
    try {
      const raw = await backend.localboardRead(meta.id);
      zip.file(unique(`Boards/${sanitize(meta.name)}`, "json"), raw);
      for (const match of raw.matchAll(/local:([0-9a-fA-F-]{6,64})/g)) media.add(match[1]);
      boardCount += 1;
    } catch {
      skipped += 1;
    }
  }
  for (const id of media) {
    try {
      const res = await fetch(attProtocolUrl(`localboard/${id}`));
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace("svg+xml", "svg");
      zip.file(`Boards/pictures/${id}.${ext}`, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      skipped += 1;
    }
  }

  // ---- notes
  const notes = await backend.vaultList().catch(() => []);
  let noteCount = 0;
  for (const note of notes) {
    try {
      // In their folders, as in the vault.
      zip.file(unique(`Notes/${note.name.split("/").map(sanitize).join("/")}`, "md"), await backend.vaultRead(note.name));
      noteCount += 1;
    } catch {
      skipped += 1;
    }
  }

  // ---- you
  const profile = await backend.profileGet().catch(() => null);
  if (profile) {
    zip.file("profile.json", JSON.stringify({ display_name: profile.display_name, accent_color: profile.accent_color, bio: profile.bio }, null, 2));
    // Your picture and banner, when you've set them.
    for (const kind of ["avatar", "banner"] as const) {
      if (!(kind === "avatar" ? profile.avatar_path : profile.banner_path)) continue;
      try {
        const res = await fetch(localProfileImageUrl(kind, profile.saved_at));
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const ext = (blob.type.split("/")[1] ?? "bin").replace("jpeg", "jpg");
        zip.file(`profile-${kind}.${ext}`, new Uint8Array(await blob.arrayBuffer()));
      } catch {
        skipped += 1;
      }
    }
  }

  // ---- your rules for the Check panel
  const rules = globalRules();
  const hasRules = Object.keys(rules.words).length + Object.keys(rules.on).length + Object.keys(rules.never).length + Object.keys(rules.picks).length > 0;
  if (hasRules) zip.file(`rules.${RULES_FILE_EXT}`, encodeRulesFile(rules, "My rules"));
  // The writer's own corrections, when they have made the list their own.
  const corrections = useAutoCorrect.getState();
  if (Object.keys(corrections.add).length || corrections.drop.length || corrections.noCapAfter.length || corrections.keepCaps.length) zip.file("autocorrect.json", encodeAutoCorrect());

  zip.file(
    "README.txt",
    [
      "A subScribe export of everything on this device.",
      "",
      "Documents/  each document as Word (.docx, with its pictures) and as .json",
      "            (the editor's own format, which keeps everything), in the",
      "            folder it is in on this device.",
      "Boards/     each board as .json (the app's board file). The pictures on",
      "            them are in Boards/pictures, named by the id the board uses.",
      "Notes/      your notes as the Markdown files they are.",
      "profile.json  your name and look on this device (with your picture and",
      "              banner beside it, if you've set them).",
      "rules.wfstyle  your own rules for the Check panel, if you have any. Add",
      "               them on another device from the panel's Rules tab.",
      "autocorrect.json  your own corrections for typing, if you have changed the",
      "                  built-in list.",
      "",
      "Documents and boards kept on a server are not in here: export those from",
      "Documents ▸ Export all, or a board's Export, while connected.",
      "",
    ].join("\n"),
  );

  onProgress("Writing the file…");
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const result = await saveExport(`subScribe (this device) ${stamp}.zip`, "zip", bytes);
  return { result, documents, boards: boardCount, notes: noteCount, skipped };
}
