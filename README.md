# WritForm

Self-hosted group creative-writing sessions: run your own server, connect with the
desktop app by IP + port, and write together — Discord-style groups and chat, timed
WYSIWYG writing prompts with full session history, friends & DMs, and an
Obsidian-compatible personal notes vault.

Every feature is an "app" on an internal platform layer (dock, UI slots, command
palette), and third-party plugins use the exact same extension points — see
[docs/plugin-api.md](docs/plugin-api.md).

## Layout

| Path | What |
|------|------|
| `crates/writform-proto` | Shared wire types (serde + ts-rs → generated TS bindings) |
| `crates/writform-crypto` | Post-quantum identity (ML-DSA-65), PBKDF2 passwords, tokens |
| `crates/writform-server` | Self-hostable axum server (SQLite, single binary, TLS) |
| `apps/desktop` | Tauri 2 desktop client (React + TypeScript) |
| `examples/plugins` | Example third-party plugin(s) |
| `docs/` | Protocol, crypto, plugin-API, and canvas-phase specs |
| `deploy/` | systemd unit; `Dockerfile` at the repo root |

## Built-in apps

💬 **Chat** — groups (invite codes, roles, kick), channels, messages with image
attachments, presence. ✍️ **Sessions** — a session holds multiple rich-text
prompts; each is started/timed/stopped by its creator, everyone writes privately,
writings reveal when the prompt ends, side chat throughout, full history browsable.
🎨 **Canvas** — group storyboards: sticky notes, text, frames, connectors, live
multi-user editing. 👥 **Friends** — requests, DMs, note sharing. 📝 **Notes** —
local-first markdown vault (Obsidian-compatible files), wiki-links + backlinks,
share snapshots to friends. 🧩 **Plugins** — enable third-party plugins with
per-plugin permissions.

## Development

Prereqs: Rust (see `rust-toolchain.toml`), Node 24+, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
# server (HTTPS on :7311; identity fingerprint printed at startup)
cargo run -p writform-server -- --data-dir ./tmp-data

# desktop app
cd apps/desktop && npm install && npm run tauri dev

# checks (same as CI)
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test
cd apps/desktop && npm run build

# regenerate TS bindings after changing writform-proto
cd apps/desktop && npm run bindings
```

Generated bindings in `apps/desktop/src/bindings/proto/` are committed; CI fails if
they drift from the Rust types.

## Self-hosting & updates

- **Easiest — no server admin at all:** open the desktop app and pick **"Host on
  this computer"** on the welcome screen. It runs a full server inside the app
  (data under the app's data directory), makes you the server admin, and shows
  shareable addresses in Settings → Server — including one-click UPnP port
  mapping for internet access, with port-forward/Tailscale guidance when the
  router refuses.
- **Docker:** `docker run -p 7311:7311 -v writform-data:/data ghcr.io/valiquo/writform-server`
- **Bare metal:** grab `writform-server` from GitHub Releases + `deploy/writform-server.service`
- Upgrading = pull the new image / binary and restart; SQLite migrations run at startup.
- Desktop releases are built by CI on tag push and published to GitHub Releases
  (auto-update via the Tauri updater once signing keys are configured — see
  `.github/workflows/release.yml` for the one-time setup).

## Security model (short version)

Clients pin a self-hosted server on first connect (TOFU): TLS 1.3 with hybrid
X25519+ML-KEM-768 key exchange (FIPS 203), plus an ML-DSA-65 (FIPS 204) server
identity key whose signature binds the TLS certificate — verified on every
connect, so a changed identity is a loud warning. Passwords are
PBKDF2-HMAC-SHA-512; session tokens are opaque and stored hashed. All client
network I/O runs in the Tauri Rust core (the webview cannot pin certificates).
Details in [docs/crypto.md](docs/crypto.md).
