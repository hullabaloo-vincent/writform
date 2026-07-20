import type { AppendUpdateResponse } from "../../bindings/proto/AppendUpdateResponse";
import type { CreateThreadRequest } from "../../bindings/proto/CreateThreadRequest";
import type { Document } from "../../bindings/proto/Document";
import type { DocumentActivity } from "../../bindings/proto/DocumentActivity";
import type { DocumentDetail } from "../../bindings/proto/DocumentDetail";
import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import type { DocumentShare } from "../../bindings/proto/DocumentShare";
import type { DocumentThread } from "../../bindings/proto/DocumentThread";
import type { DocumentThreadMessage } from "../../bindings/proto/DocumentThreadMessage";
import type { DocumentUpdateBatch } from "../../bindings/proto/DocumentUpdateBatch";
import type { DocumentVersion } from "../../bindings/proto/DocumentVersion";
import type { DocumentVersionMeta } from "../../bindings/proto/DocumentVersionMeta";
import type { SetShareRequest } from "../../bindings/proto/SetShareRequest";
import type { UpdateDocumentRequest } from "../../bindings/proto/UpdateDocumentRequest";
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

export const documentsApi = {
  list: () => api<DocumentListItem[]>("GET", "/api/v1/documents"),
  create: (title: string, format: string) =>
    api<Document>("POST", "/api/v1/documents", { title, format }),
  detail: (id: number) => api<DocumentDetail>("GET", `/api/v1/documents/${id}`),
  update: (id: number, req: UpdateDocumentRequest) =>
    api<Document>("PATCH", `/api/v1/documents/${id}`, req),
  remove: (id: number) => api<null>("DELETE", `/api/v1/documents/${id}`),

  appendUpdate: (id: number, update_b64: string) =>
    api<AppendUpdateResponse>("POST", `/api/v1/documents/${id}/updates`, { update_b64 }),
  updatesSince: (id: number, since: number) =>
    api<DocumentUpdateBatch>("GET", `/api/v1/documents/${id}/updates?since=${since}`),
  awareness: (id: number, data_b64: string) =>
    api<null>("POST", `/api/v1/documents/${id}/awareness`, { data_b64 }),

  snapshot: (id: number, doc_json: string, name?: string, kind?: "auto" | "named" | "draft") =>
    api<DocumentVersionMeta | null>("POST", `/api/v1/documents/${id}/snapshot`, {
      doc_json,
      name: name ?? null,
      kind: kind ?? null,
    }),
  versions: (id: number) => api<DocumentVersionMeta[]>("GET", `/api/v1/documents/${id}/versions`),
  version: (id: number, versionId: number) =>
    api<DocumentVersion>("GET", `/api/v1/documents/${id}/versions/${versionId}`),
  activity: (id: number) => api<DocumentActivity[]>("GET", `/api/v1/documents/${id}/activity`),

  shares: (id: number) => api<DocumentShare[]>("GET", `/api/v1/documents/${id}/shares`),
  setShare: (id: number, req: SetShareRequest) =>
    api<DocumentShare>("PUT", `/api/v1/documents/${id}/shares`, req),
  deleteShare: (id: number, kind: string, subjectId: number) =>
    api<null>("DELETE", `/api/v1/documents/${id}/shares/${kind}/${subjectId}`),

  threads: (id: number) => api<DocumentThread[]>("GET", `/api/v1/documents/${id}/threads`),
  createThread: (id: number, req: CreateThreadRequest) =>
    api<DocumentThread>("POST", `/api/v1/documents/${id}/threads`, req),
  replyThread: (threadId: number, content: string) =>
    api<DocumentThreadMessage>("POST", `/api/v1/document-threads/${threadId}/replies`, {
      content,
    }),
  setThreadResolved: (threadId: number, resolved: boolean) =>
    api<DocumentThread>("PATCH", `/api/v1/document-threads/${threadId}`, { resolved }),
  deleteThread: (threadId: number) => api<null>("DELETE", `/api/v1/document-threads/${threadId}`),
};
