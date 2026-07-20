/**
 * Typed wrappers around the Tauri commands (the only path to the network —
 * all HTTP happens in the Rust core over pinned TLS).
 *
 * During development in a plain browser, an in-memory preview implementation
 * (devPreview.ts) backs the same API; it is excluded from production builds.
 */

import type { User } from "../bindings/proto/User";

export interface SavedServer {
  addr: string;
  server_name: string;
  identity_hash: string;
  spki_hash: string;
  fingerprint: string;
  last_username: string | null;
}

export type TrustStatus =
  | { status: "trusted" }
  | { status: "new"; fingerprint: string }
  | { status: "identity_changed"; fingerprint: string; old_fingerprint: string };

export interface ProbeResult {
  addr: string;
  server_name: string;
  protocol_version: number;
  trust: TrustStatus;
}

export interface SessionInfo {
  addr: string;
  user: User;
}

export interface CmdError {
  code: string;
  message: string;
}

export function isCmdError(e: unknown): e is CmdError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** State of the server hosted inside this app ("Host on this computer"). */
export interface HostStatus {
  configured: boolean;
  running: boolean;
  port: number;
  server_name: string;
  addr: string | null;
  fingerprint: string | null;
  lan_addrs: string[];
}

export type UpnpResult =
  | { status: "mapped"; external_addr: string }
  | { status: "failed"; message: string };

export interface Reachability {
  lan_addrs: string[];
  upnp: UpnpResult;
}

/** A ServerFrame from the WS, forwarded by the Rust core. */
export type WsEvent =
  | { ev: "ready"; d: { user_id: number; server_time: number } }
  | { ev: "pong"; d: { client_time: number; server_time: number } }
  | { ev: "event"; room: string; kind: string; data: unknown }
  | { ev: "error"; code: string; message: string };

export interface Backend {
  probeServer(addr: string): Promise<ProbeResult>;
  trustServer(addr: string): Promise<void>;
  listServers(): Promise<SavedServer[]>;
  removeServer(addr: string): Promise<void>;
  login(addr: string, username: string, password: string): Promise<SessionInfo>;
  register(addr: string, username: string, password: string): Promise<SessionInfo>;
  /** Redeem an admin-issued reset code for a new password (pre-auth). */
  resetPassword(addr: string, username: string, code: string, newPassword: string): Promise<void>;
  logout(): Promise<void>;
  currentSession(): Promise<SessionInfo | null>;

  hostStatus(): Promise<HostStatus>;
  hostStart(port: number, serverName: string): Promise<HostStatus>;
  hostStop(): Promise<HostStatus>;
  hostReachability(): Promise<Reachability>;
  apiFetch(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  uploadAttachment(opts: {
    dataBase64?: string;
    filePath?: string;
    fileName?: string;
  }): Promise<ApiResponse>;
  /** Save an export archive; resolves to a human-readable location. */
  saveExport(fileName: string, dataBase64: string): Promise<string>;
  wsSub(rooms: string[]): Promise<void>;
  wsUnsub(rooms: string[]): Promise<void>;
  /** Subscribe to WS frames; returns an unsubscribe fn. */
  onWsEvent(handler: (event: WsEvent) => void): () => void;
  /** Connection up/down transitions of the socket; returns an unsubscribe fn. */
  onWsStatus(handler: (connected: boolean) => void): () => void;

  vaultList(): Promise<{ name: string; modified_at: number }[]>;
  vaultRead(name: string): Promise<string>;
  vaultWrite(name: string, content: string): Promise<void>;
  vaultDelete(name: string): Promise<void>;
  vaultBacklinks(name: string): Promise<string[]>;

  pluginsList(): Promise<
    { manifest: { id: string; name: string; version: string; icon: string; permissions: string[]; min_api_version: number }; enabled: boolean }[]
  >;
  pluginReadEntry(id: string): Promise<string>;
  pluginSetEnabled(id: string, enabled: boolean): Promise<void>;
}

function tauriBackend(): Backend {
  // Dynamic import keeps the plain-browser bundle free of tauri APIs.
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  };
  return {
    probeServer: (addr) => invoke("probe_server", { addr }),
    trustServer: (addr) => invoke("trust_server", { addr }),
    listServers: () => invoke("list_servers"),
    removeServer: (addr) => invoke("remove_server", { addr }),
    login: (addr, username, password) => invoke("login", { addr, username, password }),
    register: (addr, username, password) => invoke("register", { addr, username, password }),
    resetPassword: (addr, username, code, newPassword) =>
      invoke("reset_password", { addr, username, code, newPassword }),
    logout: () => invoke("logout"),
    currentSession: () => invoke("current_session"),
    hostStatus: () => invoke("host_status"),
    hostStart: (port, serverName) => invoke("host_start", { port, serverName }),
    hostStop: () => invoke("host_stop"),
    hostReachability: () => invoke("host_reachability"),
    apiFetch: (method, path, body) => invoke("api_fetch", { method, path, body: body ?? null }),
    uploadAttachment: ({ dataBase64, filePath, fileName }) =>
      invoke("upload_attachment", {
        dataBase64: dataBase64 ?? null,
        filePath: filePath ?? null,
        fileName: fileName ?? null,
      }),
    saveExport: (fileName, dataBase64) => invoke("save_export", { fileName, dataBase64 }),
    wsSub: (rooms) => invoke("ws_sub", { rooms }),
    wsUnsub: (rooms) => invoke("ws_unsub", { rooms }),
    onWsEvent: (handler) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        listen("ws:event", (e) => handler(e.payload as WsEvent)).then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        }),
      );
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
    onWsStatus: (handler) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        listen("ws:status", (e) =>
          handler((e.payload as { connected: boolean }).connected),
        ).then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        }),
      );
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
    vaultList: () => invoke("vault_list"),
    vaultRead: (name) => invoke("vault_read", { name }),
    vaultWrite: (name, content) => invoke("vault_write", { name, content }),
    vaultDelete: (name) => invoke("vault_delete", { name }),
    vaultBacklinks: (name) => invoke("vault_backlinks", { name }),
    pluginsList: () => invoke("plugins_list"),
    pluginReadEntry: (id) => invoke("plugin_read_entry", { id }),
    pluginSetEnabled: (id, enabled) => invoke("plugin_set_enabled", { id, enabled }),
  };
}

/**
 * Backend selection:
 *  - Inside the desktop shell: the Tauri commands (pinned TLS in the Rust core).
 *  - Plain browser during development: an in-memory preview implementation,
 *    loaded dynamically so production bundles never contain it.
 *  - Anything else: fail closed.
 */
const inTauri = "__TAURI_INTERNALS__" in window;

function unavailableBackend(): Backend {
  const fail = () =>
    Promise.reject({
      code: "no_backend",
      message: "WritForm requires the desktop app",
    } satisfies CmdError);
  return {
    probeServer: fail,
    trustServer: fail,
    listServers: fail,
    removeServer: fail,
    login: fail,
    register: fail,
    resetPassword: fail,
    logout: fail,
    currentSession: fail,
    hostStatus: fail,
    hostStart: fail,
    hostStop: fail,
    hostReachability: fail,
    apiFetch: fail,
    uploadAttachment: fail,
    saveExport: fail,
    wsSub: fail,
    wsUnsub: fail,
    onWsEvent: () => () => {},
    onWsStatus: () => () => {},
    vaultList: fail,
    vaultRead: fail,
    vaultWrite: fail,
    vaultDelete: fail,
    vaultBacklinks: fail,
    pluginsList: fail,
    pluginReadEntry: fail,
    pluginSetEnabled: fail,
  };
}

export const backend: Backend = inTauri
  ? tauriBackend()
  : import.meta.env.DEV
    ? (await import("./devPreview")).devPreviewBackend()
    : unavailableBackend();

/** True only in the browser dev preview (never in the desktop app). */
export const isDevPreview = !inTauri && import.meta.env.DEV;
