# subScribe

Tired of the ads on Discord?
Have a fun writing/creative group you meet with?
Is your writing group having to use multiple apps for writing sessions, sharing, collaboration, and feedback?
Hate sharing your info with big tech so they can serve you even MORE ads?

For me, that's a yes, yes, yes, and a big ol' YES.

subScribe is a writing suite you own. On your own device, with no account, you get a full word processor, book
publishing, a PDF editor, boards, and an Obsidian-compatible notes vault. With a server one of you runs, you can
write together live, with groups, chat (text, voice, and video), timed writing prompts with full session history,
and friends & DMs. It is fully self-hosted and nothing touches a third-party cloud.

It runs on macOS, Windows, Linux, iPhone and iPad, and in any browser pointed at your own server.

Every feature is an "app" on an internal platform layer (dock, UI slots, command
palette), and third-party plugins use the exact same extension points. See
[docs/plugin-api.md](docs/plugin-api.md).

## What's in it

The full tour is in the [feature guide](docs-site/docs/features.md) and the
[how-to pages](docs-site/docs/how-to.md). The same pages open inside the app
from the Docs icon.

- **Home**: start a document, a board or a note, pick up what you were last
  working on, and see the servers you write on.
- **Documents**: a Word-style editor with a ribbon, named styles, tables,
  footnotes and endnotes, a table of contents, sections, headers and footers,
  page setup, zoom, and a page view that breaks where the printed page does.
  Several people edit one document at once. Suggesting mode tracks changes,
  comments follow the text they are about, and every document keeps its
  version history. Other formats set the page for you: Manuscript,
  screenplay, stage play and poetry.
- **Word and PDF, in and out**: Word files open and save with their styles,
  lists, tables, notes, pictures and tracked changes. PDF export is typeset
  by the app's own layout engine, with tags for screen readers, PDF/A for
  archives and an editable copy inside if you want one. A PDF can be imported
  back into a document with its lists, tables, pictures and page setup, and
  scanned pages are read on Apple devices. Print and booklet printing use
  the same pages.
- **Check**: an editing pass that reads the whole text. It finds what is
  inconsistent (colour and color, short-term and short term, Katherine and
  Kathryn), holds the text to a house style you keep with the document, and
  reports on repeats, sentence length, dialogue, word choice and pace,
  chapter by chapter. Nothing leaves the device.
- **Books**: a Manuscript becomes a typeset paperback interior (PDF/X-1a and
  bleed for a printer), an EPUB, and a submission manuscript. The cover
  editor lays out front, spine and back to the printer's measurements.
- **PDF editor**: open a PDF as the PDF it is. Reorder, turn, add and remove
  pages, mark it up, fill in its form, sign it, and change its text (the
  last is marked Beta).
- **Fonts**: about 2,000 open-licensed families, fetched when a document
  uses one, plus the fonts installed on a desktop.
- **Sessions**: a session holds several rich-text prompts. Each is started,
  timed and stopped by its creator, everyone writes privately, and the
  writing is revealed when the prompt ends. The full history stays browsable.
- **Chat, voice and video**: groups with invite codes and roles, channels,
  markdown, custom emotes, mentions, image attachments and presence. Voice
  and video run peer to peer over WebRTC, so media never touches the server.
  Friends, DMs and profile cards.
- **Canvas**: shared storyboards with notes, shapes, frames, connectors,
  images, sketches, link cards and live references to documents, on as many
  pages as a board needs. Boards can also live on your own device.
- **Notes**: a local-first Markdown vault (Obsidian-compatible files) with
  wiki-links and backlinks. Share a snapshot of a note with a friend.
- **Plugins**: enable third-party plugins with per-plugin permissions.

Everything that needs no one else works with no server: documents, books,
PDFs, boards and notes live on the device, with folders, search, history
and a trash. Publish a document or a board to a server when you want to
share it.

## Install

**Windows / Linux:** grab the installer from
[Releases](https://github.com/hullabaloo-vincent/writform/releases).

**macOS:** build it locally. Notarizing a download needs a paid Apple Developer
account, but apps compiled on your own Mac are never quarantined, so they just
open. Double-click **`scripts/Build subScribe (macOS).command`**. It checks for
Xcode Command Line Tools, Node, and Rust, offers to install anything missing,
and drops the finished app in Applications.

See the [setup guide](docs-site/docs/setup.md) for connecting to or hosting a
server, and for using subScribe in a browser.

## Layout

| Path | What |
|------|------|
| `crates/writform-proto` | Shared wire types (serde + ts-rs → generated TS bindings) |
| `crates/writform-crypto` | Post-quantum identity (ML-DSA-65), PBKDF2 passwords, tokens |
| `crates/writform-server` | Self-hostable axum server (SQLite, single binary, TLS). It also serves the browser client |
| `apps/desktop` | The client (React + TypeScript). One codebase for the Tauri 2 apps and the browser build |
| `apps/desktop/src-tauri` | The apps' Rust core: pinned-TLS networking, on-device storage, in-app hosting, printing, text recognition |
| `apps/desktop/harness` | Test harnesses for the client (Node, no browser needed) |
| `pdf-engine` | The PDF editing engine. A Rust workspace of its own, built to WebAssembly. The built file is committed |
| `examples/plugins` | Example third-party plugins |
| `docs-site` | The user guide. The same pages render inside the app and build into a static site |
| `docs/` | Protocol, crypto and plugin-API specs, the release checklist, third-party notices |
| `deploy/` | systemd unit (the `Dockerfile` is at the repo root) |
| `vendor/` | One patched dependency, kept out of the workspace |

"WritForm" is the project's working name. It lives on in the crate names, the
repository and the app's identifier. The product is called subScribe.

## Development

Prereqs: Rust (the version in `rust-toolchain.toml`, which rustup installs
for you), Node 24+, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
# server (HTTPS on :7311, and it prints its identity fingerprint at startup)
cargo run -p writform-server -- --data-dir ./tmp-data

# desktop app
cd apps/desktop && npm install && npm run tauri dev

# the interface alone in a browser, on an in-memory stand-in for the server
cd apps/desktop && npm run dev
```

The checks:

```sh
# Rust (same as CI)
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace

# client (same as CI)
cd apps/desktop && npm run lint && npm run build

# client harnesses (run them yourself: CI does not yet)
cd apps/desktop && npm run harness            # all of them
cd apps/desktop && npm run harness -- docx    # one, by name

# regenerate TS bindings after changing writform-proto
cd apps/desktop && npm run bindings
```

Generated bindings in `apps/desktop/src/bindings/proto/` are committed, and CI
fails if they drift from the Rust types.

The PDF engine is not built by any of the above. Its WebAssembly build is
committed under `apps/desktop/src/pdf/engine/pkg/`, and only a change inside
`pdf-engine/` calls for rebuilding it. [`docs/release.md`](docs/release.md)
says how.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules the codebase holds itself
to and how to find your way around it.

### iOS

The desktop client also builds as a native iOS app (`src-tauri/gen/apple`
is the committed Xcode project). Prereqs on top of the above: Xcode,
CocoaPods (`brew install cocoapods`), and the Rust targets
(`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`). Signing
uses the development team in `tauri.conf.json` → `bundle.iOS`. Change it
to your own Apple Development team ID (Xcode → Settings → Accounts).

```sh
cd apps/desktop

# run on a simulator, or pick your plugged-in iPhone from the list
npm run tauri ios dev

# device builds want the phone and Mac on the same network for dev
# (the webview loads Vite over LAN). A real .ipa comes from:
npm run tauri ios build
```

On first install to a real device, trust the developer profile under
Settings → General → VPN & Device Management, and enable Developer Mode
(Settings → Privacy & Security). If `tauri ios build` fails at the very
end with `Directory not empty`, clear its stale output first:
`rm -rf src-tauri/gen/apple/build` (this is a CLI packaging quirk and the
Xcode build itself succeeded).

## Self-hosting & updates

- **Easiest (no server admin at all):** open the desktop app and pick **"Host on
  this computer"** on Home. It runs a full server inside the app
  (data under the app's data directory), makes you the server admin, and shows
  shareable addresses in Settings → Server. That includes one-click UPnP port
  mapping for internet access, with port-forward/Tailscale guidance when the
  router refuses.
- **Docker:** `docker run -p 7311:7311 -v writform-data:/data ghcr.io/hullabaloo-vincent/writform-server`
- **Bare metal:** grab `writform-server` from GitHub Releases + `deploy/writform-server.service`
- **In a browser:** the server serves the app itself at `https://your-server:7311/`,
  phones included. The Docker image has it on. A bare-metal server needs
  `--web-dir` pointed at a client build.
- **Behind Cloudflare** (or any proxy or tunnel), so the server's address stays
  private: `WRITFORM_TLS=off` for a tunnel, `WRITFORM_TRUST_PROXY=cloudflare`, and
  the steps in [Networking](docs-site/docs/networking.md#keep-your-servers-address-private).
- **Who can make an account:** anyone, only with an invite code, or no one, chosen
  by a server admin in Settings → Admin (or fixed with `WRITFORM_REGISTRATION`).
- Upgrading = pull the new image / binary and restart. SQLite migrations run at startup.
  Update the server before the apps: a document that uses newer formatting can
  only be stored by a server that knows it.
- Releases are one button: Actions → Release → "Run workflow" picks the version
  bump, commits it, tags, and publishes installers + the server image to GitHub
  Releases/GHCR (auto-update via the Tauri updater once signing keys are
  configured, with the one-time setup in `.github/workflows/release.yml`).
  What to check before pressing it (above all whether the document format's
  schema level has to rise) is in [`docs/release.md`](docs/release.md).

## Security model

Clients pin a self-hosted server on first connect (TOFU): TLS 1.3 with hybrid
X25519+ML-KEM-768 key exchange (FIPS 203), plus an ML-DSA-65 (FIPS 204) server
identity key whose signature binds the TLS certificate. The binding is
checked whenever the app looks a server up, so a changed identity is a loud
warning. A server behind a proxy (whose certificate is the proxy's) needs a
valid public certificate and proves its identity with a fresh signature
before every sign-in. Passwords
are PBKDF2-HMAC-SHA-512. Session tokens are opaque and stored hashed. All
client network I/O runs in the Tauri Rust core (the webview cannot pin
certificates). Details in [docs/crypto.md](docs/crypto.md).

## License and credits

See [License.md](License.md). The bundled fonts, the PDF engine's origin, the
spelling table and everything else that came from elsewhere are listed with
their licenses in [docs/notices.md](docs/notices.md).
