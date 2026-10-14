# Where this engine came from

The crates under `crates/` (all but `crates/wasm`) are derived from **PdfCraft 0.7.1**
(https://github.com/storytold/pdfcraft, commit 7437bde3), Copyright (c) 2026 ArtCraft Team and the
PdfCraft contributors, used under the MIT License or the Apache License, Version 2.0, at your
option. Both licences are here in full: `LICENSE-MIT`, `LICENSE-APACHE`.

This is a modified copy, kept and changed on its own from here on. It is not PdfCraft, and it is
not affiliated with or endorsed by its authors. The PdfCraft and ArtCraft names and logos are
trademarks of their owners and are not used by this project.

## What was taken

Ten crates, renamed from `pdfcraft-*` to `wfpdf-*`: filters, crypt, cos, content, model, fonts,
organize, annot, forms, edit. Nothing else of the project (its interface, renderer, signing,
scripting, printing, or any artwork or font file) is here.

## What was changed

- **No font is built in.** The original embeds two typefaces for typed signatures and can embed
  more from a separate checkout at build time. This copy embeds none: `CRAFT_FONTS` is empty, and
  the typed-signature outlines (`script_outline` and what goes with it) are removed.
- **Its name is out of what it writes.** The comment that wraps a page's own drawing, the name of
  a shaped font, the seed of a generated file identifier, and five messages no longer say
  PdfCraft. Private names in the files it writes that begin `PC` are kept as they were, so files
  made by either can be read by both.
- **A tick box with no appearances of its own** (some programs write them so) is on the first
  time it is ticked. The original left it off until it was ticked a second time.
- **Tests.** Three font tests read a typeface from this repository (Carlito, SIL OFL 1.1) in
  place of the one they shipped with. One writer test is skipped: it checks a third-party parser
  that needs a patch the original carries and this copy does not.
- The workspace, its manifest and its build profile are this project's own.

`crates/wasm` is this project's own work: the surface the app calls.
