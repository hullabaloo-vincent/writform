// The PDF engine: this project's copy (pdf-engine/), built to WebAssembly
// and kept in src/pdf/engine/pkg. Held here: that the build is the build of
// the source as it stands, that it is small enough, and that what it does
// to a file is what another reader (pdf.js) then finds in the file.

import { check, finish } from "./env";
import "./dom";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JSONContent } from "@tiptap/core";
import PDFDocument from "pdfkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { TypesetSession } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { initSync, PdfDoc } from "../src/pdf/engine/pkg/wfpdf.js";
// @ts-expect-error a build script, in plain JavaScript
import { engineSourceHash } from "../tools/pdf-engine-hash.mjs";

// (Harnesses run from apps/desktop. The tool's own idea of where things
// are comes from where its file is, which a bundle moves.)
const PKG_DIR = join(process.cwd(), "src/pdf/engine/pkg");
const ENGINE_DIR = join(process.cwd(), "../../pdf-engine");

const stamp = JSON.parse(readFileSync(join(PKG_DIR, "BUILD.json"), "utf8")) as { source: string; bytes: number; rustc: string; wasmBindgen: string; features: string[] };
const wasm = readFileSync(join(PKG_DIR, "wfpdf_bg.wasm"));

// ------------------------------------------------------------ the build

check("the engine kept in the app is built from the engine's source as it stands", stamp.source === engineSourceHash(ENGINE_DIR), "run node tools/build-pdf-engine.mjs");
check("…and is the file its stamp says, under four megabytes", wasm.length === stamp.bytes && wasm.length < 4_000_000, `${wasm.length} bytes`);
check("…built for what Safari 15 can run, and nothing newer", stamp.features.join() === "mutable-globals,sign-ext,multivalue,bulk-memory,bulk-memory-opt,nontrapping-float-to-int,reference-types");
const glue = readFileSync(join(PKG_DIR, "wfpdf.js"), "utf8");
check("its JavaScript side has nothing Safari 15 cannot read", !/static\s*\{/.test(glue) && !glue.includes("(?<") && !/\.at\(|findLast|structuredClone|Object\.hasOwn/.test(glue));

initSync({ module: wasm });

// --------------------------------------------------------- what it does

const session = new TypesetSession();
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
async function pdfOf(pages: string[], title = "Engine"): Promise<Uint8Array> {
  const doc: JSONContent = { type: "doc", content: pages.map((text, k) => ({ ...p(text), ...(k ? { attrs: { pageBreakBefore: true } } : {}) })) };
  const model = buildDocModel(doc, { title, author: "A. Writer", settings: { ...DEFAULT_SETTINGS, fR: "" }, date: "October 13, 2026" });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  return (await session.pdf({ kind: "document", doc: model, families: model.families, images: [], pdf: { pictures: "print", tagged: false, archive: false, source: false } })).bytes;
}
/** What another reader makes of a file: each page's words, size and turn. */
async function readBack(bytes: Uint8Array, password?: string) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password ? { password } : {}) }).promise;
  const pages: { text: string; w: number; h: number; rotate: number }[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const [x0, y0, x1, y1] = page.view;
    pages.push({ text: content.items.map((it) => ("str" in it ? it.str : "")).join("").trim(), w: Math.round(x1 - x0), h: Math.round(y1 - y0), rotate: page.rotate });
  }
  const meta = await doc.getMetadata();
  await doc.loadingTask.destroy();
  return { pages, words: pages.map((page) => page.text).join("|"), info: meta.info as Record<string, unknown> };
}
interface Info {
  pages: { w: number; h: number; rotation: number }[];
  title: string | null;
  encrypted: boolean;
  signed: boolean;
  may: { changePages: boolean; annotate: boolean; fillForms: boolean; changeText: boolean };
  canUndo: boolean;
  canRedo: boolean;
  modified: boolean;
}
const info = (doc: PdfDoc) => JSON.parse(doc.info()) as Info;
const u32 = (...n: number[]) => Uint32Array.from(n);
const thrown = (run: () => unknown): { code?: string; message?: string } => {
  try {
    run();
    return {};
  } catch (e) {
    return JSON.parse(String(e)) as { code: string; message: string };
  }
};
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0) / 1000;

const four = await pdfOf(["Page one.", "Page two.", "Page three.", "Page four."], "Four pages");
{
  const doc = new PdfDoc(four.slice(), undefined);
  const at = info(doc);
  check("a PDF is opened: its pages, their size, its title", at.pages.length === 4 && at.pages.every((page) => page.w === 612 && page.h === 792 && page.rotation === 0) && at.title === "Four pages", JSON.stringify(at).slice(0, 200));
  check("…nothing to undo, nothing changed, everything allowed", !at.canUndo && !at.canRedo && !at.modified && !at.encrypted && !at.signed && Object.values(at.may).every(Boolean));

  const moved = JSON.parse(doc.movePages(u32(3), 0)) as { changedPages: number[]; structureChanged: boolean };
  check("moving a page says the order of pages changed", moved.structureChanged && moved.changedPages.length === 4);
  const reordered = await readBack(doc.save(true, NOW));
  check("the last page moved to the front is first in the file another reader opens", reordered.words === "Page four.|Page one.|Page two.|Page three.", reordered.words);
  check("…and the file is stamped with when it was saved", String(reordered.info.ModDate ?? "").startsWith("D:20261013120000"), String(reordered.info.ModDate));

  JSON.parse(doc.rotate(u32(0, 2), 90));
  JSON.parse(doc.deletePages(u32(1)));
  const turned = await readBack(doc.save(true, NOW));
  check("pages are turned and taken out", turned.words === "Page four.|Page two.|Page three." && turned.pages.map((page) => page.rotate).join() === "90,90,0", `${turned.words} ${turned.pages.map((page) => page.rotate).join()}`);
  check("a turned page is as wide as it was tall", info(doc).pages[0].w === 792 && info(doc).pages[0].h === 612 && info(doc).pages[0].rotation === 90);

  JSON.parse(doc.duplicatePages(u32(2)));
  JSON.parse(doc.insertBlank(0, 300, 400));
  const grown = await readBack(doc.save(true, NOW));
  check("a page is copied and an empty one put in", grown.words === "|Page four.|Page two.|Page three.|Page three." && grown.pages[0].w === 300 && grown.pages[0].h === 400, grown.words);

  const other = await pdfOf(["Other one.", "Other two.", "Other three."]);
  JSON.parse(doc.insertFrom(other.slice(), undefined, u32(2, 0), 1));
  const joined = await readBack(doc.save(true, NOW));
  check("pages of another PDF are put in, in the order asked for", joined.words === "|Other three.|Other one.|Page four.|Page two.|Page three.|Page three.", joined.words);
  JSON.parse(doc.insertFrom(other.slice(), undefined, u32(), 99));
  check("…or all of them, at the end", (await readBack(doc.save(true, NOW))).words.endsWith("Page three.|Other one.|Other two.|Other three."));

  const part = await readBack(doc.extract(u32(1, 3), NOW));
  check("some pages are saved as a PDF of their own, the document left as it is", part.words === "Other three.|Page four." && info(doc).pages.length === 10, part.words);

  // Undo, all the way back, and forward again.
  let steps = 0;
  while (info(doc).canUndo) {
    JSON.parse(doc.undo());
    steps += 1;
  }
  const back = await readBack(doc.save(true, NOW));
  check("every change can be undone, back to the file as it was opened", steps === 7 && back.words === "Page one.|Page two.|Page three.|Page four." && back.pages.every((page) => page.rotate === 0) && !info(doc).modified, `${steps} ${back.words}`);
  JSON.parse(doc.redo());
  check("…and done again", (await readBack(doc.save(true, NOW))).words === "Page four.|Page one.|Page two.|Page three." && info(doc).canRedo && info(doc).modified);
  JSON.parse(doc.rotate(u32(0), 180));
  check("a new change after an undo leaves nothing to do again", !info(doc).canRedo);

  check("what cannot be done says why, and changes nothing", thrown(() => doc.deletePages(u32(0, 1, 2, 3))).code === "Invalid" && thrown(() => doc.rotate(u32(9), 90)).code === "Invalid" && thrown(() => doc.rotate(u32(0), 45)).code === "Invalid" && thrown(() => doc.insertBlank(0, 0, 100)).code === "Invalid" && info(doc).pages.length === 4);
  check("there is nothing to undo past the beginning", thrown(() => new PdfDoc(four.slice(), undefined).undo()).code === "Invalid");
  doc.free();
}

// Saving on top of the file as it was, and going on from there.
{
  const doc = new PdfDoc(four.slice(), undefined);
  JSON.parse(doc.rotate(u32(1), 90));
  const added = doc.save(false, NOW);
  const same = (a: Uint8Array, b: Uint8Array, n: number) => a.subarray(0, n).every((v, k) => v === b[k]);
  check("a quick save adds to the end of the file as it was opened", added.length > four.length && same(added, four, four.length) && (await readBack(added)).pages.map((page) => page.rotate).join() === "0,90,0,0", `${four.length} -> ${added.length}`);
  doc.markSaved(added.slice());
  check("once saved, nothing is changed any more, and the changes can still be undone", !info(doc).modified && info(doc).canUndo);
  JSON.parse(doc.deletePages(u32(3)));
  const again = doc.save(false, NOW);
  check("…and the next save builds on that one", again.length > added.length && same(again, added, added.length) && (await readBack(again)).words === "Page one.|Page two.|Page three.", (await readBack(again)).words);
  const clean = doc.save(true, NOW);
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
  check("a clean copy is written afresh, with one end and not three", text(again).split("%%EOF").length === 4 && text(clean).split("%%EOF").length === 2 && (await readBack(clean)).words === "Page one.|Page two.|Page three.");
  doc.free();
}

// Files that are not for everyone, and files that are not PDFs.
{
  const locked = await new Promise<Uint8Array>((resolve) => {
    const made = new PDFDocument({ font: null, autoFirstPage: false, pdfVersion: "1.6", userPassword: "open sesame", ownerPassword: "the owner", permissions: { printing: "highResolution" } } as never) as unknown as { addPage(o: unknown): unknown; on(e: string, f: (c: Buffer) => void): void; end(): void };
    const chunks: Buffer[] = [];
    made.on("data", (chunk) => chunks.push(chunk));
    made.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    made.addPage({ size: [612, 792], margin: 0 });
    made.addPage({ size: [612, 792], margin: 0 });
    made.end();
  });
  check("a file with a password says it needs one", thrown(() => new PdfDoc(locked.slice(), undefined)).code === "NeedsPassword");
  check("…and that a wrong one is wrong", thrown(() => new PdfDoc(locked.slice(), "not it")).code === "WrongPassword");
  const reader = new PdfDoc(locked.slice(), "open sesame");
  check("opened by its reader's password, it is open, and says what its owner allows", info(reader).pages.length === 2 && info(reader).encrypted && !info(reader).may.changePages && !info(reader).may.changeText, JSON.stringify(info(reader).may));
  check("…and a change its owner does not allow is refused", thrown(() => reader.rotate(u32(0), 90)).code === "NotPermitted" && !info(reader).canUndo);
  const owner = new PdfDoc(locked.slice(), "the owner");
  JSON.parse(owner.rotate(u32(0), 90));
  const saved = owner.save(false, NOW);
  check("its owner may change it, and it is saved still locked", info(owner).may.changePages && (await readBack(saved, "open sesame")).pages.map((page) => page.rotate).join() === "90,0" && (await pdfjs.getDocument({ data: saved.slice(), verbosity: 0 }).promise.then(() => "open", (e: { name?: string }) => e.name)) === "PasswordException");
  check("a file that is no PDF says so", thrown(() => new PdfDoc(new TextEncoder().encode("not a pdf"), undefined)).code === "Invalid");
  reader.free();
  owner.free();
}

// ------------------------------------------- marks, a form, and text

const VIEW = (page: { getViewport(o: { scale: number }): { convertToViewportPoint(x: number, y: number): number[] } }, rect: number[]) => {
  const viewport = page.getViewport({ scale: 1 });
  const [a, b] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [c, d] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b)];
};
const near = (a: number[], b: number[], by = 1.5) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= by);
interface Seen {
  subtype: string;
  rect: number[];
  contents: string;
  fieldName?: string;
  fieldValue?: unknown;
  view: number[];
}
async function annotationsOf(bytes: Uint8Array, pageNo: number): Promise<Seen[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const list = (await page.getAnnotations()) as { subtype: string; rect: number[]; contentsObj?: { str?: string }; fieldName?: string; fieldValue?: unknown }[];
  const out = list.map((a) => ({ subtype: a.subtype, rect: a.rect, contents: a.contentsObj?.str ?? "", fieldName: a.fieldName, fieldValue: a.fieldValue, view: VIEW(page, a.rect) }));
  await doc.loadingTask.destroy();
  return out;
}
interface Mark {
  index: number;
  subtype: string;
  text: string | null;
  rect: number[];
  fillSign: boolean;
}
const marks = (doc: PdfDoc, page: number) => JSON.parse(doc.marks(page)) as Mark[];

{
  const doc = new PdfDoc(four.slice(), undefined);
  doc.clock(NOW);
  const box = [100, 120, 200, 16];
  const made = JSON.parse(doc.addMark(JSON.stringify({ page: 0, kind: "highlight", rects: [box], color: [1, 0.9, 0] }), undefined)) as { index: number; change: { changedPages: number[] } };
  check("a highlight is made, and says which page to draw again", made.index === 0 && made.change.changedPages.join() === "0");
  let seen = await annotationsOf(doc.save(true, NOW), 1);
  check("another reader finds it where it was put, measured from the page's top left", seen.length === 1 && seen[0].subtype === "Highlight" && near(seen[0].view, box), JSON.stringify(seen[0]?.view));

  JSON.parse(doc.addMark(JSON.stringify({ page: 0, kind: "note", at: [300, 300], text: "Check this date." }), undefined));
  JSON.parse(doc.addMark(JSON.stringify({ page: 0, kind: "ink", strokes: [[[50, 400], [80, 420], [120, 405]]], width: 3 }), undefined));
  JSON.parse(doc.addMark(JSON.stringify({ page: 0, kind: "rect", rect: [60, 500, 120, 60] }), undefined));
  JSON.parse(doc.addMark(JSON.stringify({ page: 0, kind: "line", from: [60, 600], to: [260, 640], arrow: true }), undefined));
  JSON.parse(doc.addMark(JSON.stringify({ page: 0, kind: "text", rect: [320, 500, 180, 40], size: 12, text: "Typed on the page" }), undefined));
  const listed = marks(doc, 0);
  check("a note, a drawing, a box, an arrow and typed words are marks too, listed for their page", listed.map((m) => m.subtype).sort().join() === "FreeText,Highlight,Ink,Line,Square,Text" && listed.find((m) => m.subtype === "Text")?.text === "Check this date." && marks(doc, 1).length === 0, listed.map((m) => m.subtype).join());
  const boxMark = listed.find((m) => m.subtype === "Square")!;
  check("…each with its box on the page as shown", near(boxMark.rect, [60, 500, 120, 60], 3), JSON.stringify(boxMark.rect));
  seen = await annotationsOf(doc.save(true, NOW), 1);
  check("another reader finds them all, the typed words as words", seen.filter((a) => a.subtype !== "Popup").length === 6 && seen.some((a) => a.subtype === "FreeText" && a.contents === "Typed on the page") && seen.some((a) => a.subtype === "Text" && a.contents === "Check this date."), seen.map((a) => a.subtype).join());

  JSON.parse(doc.updateMark(0, boxMark.index, JSON.stringify({ by: [40, 25] })));
  const movedBox = marks(doc, 0).find((m) => m.subtype === "Square")!;
  check("a mark is moved by so far right and so far down", near(movedBox.rect, [100, 525, 120, 60], 3), JSON.stringify(movedBox.rect));
  const noteMark = marks(doc, 0).find((m) => m.subtype === "Text")!;
  JSON.parse(doc.updateMark(0, noteMark.index, JSON.stringify({ text: "Checked." })));
  check("what a note says is changed", marks(doc, 0).find((m) => m.subtype === "Text")?.text === "Checked.");
  JSON.parse(doc.deleteMark(0, marks(doc, 0).find((m) => m.subtype === "Ink")!.index));
  check("a mark is taken off", !marks(doc, 0).some((m) => m.subtype === "Ink") && marks(doc, 0).length === 5);
  JSON.parse(doc.undo());
  check("…and comes back with undo", marks(doc, 0).some((m) => m.subtype === "Ink"));

  // On a page that is turned, a mark still goes where it is put as shown.
  JSON.parse(doc.rotate(u32(1), 90));
  const turnedBox = [200, 100, 150, 40];
  JSON.parse(doc.addMark(JSON.stringify({ page: 1, kind: "rect", rect: turnedBox }), undefined));
  const onTurned = await annotationsOf(doc.save(true, NOW), 2);
  check("on a page turned on its side, a mark is where it was put as the page is shown", onTurned.length === 1 && near(onTurned[0].view, turnedBox, 3) && near(marks(doc, 1)[0].rect, turnedBox, 3), JSON.stringify(onTurned[0]?.view));

  check("a mark that makes no sense is refused, with nothing changed", thrown(() => doc.addMark(JSON.stringify({ page: 0, kind: "highlight", rects: [] }), undefined)).code === "Invalid" && thrown(() => doc.addMark("{not json", undefined)).code === "Invalid" && thrown(() => doc.addMark(JSON.stringify({ page: 99, kind: "note", at: [1, 1] }), undefined)).code === "Invalid" && thrown(() => doc.deleteMark(0, 99)).code === "Invalid");

  // Signing: drawn, or a picture. Then made part of the page.
  JSON.parse(doc.addMark(JSON.stringify({ page: 2, kind: "signature", strokes: [[[100, 700], [140, 680], [180, 705], [220, 690]]] }), undefined));
  const pixels = new Uint8Array(8 * 4 * 4);
  for (let k = 0; k < 32; k += 1) pixels.set([20, 20, 120, k % 3 === 0 ? 0 : 255], k * 4);
  JSON.parse(doc.addMark(JSON.stringify({ page: 2, kind: "picture", rect: [300, 660, 160, 80], w: 8, h: 4 }), pixels));
  const signed = marks(doc, 2);
  check("a signature drawn by hand and one that is a picture are put on the page", signed.length === 2 && signed.every((m) => m.fillSign) && near(signed.find((m) => m.subtype === "Stamp")!.rect, [300, 660, 160, 80], 3), JSON.stringify(signed.map((m) => [m.subtype, m.fillSign])));
  check("a picture that is not the size it says is refused", thrown(() => doc.addMark(JSON.stringify({ page: 2, kind: "picture", rect: [1, 1, 10, 10], w: 9, h: 9 }), pixels)).code === "Invalid");
  JSON.parse(doc.flattenFillSign(u32()));
  if (process.env.WF_SHOW) console.log("after flatten", JSON.stringify(marks(doc, 2)), JSON.stringify(marks(doc, 0).map((m) => m.subtype)), JSON.stringify((await annotationsOf(doc.save(true, NOW), 3)).map((a) => a.subtype)));
  check("made part of the page, they are no longer marks that can be taken off", marks(doc, 2).length === 0 && (await annotationsOf(doc.save(true, NOW), 3)).length === 0);
  check("…and so are words typed on a page, while notes and highlights stay marks", marks(doc, 0).map((m) => m.subtype).sort().join() === "Highlight,Ink,Line,Square,Text" && (await readBack(doc.save(true, NOW))).pages[0].text.includes("Typed on the page"), marks(doc, 0).map((m) => m.subtype).join());
  doc.free();
}

// A form.
{
  const face = (await loadFontFiles(["carlito"])).find((f) => f.style === "regular")!;
  const form = await new Promise<Uint8Array>((resolve) => {
    const made = new PDFDocument({ font: null, autoFirstPage: false } as never) as unknown as {
      registerFont(name: string, bytes: Buffer): void;
      font(name: string): unknown;
      fontSize(n: number): unknown;
      addPage(o: unknown): unknown;
      initForm(): unknown;
      formText(name: string, x: number, y: number, w: number, h: number, o?: unknown): unknown;
      formCheckbox(name: string, x: number, y: number, w: number, h: number, o?: unknown): unknown;
      formCombo(name: string, x: number, y: number, w: number, h: number, o?: unknown): unknown;
      on(e: string, f: (c: Buffer) => void): void;
      end(): void;
    };
    const chunks: Buffer[] = [];
    made.on("data", (chunk) => chunks.push(chunk));
    made.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    made.registerFont("body", Buffer.from(face.bytes));
    made.addPage({ size: [612, 792], margin: 0 });
    made.font("body");
    made.fontSize(11);
    made.initForm();
    made.formText("applicant.name", 72, 100, 240, 22, {});
    made.formCheckbox("agree", 72, 150, 16, 16, {});
    made.formCombo("berth", 72, 200, 160, 22, { select: ["One", "Two", "Nine"] });
    made.end();
  });
  interface Field {
    name: string;
    kind: string;
    value: string[];
    options: [string, string][];
    readOnly: boolean;
    widgets: { page: number; rect: number[]; on: boolean }[];
  }
  const doc = new PdfDoc(form.slice(), undefined);
  doc.clock(NOW);
  const fields = () => JSON.parse(doc.fields()) as Field[];
  const named = (name: string) => fields().find((f) => f.name === name)!;
  check("a form's fields are listed: what kind each is, and where on its page", fields().length === 3 && named("applicant.name").kind === "text" && named("agree").kind === "check" && named("berth").kind === "combo" && near(named("applicant.name").widgets[0].rect, [72, 100, 240, 22], 2) && named("berth").options.map((o) => o[0]).join() === "One,Two,Nine", JSON.stringify(fields().map((f) => [f.name, f.kind])));
  const filled = JSON.parse(doc.setField("applicant.name", JSON.stringify({ text: "Ada Lovelace" }))) as { changedPages: number[] };
  JSON.parse(doc.setField("agree", JSON.stringify({ check: true })));
  JSON.parse(doc.setField("berth", JSON.stringify({ choice: ["Nine"] })));
  check("filling a field in says which pages to draw again", filled.changedPages.join() === "0");
  if (process.env.WF_SHOW) console.log("fields", doc.fields());
  check("what was filled in is what the fields now hold", named("applicant.name").value.join() === "Ada Lovelace" && named("agree").widgets[0].on === true && named("berth").value.join() === "Nine", JSON.stringify(fields().map((f) => f.value)));
  const seen = await annotationsOf(doc.save(true, NOW), 1);
  const value = (name: string) => seen.find((a) => a.fieldName === name)?.fieldValue;
  check("…and what another reader finds in the saved file", value("applicant.name") === "Ada Lovelace" && value("agree") !== "Off" && value("agree") !== undefined && JSON.stringify(value("berth")).includes("Nine"), JSON.stringify(seen.map((a) => [a.fieldName, a.fieldValue])));
  check("a field that is not there, or a value that is none of a choice's, is refused", thrown(() => doc.setField("nobody", JSON.stringify({ text: "x" }))).code === "Invalid" && thrown(() => doc.setField("berth", JSON.stringify({ choice: ["Eleven"] }))).code === "Invalid" && named("berth").value.join() === "Nine");
  JSON.parse(doc.undo());
  check("filling in can be undone", named("berth").value.join() !== "Nine");
  check("a PDF without a form has no fields", JSON.parse(new PdfDoc(four.slice(), undefined).fields()).length === 0);
  doc.free();
}

// A page's own text, and text added to it.
{
  interface Block {
    index: number;
    text: string;
    rect: number[];
    font: string;
    size: number;
  }
  const doc = new PdfDoc(four.slice(), undefined);
  doc.clock(NOW);
  const blocks = (page: number) => JSON.parse(doc.textBlocks(page)) as Block[];
  const first = blocks(0);
  const body = first.find((b) => b.text.includes("Page one."));
  check("a page's text is found as blocks, each with its words, its font and where it is", !!body && body.size === 12 && /Literata/.test(body.font) && body.rect[0] > 100 && body.rect[0] < 115 && body.rect[1] > 50 && body.rect[1] < 90, JSON.stringify(first.map((b) => [b.text, b.font, b.rect.map(Math.round)])));
  const again = JSON.parse(doc.replaceBlock(0, body!.index, "Page neo.")) as { substituted: string | null; change: { changedPages: number[] } };
  const rewritten = await readBack(doc.save(true, NOW));
  check("a block is written again in its own font, when the font has the letters", again.substituted === null && again.change.changedPages.join() === "0" && rewritten.pages[0].text === "Page neo." && rewritten.pages[1].text === "Page two.", `${again.substituted} ${rewritten.pages[0].text}`);
  const other = JSON.parse(doc.replaceBlock(0, blocks(0).find((b) => b.text.includes("Page neo."))!.index, "Quartz & Jazz 7.")) as { substituted: string | null };
  const swapped = await readBack(doc.save(true, NOW));
  check("letters the font does not carry are set in a standard one, and that is said", typeof other.substituted === "string" && other.substituted.length > 0 && swapped.pages[0].text.replace(/\s+/g, " ") === "Quartz & Jazz 7.", `${other.substituted} | ${swapped.pages[0].text}`);

  JSON.parse(doc.addText(1, JSON.stringify({ rect: [100, 300, 300, 40], text: "Added on the second page.", size: 14, family: "serif", color: [0.8, 0, 0] })));
  interface Added {
    index: number;
    rect: number[];
    text: string | null;
    size: number | null;
  }
  const added = () => JSON.parse(doc.added(1)) as Added[];
  check("text is added to a page, where it is put", added().length === 1 && added()[0].text === "Added on the second page." && added()[0].size === 14 && Math.abs(added()[0].rect[0] - 100) < 2 && Math.abs(added()[0].rect[1] - 300) < 4 && (await readBack(doc.save(true, NOW))).pages[1].text.includes("Added on the second page."), JSON.stringify(added()));
  JSON.parse(doc.updateText(1, 0, JSON.stringify({ rect: [100, 320, 300, 40], text: "Changed after it was added.", size: 14 })));
  check("…changed", added()[0].text === "Changed after it was added." && (await readBack(doc.save(true, NOW))).pages[1].text.includes("Changed after it was added."));
  JSON.parse(doc.deleteAdded(1, 0));
  check("…and taken away again", added().length === 0 && (await readBack(doc.save(true, NOW))).pages[1].text === "Page two.");
  check("text in letters the standard fonts lack is refused, not drawn as question marks", thrown(() => doc.addText(1, JSON.stringify({ rect: [100, 300, 300, 40], text: "Ελληνικά", size: 12 }))).code === "Invalid" && thrown(() => doc.addText(1, JSON.stringify({ rect: [1, 1, 10, 10], text: "  ", size: 12 }))).code === "Invalid");
  doc.free();
}

finish();
