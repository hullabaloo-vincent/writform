// A book's cover: the artwork kept with the manuscript, what a paperback's
// cover sheet must measure, the two PDFs (the template and the cover for
// the printer), and the Cover tab that looks after it all.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { deflateSync } from "node:zlib";

import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { uploadDeviceCover } from "../src/apps/documents/import/importFile";
import { coverKeys, coverPatch, encodeArt, hasCover, noCover, parseArt, printPieces, type BookCover } from "../src/book/cover/art";
import { coverFont, encodeLook, encodeText, newText, parseLook, parseText, PLAIN_LOOK, startingTexts, type CoverText } from "../src/book/cover/design";
import { artBytes, buildCoverFile, buildTemplateFile, ebookCover, storeArt } from "../src/book/cover/files";
import { BLEED, coverGeometry, ebookNotes, fill, movedText, pannedLook, panelTrim, printedPages, printNotes, resizedText, sizeWords, slotBox, spineDrift } from "../src/book/cover/geometry";
import { buildScene, coverFaces, frontIsMade } from "../src/book/cover/scene";
import { readBook, updateBook } from "../src/book/model/bookMap";
import { BookInspector } from "../src/book/ui/BookInspector";
import { CoverEditor } from "../src/book/ui/CoverEditor";
import { viewFrame } from "../src/book/ui/CoverView";
import { decodeCatalog } from "../src/fonts/catalog";
import { fontLicence, isOpenLicence, OPEN_LICENCES } from "../src/fonts/licence";
import { attachmentRef, backend, localDocMediaUrl } from "../src/lib/backend";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// ------------------------------------------------------------ a picture

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
/** A PNG of one flat colour. */
function png(w: number, h: number, rgb: [number, number, number] = [180, 60, 60]): Uint8Array {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set(rgb, y * row + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// ------------------------------------------------- artwork, as it is kept

{
  const kept = [attachmentRef(41), "writform-att://attachment/41", "https://writform-att.localhost/attachment/41", "/api/v1/attachments/41", localDocMediaUrl("3f2a9c10-77aa", "9b1c22de-01ff")];
  check("a piece of artwork is one string: its size and where it is kept", kept.every((src) => JSON.stringify(parseArt(encodeArt({ src, w: 1600, h: 2560 }))) === JSON.stringify({ src, w: 1600, h: 2560 })));
  const bad = ["1600x2560 https://example.com/cover.jpg", "1600x2560 javascript:alert(1)", "1600x2560 file:///etc/passwd", "0x2560 /api/v1/attachments/4", "wide /api/v1/attachments/4", "1600x2560", 7, null, `1600x2560 /api/v1/attachments/${"9".repeat(40)}`];
  check("only a picture kept by a server or beside the document is ever one", bad.every((v) => parseArt(v) === null));

  const doc = new Y.Doc();
  check("a book starts with no cover", JSON.stringify(readBook(doc).cover) === JSON.stringify(noCover()) && !hasCover(readBook(doc).cover));
  updateBook(doc, { "cover.front": encodeArt({ src: attachmentRef(5), w: 1600, h: 2560 }), "cover.back": "nonsense", "cover.pages": 312, "cover.spine": 12 });
  const cover = readBook(doc).cover;
  check("the cover is read from the book's settings, and what isn't artwork is none", cover.front?.w === 1600 && cover.front.src === attachmentRef(5) && cover.back === null && cover.spine === null && cover.pages === 312);
  updateBook(doc, { "cover.front": null });
  check("taking a piece out takes it out", readBook(doc).cover.front === null);

  const three: BookCover = { ...noCover(), front: cover.front, back: { src: attachmentRef(6), w: 10, h: 10 } };
  check("a paperback prints from whichever of the three pieces there are", printPieces({ ...three, front: { src: attachmentRef(5), w: 1, h: 1 } }).join(" ") === "back front");
  check("…or from the whole cover alone, when there is one", printPieces({ ...three, wrap: { src: attachmentRef(9), w: 1, h: 1 } }).join(" ") === "wrap");
}

// --------------------------------------------------- what the sheet measures

const print = readBook(new Y.Doc()).print;
const sixByNine = { ...print, trim: "6x9", paper: "cream" as const };
{
  const geo = coverGeometry(sixByNine, 300);
  check("(the trim is 6 by 9)", geo.trim.w === 6 && geo.trim.h === 9, JSON.stringify(geo.trim));
  check("the spine is the paper's thickness for every page", Math.abs(geo.spine - 0.75) < 1e-9 && Math.abs(coverGeometry({ ...sixByNine, paper: "white" }, 300).spine - 0.6756) < 1e-9);
  check("the sheet is back, spine and front, with the bleed all round", Math.abs(geo.w - 13) < 1e-9 && Math.abs(geo.h - 9.25) < 1e-9);
  check("the three panels fill it side by side, back first", geo.back.x === 0 && Math.abs(geo.back.w - 6.125) < 1e-9 && Math.abs(geo.spineBox.x - 6.125) < 1e-9 && Math.abs(geo.front.x - 6.875) < 1e-9 && Math.abs(geo.front.x + geo.front.w - geo.w) < 1e-9);
  check("the barcode is on the back, a quarter inch from the spine and the foot", Math.abs(geo.barcode.x + geo.barcode.w - (geo.spineBox.x - 0.25)) < 1e-9 && Math.abs(geo.barcode.y + geo.barcode.h - (geo.h - BLEED - 0.25)) < 1e-9 && geo.barcode.w === 2 && geo.barcode.h === 1.2);
  check("an odd count of pages is a leaf more", printedPages(311) === 312 && coverGeometry(sixByNine, 311).pages === 312 && printedPages(0) === 2);
  check("a spine takes words from 80 pages up", coverGeometry(sixByNine, 80).spineText && !coverGeometry(sixByNine, 78).spineText);
  const words = sizeWords(geo);
  check("the size is said in inches, millimetres and pixels", words.inches === "13.000 × 9.250 in" && words.mm === "330.20 × 234.95 mm" && words.pixels === "3,900 × 2,775 pixels" && words.spine === "0.75 in", JSON.stringify(words));
  check("the whole cover fills the whole sheet", JSON.stringify(slotBox(geo, "wrap")) === JSON.stringify({ x: 0, y: 0, w: 13, h: 9.25 }));

  // Artwork made to the size: nothing cut, 300 to the inch.
  const exact = fill({ w: 3900, h: 2775 }, slotBox(geo, "wrap"));
  check("artwork made to the size fills it at 300 to the inch, nothing cut off", Math.abs(exact.ppi - 300) < 1e-6 && exact.over === null && Math.abs(exact.x) < 1e-9);
  // A front cover in the ebook's shape (1.6 to 1) on a 6 by 9 front.
  const tall = fill({ w: 1600, h: 2560 }, geo.front);
  check("a picture of another shape is scaled to cover and centred", tall.over === "ends" && Math.abs(tall.w - geo.front.w) < 1e-9 && tall.h > geo.front.h && Math.abs(tall.y + tall.h / 2 - geo.h / 2) < 1e-9);
  const art = (w: number, h: number) => ({ src: attachmentRef(1), w, h });
  check("artwork at the right size has nothing said of it", printNotes("wrap", art(3900, 2775), geo).length === 0 && printNotes("front", art(1838, 2775), geo).length === 0);
  check("small artwork is said to print soft", printNotes("front", art(919, 1388), geo).some((n) => n.includes("150 pixels to the inch")));
  check("artwork of another shape is said to be cut", printNotes("front", art(3000, 2775), geo).some((n) => n.includes("cut off at the sides")));
  check("an ebook cover is checked against the stores' sizes", ebookNotes(art(1600, 2560)).length === 0 && ebookNotes(art(500, 800))[0].includes("at least 625") && ebookNotes(art(2000, 2000)).some((n) => n.includes("tall cover")));

  const cover: BookCover = { ...noCover(), wrap: art(3900, 2775), pages: 300 };
  check("a cover made for the pages the book has: nothing to say", spineDrift(cover, geo) === null);
  const grown = spineDrift(cover, coverGeometry(sixByNine, 320));
  check("more pages since: the spine is wider, by so much", !!grown && grown.was === 300 && grown.now === 320 && Math.abs(grown.by - 0.05) < 1e-9);
  check("a front cover alone doesn't depend on the spine", spineDrift({ ...cover, wrap: null, front: art(1, 1) }, coverGeometry(sixByNine, 320)) === null);
}

// ------------------------------------------------------------ the two PDFs

async function readPdf(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const ops = await page.getOperatorList();
  return {
    pages: pdf.numPages,
    box: page.view,
    text: (await page.getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" "),
    images: ops.fnArray.filter((fn) => fn === OPS.paintImageXObject).length,
    raw: Buffer.from(bytes).toString("latin1"),
  };
}

const stored = new Map<string, Uint8Array>();
const realFetch = g.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
g.fetch = async (input: unknown, init?: unknown) => {
  const url = String(input).replace(/\?.*$/, "");
  const bytes = stored.get(url);
  if (bytes) {
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), blob: async () => new Blob([bytes as BlobPart], { type: "image/png" }) };
  }
  if (url.startsWith("writform-att://") || url.startsWith("/api/")) return { ok: false, status: 404 };
  return realFetch(input, init);
};
let nextId = 100;
Object.assign(backend, {
  uploadAttachment: async ({ dataBase64 }: { dataBase64?: string }) => {
    const id = (nextId += 1);
    stored.set(attachmentRef(id), new Uint8Array(Buffer.from(dataBase64 ?? "", "base64")));
    return { status: 200, body: { id, original_name: null } };
  },
});
const keep = (src: string, bytes: Uint8Array) => {
  stored.set(src, bytes);
  return src;
};

{
  const doc = new Y.Doc();
  updateBook(doc, { "meta.title": "The Long Way: A Novel", "print.trim": "6x9", "print.paper": "cream" });
  const geo = coverGeometry(readBook(doc).print, 300);

  const template = await buildTemplateFile(readBook(doc), geo);
  const t = await readPdf(template.bytes);
  check("the template is one page, the size of the whole sheet", t.pages === 1 && Math.abs(t.box[2] - 13 * 72) < 0.01 && Math.abs(t.box[3] - 9.25 * 72) < 0.01, t.box.join(" "));
  check("…with the printer's trim an eighth of an inch in on every side", t.raw.includes("/TrimBox [9 9 927 657]") && t.raw.includes("/BleedBox [0 0 936 666]"));
  check("…that names each part and says what it measures", ["Back cover", "Front cover", "Spine 0.75 in", "Barcode", "13.000 × 9.250 in", "3,900 × 2,775 pixels", "300 pages on cream paper"].every((s) => t.text.includes(s)), t.text.slice(0, 200));
  check("…with no picture in it", t.images === 0);
  check("the template is named for the book (in words a file can have)", template.fileName === "The Long Way A Novel (cover template).pdf", template.fileName);
  // (`WF_DUMP=dir npm run harness -- cover` leaves the files to look at.)
  const dump = process.env.WF_DUMP;
  if (dump) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dump}/cover-template.pdf`, template.bytes);
    writeFileSync(`${dump}/cover-template-thin.pdf`, (await buildTemplateFile(readBook(doc), coverGeometry({ ...readBook(doc).print, trim: "5x8" }, 60))).bytes);
  }
  const thin = await readPdf((await buildTemplateFile(readBook(doc), coverGeometry(readBook(doc).print, 40))).bytes);
  check("a thin book's template says its spine takes no words", thin.text.includes("too narrow for words") && !t.text.includes("too narrow for words"));

  // The cover: three pieces.
  updateBook(doc, {
    "cover.front": encodeArt({ src: keep(attachmentRef(1), png(184, 278, [30, 90, 160])), w: 184, h: 278 }),
    "cover.back": encodeArt({ src: keep(attachmentRef(2), png(184, 278, [20, 20, 30])), w: 184, h: 278 }),
    "cover.spine": encodeArt({ src: keep(attachmentRef(3), png(23, 278, [200, 170, 60])), w: 23, h: 278 }),
  });
  const three = await buildCoverFile(readBook(doc), geo);
  const c = await readPdf(three.bytes);
  check("the cover is one page of the same size, with a picture for each piece", c.pages === 1 && Math.abs(c.box[2] - 936) < 0.01 && Math.abs(c.box[3] - 666) < 0.01 && c.images === 3 && three.unread.length === 0, `${c.images} images`);
  check("…trim and bleed said for the printer", c.raw.includes("/TrimBox [9 9 927 657]") && c.raw.includes("/BleedBox [0 0 936 666]"));
  check("…named as the paperback's cover", three.fileName === "The Long Way A Novel (paperback cover).pdf");
  if (dump) (await import("node:fs")).writeFileSync(`${dump}/cover.pdf`, three.bytes);

  // The whole cover in one piece is what prints.
  updateBook(doc, { "cover.wrap": encodeArt({ src: keep(attachmentRef(4), png(390, 278, [90, 30, 90])), w: 390, h: 278 }) });
  const whole = await readPdf((await buildCoverFile(readBook(doc), geo)).bytes);
  check("with a whole cover, that alone is printed", whole.images === 1);

  // A picture that can't be read is left as paper, and said.
  updateBook(doc, { "cover.wrap": null, "cover.back": encodeArt({ src: attachmentRef(999), w: 10, h: 10 }) });
  const part = await buildCoverFile(readBook(doc), geo);
  check("a piece that can't be read is left out and named", part.unread.join(" ") === "back" && (await readPdf(part.bytes)).images === 2);
  updateBook(doc, { "cover.front": null, "cover.back": null, "cover.spine": null });
  let refused = "";
  await buildCoverFile(readBook(doc), geo).catch((e: { message?: string }) => (refused = e.message ?? ""));
  check("with nothing on it there is no cover to make", refused.includes("nothing on the cover"), refused);

  check("stored artwork is read back as what it is", (await artBytes({ src: attachmentRef(1), w: 1, h: 1 }))?.type === "image/png" && (await artBytes({ src: attachmentRef(999), w: 1, h: 1 })) === null);
}

// ------------------------------------------------ putting a picture with a book

{
  const sent: File[] = [];
  const upload = async (file: File) => {
    sent.push(file);
    return attachmentRef(77);
  };
  const { art, resaved } = await storeArt(new File([png(64, 100) as BlobPart], "My Cover FINAL.png", { type: "image/png" }), upload, 1024 * 1024);
  check("a chosen picture is kept as it is, and its size noted", art.src === attachmentRef(77) && art.w === 64 && art.h === 100 && !resaved && sent[0].name === "cover.png" && sent[0].type === "image/png");
  let said = "";
  await storeArt(new File(["GIF89a not a cover" as BlobPart], "cover.png", { type: "image/png" }), upload, 1024 * 1024).catch((e: { message?: string }) => (said = e.message ?? ""));
  check("only a JPEG or a PNG is a cover, whatever the file is called", said.includes("JPEG or a PNG") && sent.length === 1);
  // (No canvas here to save it again as a JPEG: it is refused, in words.)
  let heavy = "";
  await storeArt(new File([png(64, 100) as BlobPart], "big.png", { type: "image/png" }), upload, 20).catch((e: { code?: string; message?: string }) => (heavy = `${e.code}: ${e.message}`));
  check("a picture too heavy to keep, that can't be made lighter, is refused plainly", heavy.startsWith("too_large:") && sent.length === 1, heavy);
}

// ------------------------------------- a book on this device, published

{
  const here = localDocMediaUrl("11111111-aaaa", "22222222-bbbb");
  const gone = localDocMediaUrl("11111111-aaaa", "33333333-cccc");
  stored.set(here, png(40, 64));
  const maps = {
    settings: { paper: "a4" },
    book: {
      "meta.title": "Kept",
      "cover.front": encodeArt({ src: here, w: 40, h: 64 }),
      "cover.back": encodeArt({ src: gone, w: 40, h: 64 }),
      "cover.wrap": encodeArt({ src: attachmentRef(8), w: 9, h: 9 }),
    },
  };
  const out = await uploadDeviceCover(maps);
  const front = parseArt(out.book?.["cover.front"]);
  check("publishing uploads a device book's cover, and the book names the upload", !!front && /^\/api\/v1\/attachments\/\d+$/.test(front.src) && front.w === 40 && front.h === 64 && stored.has(front.src));
  check("…a piece that can't be read is left behind (nobody else could see it)", !("cover.back" in (out.book ?? {})));
  check("…what was already on a server, and everything else, is untouched", out.book?.["cover.wrap"] === maps.book["cover.wrap"] && out.book?.["meta.title"] === "Kept" && out.settings === maps.settings);
  check("…and the document it came from keeps its own", maps.book["cover.front"].includes("localdoc"));
  const none = { book: { "meta.title": "Plain" } };
  check("a book with no device artwork is passed through as it is", (await uploadDeviceCover(none)) === none);
}

// ------------------------------------------------------------ the Cover tab

{
  try {
    localStorage.setItem("wf-book-tab", "cover");
  } catch {
    // (no storage here)
  }
  const doc = new Y.Doc();
  updateBook(doc, { "meta.title": "On Screen", "print.trim": "6x9" });
  const host = mountPoint();
  const root = createRoot(host);
  let opened = 0;
  const sent: File[] = [];
  const draw = () =>
    act(async () =>
      root.render(
        createElement(BookInspector, {
          ydoc: doc,
          book: readBook(doc),
          readonly: false,
          words: 90000,
          chapters: 30,
          pictures: {
            upload: async (file: File) => {
              sent.push(file);
              return keep(attachmentRef(200 + sent.length), new Uint8Array(await file.arrayBuffer()));
            },
            limit: 10 * 1024 * 1024,
          },
          countPages: async () => 301,
          onOpenCover: () => {
            opened += 1;
          },
        }),
      ),
    );
  await draw();
  const tabs = [...host.querySelectorAll(".wf-inspector-tabs button")].map((b) => b.textContent);
  check("the Book panel has a Cover tab", tabs.join(" ") === "Book Design Print Ebook Cover" && host.querySelector(".wf-inspector-tabs button.active")?.textContent === "Cover");
  const slots = () => [...host.querySelectorAll(".wf-cover-slot")];
  check("it has a place for each piece of artwork", slots().map((s) => s.querySelector("strong")?.textContent).join(" | ") === "Front cover | Back cover | Spine | Whole cover");
  // The count comes a moment later.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 520)));
  await draw();
  check("the sheet is sized for the pages the engine counted (an even number)", host.textContent!.includes("For 302 pages on cream paper") && host.textContent!.includes("spine of 0.755 in"), host.querySelector(".wf-inspector-dim")?.textContent ?? "");

  const pick = async (index: number, bytes: Uint8Array, name: string) => {
    const input = slots()[index].querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([bytes as BlobPart], name, { type: "image/png" })] });
    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await draw();
  };
  await pick(0, png(160, 256), "front.png");
  const cover = () => readBook(doc).cover;
  check("choosing a picture puts it with the book", cover().front?.w === 160 && cover().front?.h === 256 && sent.length === 1 && slots()[0].textContent!.includes("160 × 256 pixels"), JSON.stringify(cover().front));
  check("…and says what to know about it (small for a store, soft in print)", slots()[0].querySelectorAll(".wf-cover-note").length >= 2);
  check("a front cover alone doesn't record the page count", cover().pages === 0);
  await pick(3, png(390, 278), "wrap.png");
  check("a whole cover records the pages it was put in for", !!cover().wrap && cover().pages === 302);
  check("the tab draws the cover as it stands (its pictures, no guides)", host.querySelectorAll(".wf-cover-svg image").length === 1 && host.querySelectorAll(".wf-cover-svg .wf-cover-guides").length === 0, String(host.querySelectorAll(".wf-cover-svg image").length));

  // Take the whole cover out: the three pieces again.
  await act(async () => (slots()[3].querySelector('button[aria-label^="Remove"]') as HTMLButtonElement).click());
  await draw();
  check("removing a piece takes it out of the book", cover().wrap === null && host.querySelectorAll(".wf-cover-svg image").length === 1);
  await act(async () => ([...host.querySelectorAll("button")].find((b) => b.textContent === "Open the cover editor…") as HTMLButtonElement).click());
  check("the tab opens the cover editor", opened === 1);

  // Someone who can only read can't change it.
  await act(async () => root.render(createElement(BookInspector, { ydoc: doc, book: readBook(doc), readonly: true, words: 90000, chapters: 30 })));
  check("a reader can't change the cover", slots().every((s) => [...s.querySelectorAll("button")].every((b) => (b as HTMLButtonElement).disabled)));
  await act(async () => root.unmount());
}

// ------------------------------------------- fonts: free for commercial use

{
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  // (Run from apps/desktop, as every harness is.)
  const dir = `${process.cwd()}/src/assets/fonts`;
  const families = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  check("every font that comes with the app has the Open Font License beside it", families.length >= 8 && families.every((f) => existsSync(`${dir}/${f}/OFL.txt`) && /SIL OPEN FONT LICENSE/i.test(readFileSync(`${dir}/${f}/OFL.txt`, "utf8"))), families.join(" "));
  const raw = JSON.parse(readFileSync(`${process.cwd()}/src/fonts/catalog.json`, "utf8")) as Parameters<typeof decodeCatalog>[0];
  const catalog = decodeCatalog(raw);
  check("every family of the online library is under an open licence that allows commercial use", catalog.fonts.length === raw.fonts.length && catalog.fonts.length > 1500 && catalog.fonts.every((f) => isOpenLicence(f.license)), [...new Set(catalog.fonts.map((f) => f.license))].join(" "));
  const mixed = decodeCatalog({ ...raw, fonts: [...raw.fonts.slice(0, 3), ["shady", "Shady Sans", "n", "4", 0, "latin", "X"]] });
  check("a family under any other licence never reaches a list", mixed.fonts.length === 3 && !mixed.byId.has("shady"));
  check("the open licences are the three, by name", Object.keys(OPEN_LICENCES).join(" ") === "OFL-1.1 Apache-2.0 UFL-1.0");
  check("the app vouches for its own fonts, not for the device's", fontLicence("garamond") === "OFL-1.1" && fontLicence("sys:Helvetica Neue") === null && fontLicence("georgia") === null && fontLicence("mono") === null);
  check("a cover is set only in the app's fonts and the library's", coverFont("playfair") === "playfair" && coverFont("gf:inter") === "gf:inter" && coverFont("sys:Papyrus") === "garamond" && coverFont("georgia") === "garamond" && coverFont(7) === "garamond");
}

// ------------------------------------------------------- the design, as kept

const bookWords = { title: "The Long Way", subtitle: "A Novel", author: "R. Aldous", description: "A woman walks north for a year. What she leaves behind follows her, a day behind." };
{
  const made = newText("title", "front", bookWords, []);
  const back = parseText(made.id, encodeText(made));
  check("a piece of text is kept as one string, and comes back as it went", JSON.stringify(back) === JSON.stringify(made), JSON.stringify(back));
  check("what isn't a piece of text is none", parseText("abcd1234", "{}") === null && parseText("abcd1234", "not json") === null && parseText("../x", encodeText(made)) === null && parseText("abcd1234", JSON.stringify({ panel: "front" })) === null);
  const wild = parseText("abcd1234", JSON.stringify({ panel: "back", text: "x", font: "sys:Arial", size: 9000, color: "red", x: 40, w: -3, align: "justify", leading: 0, back: "url(evil)" }))!;
  check("whatever a piece of text says of itself is held to what a cover can be", wild.font === "garamond" && wild.size === 400 && wild.color === "#111111" && wild.x === 1.1 && wild.w === 0.05 && wild.align === "center" && wild.leading === 0.7 && wild.back === null);
  check("a panel's look is kept only when it isn't the plain one", encodeLook(PLAIN_LOOK) === null && JSON.stringify(parseLook(encodeLook({ color: "#102030", zoom: 1.5, fx: 0.2, fy: 0.9 }))) === JSON.stringify({ color: "#102030", zoom: 1.5, fx: 0.2, fy: 0.9 }) && parseLook("junk") === PLAIN_LOOK);

  const start = startingTexts(bookWords, true);
  check("a bare cover starts with the book's own words in their usual places", start.map((t) => `${t.panel}:${t.text.slice(0, 12)}`).join(" | ") === "front:The Long Way | front:A Novel | front:R. Aldous | spine:The Long Way | back:A woman walk", start.map((t) => `${t.panel}:${t.text.slice(0, 12)}`).join(" | "));
  check("…each over the one before, each with a name of its own", new Set(start.map((t) => t.id)).size === 5 && start.every((t, i) => t.z === i + 1));
  check("a thin book starts with nothing on its spine", !startingTexts(bookWords, false).some((t) => t.panel === "spine"));

  // In the book: one key for each piece, so two people don't undo each other.
  const doc = new Y.Doc();
  const cover: BookCover = { ...noCover(), texts: start, looks: { ...noCover().looks, back: { ...PLAIN_LOOK, color: "#1a2233" } } };
  updateBook(doc, coverPatch({}, coverKeys(cover)));
  const read = readBook(doc).cover;
  check("the design is read back from the book, the lowest words first", read.texts.length === 5 && read.texts.map((t) => t.id).join() === start.map((t) => t.id).join() && read.looks.back.color === "#1a2233" && hasCover(read));
  check("each piece of text and each look is a key of its own", [...doc.getMap("book").keys()].filter((k) => k.startsWith("cover.text.")).length === 5 && doc.getMap("book").has("cover.look.back") && !doc.getMap("book").has("cover.look.front"));
  const changed = { ...read, texts: read.texts.slice(1).map((t, i) => (i === 0 ? { ...t, size: 22 } : t)) };
  const patch = coverPatch(coverKeys(read), coverKeys(changed));
  check("a change writes only what changed (and takes out what went)", Object.keys(patch).length === 2 && patch[`cover.text.${start[0].id}`] === null && typeof patch[`cover.text.${start[1].id}`] === "string", JSON.stringify(Object.keys(patch)));
  check("no change, nothing to write", Object.keys(coverPatch(coverKeys(read), coverKeys(readBook(doc).cover))).length === 0);
}

// ----------------------------------------------- moving things on the sheet

{
  const geo = coverGeometry(sixByNine, 300);
  const t = newText("title", "front", bookWords, []);
  const moved = movedText(t, 43.2, 64.8, geo); // a tenth of the front each way
  check("words dragged across the front move by that part of it", Math.abs(moved.x - (t.x + 0.1)) < 1e-9 && Math.abs(moved.y - (t.y + 0.1)) < 1e-9);
  const spine = newText("spine", "spine", bookWords, []);
  const along = movedText(spine, 500, 64.8, geo);
  check("words on the spine move along it only", Math.abs(along.x - (spine.x + 0.1)) < 1e-9 && along.y === spine.y);
  check("nothing can be dragged right off the cover", movedText(t, 99999, -99999, geo).x === 1.1 && movedText(t, 99999, -99999, geo).y === -0.2);
  const wider = resizedText(t, "end", 43.2, geo);
  const fromLeft = resizedText(t, "start", 43.2, geo);
  check("pulling the far side makes the box wider and leaves the near side", Math.abs(wider.w - (t.w + 0.1)) < 1e-9 && wider.x === t.x);
  check("pulling the near side moves it and leaves the far side where it was", Math.abs(fromLeft.x - (t.x + 0.1)) < 1e-9 && Math.abs(fromLeft.x + fromLeft.w - (t.x + t.w)) < 1e-9);
  // A picture twice as wide as the front: dragging it right shows its left.
  const art = { w: 3676, h: 2775 };
  const look = pannedLook(PLAIN_LOOK, art, geo.front, 100, 50);
  check("a picture that overhangs is dragged to show another part of it", look.fx < 0.5 && look.fy === 0.5 && pannedLook(PLAIN_LOOK, art, geo.front, -1e6, 0).fx === 1);
  const zoomed = fill(art, geo.front, { zoom: 2, fx: 0, fy: 0 });
  check("an enlarged picture prints fewer pixels to the inch, and starts where asked", Math.abs(zoomed.ppi - 150) < 0.5 && Math.abs(zoomed.x - geo.front.x) < 1e-9 && Math.abs(zoomed.y) < 1e-9);
  check("the parts of a cover as trimmed", JSON.stringify(panelTrim(geo, "front")) === JSON.stringify({ x: geo.front.x, y: BLEED, w: 6, h: 9 }) && panelTrim(geo, "spine").w === geo.spine && panelTrim(geo, "back").x === BLEED);
  const frame = viewFrame(geo, "spine", true);
  check("the spine is looked at lying on its side", frame.turn.startsWith("rotate(-90)") && Math.abs(frame.box.w - geo.h * 72) < 1e-6 && frame.box.h > geo.spine * 72);
  check("a cover is looked at whole, as trimmed, when the guides are off", JSON.stringify(viewFrame(geo, "all", false).box) === JSON.stringify({ x: 9, y: 9, w: 918, h: 648 }));
}

// ----------------------------------------------- the cover, set and printed

{
  const doc = new Y.Doc();
  updateBook(doc, { "meta.title": bookWords.title, "meta.author": bookWords.author, "print.trim": "6x9" });
  const geo = coverGeometry(readBook(doc).print, 300);
  const texts = startingTexts(bookWords, true);
  const blurb = texts.find((t) => t.panel === "back")!;
  const long = { ...blurb, text: `${bookWords.description} ${bookWords.description} ${bookWords.description}\n\nA second paragraph.`, back: "#ffffff" };
  const design: BookCover = { ...noCover(), texts: texts.map((t) => (t.id === blurb.id ? long : t)), looks: { ...noCover().looks, front: { ...PLAIN_LOOK, color: "#1d3a5f" }, spine: { ...PLAIN_LOOK, color: "#c9a23c" } } };
  const faces = await coverFaces(design.texts);
  const scene = buildScene(design, geo, faces);
  check("without its fonts yet, a cover has its paper and pictures and no words", buildScene(design, geo, null).texts.length === 0 && buildScene(design, geo, null).papers.length === 3);
  check("the words are set in the font files they print from", faces.missing.length === 0 && faces.families.join() === "garamond" && scene.faces.length >= 2);

  const by = (id: string) => scene.texts.find((t) => t.id === id)!;
  const title = by(texts[0].id);
  const front = panelTrim(geo, "front");
  const said = (t: typeof title) => t.items.map((it) => it.text).join(" ");
  check("the title is on the front, where its box is", said(title) === "The Long Way" && Math.abs(title.origin.x - front.x * 72) < 1e-6 && Math.abs(title.box.x - 0.1 * 432) < 1e-6 && Math.abs(title.box.y - 0.14 * 648) < 1e-6 && title.turn === 0);
  const first = title.items[0];
  const width = faces.set.measure(first.face, first.size, "The Long Way");
  check("…centred in it, by the font's own measure", Math.abs(first.x - (title.box.x + (title.box.w - width) / 2)) < 0.6, `${first.x} vs ${title.box.x + (title.box.w - width) / 2}`);
  check("…on a baseline inside its line", first.y > title.box.y && first.y < title.box.y + title.box.h);
  const author = by(texts[2].id);
  check("capitals and letter spacing are the typesetter's", said(author) === "R. ALDOUS" && (author.items[0].cs ?? 0) > 1);

  const spine = by(texts[3].id);
  check("the spine's words are turned to read from the top down", spine.turn === 90 && Math.abs(spine.origin.x - (geo.spineBox.x + geo.spine) * 72) < 1e-6 && spine.bounds.h > spine.bounds.w);
  check("…and lie within the spine, in its middle", spine.bounds.x >= geo.spineBox.x * 72 - 0.01 && spine.bounds.x + spine.bounds.w <= (geo.spineBox.x + geo.spine) * 72 + 0.01 && Math.abs(spine.bounds.x + spine.bounds.w / 2 - (geo.spineBox.x + geo.spine / 2) * 72) < 3);

  const back = by(blurb.id);
  const lines = new Set(back.items.map((it) => Math.round(it.y * 10)));
  check("a long paragraph is broken into lines that fit its box", lines.size >= 4 && back.items.every((it) => it.x >= back.box.x - 0.01 && it.x < back.box.x + back.box.w), `${lines.size} lines`);
  check("…a line left blank stays blank, and the band behind covers them all", back.box.h > lines.size * blurb.size * blurb.leading && !!back.band && back.band.color === "#ffffff" && back.band.h > back.box.h);
  // A narrower box: more lines.
  const narrow = buildScene({ ...design, texts: design.texts.map((t) => (t.id === blurb.id ? { ...long, w: 0.4 } : t)) }, geo, faces);
  check("a narrower box takes more lines", new Set(narrow.texts.find((t) => t.id === blurb.id)!.items.map((it) => Math.round(it.y * 10))).size > lines.size);
  // The same design on a thicker book: the front's words move with the front.
  const thick = buildScene(design, coverGeometry(readBook(doc).print, 600), faces);
  check("more pages: the design comes through, each part still on its own panel", Math.abs(thick.texts.find((t) => t.id === texts[0].id)!.origin.x - title.origin.x - 0.75 * 72) < 1e-6 && Math.abs(thick.texts.find((t) => t.id === texts[0].id)!.box.x - title.box.x) < 1e-9);

  // Printed.
  updateBook(doc, coverPatch({}, coverKeys(design)));
  const file = await buildCoverFile(readBook(doc), geo);
  const pdf = await readPdf(file.bytes);
  check("the cover prints its words as real text", ["The Long Way", "A Novel", "R. ALDOUS", "A woman walks north"].every((w) => pdf.text.replace(/\s+/g, " ").includes(w)), pdf.text.slice(0, 160));
  check("…in its own font, embedded (no picture of text)", pdf.images === 0 && /\/FontFile[23]?\b/.test(pdf.raw) && pdf.raw.includes("Garamond"));
  check("…on one sheet of the right size, with nothing left unread", pdf.pages === 1 && Math.abs(pdf.box[2] - 936) < 0.01 && file.unread.length === 0 && file.standIns.length === 0);
  if (process.env.WF_DUMP) (await import("node:fs")).writeFileSync(`${process.env.WF_DUMP}/cover-designed.pdf`, file.bytes);

  // The ebook's cover.
  check("a front with words on it is drawn for the ebook, not handed over as it came", frontIsMade(readBook(doc).cover) && !frontIsMade({ ...noCover(), front: { src: attachmentRef(1), w: 10, h: 16 } }) && frontIsMade({ ...noCover(), wrap: { src: attachmentRef(1), w: 10, h: 16 } }));
  // (No canvas here to draw it on: it falls back to the front's own picture.)
  const plain = new Y.Doc();
  updateBook(plain, { "cover.front": encodeArt({ src: attachmentRef(1), w: 184, h: 278 }) });
  check("a front that is only its picture is the ebook's cover as it is", (await ebookCover(readBook(plain), geo))?.type === "image/png" && (await ebookCover(readBook(doc), geo)) === null);
}

// ------------------------------------------------------------- the editor

{
  const doc = new Y.Doc();
  updateBook(doc, { "meta.title": bookWords.title, "meta.subtitle": bookWords.subtitle, "meta.author": bookWords.author, "meta.description": bookWords.description, "print.trim": "6x9" });
  const host = mountPoint();
  const root = createRoot(host);
  const counted = async () => 300;
  const sent: File[] = [];
  const pictures = {
    upload: async (file: File) => {
      sent.push(file);
      return keep(attachmentRef(400 + sent.length), new Uint8Array(await file.arrayBuffer()));
    },
    limit: 10 * 1024 * 1024,
  };
  const draw = (readonly = false) => act(async () => root.render(createElement(CoverEditor, { ydoc: doc, book: readBook(doc), readonly, words: 90000, chapters: 30, pictures, countPages: counted, onClose: () => {} })));
  const settle = (ms = 120) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await draw();
  await settle(520);
  await draw();
  const body = () => document.body.textContent ?? "";
  const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
  const cover = () => readBook(doc).cover;
  check("the editor opens on the whole cover, with the printer's guides", !!document.querySelector(".wf-cover-editor .wf-cover-svg.editing .wf-cover-guides") && body().includes("13.000 × 9.250 in") && document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Whole cover");
  check("an empty cover can't be made into a file yet, a template can", button("Make the cover (PDF)")!.disabled && !button("Make a template (PDF)")!.disabled);

  await act(async () => button("Start with the book’s title and author")!.click());
  await draw();
  await settle(300);
  await draw();
  check("starting from the book puts its title, subtitle, author, spine line and blurb on the cover", cover().texts.length === 5 && cover().texts.map((t) => t.panel).join(" ") === "front front front spine back");
  const drawn = () => [...document.querySelectorAll(".wf-cover-svg.editing [data-text]")];
  check("…and they are drawn on it, as text", drawn().length === 5 && drawn().some((el) => el.textContent?.includes("The Long Way")), String(drawn().length));
  check("now the cover can be made", !button("Make the cover (PDF)")!.disabled);

  // Choose the title: its words and its look can be changed.
  const titleId = cover().texts[0].id;
  const svg = document.querySelector<SVGSVGElement>(".wf-cover-svg.editing")!;
  // (Nothing is laid out here: say a point of the sheet is a pixel of the screen.)
  const same = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => same };
  (svg.querySelector("g") as unknown as { getScreenCTM: () => typeof same }).getScreenCTM = () => same;
  const point = (type: string, el: Element, x = 0, y = 0) => act(async () => void el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })));
  const down = (el: Element, x = 0, y = 0) => point("pointerdown", el, x, y);
  await down(document.querySelector(`[data-text="${titleId}"]`)!, 600, 150);
  await point("pointerup", svg);
  await draw();
  const words = () => document.querySelector<HTMLTextAreaElement>(".wf-cover-ed-words");
  check("pressing words chooses them: what they say and how they look can be changed", words()?.value === "The Long Way" && body().includes("Words on the front") && !!document.querySelector(".wf-cover-pick"));
  check("…the font's licence is said beside it", body().includes("SIL Open Font License 1.1. Free for commercial use."));

  const type = async (value: string) => {
    const el = words()!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  await type("The Longer Way");
  check("typing is shown at once and written to the book a moment later", words()!.value === "The Longer Way" && cover().texts.find((t) => t.id === titleId)!.text === "The Long Way");
  await settle(450);
  await draw();
  check("…then it is in the book", cover().texts.find((t) => t.id === titleId)!.text === "The Longer Way");

  await act(async () => button("Bold")!.click());
  await act(async () => button("Capitals")!.click());
  await draw();
  const title = () => cover().texts.find((t) => t.id === titleId)!;
  check("bold and capitals are a press each", title().bold && title().caps);
  await act(async () => button("Undo")!.click());
  await draw();
  check("a step back undoes the last change, and only that", title().bold && !title().caps && title().text === "The Longer Way");
  await act(async () => button("Redo")!.click());
  await draw();
  check("…and a step forward brings it back", title().caps);

  // Drag the title a tenth of the front each way.
  {
    const was = title();
    await down(document.querySelector(`[data-text="${titleId}"]`)!, 600, 150);
    await point("pointermove", svg, 600 + 43.2, 150 + 64.8);
    check("while it is dragged the words move on the cover, and the book waits", Math.abs(title().x - was.x) < 1e-9 && !!document.querySelector(".wf-cover-pick"));
    await point("pointerup", svg);
    await draw();
    check("let go, and they are where they were put", Math.abs(title().x - (was.x + 0.1)) < 1e-3 && Math.abs(title().y - (was.y + 0.1)) < 1e-3, `${title().x} ${title().y}`);
    await down(document.querySelector('[data-handle="end"]')!, 700, 200);
    await point("pointermove", svg, 700 - 43.2, 200);
    await point("pointerup", svg);
    await draw();
    check("its side handle makes the box narrower", Math.abs(title().w - (was.w - 0.1)) < 1e-3, String(title().w));
    await act(async () => button("Undo")!.click());
    await act(async () => button("Undo")!.click());
    await draw();
    check("a drag is one step to undo", Math.abs(title().x - was.x) < 1e-9 && Math.abs(title().w - was.w) < 1e-9);
  }

  // Add words while looking at the back: they go on the back.
  await act(async () => ([...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Back") as HTMLButtonElement).click());
  await act(async () => button("Other words")!.click());
  await draw();
  check("words added while looking at the back go on the back, on top", cover().texts.length === 6 && cover().texts[5].panel === "back" && cover().texts[5].z > cover().texts[4].z && words()?.value === "Text");
  await act(async () => button("Remove these words")!.click());
  await draw();
  check("words can be removed", cover().texts.length === 5 && !words());

  // A panel: its paper and its picture.
  await act(async () => ([...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Whole cover") as HTMLButtonElement).click());
  await down(svg.querySelector(".wf-cover-paper")!, 700, 300);
  await point("pointerup", svg);
  await draw();
  check("pressing the cover itself chooses the part pressed", [...document.querySelectorAll(".wf-cover-ed-group h4")].some((h) => h.textContent === "Front cover") && !!button("Choose a picture…") && !!document.querySelector(".wf-cover-pick.panel"));
  const input = document.querySelector<HTMLInputElement>('.wf-cover-ed-group input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([png(184, 278) as BlobPart], "art.png", { type: "image/png" })] });
  await act(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await draw();
  check("a picture chosen there is put with the book and drawn", sent.length === 1 && printPieces(cover()).length === 1 && document.querySelectorAll(".wf-cover-svg.editing image").length === 1 && !!button("Fit and center it"));

  // The file.
  await act(async () => {
    button("Make the cover (PDF)")!.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  check("the cover is made, then saved with its own press", body().includes("Ready: The Long Way (paperback cover).pdf") && !!button("Save…"), body().slice(-160));

  // Someone who can only read.
  await draw(true);
  check("a reader sees the cover and can't change it", !button("Start with the book’s title and author") && !button("Other words") && button("Undo")!.disabled);
  await act(async () => root.unmount());
}


finish();
