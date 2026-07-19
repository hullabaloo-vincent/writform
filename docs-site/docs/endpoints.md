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
| GET/PATCH | `/auth/me` | display name, avatar, accent color |
| GET | `/auth/devices` · DELETE `/auth/devices/{id}` | per-device sessions |

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

## Voice, canvas, friends, misc

| Method | Path |
| --- | --- |
| GET/POST | `/groups/{id}/voice` · POST `/voice/{id}/join` · `/voice/leave` · `/voice/{id}/signal` |
| GET/POST | `/groups/{id}/boards` · `/boards/{id}/elements` · PATCH/DELETE `/elements/{id}` |
| GET | `/link-preview?url=` (server-fetched page metadata) |
| GET/POST/DELETE | `/friends`, `/friends/requests`, `/dms` |
| POST | `/notes/share` |
| GET/PUT | `/plugins/{id}/data/{scope}/{scope_id}/{key}` |
| GET | `/admin/stats` · `/admin/users` · POST `/admin/users/{id}/logout` |

The full wire types live in `crates/writform-proto` and are exported to
TypeScript for the client — the source of truth if you're building against
the API.
