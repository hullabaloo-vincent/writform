// A document kept inside its own PDF, and got back out of it: what goes in
// (the text as it stands, its settings, its pictures), what a hostile file
// in its place cannot do, the PDF that carries it (an archive copy too),
// and the question asked when such a PDF is imported.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import type { JSONContent } from "@tiptap/core";
import { strToU8, zipSync } from "fflate";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { convertFile, importCancelled } from "../src/apps/documents/import/importFile";
import { readPdfSource } from "../src/apps/documents/import/pdfSource";
import { packSource, SOURCE_DESCRIPTION, SOURCE_NAME, SOURCE_TYPE, unpackSource, type SourceError } from "../src/apps/documents/sourceCopy";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { MEDIA_PREFIX } from "../src/docx/read";
import { DOC_SCHEMA_LEVEL } from "../src/editor/schema/levels";
import { buildDocModel } from "../src/doclayout/model";
import { setPdfjs } from "../src/lib/pdfjs";
import { chooseDialog, ConfirmHost } from "../src/platform/confirm";
import { pdfaProblems } from "./pdfa";
import { png, QUAD_JPEG } from "./pix";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
setPdfjs(pdfjs);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (text: string): JSONContent => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, bg: null, bdr: null }, content: [p(t(text))] });
const picture = (src: string, more: Record<string, unknown> = {}): JSONContent => ({ type: "image", attrs: { src, alt: "A pier", ...more } });

const DRAWING = png(12, 10, (x, y) => (x < 6 && y < 5 ? [200, 40, 40] : [250, 250, 240]));
const content: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [t("The Harbour")] },
    p(t("It was a "), t("bright", "bold"), t(" cold day, and the clocks were "), t("striking", "italic"), t(".")),
    picture("att:photo"),
    { type: "table", attrs: { cols: "120 200", head: true, lines: null }, content: [{ type: "tableRow", content: [cell("Ship"), cell("Berth")] }, { type: "tableRow", content: [cell("Maria"), cell("Four")] }] },
    picture("att:drawing", { width: 120 }),
    picture("att:photo", { width: 60 }),
    picture("att:gone"),
    { type: "blockquote", content: [picture("att:gone")] },
    p(t("The end.")),
  ],
};
const maps = {
  settings: { ...DEFAULT_SETTINGS, pageSize: "a4", subject: "A harbour", lang: "en-GB" } as Record<string, unknown>,
  styles: { title: JSON.stringify({ size: 30 }) },
  book: { "meta.title": "The Harbour", "cover.front": "1600x2560 att:cover", "cover.pages": 212 },
};
const files: Record<string, Uint8Array> = { "att:photo": QUAD_JPEG, "att:drawing": DRAWING };
const asked: string[] = [];
const fetchPicture = async (src: string) => {
  asked.push(src);
  return files[src] ?? null;
};

// ---------------------------------------------------- in, and out again

const packed = await packSource({ title: "The Harbour", format: "none", content, maps }, fetchPicture);
{
  check("a document is packed as one file, each picture fetched once", packed.bytes.length > 500 && asked.join() === "att:photo,att:drawing,att:gone", asked.join());
  check("…and the one that couldn't be had is counted", packed.left === 1);
  const copy = unpackSource(packed.bytes, DOC_SCHEMA_LEVEL);
  check("it comes back with its title and its kind", copy.title === "The Harbour" && copy.format === "none");
  const blocks = copy.content.content ?? [];
  check("…its text, formatting and table as they were", JSON.stringify(blocks[1]) === JSON.stringify(content.content![1]) && JSON.stringify(blocks[3]) === JSON.stringify(content.content![3]) && JSON.stringify(blocks[0]) === JSON.stringify(content.content![0]));
  const pictures = blocks.filter((b) => b.type === "image");
  check("…its pictures as the files they were", copy.media.length === 2 && same(copy.media[0].bytes, QUAD_JPEG) && copy.media[0].type === "image/jpeg" && same(copy.media[1].bytes, DRAWING) && copy.media[1].type === "image/png");
  check("…each shown where it was, with what was said of it", pictures.length === 3 && pictures[0].attrs?.src === copy.media[0].key && pictures[1].attrs?.src === copy.media[1].key && pictures[2].attrs?.src === copy.media[0].key && pictures[1].attrs?.width === 120 && pictures[0].attrs?.alt === "A pier" && String(pictures[0].attrs?.src).startsWith(MEDIA_PREFIX));
  check("the picture that was never in it is gone from the text too (not left pointing somewhere)", copy.left === 2 && !JSON.stringify(copy.content).includes("att:"));
  const quote = blocks.find((b) => b.type === "blockquote");
  check("…and a quote that held only that still holds something", JSON.stringify(quote?.content) === JSON.stringify([{ type: "paragraph" }]));
  check("its settings and styles come with it", copy.maps.settings?.pageSize === "a4" && copy.maps.settings?.subject === "A harbour" && copy.maps.styles?.title === maps.styles.title);
  check("a book's cover stays behind (it is artwork kept elsewhere)", copy.maps.book?.["meta.title"] === "The Harbour" && !Object.keys(copy.maps.book ?? {}).some((k) => k.startsWith("cover.")));
}

// ------------------------------------------- somebody else's file instead

{
  const why = (bytes: Uint8Array, level = DOC_SCHEMA_LEVEL): string => {
    try {
      unpackSource(bytes, level);
      return "read";
    } catch (e) {
      return (e as SourceError).code ?? String(e);
    }
  };
  const zip = (said: unknown, more: Record<string, Uint8Array> = {}) => zipSync({ "document.json": strToU8(typeof said === "string" ? said : JSON.stringify(said)), ...more });
  const good = { subscribe: 1, title: "T", format: "none", level: 1, content: { type: "doc", content: [p(t("Hello"))] }, maps: {} };
  check("what is not a zip is not a document", why(strToU8("%PDF-1.7 not a zip at all")) === "source_unreadable" && why(new Uint8Array(0)) === "source_unreadable");
  check("…nor a zip without one in it", why(zipSync({ "notes.txt": strToU8("hello") })) === "source_unreadable");
  check("…nor one that is not ours", why(zip({ ...good, subscribe: undefined })) === "source_unreadable" && why(zip("{broken")) === "source_unreadable" && why(zip({ ...good, content: { type: "paragraph" } })) === "source_unreadable" && why(zip([1, 2])) === "source_unreadable");
  check("one made by a later version says so", why(zip({ ...good, subscribe: 2 })) === "source_newer");
  check("…as does one whose formatting this version does not know", why(zip(good), 1) === "read" && why(zip({ ...good, content: { type: "doc", content: [{ type: "table", content: [] }] } }), 1) === "source_newer" && why(zip({ ...good, content: { type: "doc", content: [{ type: "somethingNew" }] } })) === "source_newer");
  // A few kilobytes that unpack to far more than a document may be.
  const bomb = zipSync({ "document.json": [new Uint8Array(17_000_000).fill(32), { level: 9 }] });
  check("a small file that unpacks to an enormous one is never unpacked", bomb.length < 100_000 && why(bomb) === "source_unreadable", `${bomb.length} bytes`);
  const strange = unpackSource(
    zip(
      { ...good, title: "x".repeat(900), format: "../../etc", content: { type: "doc", content: [p(t("Hello")), picture("pictures/1.png"), picture("pictures/2.png"), picture("https://example.org/track.png"), picture("../secret.png")] }, maps: { settings: { pageSize: "a4", nested: { a: 1 }, list: [1], big: "y".repeat(300_000), fine: 12, "cover.front": "x" }, other: { a: 1 }, styles: "no" } },
      { "pictures/1.png": DRAWING, "pictures/2.png": strToU8("not a picture, whatever its name"), "../secret.png": DRAWING, "pictures/../../up.png": DRAWING, "readme.txt": strToU8("hi") },
    ),
    DOC_SCHEMA_LEVEL,
  );
  check("a title is kept to a title's length, and a kind that is not one is the usual", strange.title.length === 200 && strange.format === "none");
  check("only pictures that are pictures, from where pictures are kept, come out", strange.media.length === 1 && same(strange.media[0].bytes, DRAWING));
  check("…and a picture named from anywhere else is left out of the text", (strange.content.content ?? []).filter((b) => b.type === "image").length === 1 && strange.left === 3 && !JSON.stringify(strange.content).includes("example.org"));
  check("settings keep only plain values of a sensible size, in the maps there are", JSON.stringify(strange.maps) === JSON.stringify({ settings: { pageSize: "a4", fine: 12 } }), JSON.stringify(strange.maps).slice(0, 200));
}

// ------------------------------------------------------------ in a PDF

const session = new TypesetSession();
const model = buildDocModel({ type: "doc", content: [content.content![0], content.content![1], content.content![8]] }, { title: "The Harbour", author: "A. Writer", settings: DEFAULT_SETTINGS, struct: true });
session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
const attach = { name: SOURCE_NAME, type: SOURCE_TYPE, description: SOURCE_DESCRIPTION, bytes: packed.bytes };
const pdfWith = async (more: Partial<DocRequest> = {}, pdf: DocRequest["pdf"] = { pictures: "print", tagged: true, archive: false, source: true }) =>
  (await session.pdf({ kind: "document", doc: model, families: model.families, images: [], pdf, attach, ...more })).bytes;
const carrying = await pdfWith();
const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

await (async () => {
  const doc = await pdfjs.getDocument({ data: carrying.slice(), verbosity: 0 }).promise;
  const attachments = (await doc.getAttachments()) as Map<string, { filename: string; description?: string }> | Record<string, { filename: string; description?: string }>;
  const list = attachments instanceof Map ? [...attachments.values()] : Object.values(attachments ?? {});
  check("the PDF carries the document as one attached file, named and described", list.length === 1 && list[0].filename === SOURCE_NAME && (list[0].description ?? "").includes("subScribe"), JSON.stringify(list.map((a) => [a.filename, a.description])));
  const text = Buffer.from(carrying).toString("latin1");
  check("…said to be what the PDF was made from", text.includes("/AFRelationship /Source") && /\/AF \[\d+ 0 R\]/.test(text) && text.includes("/Subtype /application#2Fzip"));

  const found = await readPdfSource(buffer(carrying));
  check("opened here, the document is found inside", !!found && found.copy.title === "The Harbour" && found.copy.media.length === 2 && JSON.stringify(found.copy.content.content?.[1]) === JSON.stringify(content.content![1]));
  check("…and the PDF is known to be as it was made", found?.changed === false);
  const later = Buffer.from("\n%a note added later\n%%EOF\n", "latin1");
  const marked = new Uint8Array(carrying.length + later.length);
  marked.set(carrying);
  marked.set(later, carrying.length);
  check("one saved again by something else is known to have been changed", (await readPdfSource(buffer(marked)))?.changed === true);

  const bare = await pdfWith({ attach: undefined }, { pictures: "print", tagged: true, archive: false, source: false });
  check("a PDF made without the copy has nothing inside", (await readPdfSource(buffer(bare))) === null && !Buffer.from(bare).toString("latin1").includes("EmbeddedFile"));
  check("…and what is not a PDF has none either", (await readPdfSource(buffer(strToU8("not a PDF")))) === null);
  const folded = await pdfWith({ kind: "document-booklet" });
  check("a booklet's sheets carry no copy", !Buffer.from(folded).toString("latin1").includes("EmbeddedFile"));

  // An archive copy that carries a file is PDF/A-3.
  const kept = await pdfWith({}, { pictures: "print", tagged: true, archive: true, source: true });
  const problems = pdfaProblems(kept, "3b");
  check("an archive copy with the document inside keeps every rule of the part that allows it", problems.length === 0 && Buffer.from(kept).toString("latin1").includes("<pdfaid:part>3</pdfaid:part>"), problems.join(" | "));
  check("…and held to the other part, is found to carry a file", pdfaProblems(kept, "2b").some((x) => x.startsWith("6.8")));
  check("…while the document inside is still found", (await readPdfSource(buffer(kept)))?.copy.title === "The Harbour");

  // Another program's attachment of the same name.
  const forged = { ...attach, bytes: strToU8("nothing of ours") };
  const fake = await pdfWith({ attach: forged });
  let said = "";
  await readPdfSource(buffer(fake)).catch((e) => (said = (e as SourceError).code));
  check("a file of that name that is not a document says so", said === "source_unreadable");
})();

// ------------------------------------- the whole way, as the app does it

await (async () => {
  const { buildExportPdf } = await import("../src/apps/documents/export");
  const said: string[] = [];
  const text: JSONContent = { type: "doc", content: [content.content![0], content.content![1], p(t("Kept, "), { type: "text", text: "struck out", marks: [{ type: "deletion", attrs: { a: "A. Writer", t: 1760000000 } }] }, { type: "text", text: "put in", marks: [{ type: "insertion", attrs: { a: "A. Writer", t: 1760000000 } }] }), content.content![8]] };
  const out = await buildExportPdf(text, "The Harbour", "none", { ...DEFAULT_SETTINGS, pageSize: "a4" }, undefined, () => maps, { pictures: "print", tagged: true, archive: true, source: true }, (m) => said.push(m));
  const found = await readPdfSource(buffer(out.bytes));
  check("exported with the copy asked for, the PDF holds the document and says it is putting it in", said[0] === "Putting the document inside…" && found?.copy.title === "The Harbour" && found.copy.maps.settings?.pageSize === "a4" && out.pages === 1, said.join(" | "));
  check("…with suggested changes taken as accepted", !!found && !JSON.stringify(found.copy.content).includes("struck out") && JSON.stringify(found.copy.content).includes("put in") && !JSON.stringify(found.copy.content).includes("insertion"), JSON.stringify(found?.copy.content).slice(0, 300));
  check("…and is the archive copy that may carry it", pdfaProblems(out.bytes, "3b").length === 0, pdfaProblems(out.bytes, "3b").join(" | "));
  const without = await buildExportPdf(text, "The Harbour", "none", DEFAULT_SETTINGS, undefined, () => maps, { pictures: "print", tagged: true, archive: false, source: false }, () => {});
  check("not asked for, nothing is put inside", (await readPdfSource(buffer(without.bytes))) === null);

  // A script is set on its format's own page, but what is kept is the script.
  const scene: JSONContent = { type: "doc", content: [{ type: "paragraph", attrs: { element: "scene" }, content: [t("INT. HARBOUR OFFICE. DAY")] }, { type: "paragraph", attrs: { element: "action" }, content: [t("Rain on the glass.")] }] };
  const script = await buildExportPdf(scene, "Tide", "screenplay", undefined, undefined, () => ({}), { pictures: "print", tagged: false, archive: false, source: true }, () => {});
  const kept = (await readPdfSource(buffer(script.bytes)))?.copy;
  check("a screenplay's copy is the screenplay as written, not its pages", kept?.format === "screenplay" && kept.content.content?.[0].attrs?.element === "scene" && JSON.stringify(kept.content).includes("Rain on the glass."), JSON.stringify(kept?.content).slice(0, 160));
})();

// ------------------------------------------------- asked, on the way in

await (async () => {
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(ConfirmHost)));
  const box = () => document.body.querySelector(".wf-confirm") as HTMLElement | null;
  const button = (label: string) => [...(box()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === label);
  const click = async (label: string) =>
    act(async () => {
      button(label)!.click();
      await wait(5);
    });
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 400 && !test(); i += 1) await act(async () => wait(10));
  };

  // The dialog itself.
  let picked: string | null | undefined;
  void chooseDialog("Which way?", [{ id: "a", label: "This way" }, { id: "b", label: "That way" }], { title: "A choice" }).then((id) => (picked = id));
  await until(() => !!box());
  check("a choice is asked with a way out and each way forward", !!button("Cancel") && !!button("This way") && !!button("That way") && box()?.querySelector("h3")?.textContent === "A choice");
  check("…the first of them the usual one", button("This way")?.className === "wf-primary" && button("That way")?.className === "");
  await click("That way");
  check("the way picked is what comes back", picked === "b" && !box());
  void chooseDialog("Which way?", [{ id: "a", label: "This way" }]).then((id) => (picked = id));
  await until(() => !!box());
  await click("Cancel");
  check("…and nothing when it is called off", picked === null);

  // Importing a PDF that holds its document.
  const file = (bytes: Uint8Array, name = "Harbour final.pdf") => new File([bytes as BlobPart], name, { type: "application/pdf" });
  let made: Awaited<ReturnType<typeof convertFile>> | null = null;
  let failed: unknown = null;
  const start = (bytes: Uint8Array) => {
    made = null;
    failed = null;
    void convertFile(file(bytes)).then(
      (m) => (made = m),
      (e) => (failed = e ?? "failed"),
    );
  };
  start(carrying);
  await until(() => !!box());
  check("importing such a PDF asks which is wanted", box()?.querySelector("h3")?.textContent === "This PDF holds the document it was made from" && !!button("Open the document") && !!button("Read the pages") && !box()?.textContent?.includes("changed after"), box()?.textContent ?? "no dialog");
  await click("Open the document");
  await until(() => !!made || !!failed);
  const opened = made as Awaited<ReturnType<typeof convertFile>> | null;
  check("the document is what is imported: its own title, kind, settings, formatting and pictures", opened?.stem === "The Harbour" && opened.suggestedFormat === "none" && opened.maps.settings?.pageSize === "a4" && opened.media.length === 2 && JSON.stringify(opened.content.content?.[1]) === JSON.stringify(content.content![1]), String(failed ?? opened?.stem));
  check("…and it says what it did and what was not inside", opened?.summary === "Opened the document kept inside the PDF" && opened.warnings.join().includes("2 pictures were not kept inside"), opened?.warnings.join());

  start(carrying);
  await until(() => !!box());
  await click("Read the pages");
  await until(() => !!made || !!failed);
  const pages = made as Awaited<ReturnType<typeof convertFile>> | null;
  const words = JSON.stringify(pages?.content ?? {});
  check("asked for the pages, the pages are read as before", !!pages && pages.stem === "Harbour final" && pages.media.length === 0 && words.includes("clocks were") && pages.summary !== "Opened the document kept inside the PDF", String(failed ?? words.slice(0, 120)));

  start(carrying);
  await until(() => !!box());
  await click("Cancel");
  await until(() => !!made || !!failed);
  check("called off, nothing is imported and nothing need be said", !made && importCancelled(failed));

  const changed = new Uint8Array(carrying.length + 6);
  changed.set(carrying);
  changed.set(Buffer.from("%%EOF\n", "latin1"), carrying.length);
  start(changed);
  await until(() => !!box());
  check("a PDF changed since it was made says its pages may differ", !!box()?.textContent?.includes("changed after it was made"));
  await click("Cancel");
  await until(() => !!failed);

  // A copy that cannot be used: the pages are read, and it says why.
  const newer = zipSync({ "document.json": strToU8(JSON.stringify({ subscribe: 9, content: { type: "doc", content: [] } })) });
  start(await pdfWith({ attach: { ...attach, bytes: newer } }));
  await until(() => !!made || !!failed);
  const fell = made as Awaited<ReturnType<typeof convertFile>> | null;
  check("a copy from a newer version is not asked about: the pages are read, and it says why", !!fell && !box() && fell.warnings.join().includes("newer version") && JSON.stringify(fell.content).includes("clocks were"), String(failed ?? fell?.warnings.join()));
  const alien = zipSync({ "document.json": strToU8(JSON.stringify({ subscribe: 1, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "heading" }] }] } })) });
  start(await pdfWith({ attach: { ...attach, bytes: alien } }));
  await until(() => !!made || !!failed);
  const odd = made as Awaited<ReturnType<typeof convertFile>> | null;
  check("…as for one whose text is not a document this app could hold", !!odd && odd.warnings.join().includes("could not be read"), String(failed ?? odd?.warnings.join()));

  const plain = await pdfWith({ attach: undefined }, { pictures: "print", tagged: false, archive: false, source: false });
  start(plain);
  await until(() => !!made || !!failed);
  check("an ordinary PDF is imported without a question", !!made && !box() && (made as Awaited<ReturnType<typeof convertFile>>).warnings.length === 0);
  await act(async () => root.unmount());
})();

finish();
