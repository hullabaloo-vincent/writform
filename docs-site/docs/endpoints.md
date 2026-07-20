# Endpoints

Everything is JSON over HTTPS at `/api/v1/`, authenticated with
`Authorization: Bearer <token>` (login/register return the token). Mutations
happen over REST; a WebSocket at `/api/v1/ws` fans out change events —
"REST is truth, WS is invalidation."

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
| PATCH/DELETE | `/messages/{id}` (author; admins may delete) |
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
| GET/POST | `/documents` | list (own + shared); `?q=` searches title + content |
| GET/PATCH/DELETE | `/documents/{id}` | detail (Yjs state), rename/reformat, delete (owner) |
| GET/POST | `/documents/{id}/updates` | Yjs update log — `?since=` catch-up |
| POST | `/documents/{id}/awareness` | ephemeral cursor/selection presence |
| POST | `/documents/{id}/snapshot` | version-history snapshot (auto or named) |
| GET | `/documents/{id}/versions` · `/documents/{id}/versions/{vid}` | version history |
| GET/PUT/DELETE | `/documents/{id}/shares` · `/documents/{id}/shares/{kind}/{id}` | read/write grants (friends or groups) |
| POST | `/documents/{id}/move` | move into/out of a folder |
| GET/POST | `/documents/{id}/threads` | anchored feedback threads |
| PATCH/DELETE | `/document-threads/{id}` | resolve/reopen, delete |
| POST | `/document-threads/{id}/replies` | reply to a thread |
| GET/POST | `/document-folders` | list/create folders |
| PATCH/DELETE | `/document-folders/{id}` | rename/delete (documents keep, unfoldered) |
| POST | `/document-folders/{id}/share` | share every document in a folder at once |

## Voice, canvas, friends, misc

| Method | Path |
| --- | --- |
| GET/POST | `/groups/{id}/voice` · POST `/voice/{id}/join` · `/voice/leave` · `/voice/{id}/signal` |
| GET/POST | `/groups/{id}/boards` · `/boards/{id}/elements` · PATCH/DELETE `/elements/{id}` |
| GET | `/link-preview?url=` (server-fetched page metadata) |
| GET/POST/DELETE | `/friends`, `/friends/requests`, `/dms` |
| POST | `/notes/share` |
| GET/PUT | `/plugins/{id}/data/{scope}/{scope_id}/{key}` |
| GET | `/admin/stats` · `/admin/users` · POST `/admin/users/{id}/logout` · `/admin/users/{id}/reset-code` |

The full wire types live in `crates/writform-proto` and are exported to
TypeScript for the client — the source of truth if you're building against
the API.
