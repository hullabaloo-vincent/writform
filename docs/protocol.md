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

Rooms: `user:{id}` (auto-joined), `group:{id}`, `channel:{id}`, `session:{id}`.
Subscription requires membership; the server validates on `sub`.
