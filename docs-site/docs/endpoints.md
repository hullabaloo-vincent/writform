# Endpoints

Everything is JSON over HTTPS at `/api/v1/`, authenticated with
`Authorization: Bearer <token>` (login/register return the token). Mutations
happen over REST, and a WebSocket at `/api/v1/ws` fans out change events.
The rule is "REST is truth, WS is invalidation."

## Auth & profile

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | first account becomes server admin |
| POST | `/auth/login` · `/auth/logout` | rate-limited per IP+username |
| GET/PATCH | `/auth/me` | display name, avatar, accent color, bio |
| PUT | `/auth/status` | online / busy / hidden |
| POST | `/auth/reset-password` | redeem an admin-issued one-time code |
| GET | `/auth/devices` · DELETE `/auth/devices/{id}` | per-device sessions |
| GET | `/users/{id}/profile` | public profile card |

## Groups, channels, messages

| Method | Path |
| --- | --- |
| GET/POST | `/groups` · PATCH `/groups/{id}` (admin: name/icon/color) |
| GET | `/groups/{id}/members` · `/groups/{id}/presence` |
| POST | `/groups/{id}/invites` · `/invites/redeem` |
| GET/POST | `/groups/{id}/channels` · `/channels/{id}/messages` (`?before=` / `?after=`) |
| PATCH/DELETE | `/messages/{id}` (author, and admins may delete) |
| GET/POST/DELETE | `/groups/{id}/emotes` |
| POST | `/attachments` (multipart) · GET `/attachments/{id}` |

## Sessions

| Method | Path |
| --- | --- |
| POST | `/sessions` (posts a join card to the channel) |
| GET | `/channels/{id}/sessions` · `/sessions/{id}` |
| POST | `/sessions/{id}/end` · DELETE `/sessions/{id}` (creator/admin) |
| POST | `/sessions/{id}/prompts` · `/prompts/{id}/start` · `/prompts/{id}/stop` |
| PUT | `/prompts/{id}/submission` (autosave while running) |

## Documents

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/documents` | list (own + shared) with each document's `word_count` and `excerpt`. `?q=` searches titles and the documents' words (not their JSON), and each hit has a `snippet` |
| GET/PATCH/DELETE | `/documents/{id}` | detail (Yjs state, with `?quiet=1` for bulk reads that shouldn't log "opened"), rename/reformat, delete (owner), which moves it to Recently Deleted |
| POST | `/documents/{id}/restore` | put a document back from Recently Deleted (owner) |
| GET | `/document-trash` | the caller's Recently Deleted, newest first, with `deleted_at` |
| DELETE | `/document-trash/{id}` | delete one for good (owner) |
| POST | `/document-trash/empty` | empty Recently Deleted |
| GET/POST | `/documents/{id}/updates` | Yjs update log with `?since=` catch-up (`truncated` past 16 MiB: reload the state). One update may be up to 4 MiB, and a larger one is 413 `update_too_large` |
| POST | `/documents/{id}/awareness` | ephemeral cursor/selection presence |
| POST | `/documents/{id}/snapshot` | version-history snapshot (auto, named or draft). Also refreshes the list's text, word count and excerpt |
| GET | `/documents/{id}/versions` · `/documents/{id}/versions/{vid}` | version history |
| GET/PUT/DELETE | `/documents/{id}/shares` · `/documents/{id}/shares/{kind}/{id}` | read/write grants (friends or groups) |
| POST | `/documents/{id}/move` | move into/out of a folder |
| GET/POST | `/documents/{id}/threads` | anchored feedback threads |
| PATCH/DELETE | `/document-threads/{id}` | resolve/reopen, delete |
| POST | `/document-threads/{id}/replies` | reply to a thread |
| GET/POST | `/document-folders` | list/create folders |
| PATCH/DELETE | `/document-folders/{id}` | rename/delete (documents keep, unfoldered) |
| POST | `/document-folders/{id}/share` | share every document in a folder at once |
| GET | `/document-capabilities` | `max_schema_level`: the newest document schema level this server stores (404 on servers before levels = 1) |

Deleted documents read as missing everywhere (404 to owner and
collaborators alike, no room, no images) until restored. After 30 days the
server deletes them for good. Lists change live: the owner's devices get
`document.listchanged` (create, rename, move, delete, restore) and
`document.folders` (folder changes) on their user room, and an open
document's room gets `document.deleted`.

**Schema levels.** Every document has a `schema_level`: the newest
vocabulary (node types, marks, attributes) its content uses. Level 1 is
everything through 1.0.6. An editor bound to content newer than its schema
deletes what it doesn't know, for everyone, so the content routes (detail,
`updates` both ways, and `snapshot`) take the client's level as `?sl=N`
(absent = 1) and answer 403 `client_too_old` below the document's. An update
that needs a newer level says so (`schema_level` in the body, at most the
sender's `sl` and the server's `max_schema_level`, else 400
`schema_unsupported`), and accepting it raises the document in the same
step. From level 2 up, `document.update` is sent to `docv{level}:{id}`
instead of `document:{id}`. Clients left in the plain room get
`document.deleted` with `outdated: <level>` when a document is raised, and
never the newer content. Level 2 is text colour, highlight, a font or size
on part of a paragraph, sub/superscript, paragraph indents, borders and
shading, checklists, tables, footnotes and endnotes, a table of contents,
picture placement and captions, sections, and tracked changes.

## Voice, canvas, friends, misc

| Method | Path |
| --- | --- |
| GET/POST | `/groups/{id}/voice` · POST `/voice/{id}/join` · `/voice/leave` · `/voice/{id}/signal` |
| GET/POST | `/groups/{id}/boards` · `/boards/{id}/elements` · PATCH/DELETE `/elements/{id}` |
| GET | `/link-preview?url=` (server-fetched page metadata) |
| GET | `/fonts/{family}/{subset}-{weight}-{style}.ttf` (a font of the online library that the server fetches once and keeps, so browsers never ask a third party) |
| GET/POST/DELETE | `/friends`, `/friends/requests`, `/dms` |
| POST | `/notes/share` |
| GET/PUT | `/plugins/{id}/data/{scope}/{scope_id}/{key}` |
| GET | `/admin/stats` · `/admin/users` · POST `/admin/users/{id}/logout` · `/admin/users/{id}/reset-code` |

The full wire types live in `crates/writform-proto` and are exported to
TypeScript for the client. They are the source of truth if you're building
against the API.
