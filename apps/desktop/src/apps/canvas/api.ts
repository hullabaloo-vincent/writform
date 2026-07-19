import type { BoardDetail } from "../../bindings/proto/BoardDetail";
import type { CanvasBoard } from "../../bindings/proto/CanvasBoard";
import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import type { CreateElementRequest } from "../../bindings/proto/CreateElementRequest";
import type { UpdateElementRequest } from "../../bindings/proto/UpdateElementRequest";
import { backend, type CmdError } from "../../lib/backend";

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

export const canvasApi = {
  boards: (groupId: number) => api<CanvasBoard[]>("GET", `/api/v1/groups/${groupId}/boards`),
  createBoard: (groupId: number, name: string) =>
    api<CanvasBoard>("POST", `/api/v1/groups/${groupId}/boards`, { name }),
  detail: (boardId: number) => api<BoardDetail>("GET", `/api/v1/boards/${boardId}`),
  deleteBoard: (boardId: number) => api<null>("DELETE", `/api/v1/boards/${boardId}`),
  createElement: (boardId: number, req: CreateElementRequest) =>
    api<CanvasElement>("POST", `/api/v1/boards/${boardId}/elements`, req),
  updateElement: (elementId: number, req: Partial<UpdateElementRequest>) =>
    api<CanvasElement>("PATCH", `/api/v1/elements/${elementId}`, req),
  deleteElement: (elementId: number) => api<null>("DELETE", `/api/v1/elements/${elementId}`),
};
