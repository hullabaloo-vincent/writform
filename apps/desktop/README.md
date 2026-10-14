# subScribe client

Tauri 2 + React + TypeScript. One codebase makes the desktop apps (macOS,
Windows, Linux), the iPhone and iPad app, and the browser client a server
serves. See the [repository README](../../README.md) for what subScribe is
and how to build it, and [CONTRIBUTING.md](../../CONTRIBUTING.md) for the
rules the code keeps. This file is a map of this package. ("WritForm" is
the project's working name and is what the code calls itself.)

## `src/`

- `apps/`: one directory per built-in app (home, documents, sessions, chat,
  canvas, notes, friends, settings, the docs viewer, the plugin manager),
  each registered on the platform layer.
- `platform/`: the shell the apps register on. The rail, UI slots, the
  command palette, the shortcut sheet, toasts and dialogs, and the plugin
  host.
- `editor/`: the document editor. Its schema and schema levels (`schema/`),
  marks and nodes, the ribbon and its menus (`ui/`), named styles, tables,
  tracked changes and comments (`review/`), read aloud, and the list of
  editor commands the palette and the shortcut sheet read (`commands/`).
- `doclayout/` and `book/`: the typesetting engine and its two targets. A
  document or a book goes in and a list of positioned glyphs, rules and
  pictures comes out, which is drawn as the PDF, the print job, the preview
  and the on-screen page breaks. It runs in a worker and must not touch the
  DOM.
- `docx/`: reading and writing Word files.
- `proof/`: the Check panel (consistency checks, house-style rules, style
  reports).
- `pdf/`: the PDF editor. `pdf/engine/pkg/` is the committed WebAssembly
  build of `../../pdf-engine`.
- `fonts/`: the font registry, the bundled faces, the online catalog and
  system fonts.
- `stores/`, `connect/`: the session, the connection to a server and the
  steps of joining or hosting one.
- `lib/`: `backend.ts` is the one door to the Rust core and the network.
  Also saving files, uploads, pdf.js loading.
- `bindings/proto/`: TypeScript types generated from
  `crates/writform-proto`. Regenerate with `npm run bindings` after changing
  the Rust types. Never edit them by hand.
- `styles.css`: every app's styles in one file. Classes start with `wf-`.
- `lib/devPreview.ts`: an in-memory stand-in for the server, used only by
  `npm run dev` outside Tauri so the interface can be worked on in a
  browser. It is stripped from production builds.

## `src-tauri/`

The Rust core: pinned-TLS networking and the WebSocket client, on-device
storage for documents, boards, PDFs and notes, the in-app server host
(`host.rs`), system fonts, printing, text recognition, and the Tauri
commands the webview calls. All network I/O lives here. The webview never
talks to the network directly.

## `harness/`

The client's tests: `*.test.ts` files bundled with esbuild and run in Node
(`npm run harness`, or `npm run harness -- docx` for one). `env.ts` supplies
the few browser globals modules need at import, `dom.ts` a jsdom for
harnesses that mount a real editor. `golden/` holds the hashes book output
is held to.

## `tools/`

Scripts that make committed files: the PDF engine's WebAssembly build
(`build-pdf-engine.mjs`) and the spelling table for the Check panel
(`build-varcon.mjs`). Ordinary builds run neither.

## Scripts

| Command | What it does |
|------|------|
| `npm run tauri dev` | The desktop app, with hot reload |
| `npm run dev` | The interface alone in a browser, on the stand-in backend |
| `npm run build` | Type-check and build the client (`dist/`, which a server can serve with `--web-dir`) |
| `npm run lint` | ESLint over `src` |
| `npm run harness` | The test harnesses |
| `npm run bindings` | Regenerate the wire types from `crates/writform-proto` |
| `npm run tauri ios dev` | The iOS app on a simulator or a plugged-in device |

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
and
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
extensions.
