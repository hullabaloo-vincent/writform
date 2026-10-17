# Contributing to subScribe

Thanks for wanting to help. This page says how to get the project running,
what has to pass before a change goes in, and the handful of rules the
codebase holds itself to. They are few, and each exists because breaking it
once cost something.

"WritForm" is the project's working name and is what the code calls itself.
The product is subScribe.

## Before you start

- For a fix, open a pull request.
- For anything larger, open an issue first and say what you have in mind.
  The app has a lot of moving parts that agree with each other on purpose
  (one layout engine for screen, print and PDF, one document format across
  every client), and a short conversation saves a rewrite.
- A feature that does not need to be in the core may be better as a
  plugin. Plugins use the same extension points the built-in apps do. See
  [docs/plugin-api.md](docs/plugin-api.md).

## Getting it running

You need Rust (rustup reads the version from `rust-toolchain.toml`), Node 24
or newer, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
# a server to connect to (HTTPS on :7311)
cargo run -p writform-server -- --data-dir ./tmp-data

# the desktop app
cd apps/desktop && npm install && npm run tauri dev

# the interface alone in a browser, with a stand-in for the server
cd apps/desktop && npm run dev
```

Most of the app needs no server at all. Documents, books, PDFs, boards and
notes work on the device, so `npm run tauri dev` by itself is enough for
most work on them.

## What has to pass

```sh
# Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# client
cd apps/desktop
npx tsc --noEmit
npm run lint          # one known warning in BoardRoom.tsx, nothing else
npm run build
npm run harness       # every harness
```

CI runs the Rust checks, lint, the build, and a check that the generated
bindings are committed. It does not run the harnesses yet, so run them
yourself. `npm run harness -- docx` runs one by name.

If you changed anything in `crates/writform-proto`, run `npm run bindings`
in `apps/desktop` and commit the result.

## Where things are

| Path | What lives there |
|------|------|
| `crates/writform-server` | The server. Routes in `src/routes/`, SQL migrations in `migrations/`, one test file per area in `tests/` |
| `crates/writform-proto` | Every type that crosses the wire. TypeScript bindings are generated from it |
| `crates/writform-crypto` | Server identity, password hashing, tokens |
| `apps/desktop/src/apps/` | One folder per app: home, documents, sessions, chat, canvas, notes, friends, settings, the docs viewer, the plugin manager |
| `apps/desktop/src/platform/` | The shell every app registers on: the rail, slots, the command palette, the plugin host |
| `apps/desktop/src/editor/` | The document editor: its schema, marks and nodes, the ribbon, tracked changes, styles, tables |
| `apps/desktop/src/doclayout/`, `src/book/` | The typesetting engine and its two targets, a document and a book. It makes the PDF, the print job, the preview and the on-screen page breaks |
| `apps/desktop/src/docx/` | Reading and writing Word files |
| `apps/desktop/src/proof/` | The Check panel: consistency checks and style reports |
| `apps/desktop/src/pdf/`, `pdf-engine/` | The PDF editor, and the engine it runs on |
| `apps/desktop/src/fonts/` | The font registry, the online catalog and system fonts |
| `apps/desktop/src-tauri/` | The apps' Rust core: networking, on-device storage, hosting, printing |
| `apps/desktop/harness/` | The client's tests |
| `docs-site/docs/` | The user guide |
| `docs/` | Specs, the release checklist, third-party notices |

## The rules

### The document format only ever grows

Documents are edited by several people at once, on apps of different ages.
An older app deletes, for everyone, formatting it does not know. So every
node, mark and attribute belongs to a **schema level**, and a document that
uses a newer level cannot be opened by an app or stored by a server that
predates it.

- Never remove or rename anything in the format.
- A level that has shipped in a release is frozen. New formatting goes in
  the next level.
- New attributes default to `null`, and every value is a string, a number, a
  boolean or `null`.
- Values are cleaned where they are read (`editor/schema/sanitize.ts`),
  never refused by the schema.

The tables are in `apps/desktop/src/editor/schema/levels.ts` and the whole
procedure is in [docs/release.md](docs/release.md). Per-document settings
that are not part of the text (page setup, styles, the book's details) live
in maps beside it and need no level.

### The oldest webview is Safari 15

The apps run in the system's webview, and on older Macs and iPhones that is
Safari 15. So no regular-expression lookbehind, no `Array.prototype.at`,
`findLast`, `toSorted`, `structuredClone`, `Object.hasOwn` or
`String.prototype.replaceAll`, and in CSS no `:has()`, no nesting and no
`color-mix`. A harness scans the built files for the syntax that would stop
the app from loading at all.

### The webview never touches the network

All network I/O goes through the Rust core, which pins the server's
identity. Client code calls `backend` (`apps/desktop/src/lib/backend.ts`).
Do not add a `fetch` to another origin.

### The typesetting code has no DOM

Everything under `doclayout/` and `book/engine/` runs in a worker. Nothing
it imports may reach for `window` or `document`, even at import time, or
previews, page view, print and PDF export all stop without an error. After
touching those folders run `npm run harness -- worker`. Book output is held
to golden hashes by `npm run harness -- book`, and a change there that
moves them needs a reason.

### One stylesheet

`apps/desktop/src/styles.css` holds every app's styles. Classes start with
`wf-`. Search the file before you name a new one: a name that is already in
use will restyle another app. A `button` in this app is centered and does
not wrap unless you say otherwise.

### Wording

Text people read, in the interface and in the docs, uses no semicolons and
no em dashes, and avoids the "short phrase, punchy tagline" sentence. Say
what a thing does in plain words. `npm run harness -- copy` checks the
first two on every string in `src` and on the docs.

### What comes from elsewhere

Fonts, word lists, data files and code taken from other projects must be
free for commercial use, and each is recorded with its source and license
in [docs/notices.md](docs/notices.md). If you are not sure a license
allows it, ask before adding it.

### The server's database

A migration is a new numbered file in `crates/writform-server/migrations/`.
Never edit one that has shipped. A change that needs a migration says so in
the pull request, because people who host a server will want a backup
first.

### Phones

The same client runs on iPhone and iPad and in phone browsers. A feature
may be for the desktop only, but what you build must not break the small
layouts. Narrow the window to check.

## Tests

- **Client:** harnesses in `apps/desktop/harness/*.test.ts`, bundled and
  run in Node with jsdom where an editor has to be mounted. There is no
  canvas and no real layout there, so anything measured is given a
  stand-in. Exported files are read back: PDFs with pdf.js, Word files with
  the app's own reader. Add checks to the harness for the area you changed,
  or start a new file beside the others.
- **Server:** integration tests in `crates/writform-server/tests/` boot a
  real server and talk to it.
- **By hand:** how something looks and feels is checked in the running
  app. Say in the pull request what you tried.

## Pull requests

- Keep one change to one pull request.
- Say what it does for the person using the app, then how.
- Update the user guide (`docs-site/docs/features.md`, and `how-to.md` when
  there are steps to follow) in the same pull request as the feature.
- Commit subjects in this repository start with a tag in brackets:
  `[ADD]`, `[FIX]`, `[UPDATE]`.

## Security problems

Please do not open a public issue for a security problem. Report it
privately to the maintainer, through GitHub's "Report a vulnerability" on
the repository's Security tab where that is on.

## License

By contributing you agree that your work is offered under the project's
license. See [License.md](License.md).
