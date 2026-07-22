/**
 * Browser backend: the SPA that writform-server serves itself. Everything is
 * same-origin — fetch for REST, a WebSocket for fan-out — so there is no
 * server picking and no TOFU ceremony (the browser's TLS decision happened
 * at navigation). The token lives in localStorage, plus a cookie scoped to
 * the attachments path so plain <img>/<audio> loads can authenticate
 * (headers can't be attached to those).
 */

import type { User } from "../bindings/proto/User";
import type {
  ApiResponse,
  Backend,
  CmdError,
  ProbeResult,
  SessionInfo,
  WsEvent,
} from "./backend";

const TOKEN_KEY = "wf-web-token";
const PROTOCOL_VERSION = 1;

function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(t: string | null) {
  if (t === null) {
    localStorage.removeItem(TOKEN_KEY);
    document.cookie = "wf_token=; Max-Age=0; Path=/api/v1/attachments; SameSite=Strict";
  } else {
    localStorage.setItem(TOKEN_KEY, t);
    document.cookie = `wf_token=${t}; Path=/api/v1/attachments; SameSite=Strict; Secure`;
  }
}

function errFrom(res: ApiResponse): CmdError {
  const err = (res.body ?? {}) as Partial<CmdError>;
  return {
    code: err.code ?? `http_${res.status}`,
    message: err.message ?? `request failed (${res.status})`,
  };
}

async function apiFetch(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined && body !== null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw { code: "unreachable", message: `request failed: ${e}` } satisfies CmdError;
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** Same lifecycle as the Rust WS manager: auth frame → ready, resubscribe on
 *  reconnect, exponential backoff, up/down transitions for resync. */
class WebWs {
  private ws: WebSocket | null = null;
  private rooms = new Set<string>();
  private eventHandlers = new Set<(e: WsEvent) => void>();
  private statusHandlers = new Set<(c: boolean) => void>();
  private connected = false;
  private retry = 1000;
  private stopped = true;

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.rooms.clear();
    this.setConnected(false);
  }

  private setConnected(c: boolean) {
    if (this.connected === c) return;
    this.connected = c;
    for (const h of this.statusHandlers) h(c);
  }

  private connect() {
    const t = token();
    if (this.stopped || !t) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ op: "auth", d: { token: t, protocol_version: PROTOCOL_VERSION } }),
      );
    };
    ws.onmessage = (m) => {
      let frame: WsEvent;
      try {
        frame = JSON.parse(m.data as string) as WsEvent;
      } catch {
        return;
      }
      if (frame.ev === "ready") {
        this.retry = 1000;
        if (this.rooms.size > 0) {
          ws.send(JSON.stringify({ op: "sub", d: { rooms: [...this.rooms] } }));
        }
        this.setConnected(true);
      }
      for (const h of this.eventHandlers) h(frame);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setConnected(false);
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 15_000);
      }
    };
    ws.onerror = () => ws.close();
  }

  sub(rooms: string[]) {
    for (const r of rooms) this.rooms.add(r);
    if (this.connected) this.ws?.send(JSON.stringify({ op: "sub", d: { rooms } }));
  }

  unsub(rooms: string[]) {
    for (const r of rooms) this.rooms.delete(r);
    if (this.connected) this.ws?.send(JSON.stringify({ op: "unsub", d: { rooms } }));
  }

  onEvent(h: (e: WsEvent) => void) {
    this.eventHandlers.add(h);
    return () => void this.eventHandlers.delete(h);
  }

  onStatus(h: (c: boolean) => void) {
    this.statusHandlers.add(h);
    return () => void this.statusHandlers.delete(h);
  }
}

export function webBackend(): Backend {
  const ws = new WebWs();
  const notOnWeb = (what: string) => () =>
    Promise.reject({
      code: "not_on_web",
      message: `${what} is only available in the desktop app`,
    } satisfies CmdError);

  const auth = async (path: string, username: string, password: string): Promise<SessionInfo> => {
    const res = await apiFetch("POST", path, { username, password });
    if (res.status >= 400) throw errFrom(res);
    const { token: t, user } = res.body as { token: string; user: User };
    setToken(t);
    ws.start();
    return { addr: location.host, user };
  };

  return {
    // The web client is bound to its origin — probing "connects" to it.
    probeServer: async (): Promise<ProbeResult> => {
      const res = await apiFetch("GET", "/api/v1/identity");
      if (res.status >= 400) throw errFrom(res);
      const id = res.body as { server_name: string; protocol_version: number };
      return {
        addr: location.host,
        server_name: id.server_name,
        protocol_version: id.protocol_version,
        trust: { status: "trusted" },
      };
    },
    trustServer: async () => {},
    listServers: async () => [],
    removeServer: async () => {},
    login: (_addr, username, password) => auth("/api/v1/auth/login", username, password),
    register: (_addr, username, password) => auth("/api/v1/auth/register", username, password),
    resetPassword: async (_addr, username, code, newPassword) => {
      const res = await apiFetch("POST", "/api/v1/auth/reset-password", {
        username,
        code,
        new_password: newPassword,
      });
      if (res.status >= 400) throw errFrom(res);
    },
    logout: async () => {
      await apiFetch("POST", "/api/v1/auth/logout").catch(() => {});
      setToken(null);
      ws.stop();
    },
    currentSession: async () => {
      if (!token()) return null;
      const res = await apiFetch("GET", "/api/v1/auth/me");
      if (res.status >= 400) {
        setToken(null);
        return null;
      }
      ws.start();
      return { addr: location.host, user: res.body as User };
    },
    hostStatus: async () => ({
      configured: false,
      running: false,
      port: 0,
      server_name: "",
      addr: null,
      fingerprint: null,
      lan_addrs: [],
    }),
    hostStart: notOnWeb("Hosting"),
    hostStop: notOnWeb("Hosting"),
    hostReachability: notOnWeb("Hosting"),
    profileGet: async () => null,
    profileSave: notOnWeb("The portable profile"),
    profileUpdateFields: notOnWeb("The portable profile"),
    profileDelete: notOnWeb("The portable profile"),
    localdocList: async () => [],
    localdocRead: notOnWeb("Local documents"),
    localdocWrite: notOnWeb("Local documents"),
    localdocDelete: notOnWeb("Local documents"),
    apiFetch,
    uploadAttachment: async ({ dataBase64, fileName }) => {
      if (!dataBase64) {
        throw {
          code: "no_data",
          message: "browser uploads need file contents",
        } satisfies CmdError;
      }
      const bin = atob(dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const form = new FormData();
      form.append("file", new Blob([bytes]), fileName ?? "upload");
      const headers: Record<string, string> = {};
      const t = token();
      if (t) headers.Authorization = `Bearer ${t}`;
      const res = await fetch("/api/v1/attachments", { method: "POST", headers, body: form });
      const body = (await res.json().catch(() => null)) as unknown;
      return { status: res.status, body };
    },
    // Browser "save" is a download.
    saveExport: async (fileName, dataBase64) => {
      const bin = atob(dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes]));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return "your Downloads folder";
    },
    readDroppedFile: notOnWeb("Native file drop"),
    // The browser raises its own permission prompts on getUserMedia.
    microphoneStatus: async () => "authorized",
    requestMicrophoneAccess: async () => "authorized",
    cameraStatus: async () => "authorized",
    requestCameraAccess: async () => "authorized",
    wsSub: async (rooms) => ws.sub(rooms),
    wsUnsub: async (rooms) => ws.unsub(rooms),
    onWsEvent: (handler) => ws.onEvent(handler),
    onWsStatus: (handler) => ws.onStatus(handler),
    vaultList: async () => [],
    vaultRead: notOnWeb("The notes vault"),
    vaultWrite: notOnWeb("The notes vault"),
    vaultDelete: notOnWeb("The notes vault"),
    vaultRename: notOnWeb("The notes vault"),
    vaultSearch: async () => [],
    vaultPath: notOnWeb("The notes vault"),
    vaultBacklinks: async () => [],
    pluginsList: async () => [],
    pluginReadEntry: notOnWeb("Plugins"),
    pluginSetEnabled: notOnWeb("Plugins"),
  };
}
