// Golden regression for the book pipeline: the laid-out pages (the display
// list) and the PDF bytes for every design preset and the submission
// manuscript, from a fixed synthetic book. Engine and font work must leave
// these exactly as they are — or change them on purpose:
//
//   UPDATE_GOLDEN=1 npm run harness -- book

import { check, finish } from "./env";
import "./dom";

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";

import { familiesFor } from "../src/book/engine/client";
import { TypesetSession, type LayoutRequest, type PrintKind } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { choosePreset, readBook, updateBook } from "../src/book/model/bookMap";
import { buildModel } from "../src/book/model/buildModel";
import { manuscript, prng } from "./manuscript";

const GOLDEN = new URL("../golden/book.json", import.meta.url);
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 24);

const doc = manuscript();
const cases: { name: string; kind: PrintKind; preset: string; patch?: Record<string, unknown> }[] = [
  ...["classic", "literary", "fantasy", "romance", "modern"].map((preset) => ({ name: `paperback ${preset}`, kind: "paperback" as const, preset })),
  { name: "booklet classic", kind: "booklet", preset: "classic" },
  { name: "submission times", kind: "submission-pdf", preset: "classic", patch: { "smf.font": "times" } },
  { name: "submission courier", kind: "submission-pdf", preset: "classic", patch: { "smf.font": "courier" } },
];

const session = new TypesetSession();
const results: Record<string, { pages: number; layout: string; pdf: string }> = {};
const realRandom = Math.random;
for (const c of cases) {
  const ydoc = new Y.Doc();
  choosePreset(ydoc, c.preset);
  updateBook(ydoc, { "meta.title": "The Harbour and the Garden", "meta.author": "A. N. Author", "print.toc": "on", ...c.patch });
  const model = buildModel(doc as never, "manuscript", readBook(ydoc));
  const families = familiesFor(c.kind, model);
  session.addFonts(await loadFontFiles(session.missingFamilies(families)));
  const req: LayoutRequest = { kind: c.kind, model, families, images: [], now: Date.UTC(2026, 9, 10) };
  const { dl } = await session.layout(req);
  // PDFKit tags each font subset with random letters.
  Math.random = prng(7);
  const pdf = await session.pdf(req);
  Math.random = realRandom;
  // The creation date is "now" (its own object), and the file id follows it.
  const bytes = Buffer.from(pdf.bytes)
    .toString("latin1")
    .replace(/\(D:\d{14}Z?\)/g, "(D)")
    .replace(/<xmp:CreateDate>[^<]*<\/xmp:CreateDate>/g, "")
    .replace(/\/ID \[[^\]]*\]/g, "");
  results[c.name] = { pages: dl.pages.length, layout: sha(JSON.stringify(dl)), pdf: sha(bytes) };
}

if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) {
  writeFileSync(GOLDEN, JSON.stringify(results, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(results).length} goldens.`);
  for (const [name, r] of Object.entries(results)) console.log(`  ${name}: ${r.pages} pages`);
} else {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof results;
  for (const [name, r] of Object.entries(results)) {
    const g = golden[name];
    check(`${name}: layout unchanged`, !!g && g.layout === r.layout, g ? `${r.pages} pages (was ${g.pages})` : "no golden");
    check(`${name}: PDF unchanged`, !!g && g.pdf === r.pdf);
  }
  check("no goldens without a case", Object.keys(golden).every((k) => k in results));
}
finish();
