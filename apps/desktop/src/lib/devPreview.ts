/**
 * In-browser development preview backend. This module is imported ONLY when
 * import.meta.env.DEV is true — production bundles never include it.
 */

import type {
  ApiResponse,
  Backend,
  CmdError,
  HostStatus,
  SavedServer,
  SessionInfo,
  WsEvent,
} from "./backend";

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;
  for (const m of content.matchAll(re)) links.push(m[1].trim());
  return links;
}

/** Approximates the server flow in-memory so UI work does not need the native shell. */
export function devPreviewBackend(): Backend {
  let servers: SavedServer[] = [];
  let session: SessionInfo | null = null;
  let pending: SavedServer | null = null;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let host: HostStatus = {
    configured: false,
    running: false,
    port: 7311,
    server_name: "My WritForm Server",
    addr: null,
    fingerprint: null,
    lan_addrs: [],
  };

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
  interface PreviewBoard {
    id: number;
    group_id: number;
    creator: typeof me;
    name: string;
    created_at: number;
  }
  interface PreviewElement {
    id: number;
    board_id: number;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    text: string;
    color: string;
    from_id: number | null;
    to_id: number | null;
    updated_by: number;
    updated_at: number;
  }
  let boards: PreviewBoard[] = [];
  let boardElements: PreviewElement[] = [];
  const voiceChannels: { id: number; group_id: number; name: string; created_at: number }[] = [
    { id: 90, group_id: 1, name: "Lounge", created_at: 0 },
  ];
  let voiceJoined: number | null = null;
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
    if (path === "/api/v1/friends" && method === "GET") {
      return {
        status: 200,
        body: [{ user: pal, since: 0, online: true }],
      };
    }
    if (path === "/api/v1/friends/requests" && method === "GET") {
      return { status: 200, body: { incoming: [], outgoing: [] } };
    }
    if (path === "/api/v1/auth/me" && method === "GET") {
      return {
        status: 200,
        body: { id: 1, username: "you", display_name: null, is_server_admin: true, created_at: 0 },
      };
    }
    if (path === "/api/v1/auth/me" && method === "PATCH") {
      const req = body as { display_name: string | null };
      if (session) session.user.display_name = req.display_name;
      return {
        status: 200,
        body: { id: 1, username: "you", display_name: req.display_name, is_server_admin: true, created_at: 0 },
      };
    }
    if (path === "/api/v1/auth/devices" && method === "GET") {
      return {
        status: 200,
        body: [
          { id: 1, device_label: "this browser", created_at: Date.now() - 86400000, last_seen_at: Date.now(), current: true },
          { id: 2, device_label: "old laptop", created_at: Date.now() - 604800000, last_seen_at: Date.now() - 172800000, current: false },
        ],
      };
    }
    if (m(/^\/api\/v1\/auth\/devices\/\d+$/) && method === "DELETE") {
      return { status: 204, body: null };
    }
    if (path === "/api/v1/admin/stats" && method === "GET") {
      return {
        status: 200,
        body: { users: 2, groups: 1, messages: 12, sessions: 1, attachments_bytes: 348160, online_users: 2 },
      };
    }
    if (path === "/api/v1/admin/users" && method === "GET") {
      return {
        status: 200,
        body: [
          {
            user: { id: 1, username: "you", display_name: null, is_server_admin: true, created_at: 0 },
            device_count: 2,
            online: true,
          },
          {
            user: { id: 2, username: "inkfriend", display_name: "Ink Friend", is_server_admin: false, created_at: 0 },
            device_count: 1,
            online: true,
          },
        ],
      };
    }
    if (m(/^\/api\/v1\/admin\/users\/\d+\/logout$/) && method === "POST") {
      return { status: 204, body: null };
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

    // --- voice ---
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/voice$/)) && method === "GET") {
      const gid = Number(match[1]);
      return {
        status: 200,
        body: voiceChannels
          .filter((c) => c.group_id === gid)
          .map((c) => ({ channel: c, participants: c.id === voiceJoined ? [pal] : [] })),
      };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/voice$/)) && method === "POST") {
      const channel = {
        id: nextId++,
        group_id: Number(match[1]),
        name: (body as { name: string }).name,
        created_at: Date.now(),
      };
      voiceChannels.push(channel);
      setTimeout(() => emit(`group:${channel.group_id}`, "voice.channel.created", channel), 30);
      return { status: 200, body: channel };
    }
    if ((match = m(/^\/api\/v1\/voice\/(\d+)\/join$/)) && method === "POST") {
      voiceJoined = Number(match[1]);
      return { status: 200, body: { participants: [] } };
    }
    if (path === "/api/v1/voice/leave" && method === "POST") {
      voiceJoined = null;
      return { status: 204, body: null };
    }
    if (m(/^\/api\/v1\/voice\/(\d+)\/signal$/) && method === "POST") {
      return { status: 204, body: null };
    }

    // --- canvas boards ---
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/boards$/)) && method === "GET") {
      const gid = Number(match[1]);
      return { status: 200, body: boards.filter((b) => b.group_id === gid) };
    }
    if ((match = m(/^\/api\/v1\/groups\/(\d+)\/boards$/)) && method === "POST") {
      const board = {
        id: nextId++,
        group_id: Number(match[1]),
        creator: me,
        name: (body as { name: string }).name,
        created_at: Date.now(),
      };
      boards.push(board);
      return { status: 200, body: board };
    }
    if ((match = m(/^\/api\/v1\/boards\/(\d+)$/)) && method === "GET") {
      const bid = Number(match[1]);
      const board = boards.find((b) => b.id === bid);
      if (!board) return { status: 404, body: { code: "no_such_board", message: "preview" } };
      return {
        status: 200,
        body: { board, elements: boardElements.filter((e) => e.board_id === bid) },
      };
    }
    if ((match = m(/^\/api\/v1\/boards\/(\d+)$/)) && method === "DELETE") {
      const bid = Number(match[1]);
      boards = boards.filter((b) => b.id !== bid);
      boardElements = boardElements.filter((e) => e.board_id !== bid);
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/boards\/(\d+)\/elements$/)) && method === "POST") {
      const bid = Number(match[1]);
      const req = body as Record<string, unknown>;
      const element = {
        id: nextId++,
        board_id: bid,
        z: boardElements.length,
        updated_by: me.id,
        updated_at: Date.now(),
        ...req,
      };
      boardElements.push(element as (typeof boardElements)[number]);
      setTimeout(() => emit(`canvas:${bid}`, "canvas.element.created", element), 30);
      return { status: 200, body: element };
    }
    if ((match = m(/^\/api\/v1\/elements\/(\d+)$/)) && method === "PATCH") {
      const eid = Number(match[1]);
      const el = boardElements.find((e) => e.id === eid);
      if (!el) return { status: 404, body: { code: "no_such_element", message: "preview" } };
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v !== null && v !== undefined) (el as unknown as Record<string, unknown>)[k] = v;
      }
      el.updated_at = Date.now();
      setTimeout(() => emit(`canvas:${el.board_id}`, "canvas.element.updated", { ...el }), 30);
      return { status: 200, body: { ...el } };
    }
    if ((match = m(/^\/api\/v1\/elements\/(\d+)$/)) && method === "DELETE") {
      const eid = Number(match[1]);
      const el = boardElements.find((e) => e.id === eid);
      if (el) {
        boardElements = boardElements.filter(
          (e) => e.id !== eid && e.from_id !== eid && e.to_id !== eid,
        );
        setTimeout(
          () =>
            emit(`canvas:${el.board_id}`, "canvas.element.deleted", {
              board_id: el.board_id,
              element_id: eid,
            }),
          30,
        );
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
    // The preview "socket" never drops.
    onWsStatus: () => () => {},
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
          server_name: "Preview Server",
          identity_hash: "aa",
          spki_hash: "bb",
          fingerprint,
          last_username: null,
        };
      }
      return {
        addr: normalized,
        server_name: "Preview Server",
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
        user: {
          id: 1,
          username,
          display_name: null,
          is_server_admin: true,
          created_at: Date.now(),
        },
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
    async hostStatus() {
      return host;
    },
    async hostStart(port, serverName) {
      await delay(600);
      host = {
        configured: true,
        running: true,
        port,
        server_name: serverName,
        addr: `127.0.0.1:${port}`,
        fingerprint: "3f2a-91cc-04b7-e812",
        lan_addrs: [`192.168.1.20:${port}`],
      };
      servers.push({
        addr: `127.0.0.1:${port}`,
        server_name: serverName,
        identity_hash: "aa",
        spki_hash: "bb",
        fingerprint: "3f2a-91cc-04b7-e812",
        last_username: null,
      });
      return host;
    },
    async hostStop() {
      host = { ...host, running: false, addr: null, fingerprint: null, lan_addrs: [] };
      return host;
    },
    async hostReachability() {
      await delay(800);
      return {
        lan_addrs: host.lan_addrs,
        upnp: { status: "failed", message: "no UPnP router found (search timed out)" },
      };
    },
  };
}
