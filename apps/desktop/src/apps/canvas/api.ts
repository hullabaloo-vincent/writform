import type { BoardDetail } from "../../bindings/proto/BoardDetail";
import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import type { LinkPreview } from "../../bindings/proto/LinkPreview";
import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import type { CreateElementRequest } from "../../bindings/proto/CreateElementRequest";
import type { UpdateElementRequest } from "../../bindings/proto/UpdateElementRequest";
import { backend, type CmdError } from "../../lib/backend";
import {
  activeLocalBoard,
  deleteLocalBoard,
  isLocalBoard,
  openLocalBoard,
} from "./local";

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

/**
 * Every board mutation goes through here, which makes this the one place that
 * has to know whether a board lives on the server or on this device. Boards
 * with a negative id are local; element calls carry no board id, so they
 * follow whichever board is open. Above this line nothing knows the
 * difference.
 */
export const canvasApi = {
  boards: (groupId: number) => api<CanvasBoard[]>("GET", `/api/v1/groups/${groupId}/boards`),
  createBoard: (groupId: number, name: string) =>
    api<CanvasBoard>("POST", `/api/v1/groups/${groupId}/boards`, { name }),
  // These stay `async` so a local failure surfaces as a rejected promise:
  // callers are `.catch(fail)` chains, and a synchronous throw would escape
  // them mid-gesture.
  detail: async (boardId: number) =>
    isLocalBoard(boardId)
      ? openLocalBoard(boardId)
      : api<BoardDetail>("GET", `/api/v1/boards/${boardId}`),
  updateBoard: async (boardId: number, style: string) => {
    const local = activeLocalBoard();
    return local && local.id === boardId
      ? local.updateBoard(style)
      : api<CanvasBoard>("PATCH", `/api/v1/boards/${boardId}`, { style });
  },
  deleteBoard: async (boardId: number) =>
    isLocalBoard(boardId)
      ? deleteLocalBoard(boardId)
      : api<null>("DELETE", `/api/v1/boards/${boardId}`),
  createElement: async (boardId: number, req: CreateElementRequest) => {
    const local = activeLocalBoard();
    return local && local.id === boardId
      ? local.createElement(req)
      : api<CanvasElement>("POST", `/api/v1/boards/${boardId}/elements`, req);
  },
  updateElement: async (elementId: number, req: Partial<UpdateElementRequest>) => {
    const local = activeLocalBoard();
    return local
      ? local.updateElement(elementId, req)
      : api<CanvasElement>("PATCH", `/api/v1/elements/${elementId}`, req);
  },
  deleteElement: async (elementId: number) => {
    const local = activeLocalBoard();
    if (!local) return api<null>("DELETE", `/api/v1/elements/${elementId}`);
    local.deleteElement(elementId);
    return null;
  },
  /** Ephemeral cursor broadcast; fire-and-forget, never persisted. Carries
   *  the page in view (page presence) and the sketch being drawn on, if any
   *  (a soft edit lock for peers). */
  cursor: async (
    boardId: number,
    x: number,
    y: number,
    page = 0,
    editing: number | null = null,
  ) =>
    isLocalBoard(boardId)
      ? null
      : api<null>("POST", `/api/v1/boards/${boardId}/cursor`, { x, y, page, editing }),
  linkPreview: (url: string) =>
    api<LinkPreview>("GET", `/api/v1/link-preview?url=${encodeURIComponent(url)}`),
};
