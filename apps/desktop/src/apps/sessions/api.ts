import type { CreateSessionRequest } from "../../bindings/proto/CreateSessionRequest";
import type { SessionDetail } from "../../bindings/proto/SessionDetail";
import type { SessionPrompt } from "../../bindings/proto/SessionPrompt";
import type { WritingSession } from "../../bindings/proto/WritingSession";
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

export const sessionApi = {
  list: (channelId: number) =>
    api<WritingSession[]>("GET", `/api/v1/channels/${channelId}/sessions`),
  create: (req: CreateSessionRequest) => api<WritingSession>("POST", "/api/v1/sessions", req),
  detail: (sessionId: number) => api<SessionDetail>("GET", `/api/v1/sessions/${sessionId}`),
  end: (sessionId: number) => api<null>("POST", `/api/v1/sessions/${sessionId}/end`),
  deleteSession: (sessionId: number) => api<null>("DELETE", `/api/v1/sessions/${sessionId}`),
  createPrompt: (sessionId: number, promptDoc: unknown, timerSeconds: number | null) =>
    api<SessionPrompt>("POST", `/api/v1/sessions/${sessionId}/prompts`, {
      prompt_doc: promptDoc,
      timer_seconds: timerSeconds,
    }),
  startPrompt: (promptId: number) => api<null>("POST", `/api/v1/prompts/${promptId}/start`),
  stopPrompt: (promptId: number) => api<null>("POST", `/api/v1/prompts/${promptId}/stop`),
  saveSubmission: (promptId: number, doc: unknown) =>
    api<null>("PUT", `/api/v1/prompts/${promptId}/submission`, { doc }),
};
