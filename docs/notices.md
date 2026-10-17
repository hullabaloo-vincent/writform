# Third-party notices

Notices for material that ships inside the app and is not our own.

## VarCon (the spelling table of the Check panel)

`apps/desktop/src/proof/data/en/variants.ts` is derived from VarCon, part of
the SCOWL project (github.com/en-wl/wordlist), by
`apps/desktop/tools/build-varcon.mjs`. It is a modified version: only words
up to SCOWL level 70 are kept, possessives and rows that are true of one
sense only are left out, and the format is our own.

```
Copyright 2000-2019 by Kevin Atkinson

Permission to use, copy, modify, distribute and sell this array, the
associated software, and its documentation for any purpose is hereby
granted without fee, provided that the above copyright notice appears
in all copies and that both that copyright notice and this permission
notice appear in supporting documentation. Kevin Atkinson makes no
representations about the suitability of this array for any
purpose. It is provided "as is" without express or implied warranty.

Copyright 2016 by Benjamin Titze

Permission to use, copy, modify, distribute and sell this array, the
associated software, and its documentation for any purpose is hereby
granted without fee, provided that the above copyright notice appears
in all copies and that both that copyright notice and this permission
notice appear in supporting documentation. Benjamin Titze makes no
representations about the suitability of this array for any
purpose. It is provided "as is" without express or implied warranty.

Since the original words lists come from the Ispell distribution:

Copyright 1993, Geoff Kuenning, Granada Hills, CA
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. All modifications to the source code must be clearly marked as
   such.  Binary redistributions based on modified source code
   must be clearly marked as modified versions in the documentation
   and/or other materials provided with the distribution.
(clause 4 removed with permission from Geoff Kuenning)
5. The name of Geoff Kuenning may not be used to endorse or promote
   products derived from this software without specific prior
   written permission.

THIS SOFTWARE IS PROVIDED BY GEOFF KUENNING AND CONTRIBUTORS ``AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL GEOFF KUENNING OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

## LibreOffice's autocorrect list (corrections as you type)

`apps/desktop/src/editor/autocorrect/data/enLibreOffice.ts` is derived from
the English autocorrect lists of LibreOffice (the LibreOffice project's
`core` repository, `extras/source/autocorr/lang/en-US/DocumentList.xml` and
`lang/en-GB/DocumentList.xml`, as they stood at commit `44dcf332` on
13 October 2026), by `apps/desktop/tools/build-autocorrect.mjs`.

It is a modified version, a selection of 827 of the list's 2,473 entries in
a format of our own. Left out: the names for signs (":smile:"), the patterns
for arrows and the like, slips that run over two words, entries that change
only a word's capitals or accents, and nine whose "slip" is a word in its
own right (fora, withe, directer and the like). Where the British list gives
another answer than the American one (four entries), that answer is kept
apart and used for English as it is spelled outside North America.

LibreOffice is made available under the Mozilla Public License 2.0, and so
is that one file, whatever the rest of this repository is under. The file
says so at its head. The license is at https://www.mozilla.org/MPL/2.0/ and
the list in its original form at
https://github.com/LibreOffice/core/tree/master/extras/source/autocorr/lang.

The other word lists AutoCorrect uses (`data/en.ts`, `data/symbols.ts`,
`data/capitals.ts` in the same folder) were written for this app.

## The PDF engine (editing PDFs)

`pdf-engine/` is a modified copy of ten crates of **PdfCraft 0.7.1**
(https://github.com/storytold/pdfcraft), Copyright (c) 2026 ArtCraft Team
and the PdfCraft contributors, used under the MIT License or the Apache
License, Version 2.0, at your option. Both licenses are in that folder in
full (`LICENSE-MIT`, `LICENSE-APACHE`), and `pdf-engine/NOTICE.md` says what
was taken and what was changed. It is built to WebAssembly and shipped as
`apps/desktop/src/pdf/engine/pkg/`.

This project is not PdfCraft and is not affiliated with or endorsed by its
authors. The PdfCraft and ArtCraft names and logos are their owners'
trademarks and are not used here. None of its fonts or artwork is included.

## pdf.js data files (reading PDFs)

`apps/desktop/public/pdfjs/` holds data files copied unchanged from the
`pdfjs-dist` package (Mozilla, Apache License 2.0, in `LICENSE` there), which
pdf.js loads when a PDF needs them:

- `cmaps/`: Adobe character maps (BSD 3-Clause, `cmaps/LICENSE`).
- `standard_fonts/`: the Foxit fonts (BSD 3-Clause, `LICENSE_FOXIT`) and the
  Liberation fonts (SIL Open Font License 1.1, `LICENSE_LIBERATION`), used to
  draw PDFs that name a standard font without carrying it.
- `wasm/`: the OpenJPEG, JBIG2 and qcms decoders, each with its license
  beside it.
- `iccs/`: one color profile (CC0, `iccs/LICENSE`).

The part of that package that runs a PDF's own scripts is left out.

## Fonts

The bundled fonts are under the SIL Open Font License 1.1. Each family's
`OFL.txt` is beside its files in `apps/desktop/src/assets/fonts/`.
