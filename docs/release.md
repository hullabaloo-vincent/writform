# Release checklist

Releases are cut by the Release workflow (Actions → Release → Run workflow),
which bumps the version, tags and publishes. This is what to check before
pressing it.

## 1. Did the document vocabulary change?

The document format has a **schema level** (see `docs/protocol.md`, "Schema
levels"). A client that doesn't know some vocabulary would delete it for
everyone, so the server refuses clients below a document's level. Two
constants and one table say what this build knows:

| What | Where |
|---|---|
| The vocabulary, level by level | `apps/desktop/src/editor/schema/levels.ts` (`VOCAB`) |
| The newest level the app understands | same file, `DOC_SCHEMA_LEVEL` |
| The newest level the server stores | `crates/writform-proto/src/documents.rs`, `MAX_DOC_SCHEMA_LEVEL` |

Rules:

- **A level that has shipped is frozen.** Never add to, remove from or
  rename anything in the table of a released level.
- **New vocabulary since the last release** (a node, a mark, an attribute)
  goes in the table of the *next* level. If the last release already
  shipped level N, add `LEVEL_{N+1}`, put it in `VOCAB`, and raise **both**
  constants to N+1 in the same commit.
- While a level is unreleased, later work may keep adding to it. **Level 2
  shipped in 1.1.0 and is frozen** (a harness check holds it to what it
  was). Level 3 is open now: it holds a table cell's own borders and a
  picture's outline and rounded corners. **The release that first ships
  level 3 freezes it** — after it, anything new takes level 4. That
  release raises the level, so it is a "server first" release (see 2).
- New attributes default to `null`; values are primitives; lengths are
  points; colours `#rrggbb`. Read them through `editor/schema/sanitize.ts`.

Check: `npm run harness -- schema` fails if the editor's schema uses a
name the tables don't list. The server test
`a_stock_server_reports_this_builds_level` fails if the two constants
disagree.

## 2. Server first

A document raised to a level needs a server that stores it. Tell people to
**update the server before the apps** when a release raises the level
(`docs-site/docs/setup.md`, "Updating a server", says so). A newer app on
an older server simply hides the newer controls; the reverse — an older
app on a document that uses them — is told to update.

## 3. The checks

From `apps/desktop`:

```bash
npx tsc --noEmit && npm run lint && npm run build
```

```bash
npm run harness
```

From the repository root:

```bash
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

```bash
cargo check -p writform-desktop --target aarch64-apple-ios-sim
```

`npm run bindings` after any change to `crates/writform-proto`.

Book output is pinned by `harness/golden/book.json`: `npm run harness --
book` fails if a book's pages or PDF bytes changed. If the change was
meant, run it with `UPDATE_GOLDEN=1` and say so in the release notes —
existing books will repaginate.

## The PDF engine

`pdf-engine/` (the engine PDFs are edited with) is built to WebAssembly by
hand, and the result is committed in `apps/desktop/src/pdf/engine/pkg/`. An
ordinary build never compiles it. After any change under `pdf-engine/`:

```sh
cd pdf-engine && cargo test
cd ../apps/desktop && node tools/build-pdf-engine.mjs
npm run harness -- pdfengine pdfview
```

The build tool needs `wasm-bindgen` at the exact version it names and
`wasm-opt` (binaryen). It refuses a build over 4 MB, or one that needs a
WebAssembly feature Safari 15 lacks. `pdfengine` fails while the committed
build is not the build of the source as it stands. The Rust version is
pinned twice, in `rust-toolchain.toml` and `pdf-engine/rust-toolchain.toml`:
move them together.

After an update of `pdfjs-dist`, copy its `cmaps`, `standard_fonts`, `wasm`
and `iccs` folders over `apps/desktop/public/pdfjs/` again (leaving out
`quickjs-eval.*`). `pdfview` fails until they match.

## 4. By hand

The harnesses can't open the app. Before a release that touches them:

- A Word file exported by the app opens in Word with no repair prompt;
  tracked changes can be accepted and rejected there.
- Print from macOS, Windows and an iPhone.
- PDF import is held by `npm run harness -- pdfimport`, mostly on PDFs this
  app made itself. Before a release that changes it, import a few from
  elsewhere: a Word export, a two-column paper, a statement with tables, a
  scan. Reading a scan's text is the system's own recogniser (Mac, iPhone,
  iPad): `cargo test -p writform-desktop --test ocr` runs it on a real
  picture, on a Mac only.
- Edit a real PDF (a contract, a form): move pages, mark it up, fill it in,
  sign it, save a copy, and open the copy in Preview and in Acrobat. The
  harnesses cannot draw a page, so how the editor looks and how a mark sits
  under the pointer are only ever seen here.
- PDF standards rest on a checklist in the harness, not on a validator.
  Before a release that changes the PDF writer, run veraPDF on an
  **Archive copy** (it should report PDF/A-2b, or PDF/A-3b with the copy
  inside) and a printer's preflight on a **PDF/X-1a** paperback.
- Page view, Suggesting mode and the ribbon on a phone, with the on-screen
  keyboard.
- An older build of the app against a document that uses the newest
  level: it must be told to update, and lose nothing.
- A clean install; an install with a saved server; hosting.

## 5. Notes for people updating

Say in the release notes when: documents repaginate (a layout change);
the schema level rose (update the server first; older apps must update to
open documents that use the new formatting); a migration runs (back up
`/data` first).
