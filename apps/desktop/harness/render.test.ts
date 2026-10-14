// The PDF writer's document features, on a hand-built display list:
// colours, highlights, synthetic italics, links and named places, pages of
// different sizes, and an outline of any depth — read back with pdf.js.
// (That books still come out byte for byte is book.test.ts's job.)

import { check, finish } from "./env";
import "./dom";

import { inflateSync } from "node:zlib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

import { FaceSet } from "../src/book/engine/faces";
import type { DisplayList, DLItem, DLPage } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { pageLabels, plainLabels } from "../src/book/render/labels";
import { renderPdf } from "../src/book/render/pdf";
import { keywordList, xmpPacket } from "../src/book/render/xmp";

const faces = new FaceSet(await loadFontFiles(["garamond", "cinzel"]));
const regular = faces.face("garamond", "regular");
// Cinzel has no italic: the document target slants the upright.
const slanted = faces.face("cinzel", "italic");
faces.faces[slanted].fakeItalic = true;

const text = (t: string, x: number, y: number, extra: Partial<Extract<DLItem, { t: "text" }>> = {}): DLItem => ({
  t: "text",
  x,
  y,
  face: regular,
  size: 12,
  text: t,
  ...extra,
});
const page = (n: number, section: number, items: DLItem[], size?: DLPage["size"]): DLPage => ({
  n,
  folio: String(n),
  side: n % 2 ? "recto" : "verso",
  role: "body",
  section,
  items,
  ...(size ? { size } : {}),
});

const dl: DisplayList = {
  trim: { w: 612, h: 792 },
  faces: faces.faces,
  meta: { title: "Features", author: "A. Writer", subject: "", lang: "en-US" },
  warnings: [],
  insideMargin: 1,
  sections: [
    { id: "a", title: "One", firstPage: 0, folio: "1", level: 0 },
    { id: "b", title: "One point one", firstPage: 0, folio: "1", level: 1 },
    { id: "c", title: "Deep", firstPage: 1, folio: "2", level: 2 },
    { id: "d", title: "One point two", firstPage: 1, folio: "2", level: 1 },
    { id: "e", title: "Two", firstPage: 2, folio: "3", level: 0 },
  ],
  pages: [
    page(1, 0, [
      { t: "rect", x: 72, y: 88, w: 60, h: 16, color: "#ffff00" },
      text("Highlighted", 72, 100),
      text("Crimson words", 72, 130, { color: "#cc0000" }),
      text("Back to black", 72, 160),
      text("Slanted", 72, 190, { face: slanted }),
      { t: "rule", x1: 72, y1: 132, x2: 150, y2: 132, w: 0.6, color: "#cc0000" },
      text("subScribe site", 72, 220),
      { t: "link", x: 72, y: 208, w: 80, h: 14, url: "https://example.org/" },
      text("See the appendix", 72, 250),
      { t: "link", x: 72, y: 238, w: 90, h: 14, to: "appendix" },
    ]),
    page(2, 2, [text("A wide table would go here", 72, 100)], { w: 792, h: 612 }),
    page(3, 4, [{ t: "anchor", name: "appendix", y: 90 }, text("Appendix", 72, 100)]),
  ],
};
const fonts = dl.faces.map((_, i) => faces.font(i));

/** Every page-content operator in the file (streams are deflated). */
const operators = (bytes: Uint8Array): string => {
  const raw = Buffer.from(bytes);
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf("stream\n", at);
    if (start < 0) break;
    const end = raw.indexOf("endstream", start);
    try {
      out.push(inflateSync(raw.subarray(start + 7, end)).toString("latin1"));
    } catch {
      // Not deflated (metadata), or not a content stream.
    }
    at = end + 9;
  }
  return out.join("\n");
};

type Outline = { title: string; items: Outline[] };
const read = async (bytes: Uint8Array) => {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const p = await pdf.getPage(i);
    const ops = await p.getOperatorList();
    pages.push({
      size: p.view.slice(2).map(Math.round).join("×"),
      annotations: await p.getAnnotations(),
      text: (await p.getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" "),
      fills: ops.fnArray.map((fn, k) => (fn === OPS.setFillRGBColor ? String(ops.argsArray[k]) : null)).filter(Boolean),
      transforms: ops.fnArray.filter((fn) => fn === OPS.transform).length,
    });
  }
  return {
    pages,
    outline: ((await pdf.getOutline()) ?? []) as Outline[],
    place: async (name: string) => await pdf.getDestination(name),
  };
};

{
  const bytes = await renderPdf(dl, fonts, new Map(), undefined, { color: "rgb", links: true });
  const doc = await read(bytes);
  const stream = operators(bytes);
  check("pages keep their own sizes", doc.pages.map((p) => p.size).join(", ") === "612×792, 792×612, 612×792", doc.pages.map((p) => p.size).join(", "));
  check("the text is all there, in order", doc.pages[0].text.replace(/\s+/g, " ").includes("Highlighted Crimson words Back to black Slanted"), doc.pages[0].text);
  const fills = doc.pages[0].fills.join(" | ");
  check("each run has its own colour, then back to black", /#ffff00/i.test(fills) && /#cc0000/i.test(fills) && fills.endsWith("#000000"), fills);
  check("…in RGB, with no CMYK ink", /\/DeviceRGB cs\n0 0 0 scn/.test(stream) && !stream.includes("DeviceCMYK"));
  check("a face without an italic is slanted", doc.pages[0].transforms >= 1);
  const links = doc.pages[0].annotations.filter((a) => a.subtype === "Link");
  check("a web link is a link annotation", links.some((a) => a.url === "https://example.org/"), JSON.stringify(links.map((a) => a.url ?? a.dest)));
  const place = await doc.place("appendix");
  check("an internal link points at its named place", links.some((a) => a.dest === "appendix") && Array.isArray(place), JSON.stringify(place));
  const shape = (o: Outline[]): string => o.map((x) => (x.items.length ? `${x.title}[${shape(x.items)}]` : x.title)).join(",");
  check("the outline nests to any depth", shape(doc.outline) === "One[One point one[Deep],One point two],Two", shape(doc.outline));
}

{
  const bytes = await renderPdf(dl, fonts, new Map());
  const doc = await read(bytes);
  check("without `links` there are no annotations or named places (print-on-demand)", doc.pages.every((p) => p.annotations.length === 0) && (await doc.place("appendix")) === null);
  check("the default ink is still CMYK black", /\/DeviceCMYK cs\n0 0 0 1 scn/.test(operators(bytes)));
}

// ------------------------------------------------- what the file says of itself

{
  // A title with the two characters XML cannot hold as they are. (PDFKit's
  // own metadata left them in, and no reader could then make sense of any
  // of it.)
  const titled: DisplayList = { ...dl, meta: { title: "Cats & Dogs <a study>", author: "Zoë Ångström", subject: "Pets, and why", lang: "en-GB", keywords: "cats, dogs, living together" } };
  const bytes = await renderPdf(titled, fonts, new Map(), undefined, { color: "rgb", links: true });
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  const meta = await pdf.getMetadata();
  const info = meta.info as Record<string, unknown>;
  check("the file's own record has the title, author, subject and keywords", info.Title === "Cats & Dogs <a study>" && info.Author === "Zoë Ångström" && info.Subject === "Pets, and why" && info.Keywords === "cats, dogs, living together", JSON.stringify(info));
  check("…and says when it was made and last changed (the same moment: it is new)", typeof info.CreationDate === "string" && info.CreationDate === info.ModDate, `${String(info.CreationDate)} ${String(info.ModDate)}`);
  const xmp = meta.metadata;
  check("the same is said again as XMP, which a reader can make sense of", !!xmp && xmp.get("dc:title") === "Cats & Dogs <a study>" && String(xmp.get("dc:creator")) === "Zoë Ångström" && xmp.get("dc:description") === "Pets, and why", JSON.stringify(xmp?.getAll?.() ?? null));
  check("…with the keywords as a line and as a list, and the two dates", !!xmp && xmp.get("pdf:keywords") === "cats, dogs, living together" && String(xmp.get("dc:subject")) === "cats,dogs,living together" && xmp.get("xmp:createdate") === xmp.get("xmp:modifydate") && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(xmp.get("xmp:createdate"))), JSON.stringify(xmp?.getAll?.() ?? null));
  const raw = Buffer.from(bytes).toString("latin1");
  check("the language is the document's", /\/Lang \(en-GB\)/.test(raw) && String(xmp?.get("dc:language")) === "en-GB");
  check("the metadata's length is counted in bytes (the author's name is not all ASCII)", (() => {
    const at = raw.indexOf("<?xpacket begin");
    const end = raw.indexOf('<?xpacket end="w"?>') + '<?xpacket end="w"?>'.length;
    const said = /\/Length (\d+)[^>]*>>\s*stream\s*$/.exec(raw.slice(Math.max(0, at - 200), at));
    return !!said && Number(said[1]) === end - at;
  })());

  // Nothing is said where there is nothing to say.
  const bare = await renderPdf(dl, fonts, new Map());
  const bareInfo = (await (await getDocument({ data: bare.slice(), useSystemFonts: false, isEvalSupported: false }).promise).getMetadata()).info as Record<string, unknown>;
  check("a document with no subject or keywords has neither", !("Subject" in bareInfo) && !("Keywords" in bareInfo), JSON.stringify(bareInfo));
}

{
  const p = xmpPacket({ title: "A & B", author: "", subject: "", keywords: "", lang: "", created: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), modified: new Date(Date.UTC(2026, 0, 2, 3, 4, 6)), creator: "subScribe", producer: "subScribe", extra: ["<rdf:Description rdf:about=\"\" xmlns:x1=\"urn:x\"><x1:claim>1</x1:claim></rdf:Description>"] });
  check("the packet opens with its mark and is closed", p.charCodeAt(p.indexOf('begin="') + 7) === 0xfeff && p.trim().endsWith('<?xpacket end="w"?>'));
  check("what cannot stand in XML is written the way XML writes it", p.includes("A &amp; B") && !/A & B/.test(p));
  check("dates are to the second, in UTC", p.includes("<xmp:CreateDate>2026-01-02T03:04:05Z</xmp:CreateDate>") && p.includes("<xmp:ModifyDate>2026-01-02T03:04:06Z</xmp:ModifyDate>"));
  check("empty fields are left out, and a standard's own claim can be put in", !p.includes("dc:creator") && !p.includes("dc:description") && !p.includes("pdf:Keywords") && p.includes("<x1:claim>1</x1:claim>"));
  check("keywords split on commas and lines", keywordList(" cats ,dogs\n birds,, ").join("|") === "cats|dogs|birds");
}

// ------------------------------------------------------------- page labels

{
  const said = (folios: (string | null)[]) =>
    pageLabels(folios)
      .map((r) => (r.text !== undefined ? `${r.at}:"${r.text}"` : `${r.at}:${r.style}${r.start ?? ""}`))
      .join(" ");
  check("1, 2, 3 from the first page is what a reader shows anyway", plainLabels(pageLabels(["1", "2", "3"])) && said(["1", "2", "3"]) === "0:D");
  check("a book: roman front matter, then arabic from 1", said(["i", "ii", "iii", "iv", "1", "2", "3"]) === "0:r 4:D");
  check("pages that show no number take the one they would have had", said([null, null, "iii", "iv", null, "1", "2", null, "4"]) === "0:r 5:D", said([null, null, "iii", "iv", null, "1", "2", null, "4"]));
  check("unnumbered pages before page 1 are the front matter", said([null, null, "1", "2"]) === "0:r 2:D", said([null, null, "1", "2"]));
  check("a first page that hides its number still counts", said([null, "2", "3"]) === "0:D", said([null, "2", "3"]));
  check("a count that starts elsewhere says where", said(["5", "6", "7"]) === "0:D5");
  check("a count that starts again starts a new run", said(["1", "2", "1", "2"]) === "0:D 2:D");
  check("capitals stay capitals", said(["I", "II", "III"]) === "0:R");
  check("letters: a b c, and the i that follows h is a letter", said(["a", "b", "c"]) === "0:a" && said(["g", "h", "i", "j"]) === "0:a7", said(["g", "h", "i", "j"]));
  check("…but an i on its own is one", said(["i", "ii"]) === "0:r");
  check("a number in no style a PDF knows keeps its own words", said(["A-1", "A-2", "1"]) === '0:"A-1" 1:"A-2" 2:D', said(["A-1", "A-2", "1"]));
  check("no pages, no labels", pageLabels([]).length === 0 && plainLabels([]));

  const book: DisplayList = {
    ...dl,
    sections: [],
    pages: [null, "ii", "iii", "1", "2"].map((folio, i) => ({ n: i + 1, folio, side: i % 2 ? "verso" : "recto", role: "body", section: -1, items: [text(`Page ${i + 1}`, 72, 100)] }) as DLPage),
  };
  const labelled = await getDocument({ data: (await renderPdf(book, fonts, new Map())).slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  check("a reader's page box shows the numbers printed on the pages", ((await labelled.getPageLabels()) ?? []).join(",") === "i,ii,iii,1,2", String(await labelled.getPageLabels()));
  const plain = await getDocument({ data: (await renderPdf(dl, fonts, new Map())).slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  check("plain 1, 2, 3 is not written at all", (await plain.getPageLabels()) === null);
  const folded = await getDocument({ data: (await renderPdf(book, fonts, new Map(), undefined, { booklet: true })).slice(), useSystemFonts: false, isEvalSupported: false }).promise;
  check("a booklet's sheets are not labelled as the book's pages", (await folded.getPageLabels()) === null);
}

finish();
