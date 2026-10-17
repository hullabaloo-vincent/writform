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
- `GET /api/v1/fonts/{id}/{file}` (auth required): a file of the open font
  catalog (Fontsource's mirror of the Google Fonts library). `id` is a
  catalog family id (`[a-z0-9-]`), `file` is `{subset}-{weight}-{normal|
  italic}.ttf`; anything else is 400, so the path is never a client-chosen
  URL. On a miss the server fetches `cdn.jsdelivr.net/fontsource/fonts/
  {id}@latest/{file}` (20 s timeout, 32 MB cap, must be a font by its
  magic bytes), stores it under `{data}/fonts/` (1 GiB cap, least recently
  written dropped first) and serves its own copy from then on.
  `WRITFORM_FONT_PROXY=off` stops fetching (404 `font_proxy_off`; cached
  files are still served). Desktop and mobile clients ask this route first
  when connected, then — if the user's online-library switch is on — the CDN
  directly; the browser client only ever asks this route.
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

**Document schema levels.** The CRDT carries the editor's own structure, and
an editor bound to structure its schema doesn't know deletes it — for every
collaborator. So each document has a `schema_level` (the newest vocabulary
its content uses; 1 = everything through 1.0.6), and the server keeps
clients below it away from the content: `?sl=N` on detail, `updates` and
`snapshot` (absent = 1), 403 `client_too_old` below the document's level.
A client reads the level of each edit off the Yjs transaction
(`apps/desktop/src/editor/schema/levels.ts`) and sends it with the update
when it is above the document's; the server raises the document in the same
statement that accepts the update. Updates above level 1 are broadcast to
`docv{level}:{id}`, which only clients that understand that level join;
clients left in `document:{id}` when a document is raised get
`document.deleted {doc_id, outdated: level}` instead — every release closes
the editor on that, so an older client's unsent edits stay clean and replay
after it updates. A server never stores a level above its own web client's
(`GET /document-capabilities`), and a newer app on an older server holds its
documents to the server's level.

Level 5 (after 1.2.1) adds `cid` on paragraphs and headings: a chapter's
hidden id, 8 base36 characters, which the story plan (the document's `plan`
map) ties its cards and events to. A heading gets one only when something
in the plan is put in its chapter, so a document is only raised to level 5
when its plan uses chapters. A heading copied in the same document gives
its id up, and one pasted from another document arrives without one.

Level 4 (1.2.1) adds a chapter's own art on its heading (`art`,
`artFacing`), a paragraph's tab stops (`tabs`), the marks `caps {v}` and
`letterSpacing {pt}`, an underline's `kind` and `c`, a doubled strike
(`dbl`), a table's `align` and `ind`, a row's `h` and `keep`, a cell's `va`,
and a picture's `crop` and `rot`.

Level 3 (after 1.1.0) adds `bdr` on `tableCell` (the cell's own lines, one
string of `<side>:<points>:<#rrggbb>` parts, a side of no thickness meaning
"no line here") and, on images, `bdr` (an outline, `"<points> <#rrggbb>"`)
and `round` (how round the corners are, a percentage of the shorter side up
to 50). A document is only raised to it when it uses one of them.

Level 2 (1.1.0) adds formatting on a run of text — marks
`fontFamily {f}`, `fontSize {pt}`, `textColor {c}`, `highlight {c}`,
`vscript {v}`, one property each so concurrent changes merge — paragraph
attributes `indL`, `indR`, `indF` (negative = hanging), `lineRule`/`lineAt`,
`keepNext`, `keepLines`, `shade`, `bdr`; `taskList`/`taskItem {checked}`; and
`marker` on bullet lists; tables (`table {cols, head, lines}` — column widths
are one string on the table, not an array on each cell — of `tableRow` of
`tableCell {colspan, rowspan, bg}`); `footnote {kind}`, an inline node whose
content is the note's own text; a `toc {depth}` block; `align` and `caption`
on images; and `sect` (a section starts here: one encoded string) and
`colBreak` on paragraphs. Lengths are points, colors `#rrggbb`, every value
a primitive (a border is one encoded string). Tracked changes are level 2 as
well: the marks `insertion {a, t}` and `deletion {a, t}` on text (who, and
when in seconds since 1970), and — since the sync engine keeps marks on text
only — one attribute, `tc`, on everything else that can be added or removed:
on a paragraph or heading it speaks of the paragraph break before it, on an
image, table, divider, line break, code block, footnote or contents block of
the node itself. `tc` is one string, `ins:<when>:<who>` or `del:<when>:<who>`
(both, on separate lines, when one person's addition is another's deletion).
Which mode a person is in — editing, suggesting, viewing — is theirs alone
and is not stored. A document's paragraph styles are not content: they live in its
`styles` map beside `settings`, and a paragraph names one in the level-1
`element` attribute, so older clients keep the name and draw body text.
