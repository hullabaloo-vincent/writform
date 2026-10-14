// A PDF read as a document. Most of what is read here was made by this
// app's own exporter, so what went in is known: the words, which of them
// are a paragraph, the headings, the columns.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { writeFileSync } from "node:fs";

import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as PmNode } from "@tiptap/pm/model";
import PDFDocument from "pdfkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { DEFAULT_SETTINGS, type DocSettings } from "../src/apps/documents/docSettings";
import { convertFile, importCancelled } from "../src/apps/documents/import/importFile";
import { readPdf, type EncodeImage, type PdfRead, type PdfReadOptions, type Recognise } from "../src/apps/documents/import/pdf";
import { beginPdfImport, PdfImportHost, SHOW_AFTER_MS } from "../src/apps/documents/import/PdfImportDialog";
import { seam } from "../src/apps/documents/import/pdf/paras";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { scriptedAsDocument } from "../src/doclayout/scripted";
import { docContentExtensions } from "../src/editor/schema/content";
import { levelOfJson } from "../src/editor/schema/levels";
import { fontIdForPdfName, pdfFontFamily } from "../src/fonts/pdfName";
import { setPdfjs } from "../src/lib/pdfjs";
import { png } from "./pix";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
setPdfjs(pdfjs as never);

const session = new TypesetSession();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dump = process.env.WF_DUMP;

type MarkSpec = string | { type: string; attrs: Record<string, unknown> };
const t = (text: string, ...marks: MarkSpec[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}) });
const p = (...content: (JSONContent | string)[]): JSONContent => ({ type: "paragraph", content: content.map((c) => (typeof c === "string" ? t(c) : c)) });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });
const docOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

async function pdfOf(doc: JSONContent, settings: Partial<DocSettings> = {}, more: { tagged?: boolean; images?: DocRequest["images"]; name?: string } = {}): Promise<Uint8Array> {
  const model = buildDocModel(doc, { title: "The Harbour", author: "A. Writer", settings: { ...DEFAULT_SETTINGS, ...settings }, date: "October 13, 2026", ...(more.tagged ? { struct: true } : {}) });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const { bytes } = await session.pdf({ kind: "document", doc: model, families: model.families, images: more.images ?? [], pdf: { pictures: "print", tagged: !!more.tagged, archive: false, source: false } });
  if (dump && more.name) writeFileSync(`${dump}/import-${more.name}.pdf`, bytes);
  return bytes;
}


/** A PDF drawn by hand, for what this app's own exporter never makes. */
interface Pen {
  addPage(options: { size: [number, number]; margin: number }): Pen;
  font(name: string): Pen;
  fontSize(size: number): Pen;
  fillColor(color: string): Pen;
  text(text: string, x: number, y: number, options?: Record<string, unknown>): Pen;
  moveTo(x: number, y: number): Pen;
  lineTo(x: number, y: number): Pen;
  rect(x: number, y: number, w: number, h: number): Pen;
  stroke(): Pen;
  lineWidth(w: number): Pen;
  link(x: number, y: number, w: number, h: number, url: string): Pen;
  image(src: unknown, x: number, y: number, options?: Record<string, unknown>): Pen;
  addContent(raw: string): Pen;
  y: number;
}
const FACES = await loadFontFiles(["carlito", "courier-prime"]);
async function handmade(draw: (pen: Pen) => void, options: Record<string, unknown> = {}, name = ""): Promise<Uint8Array> {
  const doc = new PDFDocument({ font: null, autoFirstPage: false, ...options } as never) as unknown as Pen & { registerFont(name: string, bytes: Buffer): void; on(event: string, fn: (chunk: Buffer) => void): void; end(): void };
  for (const face of FACES) doc.registerFont(`${face.family}-${face.style}`, Buffer.from(face.bytes));
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  draw(doc);
  doc.end();
  await done;
  const bytes = new Uint8Array(Buffer.concat(chunks));
  if (dump && name) writeFileSync(`${dump}/import-${name}.pdf`, bytes);
  return bytes;
}
const LETTER: [number, number] = [612, 792];

/** A file of a picture, without a canvas: its pixels written out as a PNG. */
const encoded: { w: number; h: number; kind: number | undefined; max: number }[] = [];
const encodeImage: EncodeImage = async (image, maxPixels) => {
  const { data, width: w, height: h, kind } = image;
  encoded.push({ w, h, kind, max: maxPixels });
  if (!data) return null;
  const step = kind === 3 ? 4 : 3;
  return { bytes: png(w, h, (x, y) => [data[(y * w + x) * step], data[(y * w + x) * step + 1], data[(y * w + x) * step + 2]]), type: "image/png", w, h };
};
const fontId = (name: string) => fontIdForPdfName(name);

/** Every document read here has to be one the editor can hold, node for
 *  node, with nothing newer in it than the formatting already released. */
const SCHEMA = getSchema(docContentExtensions());
let unfit = "";
let readings = 0;
const read = async (bytes: Uint8Array, opts: Partial<PdfReadOptions> = {}): Promise<PdfRead> => {
  const got = await readPdf(bytes, { pdfjs: pdfjs as unknown as PdfReadOptions["pdfjs"], fontId, fontFamily: pdfFontFamily, ...opts });
  readings += 1;
  try {
    PmNode.fromJSON(SCHEMA, got.content).check();
    if (levelOfJson(got.content) > 2) unfit ||= `level ${levelOfJson(got.content)}`;
  } catch (e) {
    unfit ||= String(e);
  }
  return got;
};

const textOf = (node: JSONContent): string => (node.type === "text" ? (node.text ?? "") : (node.content ?? []).map(textOf).join(""));
const outline = (content: JSONContent): string[] => (content.content ?? []).map((n) => `${n.type === "heading" ? `h${n.attrs?.level}` : n.type}:${textOf(n)}`);
const marksOf = (node: JSONContent, text: string): string[] => {
  const found = (node.content ?? []).flatMap((n): string[] => (n.type === "text" && (n.text ?? "").includes(text) ? (n.marks ?? []).map((m) => m.type) : marksOf(n, text)));
  return [...new Set(found)].sort();
};

const SEA = "The harbour was quiet that morning and nobody on the quay looked up when the ferry came in from the island. ";
const HILL = "Above the town the road climbed between stone walls, extraordinarily narrow in places, towards the lighthouse. ";

// ------------------------------------------------- words and paragraphs

{
  const source = docOf(
    h(1, "The Harbour"),
    p("It was a ", t("bright", "bold"), " cold day, and the clocks were ", t("striking", "italic"), " thirteen."),
    p(SEA.repeat(6).trim()),
    h(2, "Above the town"),
    p(HILL.repeat(5).trim()),
    p("A well-known story. ", HILL.repeat(4).trim()),
    p("Short."),
    ...Array.from({ length: 9 }, (_, k) => p(`Paragraph ${k + 1}. ${SEA.repeat(4).trim()}`)),
  );
  const bytes = await pdfOf(source, { hyphenate: true }, { name: "prose" });
  const got = await read(bytes);
  const want = outline(source);
  const have = outline(got.content);
  if (process.env.WF_SHOW) console.log(have.map((line) => line.slice(0, 110)).join("\n"), got.warnings, got.settings);
  check("every paragraph and heading comes back, in order", have.length === want.length, `${have.length} of ${want.length}`);
  check("…with its words, a word broken at a line's end whole again", have.every((line, k) => line === want[k]), have.find((line, k) => line !== want[k])?.slice(0, 140) ?? "");
  check("bold and italic words are bold and italic", marksOf(got.content, "bright").join() === "bold" && marksOf(got.content, "striking").join() === "italic", `${marksOf(got.content, "bright")} ${marksOf(got.content, "striking")}`);
  check("the running head and the page numbers are not in the text", !have.some((line) => /^paragraph:\d+$/.test(line)));
  check("it is not taken for a screenplay", got.suggestedFormat === "none");
}

// A word broken at a line's end.
{
  const known = new Set(["well-known", "mother-in-law"]);
  const join = (a: string, b: string) => {
    const { cut, glue } = seam(a, b, known);
    return (cut ? a.slice(0, -1) : a) + glue + b;
  };
  check("a hyphen that was only the break goes", join("extraordi-", "narily narrow") === "extraordinarily narrow");
  check("a hyphen the word is written with stays", join("a well-", "known story") === "a well-known story" && join("his mother-in-", "law came") === "his mother-in-law came");
  check("before a name the hyphen stays", join("the pre-", "Raphaelite painters") === "the pre-Raphaelite painters");
  check("a soft hyphen always goes", join(`extra${String.fromCharCode(0xad)}`, "ordinary") === "extraordinary");
  check("a dash is not a hyphen", join("he said -", "and left") === "he said - and left");
  check("lines otherwise join with a space", join("the end of a line", "and the next") === "the end of a line and the next");
}

// ------------------------------------------------------------- columns

{
  const source = docOf(h(1, "Two columns"), ...Array.from({ length: 14 }, (_, k) => p(`Column paragraph ${k + 1}. ${SEA.repeat(3).trim()}`)));
  const got = await read(await pdfOf(source, { cols: 2 }, { name: "columns" }));
  const want = outline(source);
  const have = outline(got.content);
  check("a page in two columns is read down one and then down the other", have.length === want.length && have.every((line, k) => line === want[k]), `${have.length} of ${want.length}: ${have.find((line, k) => line !== want[k])?.slice(0, 120) ?? ""}`);
}
{
  const left = `${SEA.repeat(5).trim()}`;
  const right = `${HILL.repeat(5).trim()}`;
  const bytes = await handmade((pen) => {
    pen.addPage({ size: LETTER, margin: 0 }).font("carlito-regular");
    pen.fontSize(24).text("Harbour News", 72, 60, { width: 468, align: "center" });
    pen.fontSize(11).text(left, 72, 110, { width: 222, align: "justify" });
    pen.text(right, 318, 110, { width: 222, align: "justify" });
    pen.text("A closing line that runs right across the page under both of the columns above it.", 72, 420, { width: 468 });
  }, {}, "newspaper");
  const have = outline((await read(bytes)).content);
  check("a title above two columns, the columns in turn, and a line beneath them", have.join("|") === [`h1:Harbour News`, `paragraph:${left}`, `paragraph:${right}`, "paragraph:A closing line that runs right across the page under both of the columns above it."].join("|"), have.map((line) => line.slice(0, 60)).join(" | "));
}

// ------------------------------------------- how words were made bold

{
  const bytes = await handmade((pen) => {
    pen.addPage({ size: LETTER, margin: 0 }).font("carlito-regular").fontSize(12);
    pen.text("Important", 72, 100, { lineBreak: false });
    pen.text("Important", 72.3, 100, { lineBreak: false });
    pen.text("notice follows here and it is not bold at all.", 127, 100, { lineBreak: false });
    pen.font("carlito-bold").text("Bold by its font", 72, 200, { lineBreak: false });
    pen.font("carlito-italic").text("and leaning by its font.", 160, 200, { lineBreak: false });
  }, {}, "bold");
  const got = await read(bytes);
  check("words drawn twice a hair apart are one bold word", outline(got.content)[0] === "paragraph:Important notice follows here and it is not bold at all." && marksOf(got.content, "Important").join() === "bold" && marksOf(got.content, "notice").length === 0, outline(got.content)[0]);
  check("a bold face and an italic face are told by their names", marksOf(got.content, "Bold by its font").join() === "bold" && marksOf(got.content, "leaning").join() === "italic");
}

// ------------------------------- links, lists, tables, notes, bookmarks

const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const cell = (text: string, attrs?: Record<string, unknown>): JSONContent => ({ type: "tableCell", ...(attrs ? { attrs } : {}), content: [text ? p(text) : { type: "paragraph" }] });
const tr = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
const note = (text: string): JSONContent => ({ type: "footnote", content: [t(text)] });
/** A document's blocks as a tree of words: enough to tell a list from a
 *  table from a paragraph, and what is in each. */
const tree = (node: JSONContent): string => {
  const kids = (node.content ?? []).filter((n) => n.type !== "text" || (n.text ?? "").trim());
  if (node.type === "text") return node.text ?? "";
  if (node.type === "footnote") return `{note ${textOf(node)}}`;
  if (node.type === "paragraph" || node.type === "heading") return `${node.type === "heading" ? `h${node.attrs?.level}` : "p"}[${(node.content ?? []).map(tree).join("")}]`;
  const tag = node.type === "orderedList" ? `ol${node.attrs?.type ?? ""}` : node.type === "bulletList" ? "ul" : node.type === "listItem" ? "li" : node.type === "table" ? "table" : node.type === "tableRow" ? "tr" : node.type === "tableCell" ? `td${Number(node.attrs?.colspan ?? 1) > 1 ? node.attrs?.colspan : ""}` : (node.type ?? "?");
  return `${tag}(${kids.map(tree).join(" ")})`;
};

{
  const source = docOf(
    h(1, "A report"),
    p("An opening paragraph with ", t("a link", { type: "link", attrs: { href: "https://example.org/harbour" } }), " in it, and a note", note("What the note says, at the foot of the page."), " after it."),
    h(2, "What was found"),
    { type: "bulletList", content: [li(p("First item")), li(p(`Second item, which is long enough to run on to a second line under the first. ${SEA.trim()}`), { type: "orderedList", content: [li(p("Inner one")), li(p("Inner two"))] }), li(p("Third item"))] },
    p("A paragraph between the lists."),
    { type: "orderedList", content: [li(p("Count one")), li(p("Count two")), li(p("Count three"))] },
    h(2, "A table"),
    { type: "table", attrs: { cols: "120 150 100", head: true }, content: [tr(cell("Region"), cell("Spring"), cell("Autumn")), tr(cell("North"), cell("Fourteen ships and a tug"), cell("12")), tr(cell("South and east", { colspan: 2 }), cell("9"))] },
    p("A closing paragraph."),
  );
  const bytes = await pdfOf(source, {}, { name: "structure" });
  const got = await read(bytes);
  const have = (got.content.content ?? []).map(tree);
  const want = (source.content ?? []).map(tree);
  if (process.env.WF_SHOW) console.log(have.join("\n"));
  check("a link leads where it led", marksOf(got.content, "a link").includes("link") && JSON.stringify(got.content).includes("https://example.org/harbour"));
  check("a footnote is a note again, where its number stood, and gone from the foot of the page", have[1] === want[1], have[1]);
  check("bullets are a list, an item's second line its own, a numbered list inside an item inside it", have[3] === want[3].replace("ol(", "ol("), have[3]);
  check("a numbered list is a numbered list, counting from one", have[5] === want[5] && (got.content.content ?? [])[5]?.attrs?.start === 1, have[5]);
  check("a table drawn with lines is a table, a cell across two columns across two", have[7] === want[7], have[7]);
  const table = (got.content.content ?? [])[7];
  check("…its columns as wide as they were, its lines kept", table?.attrs?.cols === "120 150 100" && table?.attrs?.lines === null, JSON.stringify(table?.attrs));
  check("the paragraphs around them are as they were", have.length === want.length && have[0] === want[0] && have[4] === want[4] && have[8] === want[8], `${have.length} of ${want.length}`);
  check("the exporter's bookmarks make the headings, as deep as they were", have[2] === want[2] && have[6] === want[6]);
}

// A table set in space alone, a contents page, and what is neither.
{
  const rows = [
    ["Vessel", "Berth", "Tonnage"],
    ["Maria", "Four", "1,200"],
    ["Northern Light", "Nine", "860"],
    ["Tern", "Two", "95"],
  ];
  const bytes = await handmade((pen) => {
    pen.addPage({ size: LETTER, margin: 0 }).font("carlito-regular").fontSize(11);
    pen.text("Ships in the harbour this week, with where each lies and what it carries.", 72, 80, { lineBreak: false });
    rows.forEach((row, r) => {
      pen.font(r === 0 ? "carlito-bold" : "carlito-regular");
      pen.text(row[0], 72, 120 + r * 16, { lineBreak: false });
      pen.text(row[1], 250, 120 + r * 16, { lineBreak: false });
      pen.text(row[2], 400, 120 + r * 16, { width: 60, align: "right", lineBreak: false });
    });
    pen.font("carlito-regular").text("After the table the text goes on as it did before, across the page.", 72, 220, { lineBreak: false });
    // Speech, each line begun with a dash: not a list.
    pen.text("- Did the ferry come in?", 72, 280, { lineBreak: false });
    pen.text("- It did, an hour ago.", 72, 300, { lineBreak: false });
    // A name and a date at the two ends of one line: one line.
    pen.text("A. Writer", 72, 360, { lineBreak: false });
    pen.text("13 October 2026", 440, 360, { lineBreak: false });
  }, {}, "spaced");
  const got = await read(bytes);
  const have = (got.content.content ?? []).map(tree);
  if (process.env.WF_SHOW) console.log(have.join("\n"));
  check("rows whose pieces line up in three columns are a table", have[1] === "table(tr(td(p[Vessel]) td(p[Berth]) td(p[Tonnage])) tr(td(p[Maria]) td(p[Four]) td(p[1,200])) tr(td(p[Northern Light]) td(p[Nine]) td(p[860])) tr(td(p[Tern]) td(p[Two]) td(p[95])))", have[1]);
  const table = (got.content.content ?? [])[1];
  check("…with no lines, as it had none, and its bold first row heading it", table?.attrs?.lines === "none" && table?.attrs?.head === true, JSON.stringify(table?.attrs));
  check("the text before it and after it is text", have[0].startsWith("p[Ships in the harbour") && have[2].startsWith("p[After the table"));
  check("lines of speech that begin with a dash are not a list", have[3] === "p[- Did the ferry come in?]" && have[4] === "p[- It did, an hour ago.]", `${have[3]} ${have[4]}`);
  check("two things at the two ends of one line are one line", have[5] === "p[A. Writer\t13 October 2026]", JSON.stringify(have[5]));
}

// ------------------------------------------------------------- pictures

{
  const FERRY = png(24, 12, (x, y) => (x < 12 ? [200, 40, 40] : y < 6 ? [40, 40, 200] : [250, 250, 240]));
  const MAP = png(10, 10, (x) => [x * 20, 120, 60]);
  const images: DocRequest["images"] = [
    { url: "pic:ferry", w: 24, h: 12, bytes: FERRY },
    { url: "pic:map", w: 10, h: 10, bytes: MAP },
  ];
  const source = docOf(
    h(1, "Pictures"),
    p(SEA.repeat(2).trim()),
    { type: "image", attrs: { src: "pic:ferry", width: 240, height: 120, caption: "Figure 1. The ferry at the quay." } },
    p(HILL.repeat(2).trim()),
    { type: "image", attrs: { src: "pic:map", width: 100, height: 100, align: "center" } },
    { type: "image", attrs: { src: "pic:ferry", width: 120, height: 60 } },
    p("The end."),
  );
  const bytes = await pdfOf(source, {}, { images, name: "pictures" });
  encoded.length = 0;
  const got = await read(bytes, { encodeImage });
  const blocks = got.content.content ?? [];
  const kinds = blocks.map((n) => n.type).join(" ");
  check("pictures come back where they stood in the text", kinds === "heading paragraph image paragraph image image paragraph", kinds);
  const shown = blocks.filter((n) => n.type === "image");
  check("…each as a file, a picture drawn twice kept once", got.media.length === 2 && got.media.every((m) => m.type === "image/png" && m.bytes.length > 60) && shown[0].attrs?.src === got.media[0].key && shown[2].attrs?.src === got.media[0].key && shown[1].attrs?.src === got.media[1].key, `${got.media.length} files`);
  check("…at the size it was shown", shown[0].attrs?.width === 240 && shown[0].attrs?.height === 120 && shown[1].attrs?.width === 100 && shown[2].attrs?.width === 120, JSON.stringify(shown.map((n) => [n.attrs?.width, n.attrs?.height])));
  check("what is said under a picture is the picture's, and out of the text", shown[0].attrs?.caption === "Figure 1. The ferry at the quay." && !outline(got.content).some((line) => line.includes("Figure 1")), String(shown[0].attrs?.caption));
  check("a picture in the middle of the page is in the middle", shown[1].attrs?.align === "center" && shown[0].attrs?.align === undefined, JSON.stringify(shown.map((n) => n.attrs?.align)));
  check("each is asked for once, and no larger than this device keeps", encoded.length === 2 && encoded.every((e) => e.max === 16_000_000), JSON.stringify(encoded));
  const without = await read(bytes);
  check("with nothing to make a file of them, they are left out and counted", !(without.content.content ?? []).some((n) => n.type === "image") && without.media.length === 0 && without.warnings.join().includes("2 pictures left out"), without.warnings.join());
}

// ------------------------------------------------- the look of the page

{
  const source = docOf(
    h(1, "The look"),
    ...Array.from({ length: 5 }, (_, k) => p(`Look ${k + 1}. ${SEA.repeat(4).trim()}`)),
    p("A word in ", t("red", { type: "textColor", attrs: { c: "#c00000" } }), " and one that is ", t("large", { type: "fontSize", attrs: { pt: 18 } }), " in the middle of a line of words, and one in ", t("another face", { type: "fontFamily", attrs: { f: "courier-prime" } }), "."),
    { type: "paragraph", attrs: { size: 9 }, content: [t(`All of this paragraph is small. ${HILL.repeat(2).trim()}`)] },
    ...Array.from({ length: 30 }, (_, k) => p(`More ${k + 1}. ${SEA.repeat(4).trim()}`)),
  );
  const settings: Partial<DocSettings> = { pageSize: "a4", mt: 1.25, mb: 1.1, ml: 1.4, mr: 0.9, bodyFont: "carlito", bodySize: 11, firstIndent: 0.3, paraSpacing: 0, hC: "{title}", fR: "", fC: "Page {page} of {pages}", pnStart: 5 };
  const got = await read(await pdfOf(source, settings, { name: "look" }));
  const s = got.settings;
  if (process.env.WF_SHOW) console.log(JSON.stringify(s), got.fonts, got.warnings);
  const near = (v: unknown, want: number, by = 0.06) => typeof v === "number" && Math.abs(v - want) <= by;
  check("the paper is the paper it was", s.pageSize === "a4" && s.landscape === false, `${s.pageSize}`);
  check("the margins are measured from where the text stands", near(s.ml, 1.4) && near(s.mr, 0.9, 0.12) && near(s.mt, 1.25, 0.1) && near(s.mb, 1.1, 0.12), JSON.stringify([s.ml, s.mr, s.mt, s.mb]));
  check("the text's font and size are the document's", s.bodyFont === "carlito" && s.bodySize === 11, `${s.bodyFont} ${s.bodySize}`);
  check("first lines that start in are a setting, not a tab in each paragraph", near(s.firstIndent, 0.3, 0.03) && !JSON.stringify(got.content).includes("\\t"), String(s.firstIndent));
  check("the running head is the header, out of the text", s.hC === "The Harbour" && !outline(got.content).some((line) => line === "paragraph:The Harbour"), String(s.hC));
  check("page numbers are the footer's fields, counting from where they counted", s.fC === "Page {page} of {pages}" && s.fR === "" && s.pnStart === 5, `${s.fC} | ${s.fR} | ${s.pnStart}`);
  const para = (got.content.content ?? []).find((n) => textOf(n).startsWith("A word in"))!;
  const mark = (text: string) => (para.content ?? []).find((n) => (n.text ?? "").includes(text))?.marks ?? [];
  check("a word in another colour keeps it", mark("red").some((m) => m.type === "textColor" && m.attrs?.c === "#c00000") && mark("A word").length === 0, JSON.stringify(mark("red")));
  check("a word in another size keeps it", mark("large").some((m) => m.type === "fontSize" && m.attrs?.pt === 18), JSON.stringify(mark("large")));
  check("a word in another face keeps it", mark("another face").some((m) => m.type === "fontFamily" && m.attrs?.f === "mono"), JSON.stringify(mark("another face")));
  const small = (got.content.content ?? []).find((n) => textOf(n).startsWith("All of this paragraph"));
  check("a paragraph all in another size says so once", small?.attrs?.size === 9 && (small.content ?? []).every((n) => !(n.marks ?? []).length), JSON.stringify(small?.attrs));
  const plain = (got.content.content ?? []).find((n) => textOf(n).startsWith("Look 1."));
  check("a paragraph like the rest says nothing", plain?.attrs === undefined && (plain?.content ?? []).every((n) => !(n.marks ?? []).length), JSON.stringify(plain?.attrs));
  const cols = await read(await pdfOf(docOf(...Array.from({ length: 14 }, (_, k) => p(`Column ${k + 1}. ${SEA.repeat(3).trim()}`))), { cols: 2, colGap: 0.4 }));
  check("text in two columns is a document in two columns", cols.settings.cols === 2 && near(cols.settings.colGap, 0.4, 0.12), `${cols.settings.cols} ${cols.settings.colGap}`);
}
{
  check("a face's name in a PDF is its family's", pdfFontFamily("ABCDEF+TimesNewRomanPS-BoldMT") === "Times New Roman" && pdfFontFamily("EBGaramond-Regular") === "EB Garamond" && pdfFontFamily("ArialMT") === "Arial" && pdfFontFamily("Calibri,Bold") === "Calibri" && pdfFontFamily("Courier Prime") === "Courier Prime");
  check("…a font of the app's own by its own id, a font nobody has by none", fontIdForPdfName("BZZZZZ+Literata-Regular") === "literata" && fontIdForPdfName("CourierPrime-Bold") === "mono" && fontIdForPdfName("XYZABC+SomeHouseFace-Book") === null, `${fontIdForPdfName("BZZZZZ+Literata-Regular")} ${fontIdForPdfName("CourierPrime-Bold")} ${fontIdForPdfName("XYZABC+SomeHouseFace-Book")}`);
}

// ------------------------------------------------- read by its tags

{
  const FERRY = png(24, 12, (x) => (x < 12 ? [200, 40, 40] : [40, 40, 200]));
  const source = docOf(
    h(1, "A tagged report"),
    p("An opening paragraph with ", t("a link", { type: "link", attrs: { href: "https://example.org/tagged" } }), " in it, and a note", note("What the note says."), " after it."),
    { type: "blockquote", content: [p("Somebody else said this.")] },
    // (As large as the text: nothing but its tag says it is a heading.)
    { type: "heading", attrs: { level: 3, size: 12 }, content: [t("A heading no larger than the text")] },
    { type: "bulletList", content: [li(p("First item")), li(p("Second item"), { type: "orderedList", content: [li(p("Inner one")), li(p("Inner two"))] })] },
    { type: "table", attrs: { cols: "120 150 100", head: true }, content: [tr(cell("Region"), cell("Spring"), cell("Autumn")), tr(cell("North"), cell(""), cell("12")), tr(cell("South and east", { colspan: 2 }), cell("9"))] },
    { type: "image", attrs: { src: "pic:ferry", width: 240, height: 120, alt: "A ferry at a quay", caption: "The ferry, seen from the hill." } },
    ...Array.from({ length: 9 }, (_, k) => p(`Long ${k + 1}. ${SEA.repeat(6).trim()}`)),
    p("The end."),
  );
  const bytes = await pdfOf(source, {}, { tagged: true, images: [{ url: "pic:ferry", w: 24, h: 12, bytes: FERRY }], name: "tagged" });
  const got = await read(bytes, { encodeImage });
  const have = (got.content.content ?? []).map(tree);
  const want = (source.content ?? []).map(tree);
  if (process.env.WF_SHOW) console.log(have.map((line) => line.slice(0, 200)).join("\n"), got.warnings);
  check("a tagged file comes back block for block", have.length === want.length, `${have.length} of ${want.length}`);
  check("a heading is the heading its tag says, whatever it looks like", have[0] === want[0] && have[3] === "h3[A heading no larger than the text]", have[3]);
  check("a note is where it was cited", have[1] === want[1], have[1]);
  check("a quotation is a quotation", have[2] === "blockquote(p[Somebody else said this.])", have[2]);
  check("lists are the lists they were, one inside the other", have[4] === want[4], have[4]);
  check("a table has its cells, the empty one too, and the one across two columns", have[5] === want[5], have[5]);
  const table = (got.content.content ?? [])[5];
  check("…and its first row is known to head it", table?.attrs?.head === true, JSON.stringify(table?.attrs));
  const picture = (got.content.content ?? [])[6];
  check("a picture has what it shows and what is said under it", picture?.type === "image" && picture.attrs?.alt === "A ferry at a quay" && picture.attrs?.caption === "The ferry, seen from the hill." && picture.attrs?.src === got.media[0]?.key, JSON.stringify(picture?.attrs));
  check("paragraphs a page break cut in two are whole", have.slice(7).every((line, k) => line === want[7 + k]), have.slice(7).find((line, k) => line !== want[7 + k])?.slice(0, 160) ?? "");
  check("the running head and page numbers, marked as decoration, are not text", !have.some((line) => line === "p[The Harbour]" || /^p\[\d+\]$/.test(line)));
}

// ---------------------------------------------------------------- scans

{
  const SHEET = png(60, 78, (x, y) => ((x + y) % 7 === 0 ? [90, 90, 90] : [244, 242, 236]));
  const LIMITS = { bytes: 64e6, pages: 2000, ocrPages: 300, picturePixels: 16e6, pictures: 400, pictureBytes: 96e6 };
  const scanned = (pages: number, layer = false) =>
    handmade((pen) => {
      for (let n = 0; n < pages; n += 1) {
        pen.addPage({ size: LETTER, margin: 0 }).image(Buffer.from(SHEET), 0, 0, { width: 612, height: 792 });
        if (!layer) continue;
        // The words a scanner's own software read, set where nobody sees them.
        pen.font("carlito-regular").fontSize(12).addContent("3 Tr");
        pen.text("A page that was scanned, with the words it was read as kept under the picture of it.", 72, 100, { lineBreak: false });
        pen.text("A second line of those words, on the same page.", 72, 116, { lineBreak: false });
        pen.addContent("0 Tr");
      }
    }, {}, layer ? "scan-layer" : `scan-${pages}`);
  // What a recogniser would say of the page: a heading, and two lines of a
  // paragraph, each with its box as parts of the picture.
  const seen: { lang: string; type: string; w: number }[] = [];
  const recognise: Recognise = async (picture, lang) => {
    seen.push({ lang, type: picture.type, w: picture.w });
    return [
      { text: "Minutes of the meeting", box: { x: 0.12, y: 0.1, w: 0.5, h: 0.031 }, confidence: 0.98 },
      { text: "The committee met at the harbour office and agreed that the", box: { x: 0.12, y: 0.2, w: 0.76, h: 0.0185 }, confidence: 0.95 },
      { text: "ferry should run twice a day in winter.", box: { x: 0.12, y: 0.222, w: 0.48, h: 0.0195 }, confidence: 0.93 },
      { text: "~~", box: { x: 0.5, y: 0.6, w: 0.02, h: 0.01 }, confidence: 0.1 },
    ];
  };
  const kinds = (got: PdfRead) => (got.content.content ?? []).map((n) => n.type).join(" ");

  const layered = await read(await scanned(1, true), { encodeImage, recognise, ask: { scan: async () => "pictures" } });
  check("a scan that brought its words with it is read by them, and nothing is asked", outline(layered.content).join("|") === "paragraph:A page that was scanned, with the words it was read as kept under the picture of it. A second line of those words, on the same page." && layered.media.length === 0 && seen.length === 0, outline(layered.content).join("|"));

  const one = await scanned(1);
  const asked: [number, boolean][] = [];
  const got = await read(one, { encodeImage, recognise, lang: "en-GB", ask: { scan: async (pages, canRead) => (asked.push([pages, canRead]), "read") } });
  check("a page that is a picture of text asks what to do with it", asked.length === 1 && asked[0][0] === 1 && asked[0][1] === true, JSON.stringify(asked));
  check("read, it is text: its lines a paragraph, its larger line a heading", outline(got.content).join("|") === "h1:Minutes of the meeting|paragraph:The committee met at the harbour office and agreed that the ferry should run twice a day in winter.", outline(got.content).join("|"));
  check("…the picture is not kept beside it, and what was not read surely is left out", got.media.length === 0 && !JSON.stringify(got.content).includes("~~"));
  check("…in the language asked for, from the picture itself", seen.length === 1 && seen[0].lang === "en-GB" && seen[0].type === "image/png" && seen[0].w === 60, JSON.stringify(seen));
  check("…and the import says the text was read by this device", got.warnings.join().includes("the text of 1 scanned page was read by this device and may have mistakes"), got.warnings.join());

  const kept = await read(await scanned(2), { encodeImage, recognise, ask: { scan: async () => "pictures" } });
  check("kept as pictures, each page is a picture", kinds(kept) === "image image" && kept.media.length === 1 && kept.warnings.join().includes("2 scanned pages kept as pictures"), `${kinds(kept)} ${kept.warnings.join()}`);
  const unread: boolean[] = [];
  const none = await read(one, { encodeImage, ask: { scan: async (_pages, canRead) => (unread.push(canRead), "read") } });
  check("where nothing can read a picture, that is said, and the page is a picture", unread.join() === "false" && kinds(none) === "image", `${unread.join()} ${kinds(none)}`);
  const off = await read(one, { encodeImage, recognise, ask: { scan: async () => null } }).catch((e) => e);
  check("called off at the question, nothing is imported", importCancelled(off));
  seen.length = 0;
  const some = await read(await scanned(3), { encodeImage, recognise, limits: { ...LIMITS, ocrPages: 2 }, ask: { scan: async () => "read" } });
  check("past the most pages read at once, the rest are pictures, and that is said", seen.length === 2 && kinds(some).endsWith("image") && some.warnings.join().includes("1 scanned page kept as a picture (the most read at once is 2)"), `${seen.length} ${kinds(some)} ${some.warnings.join()}`);
  const broken = await read(one, { encodeImage, recognise: async () => { throw new Error("no"); }, ask: { scan: async () => "read" } });
  check("a page that could not be read is a picture", kinds(broken) === "image" && broken.warnings.join().includes("1 scanned page kept as a picture"), `${kinds(broken)} ${broken.warnings.join()}`);

  // The question as it is asked.
  const root = createRoot(mountPoint());
  await act(async () => root.render(createElement(PdfImportHost)));
  const body = () => document.body.textContent ?? "";
  const until = async (ok: () => boolean) => {
    for (let k = 0; k < 200 && !ok(); k += 1) await act(async () => wait(10));
  };
  const press = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} button in: ${body()}`);
    await act(async () => {
      button.click();
      await wait(0);
    });
  };
  {
    const ui = beginPdfImport("Scan.pdf");
    const going = read(await scanned(2), { encodeImage, recognise, ask: ui.ask, signal: ui.signal }).finally(ui.end);
    await until(() => body().includes("pictures"));
    check("the dialog says the pages are scans, and offers to read them or keep them", body().includes("These pages are pictures") && body().includes("2 pages of this PDF are scans") && ["Cancel", "Keep as pictures", "Read the text"].every((label) => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === label)), body());
    await press("Read the text");
    let done!: PdfRead;
    await act(async () => {
      done = await going;
    });
    check("Read the text reads them", outline(done.content)[0] === "h1:Minutes of the meeting" && body() === "", outline(done.content)[0]);
  }
  {
    const ui = beginPdfImport("Scan.pdf");
    const going = read(one, { encodeImage, ask: ui.ask, signal: ui.signal }).finally(ui.end);
    await until(() => body().includes("picture"));
    check("where the text cannot be read here, only keeping the picture is offered", body().includes("This page is a picture") && !body().includes("Read the text") && body().includes("Keep as pictures"), body());
    await press("Keep as pictures");
    let done!: PdfRead;
    await act(async () => {
      done = await going;
    });
    check("…and keeps it", kinds(done) === "image");
  }
  await act(async () => root.unmount());
}

// ---------------------------------------------------------- a screenplay

{
  const el = (element: string, text: string): JSONContent => ({ type: "paragraph", attrs: { element }, content: [t(text)] });
  const script = docOf(
    el("scene_heading", "INT. KITCHEN - NIGHT"),
    el("action", "Ana stands at the window. Rain on the glass, and a car that slows outside and then goes on up the hill."),
    el("character", "ANA"),
    el("parenthetical", "(without turning)"),
    el("dialogue", "You came back. I had stopped counting the days, and then the weeks, and then I stopped counting at all."),
    el("transition", "CUT TO:"),
    el("scene_heading", "EXT. HARBOUR - DAY"),
    ...Array.from({ length: 40 }, (_, k) => el("action", `Action line ${k + 1}.`)),
    el("character", "TOM"),
    el("dialogue", "Nobody told me."),
  );
  const made = scriptedAsDocument(script, "screenplay", "The Kitchen");
  const got = await read(await pdfOf(made.doc, made.settings as Partial<DocSettings>, { name: "screenplay" }));
  const elements = (content: JSONContent) => (content.content ?? []).map((n) => `${n.attrs?.element ?? n.type}:${textOf(n)}`);
  const want = elements(script);
  const have = elements(got.content);
  check("a screenplay's pages are known for one", got.suggestedFormat === "screenplay");
  check("…and each line is the element it was, a page number nowhere among them", have.length === want.length && have.every((line, k) => line === want[k]), `${have.length} of ${want.length}: ${have.find((line, k) => line !== want[k]) ?? ""}`);
}

// --------------------------------------------- limits, progress, cancel

{
  const source = docOf(...Array.from({ length: 40 }, (_, k) => p(`Limit paragraph ${k + 1}. ${SEA.repeat(4).trim()}`)));
  const bytes = await pdfOf(source);
  const pages = (await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise).numPages;
  const steps: string[] = [];
  const whole = await read(bytes, { progress: (done, total, label) => steps.push(`${done}/${total} ${label}`) });
  check("an import says how far it is, a page at a time", pages >= 4 && steps.length === pages + 1 && steps[0] === `0/${pages} Reading page 1 of ${pages}` && steps[pages].startsWith(`${pages}/${pages}`), `${pages} pages, ${steps.length} steps`);
  const part = await read(bytes, { limits: { bytes: 64e6, pages: 2, ocrPages: 0, picturePixels: 1e6, pictures: 10, pictureBytes: 1e6 } });
  check("past the most pages it reads, it stops and says so", outline(part.content).length < outline(whole.content).length && part.warnings.join().includes(`only the first 2 of ${pages} pages`), part.warnings.join());
  const tooLarge = await read(bytes, { limits: { bytes: 1000, pages: 9, ocrPages: 0, picturePixels: 1e6, pictures: 10, pictureBytes: 1e6 } }).catch((e: { code?: string }) => e.code);
  check("a file larger than it may read is refused", tooLarge === "pdf_too_large");
  const ctrl = new AbortController();
  const stopped = await read(bytes, { signal: ctrl.signal, progress: (done) => (done === 1 ? ctrl.abort() : undefined) }).catch((e) => e);
  check("an import called off stops, and says only that", importCancelled(stopped), JSON.stringify(stopped));
  const rubbish = await read(new TextEncoder().encode("this is not a pdf at all")).catch((e: { code?: string }) => e.code);
  check("a file that is no PDF says so", rubbish === "pdf_invalid", String(rubbish));
}

// ------------------------------------------------------------ password

{
  const locked = await handmade((pen) => {
    pen.addPage({ size: LETTER, margin: 0 }).font("carlito-regular").fontSize(12).text("Behind a password.", 72, 100, { lineBreak: false });
  }, { userPassword: "open sesame" });
  const refused = await read(locked).catch((e: { code?: string }) => e.code);
  check("a file with a password, and nobody to ask, says what to do", refused === "pdf_password", String(refused));
  const asked: boolean[] = [];
  const got = await read(locked, { ask: { password: async (again) => (asked.push(again), again ? "open sesame" : "wrong") } });
  check("the password is asked for, and again while it is wrong", asked.join() === "false,true" && outline(got.content).join() === "paragraph:Behind a password.", `${asked.join()} ${outline(got.content).join()}`);
  const off = await read(locked, { ask: { password: async () => null } }).catch((e) => e);
  check("asked and called off, nothing is imported", importCancelled(off));

  // The dialog that asks, and the import as a file is imported.
  const root = createRoot(mountPoint());
  await act(async () => root.render(createElement(PdfImportHost)));
  const body = () => document.body.textContent ?? "";
  const press = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} button in: ${body()}`);
    await act(async () => {
      button.click();
      await wait(0);
    });
  };
  const type = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    const setter = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const until = async (ok: () => boolean) => {
    for (let k = 0; k < 200 && !ok(); k += 1) await act(async () => wait(10));
  };
  const file = () => new File([locked as BlobPart], "Locked.pdf", { type: "application/pdf" });

  const going = convertFile(file());
  await until(() => body().includes("has a password"));
  check("importing a file with a password opens a dialog that asks for it", body().includes("This PDF has a password") && body().includes("Type the password"), body());
  check("…which will not go on with nothing typed", document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === true);
  await type("not it");
  await press("Open");
  await until(() => body().includes("did not open"));
  check("a wrong password is said to be wrong, and asked for again", body().includes("That password did not open it"), body());
  await type("open sesame");
  await press("Open");
  let converted!: Awaited<typeof going>;
  await act(async () => {
    converted = await going;
  });
  check("the right one opens it, and the dialog is gone", outline(converted.content).join() === "paragraph:Behind a password." && body() === "", `${outline(converted.content).join()} [${body()}]`);

  const second = convertFile(file()).catch((e) => e);
  await until(() => body().includes("has a password"));
  await press("Cancel");
  let ended: unknown;
  await act(async () => {
    ended = await second;
  });
  check("Cancel there imports nothing and says nothing", importCancelled(ended) && body() === "");

  check("a quick import shows no dialog at all", SHOW_AFTER_MS >= 1000);
  await act(async () => root.unmount());
}

check("everything read here is a document the editor can hold, in formatting every released version knows", readings >= 20 && unfit === "", `${readings} readings ${unfit}`);

finish();
