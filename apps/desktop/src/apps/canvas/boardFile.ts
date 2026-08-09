/**
 * Native board files (`.wfboard`) and the plumbing every board import
 * shares. A .wfboard is a ZIP: `board.json` holds the board's name, style
 * (pages, backgrounds) and elements with ids rewritten to ordinals; `media/n`
 * holds the raw bytes of every referenced picture. The format is
 * self-contained, so a board round-trips between servers, between accounts,
 * and between a group and "on this device" — which also makes it the way to
 * publish a local board to a group.
 */

import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import { backend, isWeb } from "../../lib/backend";
import { uploadBlob } from "../../lib/upload";
import { b64encode } from "../documents/collab";
import { canvasApi } from "./api";
import {
  activeLocalBoard,
  closeLocalBoard,
  imageSrc,
  openLocalBoard,
  saveLocalImage,
  useLocalBoards,
} from "./local";

/* ------------------------------------------------- shared import plumbing */

export type ImportDest = { kind: "group"; groupId: number } | { kind: "local" };

export interface ImportProgress {
  label: string;
  done: number;
  total: number;
}

export interface ImportResult {
  boardId: number;
  /** Human note about what didn't survive ("3 images skipped"), if anything. */
  notice: string | null;
}

/** Thrown (by reference) when the user cancels; dialogs swallow it. */
export const IMPORT_CANCELLED = { code: "cancelled", message: "Import cancelled" };

export const isCancelled = (e: unknown): boolean =>
  e === IMPORT_CANCELLED || (e as { code?: string } | null)?.code === "cancelled";

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw IMPORT_CANCELLED;
}

/** Create the destination board. Local boards also open a headless session —
 *  element writes route through the open session, and going through the
 *  store's openBoard would swap the UI to the board mid-import. */
export async function createDestBoard(dest: ImportDest, name: string): Promise<number> {
  const clean = name.trim().slice(0, 120) || "Imported board";
  if (dest.kind === "group") return (await canvasApi.createBoard(dest.groupId, clean)).id;
  const id = await useLocalBoards.getState().create(clean);
  await openLocalBoard(id);
  return id;
}

/** Store one picture for the destination; returns the element `text` ref. */
export async function saveMediaFor(dest: ImportDest, blob: Blob, name: string): Promise<string> {
  if (dest.kind === "local") return saveLocalImage(blob);
  return String((await uploadBlob(blob, name)).id);
}

/** A local import dies cleanly if its session was displaced mid-way. */
export function guardDest(dest: ImportDest, boardId: number): void {
  if (dest.kind === "local" && activeLocalBoard()?.id !== boardId) {
    throw { code: "interrupted", message: "the board was closed while importing" };
  }
}

export async function finishDest(dest: ImportDest): Promise<void> {
  if (dest.kind === "local") {
    await closeLocalBoard(); // guaranteed flush
    await useLocalBoards.getState().load();
  }
}

/** Best-effort removal of a partially imported board (routes local/server). */
export async function abandonBoard(boardId: number): Promise<void> {
  await canvasApi.deleteBoard(boardId).catch(() => {});
}

/** Bounded-concurrency map that keeps result order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Server-side ceilings the importers must respect. */
export const MAX_BOARD_ELEMENTS = 2000;
const MAX_SERVER_MEDIA = 9_800_000; // headroom under the 10 MiB attachment cap
const MAX_LOCAL_MEDIA = 24 * 1024 * 1024;

export const mediaByteLimit = (dest: ImportDest): number =>
  dest.kind === "local" ? MAX_LOCAL_MEDIA : MAX_SERVER_MEDIA;

/* ---------------------------------------------------------- file format */

const FORMAT = "subscribe-board";
const MEDIA_REF = /^media:(\d+)$/;

interface BoardFileElement {
  kind: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  text: string;
  color: string;
  style: string;
  /** Ordinals into `elements`, for connectors. */
  from: number | null;
  to: number | null;
}

interface BoardFileJson {
  format: typeof FORMAT;
  version: 1;
  name: string;
  /** The board's style column verbatim, with media refs rewritten. */
  style: string;
  elements: BoardFileElement[];
  /** Zip paths, index = media ordinal referenced as `media:<i>`. */
  media: string[];
}

/** Board style is opaque JSON to the server; we only care where images hide. */
interface StyleWithImages {
  image?: number | string;
  pages?: { bg?: { image?: number | string } }[];
  [key: string]: unknown;
}

function parseStyle(raw: string): StyleWithImages | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StyleWithImages;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Walk every image slot in a style object (top-level + per-page). */
type StyleImageSlot = {
  get: () => number | string | undefined;
  set: (v: number | string | undefined) => void;
};

function styleImageSlots(style: StyleWithImages): StyleImageSlot[] {
  const slots: StyleImageSlot[] = [
    {
      get: () => style.image,
      set: (v) => {
        style.image = v;
      },
    },
  ];
  for (const page of style.pages ?? []) {
    if (!page || typeof page !== "object") continue;
    slots.push({
      get: () => page.bg?.image,
      set: (v) => {
        if (page.bg) page.bg.image = v;
      },
    });
  }
  return slots;
}

/* --------------------------------------------------------------- export */

export interface BoardExportResult {
  fileName: string;
  where: string;
  skippedMedia: number;
}

const sanitizeFileName = (name: string): string =>
  name.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 80) || "board";

/**
 * Export a board the caller already has in memory (BoardRoom's store state —
 * fetching detail for a local board would reopen its session under the live
 * view). Media are fetched through the same URLs the <img> tags use.
 */
export async function exportBoard(
  board: CanvasBoard,
  elements: CanvasElement[],
): Promise<BoardExportResult> {
  const { default: JSZip } = await import("jszip");

  // Every picture the board references, deduped: element images + backgrounds.
  const refs = new Map<string, number>();
  const addRef = (ref: string) => {
    if (!refs.has(ref)) refs.set(ref, refs.size);
  };
  for (const el of elements) if (el.kind === "image" && el.text) addRef(el.text);
  const style = parseStyle(board.style);
  if (style) {
    for (const slot of styleImageSlots(style)) {
      const v = slot.get();
      if (v !== undefined && v !== null && v !== "") addRef(String(v));
    }
  }

  // Fetch bytes; a failure skips that picture rather than the whole export.
  const blobs = new Map<string, Blob>();
  await pool([...refs.keys()], 3, async (ref) => {
    try {
      const res = await fetch(imageSrc({ text: ref }));
      if (res.ok) blobs.set(ref, await res.blob());
    } catch {
      // unreachable media — counted below
    }
  });
  const skippedMedia = refs.size - blobs.size;

  // Ordinals only for media that actually made it into the file.
  const mediaOrdinal = new Map<string, number>();
  for (const ref of refs.keys()) {
    if (blobs.has(ref)) mediaOrdinal.set(ref, mediaOrdinal.size);
  }

  // Elements whose picture failed are left out; connectors follow their ends.
  const kept = elements.filter(
    (el) => el.kind !== "image" || (el.text !== "" && mediaOrdinal.has(el.text)),
  );
  const keptIds = new Set(kept.map((el) => el.id));
  const final = kept.filter(
    (el) =>
      el.kind !== "connector" ||
      (el.from_id !== null && el.to_id !== null && keptIds.has(el.from_id) && keptIds.has(el.to_id)),
  );
  const ordinalOf = new Map(final.map((el, i) => [el.id, i]));

  const fileElements: BoardFileElement[] = final.map((el) => ({
    kind: el.kind,
    page: el.page ?? 0,
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    z: el.z,
    text:
      el.kind === "image" ? `media:${mediaOrdinal.get(el.text)}` : el.text,
    color: el.color,
    style: el.style,
    from: el.from_id === null ? null : (ordinalOf.get(el.from_id) ?? null),
    to: el.to_id === null ? null : (ordinalOf.get(el.to_id) ?? null),
  }));

  if (style) {
    for (const slot of styleImageSlots(style)) {
      const v = slot.get();
      if (v === undefined || v === null || v === "") continue;
      const ordinal = mediaOrdinal.get(String(v));
      slot.set(ordinal === undefined ? undefined : `media:${ordinal}`);
    }
  }

  const json: BoardFileJson = {
    format: FORMAT,
    version: 1,
    name: board.name,
    style: style ? JSON.stringify(style) : "",
    elements: fileElements,
    media: [...mediaOrdinal.values()].map((n) => `media/${n}`),
  };

  const zip = new JSZip();
  zip.file("board.json", JSON.stringify(json));
  for (const [ref, ordinal] of mediaOrdinal) {
    const blob = blobs.get(ref);
    if (blob) zip.file(`media/${ordinal}`, blob);
  }

  const bytes = await zip.generateAsync({ type: "uint8array" });
  const fileName = `${sanitizeFileName(board.name)}.wfboard`;
  const where = await backend.saveExport(fileName, b64encode(bytes));
  return { fileName, where, skippedMedia };
}

/* --------------------------------------------------------------- import */

export async function importBoardFile(
  file: File,
  dest: ImportDest,
  onProgress: (p: ImportProgress) => void,
  signal: AbortSignal,
): Promise<ImportResult> {
  const { default: JSZip } = await import("jszip");
  onProgress({ label: "Reading board file", done: 0, total: 1 });

  const zip = await JSZip.loadAsync(await file.arrayBuffer()).catch(() => {
    throw { code: "bad_file", message: "That file doesn't look like a board file." };
  });
  const entry = zip.file("board.json");
  if (!entry) throw { code: "bad_file", message: "That file isn't a subScribe board." };
  let json: BoardFileJson;
  try {
    json = JSON.parse(await entry.async("string")) as BoardFileJson;
  } catch {
    throw { code: "bad_file", message: "That board file is damaged." };
  }
  if (json.format !== FORMAT || json.version !== 1 || !Array.isArray(json.elements)) {
    throw { code: "bad_file", message: "That board file is from an unsupported version." };
  }
  if (json.elements.length > MAX_BOARD_ELEMENTS) {
    throw { code: "too_big", message: `Boards hold at most ${MAX_BOARD_ELEMENTS} elements.` };
  }
  throwIfAborted(signal);

  // Media out of the zip first — all parse-stage, nothing to clean up yet.
  const mediaBlobs: (Blob | null)[] = await pool(json.media ?? [], 3, async (path) => {
    const f = zip.file(path);
    return f ? await f.async("blob") : null;
  });
  throwIfAborted(signal);

  const name = json.name || file.name.replace(/\.wfboard$/i, "");
  const boardId = await createDestBoard(dest, name);
  let skipped = 0;

  try {
    // Store the pictures, then translate `media:<n>` to the new refs.
    const limit = mediaByteLimit(dest);
    const mediaRefs: (string | null)[] = await pool(mediaBlobs, 3, async (blob, i) => {
      throwIfAborted(signal);
      if (!blob || blob.size === 0 || blob.size > limit) return null;
      guardDest(dest, boardId);
      onProgress({ label: "Storing images", done: i, total: mediaBlobs.length });
      return saveMediaFor(dest, blob, `board-media-${i}.png`);
    });
    const resolveMedia = (text: string): string | null => {
      const m = MEDIA_REF.exec(text);
      if (!m) return null;
      return mediaRefs[Number(m[1])] ?? null;
    };

    // Board style (pages, backgrounds) with its media refs translated.
    const style = parseStyle(json.style);
    if (style) {
      for (const slot of styleImageSlots(style)) {
        const v = slot.get();
        if (v === undefined || v === null || v === "") continue;
        const ref = resolveMedia(String(v));
        slot.set(ref === null ? undefined : /^\d+$/.test(ref) ? Number(ref) : ref);
      }
      throwIfAborted(signal);
      guardDest(dest, boardId);
      await canvasApi.updateBoard(boardId, JSON.stringify(style));
    }

    // Creation order becomes z: bodies by original z, then connectors.
    const ordered = json.elements
      .map((el, ordinal) => ({ el, ordinal }))
      .sort((a, b) => (a.el.z ?? 0) - (b.el.z ?? 0) || a.ordinal - b.ordinal);
    const bodies = ordered.filter(({ el }) => el.kind !== "connector");
    const connectors = ordered.filter(({ el }) => el.kind === "connector");
    const newIds = new Map<number, number>();
    const total = bodies.length + connectors.length;
    let done = 0;

    for (const { el, ordinal } of bodies) {
      throwIfAborted(signal);
      guardDest(dest, boardId);
      onProgress({ label: "Placing elements", done: done++, total });
      let text = el.text;
      if (el.kind === "image") {
        const ref = resolveMedia(el.text);
        if (ref === null) {
          skipped += 1;
          continue;
        }
        text = ref;
      }
      const made = await canvasApi.createElement(boardId, {
        kind: el.kind,
        page: el.page ?? 0,
        x: el.x,
        y: el.y,
        w: el.w,
        h: el.h,
        text,
        color: el.color ?? "",
        style: el.style ?? "",
        from_id: null,
        to_id: null,
      });
      newIds.set(ordinal, made.id);
    }

    for (const { el } of connectors) {
      throwIfAborted(signal);
      guardDest(dest, boardId);
      onProgress({ label: "Placing elements", done: done++, total });
      const from = el.from === null ? undefined : newIds.get(el.from);
      const to = el.to === null ? undefined : newIds.get(el.to);
      if (from === undefined || to === undefined) {
        skipped += 1;
        continue;
      }
      await canvasApi.createElement(boardId, {
        kind: "connector",
        page: el.page ?? 0,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        text: el.text,
        color: el.color ?? "",
        style: el.style ?? "",
        from_id: from,
        to_id: to,
      });
    }

    await finishDest(dest);
    return {
      boardId,
      notice: skipped > 0 ? `${skipped} item${skipped === 1 ? "" : "s"} couldn't be imported` : null,
    };
  } catch (e) {
    await abandonBoard(boardId);
    throw e;
  }
}

/** Web clients import .wfboard only; PDFs need the desktop app. */
export const canImportPdf = !isWeb;
