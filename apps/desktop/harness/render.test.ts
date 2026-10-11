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
import { renderPdf } from "../src/book/render/pdf";

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

finish();
