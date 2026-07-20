# WritForm wire protocol

Status: **living doc** — kept in sync with `crates/writform-proto`, which is the
machine-checked source of truth (TS bindings are generated from it).

`PROTOCOL_VERSION = 1`. The client sends its version in the WS `auth` frame;
mismatches are rejected with a clear error.

## Transport

- HTTPS + WSS over pinned self-signed TLS (see [crypto.md](crypto.md)).
- REST base path: `/api/v1/`. JSON bodies, `writform_proto::api` types.
- Errors: non-2xx responses carry `ApiError { code, message }` with stable
  machine-readable codes.

## Principles

- **Mutations over REST, fan-out over WS.** The socket carries subscriptions,
  heartbeats, and events only. Missed events are healed by REST refetch on
  reconnect ("REST is truth, WS is invalidation").
- Timestamps are unix **milliseconds** everywhere.
- IDs are numeric (SQLite rowids) wrapped in newtypes in `writform-proto`.

## Endpoints (Phase 0–1)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/v1/healthz` | no | `Healthz` — liveness + server identity preview |
| GET | `/api/v1/identity` | no | `ServerIdentity` — TOFU pinning material |
| POST | `/api/v1/auth/register` | no | `RegisterRequest` → `AuthResponse` |
| POST | `/api/v1/auth/login` | no | `LoginRequest` → `AuthResponse`; rate-limited |
| POST | `/api/v1/auth/logout` | bearer | revokes the presented token |

Later phases add groups, channels, messages, attachments, sessions, friends,
notes-sharing, and plugin-data endpoints; each lands here with its phase.

## WebSocket `/api/v1/ws`

Client frames (`ClientFrame`): `auth {token, protocol_version}` (first frame),
`sub {rooms}` / `unsub {rooms}`, `ping {client_time}`.

Server frames (`ServerFrame`): `ready`, `pong` (carries both clocks for offset
estimation — session countdowns render off server time), generic
`event {room, kind, data}` (e.g. `message.created`, `session.started`), and
`error {code, message}`.

Rooms: `user:{id}` (auto-joined), `group:{id}`, `channel:{id}`, `session:{id}`,
`canvas:{board_id}`, `document:{id}`. Subscription requires membership (or, for
documents, a read/write share); the server validates on `sub`.

## Later additions (post-MVP round)

- `PATCH /api/v1/groups/{id}` (admin): name/icon/accent customization →
  `group.updated` to `group:{id}`.
- `PATCH /api/v1/auth/me` now also takes `avatar_attachment_id` +
  `accent_color`; `UserRef` carries both everywhere it appears.
- `DELETE /api/v1/sessions/{id}` (creator/admin): hard delete incl. side-chat
  channel → `session.deleted` to `session:{id}` + home channel.
- Session creation posts a `kind = "session"` join-card message (content =
  `{"session_id","title"}` JSON) to the home channel.
- Voice: `/api/v1/groups/{id}/voice` (list/create), `/api/v1/voice/{id}`
  (delete), `/join`, `/leave`, `/{id}/signal` — presence in memory, WebRTC
  signaling relayed to `user:{id}` rooms; media is a P2P DTLS-SRTP mesh and
  never touches the server. Events: `voice.channel.created/deleted`,
  `voice.joined/left` (group room), `voice.signal` (user room).
- `GET /api/v1/link-preview?url=` (auth required): the server fetches the page
  (http/https only, 5s timeout, 512KB cap, HTML only, 15-minute in-memory
  cache) and returns `{url, title, description, image_url}` for canvas link
  cards. The endpoint can reach anything the *server* can reach (including
  its LAN) — it is authenticated and intended for trusted friend-servers; do
  not expose a WritForm server to untrusted registration.
- Canvas element kinds now include `image` (attachment id in `text`), `link`
  (URL in `text`), and `document` (JSON `{document_id, mode, anchor_b64?,
  head_b64?}` in `text` — a live reference to a document or a selection
  within it). Elements also carry a `style` field (JSON: size/bold/
  italic/underline/align/list) for sticky/text formatting, and frames use
  `color` the same way stickies do.
- `PUT /api/v1/auth/status` sets `online` / `busy` / `hidden`;
  `GET /api/v1/users/{id}/profile` returns a public profile card. Presence
  fans out to group rooms and to each friend's `user:{id}` room.
- `POST /api/v1/auth/reset-password` redeems a one-time code (minted by a
  server admin via `POST /api/v1/admin/users/{id}/reset-code`) for a new
  password; revokes every existing session for that account.

### Documents

Collaborative documents sync via a Yjs CRDT rather than server-authoritative
rows: clients merge local edits into update batches (Yjs update-v1 encoding,
base64) and `POST /api/v1/documents/{id}/updates`; the server assigns a
per-document `seq`, appends to a log, and broadcasts `document.update
{seq, update_b64, author}` to the `document:{id}` room. Clients apply
incoming updates unconditionally — Yjs updates are idempotent, so retries and
echoes are harmless. `GET /api/v1/documents/{id}/updates?since=N` catches up
after a reconnect; the server periodically compacts the log into a merged
state (`documents.ydoc_state`) and reports `truncated: true` if the requested
tail was pruned, at which point the client re-fetches the full document
instead. Cursor/selection presence goes through
`POST /api/v1/documents/{id}/awareness` and is never persisted.

Version history is separate from the CRDT log: clients POST a TipTap-JSON
snapshot (`/documents/{id}/snapshot`), auto-saved periodically and
deduplicated, or explicitly named. Restoring a version is a normal CRDT edit
(replace the document content), not a server-side operation — so it merges
correctly even if someone else is editing at the same time.

Sharing grants `read` or `write` to a friend or a whole group (which also
posts a `kind = "document"` card to that group's home channel). Feedback
threads anchor to a selection via Yjs relative positions plus a plain-text
excerpt, so a comment still makes sense if the anchored text is later edited
away.

WS events on `document:{id}`: `document.update`, `document.awareness`,
`document.meta`, `document.deleted`, `document.version`,
`document.thread.created/replied/updated/deleted`. `document.listchanged`
fires on a user's or group's room when a share is granted or revoked.
