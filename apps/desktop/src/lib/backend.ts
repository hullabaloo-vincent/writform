/**
 * Typed wrappers around the Tauri commands (the only path to the network —
 * all HTTP happens in the Rust core over pinned TLS).
 *
 * When running in a plain browser (vite dev without Tauri), a lightweight
 * mock backs the same API so UI work doesn't require the native shell.
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
  logout(): Promise<void>;
  currentSession(): Promise<SessionInfo | null>;
  apiFetch(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  uploadAttachment(opts: {
    dataBase64?: string;
    filePath?: string;
    fileName?: string;
  }): Promise<ApiResponse>;
  wsSub(rooms: string[]): Promise<void>;
  wsUnsub(rooms: string[]): Promise<void>;
  /** Subscribe to WS frames; returns an unsubscribe fn. */
  onWsEvent(handler: (event: WsEvent) => void): () => void;

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
    logout: () => invoke("logout"),
    currentSession: () => invoke("current_session"),
    apiFetch: (method, path, body) => invoke("api_fetch", { method, path, body: body ?? null }),
    uploadAttachment: ({ dataBase64, filePath, fileName }) =>
      invoke("upload_attachment", {
        dataBase64: dataBase64 ?? null,
        filePath: filePath ?? null,
        fileName: fileName ?? null,
      }),
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

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;
  for (const m of content.matchAll(re)) links.push(m[1].trim());
  return links;
}

/** In-browser mock: approximates the flow for UI development only. */
function mockBackend(): Backend {
  let servers: SavedServer[] = [];
  let session: SessionInfo | null = null;
  let pending: SavedServer | null = null;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // --- tiny in-memory chat world for UI development ---
  const wsHandlers = new Set<(e: WsEvent) => void>();
  const emit = (room: string, kind: string, data: unknown) => {
    for (const h of wsHandlers) h({ ev: "event", room, kind, data });
  };
  let nextId = 100;
  const me = { id: 1, username: "you", display_name: null };
  const pal = { id: 2, username: "inkfriend", display_name: "Ink Friend" };
  const groups = [
    { id: 1, name: "Writers Guild", owner_id: 2, my_role: "member", created_at: 0 },
  ];
  const channels = [
    { id: 1, group_id: 1, kind: "text", name: "general", position: 0 },
    { id: 2, group_id: 1, kind: "text", name: "prompts", position: 1 },
  ];
  interface MockPrompt {
    id: number;
    session_id: number;
    creator_id: number;
    position: number;
    prompt_doc: unknown;
    timer_seconds: number | null;
    state: string;
    started_at: number | null;
    ends_at: number | null;
    ended_at: number | null;
  }
  const sessions: {
    id: number;
    channel_id: number;
    creator: typeof me;
    title: string;
    state: string;
    chat_channel_id: number;
    created_at: number;
    ended_at: number | null;
  }[] = [];
  const prompts: MockPrompt[] = [];
  const vault: Record<string, { content: string; mtime: number }> = {
    Welcome: {
      content: "# Welcome\n\nThis is your vault. Link notes like [[Ideas]].\n",
      mtime: Date.now() - 100000,
    },
    Ideas: { content: "# Ideas\n\n- a story about rain\n\nBack to [[Welcome]].\n", mtime: Date.now() },
  };
  const submissions: {
    id: number;
    prompt_id: number;
    author: typeof me;
    doc: unknown;
    updated_at: number;
  }[] = [];
  const messages: Record<number, unknown[]> = {
    1: [
      {
        id: 1,
        channel_id: 1,
        author: pal,
        kind: "text",
        content: "welcome to the guild! ✍️",
        reply_to_id: null,
        attachments: [],
        created_at: Date.now() - 60_000,
        edited_at: null,
      },
    ],
    2: [],
  };
  const mockApi = (method: string, path: string, body: unknown): ApiResponse => {
    const m = (re: RegExp) => path.match(re);
    let match: RegExpMatchArray | null;
    if (method === "GET" && path === "/api/v1/groups") {
      return { status: 200, body: groups };
    }
    if (method === "POST" && path === "/api/v1/groups") {
      const group = {
        id: nextId++,
        name: (body as { name: string }).name,
        owner_id: me.id,
        my_role: "admin",
        created_at: Date.now(),
      };
      groups.push(group);
      const general = { id: nextId++, group_id: group.id, kind: "text", name: "general", position: 0 };
      channels.push(general);
      messages[general.id] = [];
      return { status: 200, body: group };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/channels$/)) && method === "GET") {
      const gid = Number(match[1]);
      return { status: 200, body: channels.filter((c) => c.group_id === gid) };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/channels$/)) && method === "POST") {
      const gid = Number(match[1]);
      const channel = {
        id: nextId++,
        group_id: gid,
        kind: "text",
        name: (body as { name: string }).name.toLowerCase().replace(/ /g, "-"),
        position: channels.length,
      };
      channels.push(channel);
      messages[channel.id] = [];
      emit(`group:${gid}`, "channel.created", channel);
      return { status: 200, body: channel };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/members$/)) && method === "GET") {
      return {
        status: 200,
        body: [
          { user: pal, role: "admin", joined_at: 0 },
          { user: me, role: "member", joined_at: 0 },
        ],
      };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/presence$/)) && method === "GET") {
      return { status: 200, body: { online: [me.id, pal.id] } };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/emotes$/)) && method === "GET") {
      return { status: 200, body: [] };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/invites$/)) && method === "POST") {
      return {
        status: 200,
        body: { code: "mock1234", expires_at: null, max_uses: null, use_count: 0, revoked: false },
      };
    }
    if ((match = m(/^\/api\/v1\/channels\/(\d+)\/messages$/)) && method === "GET") {
      // Copy: the real backend serializes over IPC, so callers never share
      // references with server state. The mock must behave the same.
      return { status: 200, body: [...(messages[Number(match[1])] ?? [])] };
    }
    if ((match = m(/^\/api\/v1\/channels\/(\d+)\/messages$/)) && method === "POST") {
      const cid = Number(match[1]);
      const message = {
        id: nextId++,
        channel_id: cid,
        author: me,
        kind: "text",
        content: (body as { content: string }).content,
        reply_to_id: null,
        attachments: [],
        created_at: Date.now(),
        edited_at: null,
      };
      (messages[cid] ??= []).push(message);
      setTimeout(() => emit(`channel:${cid}`, "message.created", message), 30);
      return { status: 200, body: message };
    }
    if (path === "/api/v1/invites/redeem" && method === "POST") {
      return { status: 400, body: { code: "invalid_invite", message: "mock: unknown invite" } };
    }

    // --- sessions ---
    if ((match = m(/^\/api\/v1\/channels\/(\d+)\/sessions$/)) && method === "GET") {
      const cid = Number(match[1]);
      return { status: 200, body: sessions.filter((s) => s.channel_id === cid) };
    }
    if (path === "/api/v1/sessions" && method === "POST") {
      const req = body as { channel_id: number; title: string };
      const chat = { id: nextId++, group_id: 1, kind: "session", name: `session: ${req.title}`, position: 999 };
      channels.push(chat);
      messages[chat.id] = [];
      const session = {
        id: nextId++,
        channel_id: req.channel_id,
        creator: me,
        title: req.title,
        state: "active",
        chat_channel_id: chat.id,
        created_at: Date.now(),
        ended_at: null,
      };
      sessions.push(session);
      return { status: 200, body: session };
    }
    if ((match = m(/^\/api\/v1\/sessions\/(\d+)$/)) && method === "GET") {
      const sid = Number(match[1]);
      const session = sessions.find((s) => s.id === sid);
      if (!session) return { status: 404, body: { code: "no_such_session", message: "mock" } };
      return {
        status: 200,
        body: {
          session: { ...session },
          prompts: prompts.filter((p) => p.session_id === sid).map((p) => ({ ...p })),
          submissions: submissions
            .filter((sub) => {
              const p = prompts.find((pp) => pp.id === sub.prompt_id);
              return p?.session_id === sid && (p?.state === "ended" || sub.author.id === me.id);
            })
            .map((s) => ({ ...s })),
        },
      };
    }
    if ((match = m(/^\/api\/v1\/sessions\/(\d+)\/prompts$/)) && method === "POST") {
      const sid = Number(match[1]);
      const req = body as { prompt_doc: unknown; timer_seconds: number | null };
      const prompt = {
        id: nextId++,
        session_id: sid,
        creator_id: me.id,
        position: prompts.length,
        prompt_doc: req.prompt_doc,
        timer_seconds: req.timer_seconds,
        state: "draft",
        started_at: null as number | null,
        ends_at: null as number | null,
        ended_at: null as number | null,
      };
      prompts.push(prompt);
      setTimeout(() => emit(`session:${sid}`, "prompt.created", { ...prompt }), 30);
      return { status: 200, body: { ...prompt } };
    }
    if ((match = m(/^\/api\/v1\/prompts\/(\d+)\/start$/)) && method === "POST") {
      const prompt = prompts.find((p) => p.id === Number(match![1]));
      if (!prompt) return { status: 404, body: { code: "no_such_prompt", message: "mock" } };
      prompt.state = "running";
      prompt.started_at = Date.now();
      prompt.ends_at = prompt.timer_seconds ? Date.now() + prompt.timer_seconds * 1000 : null;
      if (prompt.ends_at) {
        setTimeout(() => {
          if (prompt.state === "running") {
            prompt.state = "ended";
            prompt.ended_at = Date.now();
            emit(`session:${prompt.session_id}`, "prompt.ended", {
              session_id: prompt.session_id,
              prompt_id: prompt.id,
              reason: "timer",
            });
          }
        }, prompt.timer_seconds! * 1000);
      }
      setTimeout(
        () =>
          emit(`session:${prompt.session_id}`, "prompt.started", {
            session_id: prompt.session_id,
            prompt_id: prompt.id,
            started_at: prompt.started_at,
            ends_at: prompt.ends_at,
          }),
        30,
      );
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/prompts\/(\d+)\/stop$/)) && method === "POST") {
      const prompt = prompts.find((p) => p.id === Number(match![1]));
      if (!prompt) return { status: 404, body: { code: "no_such_prompt", message: "mock" } };
      prompt.state = "ended";
      prompt.ended_at = Date.now();
      setTimeout(
        () =>
          emit(`session:${prompt.session_id}`, "prompt.ended", {
            session_id: prompt.session_id,
            prompt_id: prompt.id,
            reason: "stopped",
          }),
        30,
      );
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/prompts\/(\d+)\/submission$/)) && method === "PUT") {
      const pid = Number(match[1]);
      const req = body as { doc: unknown };
      const existing = submissions.find((s) => s.prompt_id === pid && s.author.id === me.id);
      if (existing) {
        existing.doc = req.doc;
        existing.updated_at = Date.now();
      } else {
        submissions.push({ id: nextId++, prompt_id: pid, author: me, doc: req.doc, updated_at: Date.now() });
      }
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/sessions\/(\d+)\/end$/)) && method === "POST") {
      const sid = Number(match[1]);
      const session = sessions.find((s) => s.id === sid);
      if (session) {
        session.state = "ended";
        session.ended_at = Date.now();
        for (const p of prompts.filter((p) => p.session_id === sid && p.state === "running")) {
          p.state = "ended";
          p.ended_at = Date.now();
        }
        setTimeout(() => emit(`session:${sid}`, "session.ended", { session_id: sid }), 30);
      }
      return { status: 204, body: null };
    }

    return { status: 404, body: { code: "mock_unhandled", message: `mock: ${method} ${path}` } };
  };

  return {
    apiFetch: async (method, path, body) => {
      await delay(120);
      return mockApi(method.toUpperCase(), path, body);
    },
    uploadAttachment: async () => ({
      status: 400,
      body: { code: "mock", message: "uploads need the real app" },
    }),
    wsSub: async () => {},
    wsUnsub: async () => {},
    onWsEvent: (handler) => {
      wsHandlers.add(handler);
      return () => wsHandlers.delete(handler);
    },
    async vaultList() {
      return Object.entries(vault).map(([name, v]) => ({ name, modified_at: v.mtime }));
    },
    async vaultRead(name) {
      const note = vault[name];
      if (!note) throw { code: "io", message: "note not found" } as CmdError;
      return note.content;
    },
    async vaultWrite(name, content) {
      vault[name] = { content, mtime: Date.now() };
    },
    async vaultDelete(name) {
      delete vault[name];
    },
    async vaultBacklinks(name) {
      const target = name.toLowerCase();
      return Object.entries(vault)
        .filter(
          ([n, v]) =>
            n.toLowerCase() !== target &&
            extractWikiLinks(v.content).some((l) => l.toLowerCase() === target),
        )
        .map(([n]) => n);
    },
    async pluginsList() {
      return [];
    },
    async pluginReadEntry() {
      throw { code: "mock", message: "plugins need the real app" } as CmdError;
    },
    async pluginSetEnabled() {},
    async probeServer(addr) {
      await delay(400);
      if (addr.includes("down")) {
        throw { code: "unreachable", message: "could not reach server (mock)" } as CmdError;
      }
      const normalized = addr.includes(":") ? addr : `${addr}:7311`;
      const known = servers.find((s) => s.addr === normalized);
      const fingerprint = "3f2a-91cc-04b7-e812";
      if (!known) {
        pending = {
          addr: normalized,
          server_name: "Mock Server",
          identity_hash: "aa",
          spki_hash: "bb",
          fingerprint,
          last_username: null,
        };
      }
      return {
        addr: normalized,
        server_name: "Mock Server",
        protocol_version: 1,
        trust: known ? { status: "trusted" } : { status: "new", fingerprint },
      };
    },
    async trustServer(addr) {
      if (pending?.addr === addr) {
        servers.push(pending);
        pending = null;
      }
    },
    async listServers() {
      return servers;
    },
    async removeServer(addr) {
      servers = servers.filter((s) => s.addr !== addr);
    },
    async login(addr, username) {
      await delay(300);
      session = {
        addr,
        user: { id: 1, username, display_name: null, created_at: Date.now() },
      };
      return session;
    },
    async register(addr, username) {
      return this.login(addr, username, "");
    },
    async logout() {
      session = null;
    },
    async currentSession() {
      return session;
    },
  };
}

const inTauri = "__TAURI_INTERNALS__" in window;
export const backend: Backend = inTauri ? tauriBackend() : mockBackend();
export const isMockBackend = !inTauri;
