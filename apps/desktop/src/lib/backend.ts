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

/** Locally saved presentation, applied to servers on explicit request. */
export interface PortableProfile {
  display_name: string | null;
  accent_color: string | null;
  bio: string | null;
  avatar_path: string | null;
  banner_path: string | null;
  saved_at: number;
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

/** Startup resume outcome: a live session, or why there isn't one.
 *  "expired" = a remembered token was rejected (show login + notice);
 *  "unreachable" = the remembered server didn't answer (token kept). */
export interface ResumeResult {
  session: SessionInfo | null;
  reason: "expired" | "unreachable" | null;
  addr: string | null;
}

/** Set by the session store: called when any API response proves the token
 *  is dead (401 expired_token/invalid_token) so one place handles the drop
 *  back to the connect screen. Lives here to avoid a store↔backend cycle. */
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}
export function noteAuthFailure(status: number, body: unknown): void {
  if (status !== 401) return;
  const code = (body as { code?: string } | null)?.code;
  if (code === "expired_token" || code === "invalid_token") onUnauthorized?.();
}

/** What an export is; fixes the file's extension and the Save panel filter. */
/** An on-device document in the organizer's list. */
export interface LocalDocListing {
  id: string;
  title: string;
  format: string;
  updated_at: number;
  /** 0 / empty for documents not saved since list metadata existed. */
  words?: number;
  excerpt?: string;
}

/** An on-device document in Recently Deleted. */
export interface LocalTrashListing {
  id: string;
  title: string;
  format: string;
  deleted_at: number;
  words: number;
  excerpt: string;
}

export type SaveKind = "pdf" | "epub" | "docx" | "zip" | "wfboard";

export type SaveResult =
  | {
      status: "saved";
      /** Absolute path when the platform wrote a real file (desktop/iOS). */
      path: string | null;
      /** Where it went, in the user's words ("Downloads", "Files › …"). */
      location: string;
      /** The desktop file manager can show it (Show in Finder). */
      revealable: boolean;
    }
  | { status: "cancelled" };

export const SAVE_MIME: Record<SaveKind, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
  wfboard: "application/zip",
};

/** Browser save: a download. The URL outlives the click — revoking it
 *  synchronously can cancel the download in some engines. */
export function browserDownload(fileName: string, kind: SaveKind, bytes: Uint8Array): SaveResult {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: SAVE_MIME[kind] }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { status: "saved", path: null, location: "your Downloads", revealable: false };
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
  /** `remember` keeps the session token on this device for auto-resume. */
  login(addr: string, username: string, password: string, remember: boolean): Promise<SessionInfo>;
  register(
    addr: string,
    username: string,
    password: string,
    remember: boolean,
  ): Promise<SessionInfo>;
  /** Redeem an admin-issued reset code for a new password (pre-auth). */
  resetPassword(addr: string, username: string, code: string, newPassword: string): Promise<void>;
  logout(): Promise<void>;
  currentSession(): Promise<ResumeResult>;

  hostStatus(): Promise<HostStatus>;
  hostStart(port: number, serverName: string): Promise<HostStatus>;
  hostStop(): Promise<HostStatus>;
  hostReachability(): Promise<Reachability>;

  /** Locally saved portable profile, or null when none is saved. */
  profileGet(): Promise<PortableProfile | null>;
  /** Snapshot fields + the current avatar/banner attachments locally. */
  profileSave(fields: {
    displayName: string | null;
    accentColor: string | null;
    bio: string | null;
    avatarAttachmentId: number | null;
    bannerAttachmentId: number | null;
  }): Promise<PortableProfile>;
  /** Update text fields only, keeping stored images (offline editing). */
  profileUpdateFields(fields: {
    displayName: string | null;
    accentColor: string | null;
    bio: string | null;
  }): Promise<PortableProfile>;
  profileDelete(): Promise<void>;

  /** Documents stored on this device (meta only; state stays on disk). */
  localdocList(): Promise<LocalDocListing[]>;
  /** Raw JSON payload of one local document (schema owned by the client). */
  localdocRead(id: string): Promise<string>;
  /** Save a document; `meta` (JSON: title, format, words, excerpt) is kept
   *  beside it so the list never reads whole manuscripts. */
  localdocWrite(id: string, content: string, meta?: string): Promise<void>;
  /** Delete for good (Recently Deleted's purge goes through `localdocPurge`). */
  localdocDelete(id: string): Promise<void>;
  /** Move to Recently Deleted (with its history and notes) for 30 days. */
  localdocTrash(id: string): Promise<void>;
  localdocTrashList(): Promise<LocalTrashListing[]>;
  localdocRestore(id: string): Promise<void>;
  localdocPurge(id: string): Promise<void>;
  localdocTrashEmpty(): Promise<void>;
  /** Legacy (v1) single-file history; read once to migrate. Empty when none. */
  localdocHistoryRead(id: string): Promise<string>;
  /** Keep the migrated v1 file as `.v1.bak`. */
  localdocHistoryRetire(id: string): Promise<void>;
  /** History v2: the version index (JSON); empty string when none yet. */
  localdocHistIndexRead(id: string): Promise<string>;
  localdocHistIndexWrite(id: string, content: string): Promise<void>;
  /** One compressed version's bytes (raw IPC body both ways). */
  localdocHistBlobWrite(id: string, version: string, bytes: Uint8Array): Promise<void>;
  localdocHistBlobRead(id: string, version: string): Promise<Uint8Array>;
  localdocHistBlobDelete(id: string, version: string): Promise<void>;
  /** Feedback threads (notes-to-self) for a local document. */
  localdocFeedbackRead(id: string): Promise<string>;
  localdocFeedbackWrite(id: string, content: string): Promise<void>;

  /** Canvas boards stored on this device (meta only; elements stay on disk). */
  localboardList(): Promise<{ id: string; name: string; updated_at: number }[]>;
  /** Raw JSON payload of one local board (schema owned by the client). */
  localboardRead(id: string): Promise<string>;
  localboardWrite(id: string, content: string): Promise<void>;
  localboardDelete(id: string): Promise<void>;
  /** Store a pasted picture for a local board. The bytes travel as a raw IPC
   *  body and are written to disk verbatim — base64 would inflate a photo by
   *  a third for no gain, and the render path reads the file directly. */
  localmediaWrite(mediaId: string, bytes: ArrayBuffer): Promise<void>;
  /** Delete stored pictures no board references any more. */
  localmediaPrune(keep: string[]): Promise<void>;
  apiFetch(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  uploadAttachment(opts: {
    dataBase64?: string;
    filePath?: string;
    fileName?: string;
  }): Promise<ApiResponse>;
  /** Save an export the user asked for: the native Save panel on desktop,
   *  the Files-visible Documents folder on iOS, a download on the web. */
  saveFile(fileName: string, kind: SaveKind, bytes: Uint8Array): Promise<SaveResult>;
  /** Read a natively drag-dropped file so the importer can parse its bytes. */
  readDroppedFile(path: string): Promise<{ name: string; data_base64: string }>;
  /** Microphone authorization: not_determined | restricted | denied | authorized. */
  microphoneStatus(): Promise<string>;
  /** Camera authorization state (`authorized` off-macOS). */
  cameraStatus(): Promise<string>;
  /** Prompt for camera access if undecided; resolves to the final state. */
  requestCameraAccess(): Promise<string>;
  /** Raise the OS microphone prompt when undecided; resolves to the outcome. */
  requestMicrophoneAccess(): Promise<string>;
  wsSub(rooms: string[]): Promise<void>;
  wsUnsub(rooms: string[]): Promise<void>;
  /** Ephemeral "typing in this channel" signal; dropped when the socket is down. */
  wsTyping(channelId: number): Promise<void>;
  /** Subscribe to WS frames; returns an unsubscribe fn. */
  onWsEvent(handler: (event: WsEvent) => void): () => void;
  /** Connection up/down transitions of the socket; returns an unsubscribe fn. */
  onWsStatus(handler: (connected: boolean) => void): () => void;

  vaultList(): Promise<{ name: string; modified_at: number }[]>;
  vaultRead(name: string): Promise<string>;
  vaultWrite(name: string, content: string): Promise<void>;
  vaultDelete(name: string): Promise<void>;
  /** Renames a note and repoints `[[old]]` links vault-wide; returns the name used. */
  vaultRename(name: string, newName: string): Promise<string>;
  vaultBacklinks(name: string): Promise<string[]>;
  /** Case-insensitive name+content search; name matches first, cap 50. */
  vaultSearch(query: string): Promise<{ name: string; snippet: string; modified_at: number }[]>;
  /** Absolute path of the vault folder (for reveal-in-Finder). */
  vaultPath(): Promise<string>;

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
    login: (addr, username, password, remember) =>
      invoke("login", { addr, username, password, remember }),
    register: (addr, username, password, remember) =>
      invoke("register", { addr, username, password, remember }),
    resetPassword: (addr, username, code, newPassword) =>
      invoke("reset_password", { addr, username, code, newPassword }),
    logout: () => invoke("logout"),
    currentSession: () => invoke("current_session"),
    hostStatus: () => invoke("host_status"),
    hostStart: (port, serverName) => invoke("host_start", { port, serverName }),
    hostStop: () => invoke("host_stop"),
    hostReachability: () => invoke("host_reachability"),
    profileGet: () => invoke("profile_get"),
    profileSave: (f) =>
      invoke("profile_save", {
        displayName: f.displayName,
        accentColor: f.accentColor,
        bio: f.bio,
        avatarAttachmentId: f.avatarAttachmentId,
        bannerAttachmentId: f.bannerAttachmentId,
      }),
    profileUpdateFields: (f) =>
      invoke("profile_update_fields", {
        displayName: f.displayName,
        accentColor: f.accentColor,
        bio: f.bio,
      }),
    profileDelete: () => invoke("profile_delete"),
    localdocList: () => invoke("localdoc_list"),
    localdocRead: (id) => invoke("localdoc_read", { id }),
    localdocWrite: (id, content, meta) => invoke("localdoc_write", { id, content, meta: meta ?? null }),
    localdocDelete: (id) => invoke("localdoc_delete", { id }),
    localdocTrash: (id) => invoke("localdoc_trash", { id }),
    localdocTrashList: () => invoke("localdoc_trash_list"),
    localdocRestore: (id) => invoke("localdoc_restore", { id }),
    localdocPurge: (id) => invoke("localdoc_purge", { id }),
    localdocTrashEmpty: () => invoke("localdoc_trash_empty"),
    localdocHistoryRead: (id) => invoke("localdoc_history_read", { id }),
    localdocHistoryRetire: (id) => invoke("localdoc_history_retire", { id }),
    localdocHistIndexRead: (id) => invoke("localdoc_hist_index_read", { id }),
    localdocHistIndexWrite: (id, content) => invoke("localdoc_hist_index_write", { id, content }),
    localdocHistBlobWrite: async (id, version, bytes) => {
      const { invoke: raw } = await import("@tauri-apps/api/core");
      await raw("localdoc_hist_blob_write", bytes, { headers: { "x-doc": id, "x-version": version } });
    },
    localdocHistBlobRead: async (id, version) =>
      new Uint8Array(await invoke<ArrayBuffer>("localdoc_hist_blob_read", { id, version })),
    localdocHistBlobDelete: (id, version) => invoke("localdoc_hist_blob_delete", { id, version }),
    localdocFeedbackRead: (id) => invoke("localdoc_feedback_read", { id }),
    localdocFeedbackWrite: (id, content) => invoke("localdoc_feedback_write", { id, content }),
    localboardList: () => invoke("localboard_list"),
    localboardRead: (id) => invoke("localboard_read", { id }),
    localboardWrite: (id, content) => invoke("localboard_write", { id, content }),
    localboardDelete: (id) => invoke("localboard_delete", { id }),
    localmediaWrite: async (mediaId, bytes) => {
      // Raw body, not a JSON argument: the bytes go across untouched.
      const { invoke: raw } = await import("@tauri-apps/api/core");
      await raw("localmedia_write", bytes, { headers: { "x-media": mediaId } });
    },
    localmediaPrune: (keep) => invoke("localmedia_prune", { keep }),
    apiFetch: async (method, path, body) => {
      const res = await invoke<ApiResponse>("api_fetch", { method, path, body: body ?? null });
      noteAuthFailure(res.status, res.body);
      return res;
    },
    uploadAttachment: ({ dataBase64, filePath, fileName }) =>
      invoke("upload_attachment", {
        dataBase64: dataBase64 ?? null,
        filePath: filePath ?? null,
        fileName: fileName ?? null,
      }),
    saveFile: async (fileName, kind, bytes) => {
      // Raw body (no base64 inflation); the name rides a header, which must
      // be ASCII — hence the percent-encoding Rust undoes.
      const { invoke: raw } = await import("@tauri-apps/api/core");
      const saved = await raw<{ path: string; location: string; revealable: boolean } | null>(
        "save_file",
        bytes,
        { headers: { "x-file-name": encodeURIComponent(fileName), "x-file-kind": kind } },
      );
      return saved ? { status: "saved", ...saved } : { status: "cancelled" };
    },
    readDroppedFile: (path) => invoke("read_dropped_file", { path }),
    microphoneStatus: () => invoke("microphone_status"),
    requestMicrophoneAccess: () => invoke("request_microphone_access"),
    cameraStatus: () => invoke("camera_status"),
    requestCameraAccess: () => invoke("request_camera_access"),
    wsSub: (rooms) => invoke("ws_sub", { rooms }),
    wsUnsub: (rooms) => invoke("ws_unsub", { rooms }),
    wsTyping: (channelId) => invoke("ws_typing", { channelId }),
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
    vaultRename: (name, newName) => invoke("vault_rename", { name, newName }),
    vaultSearch: (query) => invoke("vault_search", { query }),
    vaultPath: () => invoke("vault_path"),
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
 *  - Plain browser in production: the web client served by writform-server
 *    itself — same-origin fetch + WebSocket (webBackend.ts).
 */
const inTauri = "__TAURI_INTERNALS__" in window;

export const backend: Backend = inTauri
  ? tauriBackend()
  : import.meta.env.DEV
    ? (await import("./devPreview")).devPreviewBackend()
    : (await import("./webBackend")).webBackend();

/** True only in the browser dev preview (never in the desktop app). */
export const isDevPreview = !inTauri && import.meta.env.DEV;

/** True in the browser web client served by writform-server. */
export const isWeb = !inTauri && !import.meta.env.DEV;

/** True inside the native iOS/Android shell (a Tauri build, not the mobile
 *  web client). Desktop-only surfaces — updater, relaunch, window badge —
 *  check this; haptics exist only here. */
export const isMobileApp = inTauri && /iPhone|iPad|iPod|Android/.test(navigator.userAgent);

/**
 * URL into the app's custom `writform-att` protocol, in the shape THIS
 * platform's webview can actually load. macOS and Linux take the scheme
 * as-is; Windows' WebView2 refuses bare custom schemes, so Tauri serves the
 * same handler from `http(s)://writform-att.localhost` there — matching the
 * page's own protocol, hence location.protocol.
 */
export function attProtocolUrl(path: string): string {
  return navigator.userAgent.includes("Windows")
    ? `${location.protocol}//writform-att.localhost/${path}`
    : `writform-att://${path}`;
}

/** URL for an attachment, valid on the current platform. Desktop rides the
 *  pinned `writform-att` protocol; the web client fetches same-origin
 *  (authenticated by the path-scoped cookie for <img>-style loads). */
export function attachmentUrl(id: number): string {
  return inTauri ? attProtocolUrl(`attachment/${id}`) : `/api/v1/attachments/${id}`;
}

/** Documents store attachment image URLs written by whichever platform made
 *  them; re-point any known shape at the current platform's at render time. */
export function normalizeAttachmentSrc(src: string): string {
  const m =
    /^(?:writform-att:\/\/attachment|https?:\/\/writform-att\.localhost\/attachment|\/api\/v1\/attachments)\/(\d+)$/.exec(
      src,
    );
  return m ? attachmentUrl(Number(m[1])) : src;
}
