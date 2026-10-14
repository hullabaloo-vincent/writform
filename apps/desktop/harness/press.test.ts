// A book's interior as a press asks for it: PDF/X-1a:2001 (black ink and
// greys, PDF 1.3, the printing it was made for named) and bleed (each sheet
// larger than its page at the top, the foot and the outside edge). The
// pages themselves are set exactly as they are without either.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { writeFileSync } from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { familiesFor, setPictureSource } from "../src/book/engine/client";
import { grays, keptPicture, makePicture, planPicture, sniff, type PdfPicture, type PictureTools, type RawPicture } from "../src/book/engine/pictures";
import { BLEED_PT, TypesetSession, type LayoutRequest } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { choosePreset, readBook, updateBook } from "../src/book/model/bookMap";
import { buildModel } from "../src/book/model/buildModel";
import { ExportBookDialog } from "../src/book/ui/ExportBookDialog";
import { backend } from "../src/lib/backend";
import { manuscript, type N } from "./manuscript";
import { pdfObjects, pdfxProblems } from "./pdfa";
import { fakeProfile, GRAY_JPEG, png, QUAD_JPEG, withProfile } from "./pix";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const latin = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const count = (bytes: Uint8Array, what: string) => latin(bytes).split(what).length - 1;
const dump = process.env.WF_DUMP;

// A short book with two pictures in its first chapter.
const doc = manuscript({ chapters: 3 }) as N;
const first = (doc.content ?? []).findIndex((n) => n.type === "paragraph" && !n.attrs?.element);
doc.content!.splice(first + 1, 0, { type: "image", attrs: { src: "pic:colour" } }, { type: "image", attrs: { src: "pic:grey" } });
const ydoc = new Y.Doc();
choosePreset(ydoc, "classic");
updateBook(ydoc, { "meta.title": "The Harbour & the Garden", "meta.author": "A. N. Author" });
const book = readBook(ydoc);
const model = buildModel(doc as never, "manuscript", book);
const families = familiesFor("paperback", model);
const session = new TypesetSession();
session.addFonts(await loadFontFiles(session.missingFamilies(families)));
const images = [
  { url: "pic:colour", w: 16, h: 8 },
  { url: "pic:grey", w: 8, h: 8 },
];
const request = (press?: LayoutRequest["press"]): LayoutRequest => ({ kind: "paperback", model, families, images, now: Date.UTC(2026, 9, 13), ...(press ? { press } : {}) });
const greyPixels = new Uint8Array(16 * 8).map((_, i) => (i % 16) * 16);
const GREYS = new Map<string, PdfPicture>([
  ["pic:colour", { kind: "gray", bytes: greyPixels, w: 16, h: 8 }],
  ["pic:grey", keptPicture(GRAY_JPEG, sniff(GRAY_JPEG)!, false)],
]);
const COLOURS = new Map<string, PdfPicture>([
  ["pic:colour", keptPicture(QUAD_JPEG, sniff(QUAD_JPEG)!)],
  ["pic:grey", keptPicture(GRAY_JPEG, sniff(GRAY_JPEG)!)],
]);
const from = (pictures: Map<string, PdfPicture>) => async (want: { url: string }[]) => new Map(want.flatMap((w) => (pictures.has(w.url) ? [[w.url, pictures.get(w.url)!] as [string, PdfPicture]] : [])));

// --------------------------------------------------------- greys only

await (async () => {
  const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
  check("a pixel's grey is how light it is to the eye: green most, blue least", JSON.stringify([...grays(rgba, 6, 1)]) === JSON.stringify([76, 150, 29, 255, 0, 128]), JSON.stringify([...grays(rgba, 6, 1)]));

  const colour = sniff(QUAD_JPEG)!;
  const grey = sniff(GRAY_JPEG)!;
  check("for a press in black, a JPEG in greys goes in as it is", planPicture(grey, { w: 72, h: 72 }, "print", { gray: true }).act === "keep" && planPicture(grey, { w: 2, h: 2 }, "print", { gray: true }).act === "keep");
  check("…and one in colour is drawn, however good it is", planPicture(colour, { w: 144, h: 72 }, "print", { gray: true }).act === "draw" && planPicture(colour, { w: 144, h: 72 }, "print").act === "keep");
  const big = planPicture({ ...colour, w: 6000, h: 4000 }, { w: 144, h: 96 }, "original", { gray: true });
  check("…at no more pixels than are kept one by one", big.act === "draw" && big.w * big.h <= 9_000_000 && big.w > 3000);

  const drawn: boolean[] = [];
  const tools: PictureTools = {
    async draw(_bytes, _type, w, h, _orientation, white) {
      drawn.push(white);
      return { pixels: () => new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 1 ? 200 : 40)), jpeg: async () => new Uint8Array(5), free() {} };
    },
  };
  const made = (await makePicture(QUAD_JPEG, colour, { w: 144, h: 72 }, "print", { flatten: true, gray: true }, tools)) as RawPicture;
  check("a colour photograph is made greys, drawn on white, each pixel kept", made.kind === "gray" && made.bytes.length === 16 * 8 && made.bytes[0] === Math.round(0.299 * 40 + 0.587 * 200 + 0.114 * 40) && drawn.join() === "true" && !made.alpha && !made.icc);
  const profiled = withProfile(GRAY_JPEG, fakeProfile("GRAY"));
  const kept = (await makePicture(profiled, sniff(profiled)!, { w: 72, h: 72 }, "print", { flatten: true, gray: true }, tools)) as RawPicture;
  check("a grey one is not drawn, and goes in without the profile it came with (a press wants none)", kept.kind === "jpeg" && kept.gray === true && !kept.icc && same(kept.bytes, GRAY_JPEG) && drawn.length === 1);
  const drawing = png(12, 10, (x) => (x < 6 ? [200, 40, 40] : [250, 250, 240]));
  check("a drawing is made greys too", ((await makePicture(drawing, sniff(drawing)!, { w: 72, h: 60 }, "print", { flatten: true, gray: true }, tools)) as RawPicture).kind === "gray");
})();

// ---------------------------------------------------------- the files

const plainDl = (await session.layout(request())).dl;
const pressDl = (await session.layout(request({ x1a: true, bleed: true }))).dl;
check("a book's pages are set the same whatever the press asks for", JSON.stringify(plainDl) === JSON.stringify(pressDl) && plainDl.pages.length > 10, `${plainDl.pages.length} pages`);

const usual = (await session.pdf(request(), () => {}, from(COLOURS))).bytes;
const x1a = (await session.pdf(request({ x1a: true }), () => {}, from(GREYS))).bytes;
const bled = (await session.pdf(request({ bleed: true }), () => {}, from(COLOURS))).bytes;
const both = (await session.pdf(request({ x1a: true, bleed: true }), () => {}, from(GREYS))).bytes;
if (dump) {
  writeFileSync(path.join(dump, "book-x1a-bleed.pdf"), both);
  writeFileSync(path.join(dump, "book-usual.pdf"), usual);
}

{
  const problems = pdfxProblems(x1a);
  check("a book asked for as PDF/X-1a keeps every rule on the list", problems.length === 0, problems.join(" | "));
  const text = latin(x1a);
  const { objects } = pdfObjects(x1a);
  const intent = [...objects.values()].find((o) => /\/Type \/OutputIntent/.test(o.dict));
  check("it is a PDF 1.3 that says so of itself, and names the printing it was made for", text.startsWith("%PDF-1.3") && !!intent && /\/S \/GTS_PDFX/.test(intent.dict) && /CGATS TR 001/.test(intent.dict) && !/DestOutputProfile/.test(intent.dict));
  check("its pictures are greys: one as pixels, one the grey JPEG it was", count(x1a, "/Subtype /Image") === 2 && count(x1a, "/ColorSpace /DeviceGray") === 2 && Buffer.from(x1a).indexOf(Buffer.from(GRAY_JPEG)) > 0 && !text.includes("/DeviceRGB"));
  const pdf = await getDocument({ data: x1a.slice(), verbosity: 0 }).promise;
  const info = (await pdf.getMetadata()).info as Record<string, unknown>;
  check("its title and author are still said, and it has no newer kind of metadata", info.Title === "The Harbour & the Garden" && info.Author === "A. N. Author" && !(await pdf.getMetadata()).metadata && !text.includes("/Lang"));
  check("its pages are labelled as before (that is as old as PDF 1.3)", text.includes("/PageLabels") === latin(usual).includes("/PageLabels") && pdf.numPages === plainDl.pages.length);

  const mixed = (await session.pdf(request({ x1a: true }), () => {}, from(COLOURS))).bytes;
  check("a colour picture handed to it anyway is left out, and the file still keeps the rules", pdfxProblems(mixed).length === 0 && count(mixed, "/Subtype /Image") === 1, pdfxProblems(mixed).join(" | "));

  const lacks = pdfxProblems(usual);
  check("the usual book PDF makes no such claim, and the list says what sets it apart", lacks.includes("it is not a PDF 1.3") && lacks.some((x) => x.includes("PDF/X-1a:2001")) && lacks.some((x) => x.includes("no PDF/X output intent")) && lacks.some((x) => x.includes("a picture is in DeviceRGB")), lacks.join(" | "));
  check("…and is byte for byte what it was before a press could be asked for", !latin(usual).includes("GTS_PDFX") && latin(usual).startsWith("%PDF-1.4"));

  // The list is tried: a fault put into a good file is found.
  const spoil = (from: string, to: string): Uint8Array => {
    const at = text.indexOf(from);
    if (at < 0 || from.length !== to.length) throw new Error(`cannot put ${to} for ${from}`);
    const out = x1a.slice();
    out.set(Buffer.from(to, "latin1"), at);
    return out;
  };
  check("a file whose picture is in three colours is found out", pdfxProblems(spoil("/ColorSpace /DeviceGray", "/ColorSpace /DeviceRGB ")).some((x) => x.includes("DeviceRGB")));
  check("…one that does not say it is PDF/X-1a", pdfxProblems(spoil("(PDF/X-1a:2001)", "(PDF/X-3:2002) ")).some((x) => x.includes("PDF/X-1a:2001")));
  check("…one that names no registry for its condition", pdfxProblems(spoil("/RegistryName", "/RegistryNone")).some((x) => x.includes("registry")));
  check("…and one with a page that does not say where it is trimmed", pdfxProblems(spoil("/TrimBox", "/TrumBox")).some((x) => x.includes("trimmed")));
}

await (async () => {
  const sizes = async (bytes: Uint8Array) => {
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const out: { media: number[]; x: number; y: number }[] = [];
    for (const n of [1, 2, 3, 4, 9, 10]) {
      const page = await pdf.getPage(n);
      const items = (await page.getTextContent()).items.filter((it) => "str" in it && it.str.trim()) as { transform: number[] }[];
      out.push({ media: page.view.map((v) => Math.round(v * 100) / 100), x: items[0]?.transform[4] ?? -1, y: items[0]?.transform[5] ?? -1 });
    }
    return out;
  };
  const trims = (bytes: Uint8Array) => [...pdfObjects(bytes).objects.values()].filter((o) => /\/Type \/Page\b/.test(o.dict)).map((o) => /\/TrimBox \[([^\]]+)\]/.exec(o.dict)![1].trim().split(/\s+/).map(Number));
  const w = plainDl.trim.w;
  const h = plainDl.trim.h;
  const before = await sizes(usual);
  const after = await sizes(bled);
  check("with bleed each sheet is an eighth of an inch larger at the top, the foot and one side", BLEED_PT === 9 && after.every((p) => p.media[2] === Math.round((w + 9) * 100) / 100 && p.media[3] === Math.round((h + 18) * 100) / 100) && before.every((p) => p.media[2] === Math.round(w * 100) / 100), JSON.stringify(after[0].media));
  const boxes = trims(bled);
  const rectos = plainDl.pages.map((p, i) => (p.side === "recto" ? i : -1)).filter((i) => i >= 0);
  const versos = plainDl.pages.map((p, i) => (p.side === "verso" ? i : -1)).filter((i) => i >= 0);
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  check("the page is marked on it as the trim: a right-hand page against the left edge (its bleed is on the right)", rectos.length > 3 && rectos.every((i) => near(boxes[i], [0, 9, w, 9 + h])), JSON.stringify(boxes[rectos[0]]));
  check("…a left-hand page a bleed in from it", versos.length > 3 && versos.every((i) => near(boxes[i], [9, 9, 9 + w, 9 + h])), JSON.stringify(boxes[versos[0]]));
  // Text sits where it sat on the page, wherever the page is on the sheet.
  // (A page with nothing on it has no words to have moved.)
  const moved = before.map((p, i) => ({ dx: Math.round((after[i].x - p.x) * 100) / 100, dy: Math.round((after[i].y - p.y) * 100) / 100, side: plainDl.pages[[1, 2, 3, 4, 9, 10][i] - 1].side, blank: p.x < 0 })).filter((m) => !m.blank);
  check("the words keep their place on the page", moved.length >= 3 && moved.some((m) => m.side === "verso") && moved.every((m) => m.dy === 9 && m.dx === (m.side === "verso" ? 9 : 0)), JSON.stringify(moved));
  check("the usual book has no bleed: sheet, bleed and trim are one", trims(usual).every((box) => near(box, [0, 0, w, h])));
  check("both together keep the press's rules", pdfxProblems(both).length === 0 && near(trims(both)[versos[0]], [9, 9, 9 + w, 9 + h]), pdfxProblems(both).join(" | "));
  const folded = (await session.pdf({ ...request({ x1a: true, bleed: true }), kind: "booklet" }, () => {}, from(COLOURS))).bytes;
  check("a booklet printed at home is neither", !latin(folded).includes("GTS_PDFX") && latin(folded).startsWith("%PDF-1.4"));
})();

// --------------------------------------------------------- the dialog

await (async () => {
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const saved: string[] = [];
  Object.assign(backend, { saveFile: async (name: string) => (saved.push(name), { status: "saved" }) });
  const drawn: number[] = [];
  setPictureSource(
    async (url) => (url === "pic:colour" ? QUAD_JPEG : url === "pic:grey" ? GRAY_JPEG : null),
    {
      async draw(_bytes, _type, w, h) {
        drawn.push(w * h);
        return { pixels: () => new Uint8ClampedArray(w * h * 4).fill(180), jpeg: async () => new Uint8Array(40), free() {} };
      },
    },
  );
  const host = mountPoint();
  const root = createRoot(host);
  const editor = { getJSON: () => doc } as never;
  const draw = () => act(async () => root.render(createElement(ExportBookDialog, { kind: "paperback", editor, ydoc, book, format: "manuscript", readonly: false, onShowSource() {}, onClose() {} })));
  await draw();
  const box = () => document.body.querySelector(".wf-export-book-modal") as HTMLElement;
  const button = (label: string) => [...box().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  const tick = (label: string) => [...box().querySelectorAll<HTMLInputElement>('.wf-export-press input[type="checkbox"]')].find((el) => el.parentElement?.textContent?.startsWith(label))!;
  check("a paperback's dialog offers what a press may ask for, neither chosen", !!tick("PDF/X-1a for a printer") && !!tick("With bleed") && !tick("PDF/X-1a for a printer").checked && !tick("With bleed").checked);
  await act(async () => tick("PDF/X-1a for a printer").click());
  await act(async () => tick("With bleed").click());
  await act(async () => button("Create PDF")!.click());
  for (let i = 0; i < 600 && !box().querySelector(".wf-export-ready") && !box().querySelector(".wf-connect-error"); i += 1) await act(async () => wait(25));
  const ready = box().querySelector(".wf-export-ready")?.textContent ?? box().querySelector(".wf-connect-error")?.textContent ?? "";
  check("chosen, the book is made that way and says so", ready.includes("with bleed") && ready.includes("PDF/X-1a"), ready);
  check("…its colour picture drawn to be made grey, its grey one not", drawn.length === 1, `${drawn.length} drawn`);
  check("…and the choice is remembered on this device", localStorage.getItem("wf-book-press") === JSON.stringify({ x1a: true, bleed: true }));
  check("the choices give way to the file once it is made", !box().querySelector(".wf-export-press") && !!button("Save…"));
  await act(async () => root.unmount());

  const host2 = mountPoint();
  const root2 = createRoot(host2);
  await act(async () => root2.render(createElement(ExportBookDialog, { kind: "booklet", editor, ydoc, book, format: "manuscript", readonly: false, onShowSource() {}, onClose() {} })));
  check("a booklet's dialog has no such choices", !document.body.querySelector(".wf-export-press"));
  await act(async () => root2.unmount());
})();

finish();
