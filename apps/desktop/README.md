# WritForm desktop client

Tauri 2 + React + TypeScript. See the [repository README](../../README.md) for
what WritForm is and how to build it; this file only covers this package's
layout.

- `src/apps/` — one directory per built-in app (chat, sessions, documents,
  canvas, voice, friends, notes, plugins, settings), each registered on the
  internal platform layer in `src/platform/`
- `src/bindings/proto/` — TypeScript types generated from
  `crates/writform-proto`; regenerate with `npm run bindings` after changing
  the Rust types, never hand-edit
- `src-tauri/` — the Rust core: pinned-TLS networking, the WebSocket client,
  the local server host (`host.rs`), and Tauri commands the webview calls
  into. All network I/O lives here — the webview never talks to the network
  directly
- `src/lib/devPreview.ts` — an in-memory mock backend used only in
  `npm run dev` outside Tauri, so UI can be iterated on in a browser; stripped
  from production builds

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
and
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
extensions.
