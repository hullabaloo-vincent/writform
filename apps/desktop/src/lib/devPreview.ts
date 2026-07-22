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
  interface PreviewUser {
    id: number;
    username: string;
    display_name: string | null;
    avatar_attachment_id: number | null;
    accent_color: string | null;
    status?: string;
  }
  const me: PreviewUser = {
    id: 1,
    username: "you",
    display_name: null,
    avatar_attachment_id: null,
    accent_color: null,
  };
  const pal: PreviewUser = {
    id: 2,
    username: "inkfriend",
    display_name: "Ink Friend",
    avatar_attachment_id: null,
    accent_color: "#93d3a2",
  };
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
    creator: PreviewUser;
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
    style: string;
    from_id: number | null;
    to_id: number | null;
    updated_by: number;
    updated_at: number;
  }
  let boards: PreviewBoard[] = [];
  let boardElements: PreviewElement[] = [];

  // --- documents fixtures (CRDT sync is stubbed: single-user local edits) ---
  interface PreviewDoc {
    id: number;
    owner: PreviewUser;
    title: string;
    format: string;
    folder_id: number | null;
    created_at: number;
    updated_at: number;
  }
  let previewDocs: { document: PreviewDoc; my_access: string }[] = [
    {
      document: {
        id: 60,
        owner: pal,
        title: "Waterpark quest outline",
        format: "manuscript",
        folder_id: null,
        created_at: Date.now() - 86_400_000,
        updated_at: Date.now() - 3_600_000,
      },
      my_access: "read",
    },
  ];
  let docFolders: { id: number; name: string; created_at: number }[] = [
    { id: 70, name: "Drafts", created_at: Date.now() - 172_800_000 },
  ];
  const docSeqs: Record<number, number> = {};
  const docVersions: Record<number, unknown[]> = {};
  const docThreads: Record<number, unknown[]> = {};
  const docShares: Record<number, unknown[]> = {};
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
        reactions: [],
        created_at: Date.now() - 60_000,
        edited_at: null,
      },
    ],
    2: [],
  };
  /** message id -> emoji -> reacting user ids. */
  const previewReactions: Record<number, Record<string, number[]>> = {};
  const emitReactions = (messageId: number) => {
    let channelId = 0;
    for (const [cid, list] of Object.entries(messages)) {
      if ((list as { id: number }[]).some((mm) => mm.id === messageId)) channelId = Number(cid);
    }
    const grouped = Object.entries(previewReactions[messageId] ?? {}).map(([emoji, ids]) => ({
      emoji,
      count: ids.length,
      user_ids: ids,
      users: ids.map((id) => (id === me.id ? "you" : "Ink Friend")),
    }));
    setTimeout(
      () =>
        emit(`channel:${channelId}`, "message.reactions", {
          channel_id: channelId,
          message_id: messageId,
          reactions: grouped,
        }),
      20,
    );
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
    if ((match = m(/^\/api\/v1\/groups\/(\d+)$/)) && method === "PATCH") {
      const gid = Number(match[1]);
      const group = groups.find((g) => g.id === gid) as
        | (typeof groups)[number]
        | undefined;
      if (!group) return { status: 404, body: { code: "no_such_group", message: "not found" } };
      const req = body as {
        name: string | null;
        icon_attachment_id: number | null;
        accent_color: string | null;
      };
      if (req.name) group.name = req.name;
      (group as Record<string, unknown>).icon_attachment_id = req.icon_attachment_id;
      (group as Record<string, unknown>).accent_color = req.accent_color;
      setTimeout(
        () =>
          emit(`group:${gid}`, "group.updated", {
            group_id: gid,
            name: group.name,
            icon_attachment_id: req.icon_attachment_id,
            accent_color: req.accent_color,
          }),
        30,
      );
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
      return { status: 200, body: { online: [me.id], busy: [pal.id] } };
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
    if ((match = m(/^\/api\/v1\/messages\/(\d+)$/)) && method === "DELETE") {
      const mid = Number(match[1]);
      for (const [cid, list] of Object.entries(messages)) {
        const idx = (list as { id: number }[]).findIndex((msg) => msg.id === mid);
        if (idx >= 0) {
          list.splice(idx, 1);
          setTimeout(
            () =>
              emit(`channel:${cid}`, "message.deleted", {
                message_id: mid,
                channel_id: Number(cid),
              }),
            30,
          );
          break;
        }
      }
      return { status: 204, body: null };
    }
    if (path === "/api/v1/auth/status" && method === "PUT") {
      const req = body as { status: string };
      me.status = req.status;
      return {
        status: 200,
        body: { id: 1, username: "you", display_name: null, is_server_admin: true, avatar_attachment_id: null, accent_color: null, status: req.status, bio: null, created_at: 0 },
      };
    }
    if ((match = m(/^\/api\/v1\/users\/(\d+)\/profile$/)) && method === "GET") {
      const uid = Number(match[1]);
      const u = uid === 2 ? pal : me;
      return {
        status: 200,
        body: {
          id: uid,
          username: u.username,
          display_name: u.display_name,
          avatar_attachment_id: null,
          accent_color: u.accent_color ?? null,
          bio: uid === 2 ? "Ink-stained collaborator. Writes at dawn." : null,
          status: uid === 2 ? "busy" : "online",
          created_at: 1700000000000,
        },
      };
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
        body: { id: 1, username: "you", display_name: null, is_server_admin: true, avatar_attachment_id: null, accent_color: null, status: "online", bio: null, created_at: 0 },
      };
    }
    if (path === "/api/v1/auth/me" && method === "PATCH") {
      const req = body as { display_name: string | null };
      if (session) session.user.display_name = req.display_name;
      return {
        status: 200,
        body: { id: 1, username: "you", display_name: req.display_name, is_server_admin: true, avatar_attachment_id: null, accent_color: null, status: "online", bio: null, created_at: 0 },
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
            user: { id: 1, username: "you", display_name: null, is_server_admin: true, avatar_attachment_id: null, accent_color: null, status: "online", bio: null, created_at: 0 },
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
      const card = {
        id: nextId++,
        channel_id: req.channel_id,
        author: me,
        kind: "session",
        content: JSON.stringify({ session_id: session.id, title: req.title }),
        reply_to_id: null,
        attachments: [],
        created_at: Date.now(),
        edited_at: null,
      };
      (messages[req.channel_id] ??= []).push(card);
      setTimeout(() => emit(`channel:${req.channel_id}`, "message.created", card), 30);
      return { status: 200, body: session };
    }
    if ((match = m(/^\/api\/v1\/sessions\/(\d+)$/)) && method === "DELETE") {
      const sid = Number(match[1]);
      const idx = sessions.findIndex((s) => s.id === sid);
      if (idx >= 0) {
        sessions.splice(idx, 1);
        setTimeout(() => emit(`session:${sid}`, "session.deleted", { session_id: sid }), 30);
      }
      return { status: 204, body: null };
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

    if (path.startsWith("/api/v1/link-preview?") && method === "GET") {
      const url = decodeURIComponent(path.split("url=")[1] ?? "");
      return {
        status: 200,
        body: {
          url,
          title: "Example page title",
          description: "A short description of the linked page.",
          image_url: null,
        },
      };
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

    // --- documents ---
    if ((path === "/api/v1/documents" || path.startsWith("/api/v1/documents?")) && method === "GET") {
      const q = decodeURIComponent(path.split("q=")[1] ?? "").toLowerCase();
      const results = q
        ? previewDocs.filter((d) => d.document.title.toLowerCase().includes(q))
        : previewDocs;
      return { status: 200, body: results };
    }
    if (path === "/api/v1/documents" && method === "POST") {
      const req = body as { title: string; format: string };
      const document: PreviewDoc = {
        id: nextId++,
        owner: me,
        title: req.title,
        format: req.format || "none",
        folder_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      previewDocs = [{ document, my_access: "owner" }, ...previewDocs];
      return { status: 200, body: document };
    }
    if (path === "/api/v1/document-folders" && method === "GET") {
      return {
        status: 200,
        body: docFolders.map((f) => ({
          ...f,
          document_count: previewDocs.filter((d) => d.document.folder_id === f.id).length,
        })),
      };
    }
    if (path === "/api/v1/document-folders" && method === "POST") {
      const folder = {
        id: nextId++,
        name: (body as { name: string }).name,
        created_at: Date.now(),
      };
      docFolders.push(folder);
      return { status: 200, body: { ...folder, document_count: 0 } };
    }
    if ((match = m(/^\/api\/v1\/document-folders\/(\d+)$/))) {
      const fid = Number(match[1]);
      const folder = docFolders.find((f) => f.id === fid);
      if (!folder) return { status: 404, body: { code: "no_such_folder", message: "preview" } };
      if (method === "PATCH") {
        folder.name = (body as { name: string }).name;
        return { status: 200, body: { ...folder, document_count: 0 } };
      }
      docFolders = docFolders.filter((f) => f.id !== fid);
      for (const d of previewDocs) {
        if (d.document.folder_id === fid) d.document.folder_id = null;
      }
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/document-folders\/(\d+)\/share$/)) && method === "POST") {
      const fid = Number(match[1]);
      const req = body as { subject_kind: string; subject_id: number; access: string };
      const inFolder = previewDocs.filter((d) => d.document.folder_id === fid);
      return {
        status: 200,
        body: inFolder.map((d) => ({
          doc_id: d.document.id,
          subject_kind: req.subject_kind,
          subject_id: req.subject_id,
          subject_name: req.subject_kind === "user" ? "Ink Friend" : "Preview Group",
          access: req.access,
          created_at: Date.now(),
        })),
      };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/move$/)) && method === "POST") {
      const did = Number(match[1]);
      const entry = previewDocs.find((d) => d.document.id === did);
      if (!entry) return { status: 404, body: { code: "no_such_document", message: "preview" } };
      entry.document.folder_id = (body as { folder_id: number | null }).folder_id;
      return { status: 200, body: entry.document };
    }
    if (m(/^\/api\/v1\/admin\/users\/(\d+)\/reset-code$/) && method === "POST") {
      return {
        status: 200,
        body: { code: "ABCDE-FGHJK", expires_at: Date.now() + 3_600_000 },
      };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)$/))) {
      const did = Number(match[1]);
      const entry = previewDocs.find((d) => d.document.id === did);
      if (!entry) return { status: 404, body: { code: "no_such_document", message: "preview" } };
      if (method === "GET") {
        return {
          status: 200,
          body: {
            document: entry.document,
            my_access: entry.my_access,
            state_b64: "",
            seq: docSeqs[did] ?? 0,
          },
        };
      }
      if (method === "PATCH") {
        const req = body as { title?: string | null; format?: string | null };
        if (req.title) entry.document.title = req.title;
        if (req.format) entry.document.format = req.format;
        entry.document.updated_at = Date.now();
        setTimeout(() => emit(`document:${did}`, "document.meta", { ...entry.document }), 30);
        return { status: 200, body: entry.document };
      }
      if (method === "DELETE") {
        previewDocs = previewDocs.filter((d) => d.document.id !== did);
        setTimeout(() => emit(`document:${did}`, "document.deleted", { doc_id: did }), 30);
        return { status: 204, body: null };
      }
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/updates/))) {
      const did = Number(match[1]);
      if (method === "POST") {
        docSeqs[did] = (docSeqs[did] ?? 0) + 1;
        return { status: 200, body: { seq: docSeqs[did] } };
      }
      return { status: 200, body: { updates: [], truncated: false } };
    }
    if (m(/^\/api\/v1\/documents\/(\d+)\/awareness$/)) {
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/snapshot$/)) && method === "POST") {
      const did = Number(match[1]);
      const req = body as { doc_json: string; name?: string | null };
      const meta = {
        id: nextId++,
        doc_id: did,
        kind: req.name ? "named" : "auto",
        name: req.name ?? null,
        created_by: me,
        created_at: Date.now(),
      };
      docVersions[did] = [{ meta, doc_json: req.doc_json }, ...(docVersions[did] ?? [])];
      return { status: 200, body: meta };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/versions$/)) && method === "GET") {
      const did = Number(match[1]);
      return {
        status: 200,
        body: (docVersions[did] ?? []).map((v) => (v as { meta: unknown }).meta),
      };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/versions\/(\d+)$/)) && method === "GET") {
      const did = Number(match[1]);
      const vid = Number(match[2]);
      const v = (docVersions[did] ?? []).find(
        (x) => (x as { meta: { id: number } }).meta.id === vid,
      );
      if (!v) return { status: 404, body: { code: "no_such_version", message: "preview" } };
      return { status: 200, body: v };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/shares$/))) {
      const did = Number(match[1]);
      if (method === "PUT") {
        const req = body as { subject_kind: string; subject_id: number; access: string };
        const share = {
          doc_id: did,
          subject_kind: req.subject_kind,
          subject_id: req.subject_id,
          subject_name: req.subject_kind === "user" ? "Ink Friend" : "Preview Group",
          access: req.access,
          created_at: Date.now(),
        };
        docShares[did] = [
          ...(docShares[did] ?? []).filter(
            (s) =>
              (s as { subject_kind: string; subject_id: number }).subject_kind !==
                req.subject_kind ||
              (s as { subject_id: number }).subject_id !== req.subject_id,
          ),
          share,
        ];
        return { status: 200, body: share };
      }
      return { status: 200, body: docShares[did] ?? [] };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/shares\/(\w+)\/(\d+)$/)) && method === "DELETE") {
      const did = Number(match[1]);
      docShares[did] = (docShares[did] ?? []).filter(
        (s) =>
          (s as { subject_kind: string }).subject_kind !== match![2] ||
          (s as { subject_id: number }).subject_id !== Number(match![3]),
      );
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/documents\/(\d+)\/threads$/))) {
      const did = Number(match[1]);
      if (method === "POST") {
        const req = body as {
          content: string;
          anchor_b64?: string | null;
          head_b64?: string | null;
          excerpt?: string | null;
        };
        const thread = {
          id: nextId++,
          doc_id: did,
          author: me,
          anchor_b64: req.anchor_b64 ?? null,
          head_b64: req.head_b64 ?? null,
          excerpt: req.excerpt ?? null,
          resolved: false,
          created_at: Date.now(),
          messages: [] as unknown[],
        };
        thread.messages.push({
          id: nextId++,
          thread_id: thread.id,
          author: me,
          content: req.content,
          created_at: Date.now(),
        });
        docThreads[did] = [...(docThreads[did] ?? []), thread];
        setTimeout(() => emit(`document:${did}`, "document.thread.created", thread), 30);
        return { status: 200, body: thread };
      }
      return { status: 200, body: docThreads[did] ?? [] };
    }
    if ((match = m(/^\/api\/v1\/document-threads\/(\d+)\/replies$/)) && method === "POST") {
      const tid = Number(match[1]);
      for (const threads of Object.values(docThreads)) {
        const thread = threads.find((t) => (t as { id: number }).id === tid) as
          | { id: number; doc_id: number; messages: unknown[] }
          | undefined;
        if (thread) {
          const message = {
            id: nextId++,
            thread_id: tid,
            author: me,
            content: (body as { content: string }).content,
            created_at: Date.now(),
          };
          thread.messages.push(message);
          setTimeout(
            () =>
              emit(`document:${thread.doc_id}`, "document.thread.replied", {
                doc_id: thread.doc_id,
                message,
              }),
            30,
          );
          return { status: 200, body: message };
        }
      }
      return { status: 404, body: { code: "no_such_thread", message: "preview" } };
    }
    if ((match = m(/^\/api\/v1\/document-threads\/(\d+)$/))) {
      const tid = Number(match[1]);
      for (const [didStr, threads] of Object.entries(docThreads)) {
        const thread = threads.find((t) => (t as { id: number }).id === tid) as
          | { id: number; resolved: boolean }
          | undefined;
        if (thread) {
          const did = Number(didStr);
          if (method === "PATCH") {
            thread.resolved = (body as { resolved: boolean }).resolved;
            setTimeout(() => emit(`document:${did}`, "document.thread.updated", { ...thread }), 30);
            return { status: 200, body: thread };
          }
          docThreads[did] = threads.filter((t) => (t as { id: number }).id !== tid);
          setTimeout(
            () =>
              emit(`document:${did}`, "document.thread.deleted", {
                doc_id: did,
                thread_id: tid,
              }),
            30,
          );
          return { status: 204, body: null };
        }
      }
      return { status: 404, body: { code: "no_such_thread", message: "preview" } };
    }

    // --- reactions ---
    if ((match = m(/^\/api\/v1\/messages\/(\d+)\/reactions$/)) && method === "POST") {
      const mid = Number(match[1]);
      const emoji = (body as { emoji: string }).emoji;
      const set = previewReactions[mid] ?? (previewReactions[mid] = {});
      set[emoji] = set[emoji] ?? [];
      if (!set[emoji].includes(me.id)) set[emoji].push(me.id);
      emitReactions(mid);
      return { status: 204, body: null };
    }
    if ((match = m(/^\/api\/v1\/messages\/(\d+)\/reactions\/(.+)$/)) && method === "DELETE") {
      const mid = Number(match[1]);
      const emoji = decodeURIComponent(match[2]);
      const set = previewReactions[mid];
      if (set?.[emoji]) {
        set[emoji] = set[emoji].filter((u) => u !== me.id);
        if (set[emoji].length === 0) delete set[emoji];
      }
      emitReactions(mid);
      return { status: 204, body: null };
    }
    if (m(/^\/api\/v1\/boards\/(\d+)\/cursor$/) && method === "POST") {
      return { status: 204, body: null }; // no peers in the preview
    }

    return { status: 404, body: { code: "mock_unhandled", message: `mock: ${method} ${path}` } };
  };

  return {
    apiFetch: async (method, path, body) => {
      await delay(120);
      return mockApi(method.toUpperCase(), path, body);
    },
    // The browser engine prompts on getUserMedia, so there is no native
    // gate to pre-authorize in the preview.
    readDroppedFile: async () => {
      throw { code: "mock", message: "native drag-drop needs the real app" } as CmdError;
    },
    microphoneStatus: async () => "authorized",
    requestMicrophoneAccess: async () => "authorized",
    cameraStatus: async () => "authorized",
    requestCameraAccess: async () => "authorized",
    saveExport: async (fileName, dataBase64) => {
      // Browser preview: a plain download.
      const bin = atob(dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return "your browser's downloads folder";
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
    async vaultSearch(query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const nameHits: { name: string; snippet: string; modified_at: number }[] = [];
      const contentHits: typeof nameHits = [];
      for (const [name, v] of Object.entries(vault)) {
        if (name.toLowerCase().includes(needle)) {
          nameHits.push({ name, snippet: "", modified_at: v.mtime });
        } else {
          const pos = v.content.toLowerCase().indexOf(needle);
          if (pos >= 0) {
            const start = Math.max(0, pos - 40);
            const end = Math.min(v.content.length, pos + needle.length + 40);
            contentHits.push({
              name,
              snippet: `${start > 0 ? "…" : ""}${v.content
                .slice(start, end)
                .replace(/\s+/g, " ")
                .trim()}${end < v.content.length ? "…" : ""}`,
              modified_at: v.mtime,
            });
          }
        }
      }
      return [...nameHits, ...contentHits].slice(0, 50);
    },
    async vaultPath() {
      return "/preview/vault";
    },
    async vaultRename(name, newName) {
      const old = name.trim();
      const next = newName.trim();
      if (old.toLowerCase() !== next.toLowerCase() && vault[next]) {
        throw { code: "name_taken", message: `a note named "${next}" already exists` } as CmdError;
      }
      const note = vault[old];
      if (!note) throw { code: "io", message: "note not found" } as CmdError;
      delete vault[old];
      vault[next] = note;
      const target = old.toLowerCase();
      for (const [n, v] of Object.entries(vault)) {
        vault[n] = {
          ...v,
          content: v.content.replace(
            /\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g,
            (raw, link: string, label = "") =>
              link.trim().toLowerCase() === target ? `[[${next}${label}]]` : raw,
          ),
        };
      }
      return next;
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
          avatar_attachment_id: null,
          accent_color: null,
          status: "online",
          bio: null,
          created_at: Date.now(),
        },
      };
      return session;
    },
    async register(addr, username) {
      return this.login(addr, username, "");
    },
    async resetPassword() {
      await delay(300);
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
