/**
 * Canvas boards stored on this device: single-user, no server involved. One
 * JSON file per board via the `localboard_*` commands, holding the whole
 * element list — a board is text, geometry and colors, so full-file debounced
 * saves are both simpler and lossless. No WS, no cursors, no sharing.
 *
 * Local boards carry NEGATIVE ids, which can never collide with a server
 * board's, and `canvasApi` routes on that sign. Everything above this layer —
 * the canvas store, BoardRoom, its undo/redo — cannot tell the difference and
 * needs no changes. Element ids are per-board counters, safe because exactly
 * one board is open at a time.
 */

import { create } from "zustand";

import type { BoardDetail } from "../../bindings/proto/BoardDetail";
import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import type { CreateElementRequest } from "../../bindings/proto/CreateElementRequest";
import type { UpdateElementRequest } from "../../bindings/proto/UpdateElementRequest";
import type { UserRef } from "../../bindings/proto/UserRef";
import { attachmentUrl, attProtocolUrl, backend, isCmdError } from "../../lib/backend";
import { toast, toastError } from "../../platform/toast";
import { useLocalProfile } from "../../stores/localProfile";

const SAVE_MS = 600;

/** The author of boards that never leave this device: you, by the name and
 *  colour this device knows you by. */
function localUser(): UserRef {
  const { name, accent } = useLocalProfile.getState();
  return {
    id: 0,
    username: "you",
    display_name: name || "You",
    avatar_attachment_id: null,
    accent_color: accent,
  };
}

interface LocalBoardFile {
  id: number;
  name: string;
  /** Background JSON, same shape a server board stores. */
  style: string;
  created_at: number;
  next_element_id: number;
  elements: CanvasElement[];
}

export interface LocalBoardMeta {
  id: number;
  name: string;
  updated_at: number;
}

export const isLocalBoard = (boardId: number): boolean => boardId < 0;

/** Marks an image element whose picture lives on this device. Everywhere
 *  else an image element's `text` is a server attachment id. */
const LOCAL_MEDIA = "local:";

/**
 * Store a pasted picture beside its board and return the reference to put in
 * the element. Bytes go across as an ArrayBuffer and land on disk unchanged —
 * nothing is base64-encoded, in transit or at rest.
 */
export async function saveLocalImage(blob: Blob): Promise<string> {
  const mediaId = crypto.randomUUID();
  await backend.localmediaWrite(mediaId, await blob.arrayBuffer());
  return `${LOCAL_MEDIA}${mediaId}`;
}

/** Where an image element's picture comes from: a file on this device, or a
 *  server attachment. */
export function imageSrc(el: { text: string }): string {
  if (el.text.startsWith(LOCAL_MEDIA)) {
    return attProtocolUrl(`localboard/${el.text.slice(LOCAL_MEDIA.length)}`);
  }
  return attachmentUrl(Number(el.text));
}

/**
 * Delete stored pictures nothing points at any more. Runs after a board is
 * deleted — the media store is shared, so which files are still wanted can
 * only be answered by reading every remaining board.
 */
async function pruneMedia(): Promise<void> {
  // Anything the open board just added is only in memory until it flushes.
  await session?.flush();
  const boards = await backend.localboardList();
  const keep = new Set<string>();
  const note = (raw: string) => {
    for (const match of raw.matchAll(/local:([0-9a-fA-F-]{6,64})/g)) keep.add(match[1]);
  };
  for (const meta of boards) note(await backend.localboardRead(meta.id).catch(() => ""));
  // A board in Recently Deleted can come back: its pictures wait with it.
  const trashed = await backend.localboardTrashList();
  for (const meta of trashed) {
    const raw = await backend.localboardTrashRead(meta.id).catch(() => null);
    // Unreadable: don't guess — keep everything this time.
    if (raw === null) return;
    note(raw);
  }
  await backend.localmediaPrune([...keep]);
}

/** Board id → the digits the command layer uses as a filename. */
const fileId = (boardId: number): string => String(-boardId);

class LocalBoardSession {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private closed = false;
  /** The last save failed (said once, until one succeeds). */
  private failed = false;
  private onUnload = () => void this.flush();

  constructor(private file: LocalBoardFile) {
    window.addEventListener("beforeunload", this.onUnload);
  }

  get id(): number {
    return this.file.id;
  }

  private board(): CanvasBoard {
    return {
      id: this.file.id,
      group_id: 0,
      creator: localUser(),
      name: this.file.name,
      style: this.file.style,
      created_at: this.file.created_at,
    };
  }

  detail(): BoardDetail {
    return { board: this.board(), elements: [...this.file.elements] };
  }

  updateBoard(style: string): CanvasBoard {
    this.file.style = style;
    this.touch();
    return this.board();
  }

  createElement(req: CreateElementRequest): CanvasElement {
    const top = this.file.elements.reduce((max, el) => Math.max(max, el.z), 0);
    const element: CanvasElement = {
      id: this.file.next_element_id,
      board_id: this.file.id,
      kind: req.kind,
      x: req.x,
      y: req.y,
      w: req.w,
      h: req.h,
      z: top + 1,
      text: req.text,
      page: req.page ?? 0,
      color: req.color,
      style: req.style,
      from_id: req.from_id,
      to_id: req.to_id,
      updated_by: 0,
      updated_at: Date.now(),
    };
    this.file.next_element_id += 1;
    this.file.elements.push(element);
    this.touch();
    return element;
  }

  updateElement(elementId: number, req: Partial<UpdateElementRequest>): CanvasElement {
    const at = this.file.elements.findIndex((el) => el.id === elementId);
    if (at < 0) throw { code: "not_found", message: "element is no longer on this board" };
    // Null and undefined both mean "keep" — the server treats them the same.
    const patch = Object.fromEntries(
      Object.entries(req).filter(([, value]) => value !== null && value !== undefined),
    );
    const next: CanvasElement = { ...this.file.elements[at], ...patch, updated_at: Date.now() };
    this.file.elements[at] = next;
    this.touch();
    return next;
  }

  deleteElement(elementId: number): void {
    this.file.elements = this.file.elements.filter(
      // Connectors die with either endpoint, the way the server cascades.
      (el) => el.id !== elementId && el.from_id !== elementId && el.to_id !== elementId,
    );
    this.touch();
  }

  private touch(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_MS);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await backend.localboardWrite(fileId(this.file.id), JSON.stringify(this.file));
      if (this.failed) {
        this.failed = false;
        toast("The board is saved again.", "success");
      }
    } catch (e) {
      // Keep it dirty and keep trying — and say so, once: a board that
      // quietly isn't saving is the worst kind of failure.
      this.dirty = true;
      if (!this.failed) {
        this.failed = true;
        toastError(
          `This board couldn't be saved to this device${isCmdError(e) ? ` (${e.message})` : ""}. It's still open. Keep it open and it will save as soon as it can.`,
        );
      }
      if (!this.closed) {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.flush(), 5000);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.flush();
    this.closed = true;
    window.removeEventListener("beforeunload", this.onUnload);
  }
}

let session: LocalBoardSession | null = null;

/** The open local board, if the board on screen lives on this device. */
export const activeLocalBoard = (): LocalBoardSession | null => session;

export async function openLocalBoard(boardId: number): Promise<BoardDetail> {
  await closeLocalBoard();
  const raw = await backend.localboardRead(fileId(boardId));
  const parsed = JSON.parse(raw) as Partial<LocalBoardFile>;
  const file: LocalBoardFile = {
    id: boardId,
    name: parsed.name ?? "Untitled",
    style: parsed.style ?? "",
    created_at: parsed.created_at ?? Date.now(),
    next_element_id: parsed.next_element_id ?? 1,
    elements: parsed.elements ?? [],
  };
  session = new LocalBoardSession(file);
  return session.detail();
}

/**
 * A board on this device as it stands, without opening it: the open one is
 * saved and read from memory (opening a second session would pull the board
 * out from under the room showing it); any other is read from its file.
 */
export async function readLocalBoard(boardId: number): Promise<BoardDetail> {
  if (session?.id === boardId) {
    await session.flush();
    return session.detail();
  }
  const parsed = JSON.parse(await backend.localboardRead(fileId(boardId))) as Partial<LocalBoardFile>;
  return {
    board: {
      id: boardId,
      group_id: 0,
      creator: localUser(),
      name: parsed.name ?? "Untitled",
      style: parsed.style ?? "",
      created_at: parsed.created_at ?? 0,
    },
    elements: parsed.elements ?? [],
  };
}

/** Boards on this device with the query in their name or in the words on
 *  them: board id → the words around the match ("" when it's the name). */
export async function searchLocalBoards(query: string): Promise<Map<number, string>> {
  const hits = await backend.localboardSearch(query);
  return new Map(hits.map((hit) => [-Number(hit.id), hit.snippet]));
}

export async function closeLocalBoard(): Promise<void> {
  const old = session;
  session = null;
  if (old) await old.destroy();
}

export async function deleteLocalBoard(boardId: number, opts: { forGood?: boolean } = {}): Promise<null> {
  if (session?.id === boardId) await closeLocalBoard();
  const name = useLocalBoards.getState().items.find((b) => b.id === boardId)?.name ?? "Board";
  // To Recently Deleted (30 days): the toast puts it straight back.
  await backend.localboardDelete(fileId(boardId));
  // A board that never really existed (a failed import) isn't kept.
  if (opts.forGood) await backend.localboardPurge(fileId(boardId)).catch(() => {});
  await useLocalBoards.getState().load();
  await pruneMedia().catch(() => {}); // tidying disk must never fail a delete
  if (opts.forGood) return null;
  toast(`Deleted “${name}”.`, "info", {
    durationMs: 10000,
    action: {
      label: "Undo",
      run: () =>
        void backend
          .localboardRestore(fileId(boardId))
          .then(() => useLocalBoards.getState().load())
          .catch(() => toastError("That board couldn't be restored.")),
    },
  });
  return null;
}

interface LocalBoardsState {
  items: LocalBoardMeta[];
  loaded: boolean;
  load: () => Promise<void>;
  create: (name: string) => Promise<number>;
  remove: (boardId: number) => Promise<void>;
}

export const useLocalBoards = create<LocalBoardsState>((set, get) => ({
  items: [],
  loaded: false,

  load: async () => {
    const rows = await backend.localboardList();
    set({
      items: rows.map((r) => ({ id: -Number(r.id), name: r.name, updated_at: r.updated_at })),
      loaded: true,
    });
  },

  create: async (name) => {
    // The creation stamp doubles as the id: unique, ordered, and negative so
    // it can never be mistaken for a server board.
    const id = -Date.now();
    const file: LocalBoardFile = {
      id,
      name: name.trim() || "Untitled",
      style: "",
      created_at: Date.now(),
      next_element_id: 1,
      elements: [],
    };
    await backend.localboardWrite(fileId(id), JSON.stringify(file));
    await get().load();
    return id;
  },

  remove: async (boardId) => {
    await deleteLocalBoard(boardId);
  },
}));
