// Documents on pages: paragraphs set first-fit and flowed down columns and
// across pages, with headings kept to their text, no line left alone, and
// each page's header, footer and line numbers — then the PDF read back.

import { check, finish } from "./env";
import "./dom";

import type { JSONContent } from "@tiptap/core";
import { Node as PmNode } from "@tiptap/pm/model";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { DEFAULT_SETTINGS, type DocSettings } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DisplayList, DLItem, DLPage, DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { lineOffsets } from "../src/doclayout/lineStarts";
import { buildDocModel } from "../src/doclayout/model";
import { scriptedAsDocument } from "../src/doclayout/scripted";
import { contentSchema } from "../src/editor/schema/content";
import type { StyleOverrides } from "../src/editor/styles/sheet";
import { printFace } from "../src/fonts/substitutes";
import { prng } from "./manuscript";

const session = new TypesetSession();

const WORDS = "the of and a to in is that it was for on are as with his they at be this from have or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over river window morning silence letter garden winter harbour station lantern whisper shoulder evening remember beneath against between although perhaps suddenly afterwards understanding extraordinary conversation".split(" ");

function prose(rand: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const s = out.join(" ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}
const t = (text: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });

/** Pictures the documents here show: their addresses and sizes (and, for
 *  a PDF, their bytes). */
const PICTURES: DocRequest["images"] = [];

async function layout(doc: JSONContent, settings: Partial<DocSettings> = {}, title = "A Document", styles: StyleOverrides = {}) {
  const model = buildDocModel(doc, { title, author: "A. Writer", settings: { ...DEFAULT_SETTINGS, ...settings }, date: "October 10, 2026", styles });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req: DocRequest = { kind: "document", doc: model, families: model.families, images: PICTURES };
  const { dl } = await session.layout(req);
  return { dl, model, req };
}

const isText = (it: DLItem): it is DLText => it.t === "text";
/** A page's body lines (by baseline), top to bottom, as text. */
function lines(page: DLPage, dl: DisplayList, within?: { top: number; bottom: number }): { y: number; x: number; text: string }[] {
  const rows = new Map<number, DLText[]>();
  for (const it of page.items) {
    if (!isText(it)) continue;
    if (within && (it.y < within.top || it.y > within.bottom)) continue;
    const key = Math.round(it.y * 10);
    rows.set(key, [...(rows.get(key) ?? []), it]);
  }
  void dl;
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, items]) => {
      items.sort((a, b) => a.x - b.x);
      return { y: key / 10, x: items[0].x, text: items.map((i) => i.text).join(" ") };
    });
}
const body = (dl: DisplayList, s: DocSettings = DEFAULT_SETTINGS) => ({ top: s.mt * 72 - 1, bottom: dl.trim.h - s.mb * 72 + 1 });
const allText = (dl: DisplayList) => dl.pages.flatMap((pg) => lines(pg, dl).map((l) => l.text)).join(" ");

// ------------------------------------------------------------- the basics

{
  const { dl, model } = await layout({
    type: "doc",
    content: [
      h(1, "A Title"),
      p(null, t("Plain "), t("bold", "bold"), t(" "), t("italic", "italic"), t(" "), t("under", "underline"), t(" "), t("struck", "strike"), t(" "), t("code()", "code"), t(" "), t("a link", { type: "link", attrs: { href: "https://example.com/" } }), t(".")),
      p({ align: "center" }, t("Centred")),
      p({ align: "right" }, t("Right")),
      { type: "bulletList", content: [{ type: "listItem", content: [p(null, t("First item"))] }, { type: "listItem", content: [p(null, t("Second item")), { type: "orderedList", attrs: { start: 3, type: "a" }, content: [{ type: "listItem", content: [p(null, t("Nested"))] }] }] }] },
      { type: "blockquote", content: [p(null, t("Quoted text."))] },
      { type: "codeBlock", content: [t("if (a) {\n  b();\n}")] },
      { type: "horizontalRule" },
      p(null),
      p(null, t("Last.")),
    ],
  });
  const pg = dl.pages[0];
  const ls = lines(pg, dl, body(dl));
  const left = DEFAULT_SETTINGS.ml * 72;
  const right = dl.trim.w - DEFAULT_SETTINGS.mr * 72;
  check("one page, US Letter", dl.pages.length === 1 && dl.trim.w === 612 && dl.trim.h === 792);
  check("the default body is set in the Georgia stand-in, and says so", model.body.family === "literata" && dl.warnings.some((w) => w.kind === "font" && w.message.includes("Georgia → Literata")));
  check("text starts at the left margin", Math.abs(ls[0].x - left) < 0.01 && ls[0].text === "A Title", `${ls[0].x} ${ls[0].text}`);
  const title = pg.items.find((it) => isText(it) && it.text === "A Title") as DLText;
  check("a heading is large and bold", title.size === 24 && dl.faces[title.face].style === "bold");
  const faceOf = (text: string) => dl.faces[(pg.items.find((it) => isText(it) && it.text.includes(text)) as DLText).face];
  check("bold, italic and code pick their faces", faceOf("bold").style === "bold" && faceOf("italic").style === "italic" && faceOf("code()").family === "courier-prime");
  const linkText = pg.items.find((it) => isText(it) && it.text.includes("a link")) as DLText;
  const link = pg.items.find((it) => it.t === "link");
  check("a link is coloured, underlined and clickable", linkText.color === "#0563c1" && link?.t === "link" && link.url === "https://example.com/" && pg.items.some((it) => it.t === "rule" && it.color === "#0563c1"));
  const rules = pg.items.filter((it) => it.t === "rule");
  check("underline, strike and the divider are drawn", rules.length >= 4, String(rules.length));
  const centred = pg.items.find((it) => isText(it) && it.text === "Centred") as DLText;
  const rightSet = pg.items.find((it) => isText(it) && it.text === "Right") as DLText;
  check("centred and right-set lines", Math.abs(centred.x - (left + right) / 2) < 30 && rightSet.x > (left + right) / 2);
  const item = pg.items.find((it) => isText(it) && it.text === "First item") as DLText;
  const bullet = pg.items.find((it) => isText(it) && it.text === "•") as DLText;
  const nested = pg.items.find((it) => isText(it) && it.text === "Nested") as DLText;
  const marker = pg.items.find((it) => isText(it) && it.text === "c.") as DLText;
  check("list items are indented, their markers hung", Math.abs(item.x - (left + 30)) < 0.01 && bullet.x < item.x && bullet.y === item.y && Math.abs(nested.x - (left + 60)) < 0.01 && marker?.y === nested.y);
  const quoted = pg.items.find((it) => isText(it) && it.text.startsWith("Quoted")) as DLText;
  check("a quote is set in from the margin", Math.abs(quoted.x - (left + 30)) < 0.01);
  const code = pg.items.filter((it) => isText(it) && dl.faces[it.face].family === "courier-prime" && it.y > quoted.y) as DLText[];
  check("code keeps its lines and its indentation", code.length === 3 && Math.abs(code[1].x - code[0].x - 2 * 0.6 * 10.8) < 0.01 && code[2].x === code[0].x && code[2].y > code[1].y, code.map((c) => `${c.x.toFixed(1)}:${c.text}`).join("|"));
  check("the footer carries the page number, bottom right", lines(pg, dl).some((l) => l.text === "1" && l.y > dl.trim.h - 72 && l.x > right - 20));
  check("headings become the outline", dl.sections.length === 1 && dl.sections[0].title === "A Title" && dl.sections[0].firstPage === 0 && pg.items.some((it) => it.t === "anchor"));
}

// --------------------------------------------------------------- page flow

{
  const rand = prng(11);
  const content: JSONContent[] = [];
  for (let i = 0; i < 40; i += 1) {
    if (i % 7 === 3) content.push(h(2, `Section ${i}`));
    content.push(p(null, t(prose(rand, 60 + Math.floor(rand() * 120)))));
  }
  content.push(p({ pageBreakBefore: true }, t("After a page break.")));
  const { dl, model } = await layout({ type: "doc", content });
  const area = body(dl);
  check("a long document runs over many pages", dl.pages.length > 5, String(dl.pages.length));

  // No paragraph leaves a single line at a page's foot or top (the page
  // before a forced break aside).
  const srcLines = dl.pages.map((pg) => {
    const count = new Map<number, Set<number>>();
    for (const it of pg.items) {
      if (!isText(it) || it.src === undefined || it.y < area.top || it.y > area.bottom) continue;
      count.set(it.src, (count.get(it.src) ?? new Set()).add(Math.round(it.y * 10)));
    }
    return count;
  });
  let alone = 0;
  for (let i = 0; i + 1 < srcLines.length; i += 1) {
    for (const [src, ys] of srcLines[i]) {
      const next = srcLines[i + 1].get(src);
      if (next && (ys.size < 2 || next.size < 2)) alone += 1;
    }
  }
  check("no line is left alone at a page's foot or top", alone === 0, String(alone));

  // Every heading has text under it on its own page.
  let stranded = 0;
  dl.pages.forEach((pg) => {
    const ls = lines(pg, dl, area);
    const lastY = ls[ls.length - 1]?.y ?? 0;
    for (const it of pg.items) {
      if (isText(it) && it.text.startsWith("Section ") && it.size > 13 && it.y >= lastY - 1) stranded += 1;
    }
  });
  check("no heading is stranded at the foot of a page", stranded === 0, String(stranded));
  const lastPage = dl.pages[dl.pages.length - 1];
  const first = lines(lastPage, dl, area)[0];
  check("a page break starts a page", first.text === "After a page break." && first.y < area.top + 30, JSON.stringify(first));
  const bottoms = dl.pages.slice(0, -2).map((pg) => Math.max(...lines(pg, dl, area).map((l) => l.y)));
  check("pages fill to near the bottom margin", bottoms.every((y) => y > area.bottom - 110 && y <= area.bottom), bottoms.map((y) => y.toFixed(0)).join(","));
  check("page numbers run", dl.pages.every((pg, i) => pg.folio === String(i + 1)) && lines(dl.pages[3], dl).some((l) => l.text === "4" && l.y > area.bottom));
  check("the outline points at the right pages", dl.sections.length === 6 && dl.sections.every((s2) => dl.pages[s2.firstPage].items.some((it) => isText(it) && it.text === s2.title)));
  void model;

  // Typing at the end of a paragraph never moves the lines above it.
  const one = await layout({ type: "doc", content: [p(null, t(prose(prng(3), 200)))] });
  const two = await layout({ type: "doc", content: [p(null, t(`${prose(prng(3), 200)} And then some more words were typed at the very end of it.`))] });
  const l1 = lines(one.dl.pages[0], one.dl, area).map((l) => l.text);
  const l2 = lines(two.dl.pages[0], two.dl, area).map((l) => l.text);
  check("typing at a paragraph's end leaves the lines above alone", l1.length > 5 && l1.slice(0, -1).every((line, i) => line === l2[i]));
}

// ------------------------------------------------------------- page setup

{
  const rand = prng(5);
  const content = Array.from({ length: 30 }, () => p(null, t(prose(rand, 90))));
  const settings: Partial<DocSettings> = {
    pageSize: "a5",
    landscape: true,
    mt: 0.6,
    mb: 0.7,
    ml: 0.5,
    mr: 0.9,
    gutter: 0.3,
    mirror: true,
    cols: 2,
    colGap: 0.4,
    bodyFont: "garamond",
    bodySize: 10,
    bodyLine: 1,
    paraSpacing: 4,
    firstIndent: 0.25,
    lineNumbers: true,
    hfFirst: true,
    hfEven: true,
    pnFormat: "i",
    pnStart: 3,
    hL: "{title}",
    hC: "",
    hR: "{author}",
    fL: "",
    fC: "Page {page} of {pages}",
    fR: "{date}",
    h1C: "FIRST",
    heL: "{page}",
    heR: "Even",
    feL: "",
  };
  const { dl } = await layout({ type: "doc", content }, settings, "Setup");
  const s = { ...DEFAULT_SETTINGS, ...settings };
  check("landscape A5", Math.abs(dl.trim.w - 8.27 * 72) < 0.01 && Math.abs(dl.trim.h - 5.83 * 72) < 0.01);
  const area = body(dl, s);
  const xs = (pg: DLPage) => (pg.items.filter((it) => isText(it) && it.src !== undefined && it.y > area.top && it.y < area.bottom) as DLText[]).map((it) => it.x);
  const colW = (dl.trim.w - (0.5 + 0.9 + 0.3) * 72 - 0.4 * 72) / 2;
  // Page index 0 is page iii (odd): the binding edge is on the left.
  const odd = Math.min(...xs(dl.pages[0]));
  const even = Math.min(...xs(dl.pages[1]));
  check("odd pages start past the gutter", Math.abs(odd - (0.5 + 0.3) * 72) < 0.01, String(odd));
  check("even pages mirror the margins", Math.abs(even - 0.9 * 72) < 0.01, `${even} vs ${odd}`);
  const second = xs(dl.pages[0]).filter((x) => x > (0.8 * 72) + colW);
  check("text runs in two columns", second.length > 5 && Math.min(...second) >= 0.8 * 72 + colW + 0.4 * 72 - 0.01, String(Math.min(...second)));
  const all = (pg: DLPage) => lines(pg, dl).map((l) => l.text);
  check("the first page has its own header and no footer", all(dl.pages[0]).includes("FIRST") && !all(dl.pages[0]).some((x) => x.startsWith("Page ")));
  check("even pages have theirs", all(dl.pages[1]).includes("iv Even"), all(dl.pages[1]).slice(0, 3).join("|"));
  const total = dl.pages.length;
  const roman = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
  check("other pages: title, author, numbered in roman from iii, the date", all(dl.pages[2]).includes("Setup A. Writer") && all(dl.pages[2]).includes(`Page v of ${roman[total + 2]} October 10, 2026`), all(dl.pages[2]).filter((x) => x.length < 40).join("|"));
  const numbers = (dl.pages[0].items.filter((it) => isText(it) && it.color === "#808080") as DLText[]).map((it) => it.text);
  check("lines are numbered down each page", numbers.length > 20 && numbers[0] === "1" && numbers[numbers.length - 1] === String(numbers.length));
  check("the body font is the one asked for", dl.faces.some((f) => f.family === "garamond") && !dl.warnings.some((w) => w.kind === "font"));
}

// ------------------------------------------------------------ fonts & glyphs

{
  check("fonts print in their own files or a named stand-in", printFace("garamond").substituted === false && printFace("mono").family === "courier-prime" && printFace("sys:Calibri").family === "carlito" && printFace("sys:Calibri").metric && printFace("times").family === "libertinus" && printFace("sys:Wingdings Sans Pro").family === "literata" && printFace(null).asked === "Georgia");
  const { dl } = await layout({
    type: "doc",
    content: [
      p({ font: "sans" }, t("Sans text with "), t("italics", "italic"), t(".")),
      p({ font: "cinzel" }, t("Cinzel has no "), t("italic", "italic"), t(" of its own.")),
      p(null, t("Greek αβγ and Cyrillic жзи in a Latin face.")),
      p(null, t("An emoji 🎉 nobody has.")),
    ],
  });
  const pg = dl.pages[0];
  const find = (s: string) => pg.items.find((it) => isText(it) && it.text.includes(s)) as DLText;
  check("Sans prints in the bundled sans-serif, with a real italic", dl.faces[find("Sans").face].family === "carlito" && dl.faces[find("italics").face].style === "italic" && !dl.faces[find("italics").face].fakeItalic);
  const slanted = dl.faces[(pg.items.find((it) => isText(it) && it.text === "italic") as DLText).face];
  check("a family without an italic is slanted", slanted.family === "cinzel" && slanted.fakeItalic === true && slanted.cssStyle === "normal");
  check("characters the body face lacks come from one that has them", dl.faces[find("αβγ").face].family !== "literata" || dl.faces[find("Greek").face].family === dl.faces[find("αβγ").face].family, dl.faces[find("αβγ").face].family);
  check("…and what no face has is reported", dl.warnings.some((w) => w.kind === "missing-glyphs" && w.message.includes("🎉")), dl.warnings.map((w) => w.message).join(" / "));
}

// -------------------------------------------------------------------- PDF

{
  const rand = prng(21);
  const content: JSONContent[] = [h(1, "Chapter One"), p(null, t("Opening with a "), t("link", { type: "link", attrs: { href: "https://example.com/pdf" } }), t(" and “curly quotes” — dashes, naïve café."))];
  for (let i = 0; i < 12; i += 1) content.push(p(null, t(prose(rand, 120))));
  content.push(h(2, "A Section"), p(null, t(prose(rand, 80))));
  const { req, dl } = await layout({ type: "doc", content }, { hC: "{title}" }, "Read Back");
  const result = await session.pdf(req);
  check("the PDF has the layout's pages", result.pages === dl.pages.length && result.trim.w === 8.5 && result.trim.h === 11);
  const pdf = await getDocument({ data: new Uint8Array(result.bytes), useSystemFonts: false, isEvalSupported: false }).promise;
  check("…and reads back as many", pdf.numPages === dl.pages.length);
  const page1 = await pdf.getPage(1);
  const textContent = await page1.getTextContent();
  const text = textContent.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ");
  check("text reads back in order, with its punctuation", text.includes("Chapter One") && text.includes("Opening with a link and “curly quotes” — dashes, naïve café.") && text.indexOf("Read Back") < text.indexOf("Chapter One"), text.slice(0, 160));
  const annotations = await page1.getAnnotations();
  check("the link is a link", annotations.some((a) => a.subtype === "Link" && a.url === "https://example.com/pdf"));
  const outline = await pdf.getOutline();
  check("the outline nests", outline?.length === 1 && outline[0].title === "Chapter One" && outline[0].items.length === 1 && outline[0].items[0].title === "A Section");
  const meta = await pdf.getMetadata();
  check("title and author are set", (meta.info as { Title?: string; Author?: string }).Title === "Read Back" && (meta.info as { Author?: string }).Author === "A. Writer");
  await page1.getOperatorList();
  const fontNames = new Set<string>();
  for (const it of textContent.items) if ("fontName" in it) fontNames.add(it.fontName);
  const embedded = [...fontNames].map((name) => (page1.commonObjs.get(name) as { name?: string } | undefined)?.name ?? "");
  check("the fonts are embedded subsets of the real faces", embedded.length >= 1 && embedded.every((n) => /Literata/i.test(n)), embedded.join(", "));

  const booklet = await session.pdf({ ...req, kind: "document-booklet" });
  const imposed = await getDocument({ data: new Uint8Array(booklet.bytes), useSystemFonts: false, isEvalSupported: false }).promise;
  const sheet = await imposed.getPage(1);
  check("a booklet imposes two pages to a sheet", booklet.sheets === Math.ceil(dl.pages.length / 4) && imposed.numPages === Math.ceil(dl.pages.length / 4) * 2 && Math.abs(sheet.view[2] - 1224) < 0.5, `${imposed.numPages} sheets sides, ${sheet.view[2]}`);
}

// ------------------------------------------------------- formatting (level 2)

const mk = (type: string, attrs: Record<string, unknown>) => ({ type, attrs });
const task = (checked: boolean, text: string): JSONContent => ({ type: "taskItem", ...(checked ? { attrs: { checked: true } } : {}), content: [p(null, t(text))] });
const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });

{
  const rand = prng(21);
  const long = prose(rand, 36);
  const { dl } = await layout(
    {
      type: "doc",
      content: [
        p({ element: "title" }, t("Styled Title")),
        h(1, "Recoloured heading"),
        p(null, t("Start "), t("red", mk("textColor", { c: "#c00000" })), t(" "), t("marked words here", mk("highlight", { c: "#ffff00" })), t(" x"), t("2", mk("vscript", { v: "super" })), t(" H"), t("2", mk("vscript", { v: "sub" })), t("O "), t("sans", mk("fontFamily", { f: "sans" })), t(" end.")),
        p(null, t("A line with one "), t("LARGE", mk("fontSize", { pt: 30 })), t(" word in it. "), t(long)),
        p({ indL: 72, indR: 36, indF: -36 }, t("Hanging: "), t(long)),
        p({ indF: 30 }, t("Indented: "), t(long)),
        p({ lineRule: "exact", lineAt: 20 }, t("Exact: "), t(long)),
        p({ shade: "#fff2cc", bdr: "tblr 1.5 #c00000" }, t("Boxed: "), t(long)),
        p({ element: "u-pull01" }, t("In a style of its own.")),
      ],
    },
    {},
    "Formatting",
    { h1: { props: { color: "#2f5496", size: 20 } }, "u-pull01": { name: "Pull quote", props: { italic: true, align: "center", size: 14 } } },
  );
  const pg = dl.pages[0];
  const left = DEFAULT_SETTINGS.ml * 72;
  const right = dl.trim.w - DEFAULT_SETTINGS.mr * 72;
  const textOf = (needle: string) => pg.items.find((it) => isText(it) && it.text.includes(needle)) as DLText;
  const exact = (needle: string) => pg.items.find((it) => isText(it) && it.text === needle) as DLText;

  const titleText = textOf("Styled Title");
  check("the Title style: large and bold", Math.abs(titleText.size - 26.4) < 0.01 && dl.faces[titleText.face].style === "bold");
  const heading = textOf("Recoloured heading");
  check("a changed heading style is set as changed", heading.size === 20 && heading.color === "#2f5496" && dl.faces[heading.face].style === "bold");
  const own = textOf("In a style of its own.");
  check("a style of the document's own", own.size === 14 && dl.faces[own.face].style === "italic" && Math.abs(own.x + 0 - (left + right) / 2) < 120 && own.x > left + 60);

  const red = exact("red");
  check("text colour", red?.color === "#c00000");
  const marked = textOf("marked words here");
  const bar = pg.items.find((it) => it.t === "rect" && it.color === "#ffff00");
  check(
    "a highlight is one bar under its words, as tall as the type",
    !!bar && bar.t === "rect" && Math.abs(bar.x - marked.x) < 0.01 && bar.w > 60 && bar.y < marked.y - 6 && bar.y + bar.h > marked.y + 1 && pg.items.indexOf(bar) < pg.items.indexOf(marked),
    JSON.stringify(bar),
  );
  const start = textOf("Start");
  const scripts = pg.items.filter((it): it is DLText => isText(it) && it.text === "2");
  const sup = scripts.find((it) => it.y < start.y);
  const sub = scripts.find((it) => it.y > start.y);
  check("superscript is smaller and raised, subscript smaller and lowered", !!sup && !!sub && Math.abs(sup.size - 12 * 0.65) < 0.01 && Math.abs(start.y - sup.y - 12 * 0.33) < 0.01 && Math.abs(sub.y - start.y - 12 * 0.14) < 0.01, JSON.stringify([sup, sub]));
  check("a run in another typeface", dl.faces[exact("sans").face].family === "carlito");

  const large = exact("LARGE");
  const sameLine = textOf("A line with one");
  const linesAt = lines(pg, dl, body(dl));
  const at = linesAt.findIndex((l) => l.text.startsWith("A line with one"));
  check("one large word makes its line taller, and only its line", large.size === 30 && large.y === sameLine.y && linesAt[at + 2].y - linesAt[at + 1].y < 20 && linesAt[at + 1].y - linesAt[at].y > 22, `${linesAt[at + 1].y - linesAt[at].y} then ${linesAt[at + 2].y - linesAt[at + 1].y}`);

  const hangAt = linesAt.findIndex((l) => l.text.startsWith("Hanging:"));
  check(
    "a hanging indent: the first line out, the rest in, the right side in",
    Math.abs(linesAt[hangAt].x - (left + 36)) < 0.01 && Math.abs(linesAt[hangAt + 1].x - (left + 72)) < 0.01,
    `${linesAt[hangAt].x - left} then ${linesAt[hangAt + 1].x - left}`,
  );
  const indAt = linesAt.findIndex((l) => l.text.startsWith("Indented:"));
  check("a first-line indent", Math.abs(linesAt[indAt].x - (left + 30)) < 0.01 && Math.abs(linesAt[indAt + 1].x - left) < 0.01);
  const exAt = linesAt.findIndex((l) => l.text.startsWith("Exact:"));
  check("an exact line height", Math.abs(linesAt[exAt + 1].y - linesAt[exAt].y - 20) < 0.01 && Math.abs(linesAt[exAt + 2].y - linesAt[exAt + 1].y - 20) < 0.01);

  const boxed = textOf("Boxed:");
  const shades = pg.items.filter((it) => it.t === "rect" && it.color === "#fff2cc");
  const borders = pg.items.filter((it) => it.t === "rule" && it.color === "#c00000" && it.w === 1.5);
  const sidesOf = borders.filter((it) => it.t === "rule" && it.x1 === it.x2);
  const caps = borders.filter((it) => it.t === "rule" && it.y1 === it.y2);
  check(
    "shading behind every line of a paragraph, a rule above and below, and down both sides",
    shades.length >= 3 && caps.length === 2 && sidesOf.length === shades.length * 2 && shades.every((it) => it.t === "rect" && it.x < left && it.x + it.w > right) && pg.items.indexOf(shades[0]) < pg.items.indexOf(boxed),
    `${shades.length} bars, ${caps.length} caps, ${sidesOf.length} sides`,
  );
  check("…and the text hasn't moved sideways", Math.abs(boxed.x - left) < 0.01);

}

{
  const { dl } = await layout({
    type: "doc",
    content: [
      { type: "taskList", content: [task(true, "Done thing"), task(false, "Open thing")] },
      { type: "bulletList", attrs: { marker: "dash" }, content: [li(p(null, t("Dashed item")))] },
      { type: "bulletList", attrs: { marker: "check" }, content: [li(p(null, t("Ticked item")))] },
      {
        type: "orderedList",
        attrs: { start: 1, type: "legal" },
        content: [li(p(null, t("Legal one")), { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(null, t("Legal sub one"))), li(p(null, t("Legal sub two")))] }), li(p(null, t("Legal two")))],
      },
    ],
  });
  const pg = dl.pages[0];
  const left = DEFAULT_SETTINGS.ml * 72;
  const textOf = (needle: string) => pg.items.find((it) => isText(it) && it.text.includes(needle)) as DLText;
  const done = textOf("Done thing");
  const open = textOf("Open thing");
  const near = (y: number) => pg.items.filter((it) => it.t === "rule" && !it.color && it.x2 < done.x && it.y1 > y - 12 && it.y1 < y + 3 && it.x1 > left);
  check("a checklist's boxes are drawn, the done one ticked", near(open.y).length === 4 && near(done.y).length === 6, `${near(open.y).length} / ${near(done.y).length}`);
  const dashed = textOf("Dashed item");
  check("a list's own marker", pg.items.some((it) => isText(it) && it.text === "–" && it.y === dashed.y && it.x < dashed.x));
  const ticked = textOf("Ticked item");
  check("a tick is drawn, not typed", pg.items.filter((it) => it.t === "rule" && it.x2 < ticked.x && it.y1 > ticked.y - 12 && it.y1 < ticked.y + 3 && it.x1 > left).length === 2 && !dl.warnings.some((w) => w.kind === "missing-glyphs"));
  const markers = ["1.", "1.1.", "1.2.", "2."].map((m) => pg.items.find((it) => isText(it) && it.text === m) as DLText | undefined);
  check("legal numbering shows the levels above", markers.every(Boolean) && markers[1]!.y === textOf("Legal sub one").y && markers[3]!.y === textOf("Legal two").y, markers.map((m) => m?.text ?? "missing").join(" "));
}

{
  // Three paragraphs with the same border are one box.
  const box = { bdr: "tblr 0.75 #000000", shade: "#f2f2f2" };
  const { dl } = await layout({ type: "doc", content: [p(null, t("Before.")), p(box, t("Box one.")), p(box, t("Box two.")), p(box, t("Box three.")), p(null, t("After."))] });
  const pg = dl.pages[0];
  const rules = pg.items.filter((it) => it.t === "rule" && it.w === 0.75 && it.color === "#000000");
  const caps = rules.filter((it) => it.t === "rule" && it.y1 === it.y2);
  const bars = pg.items.filter((it): it is Extract<DLItem, { t: "rect" }> => it.t === "rect" && it.color === "#f2f2f2").sort((a, b) => a.y - b.y);
  const seamless = bars.every((bar, i) => i === 0 || Math.abs(bars[i - 1].y + bars[i - 1].h - bar.y) < 0.5);
  check("neighbours with the same border are one box: two rules across, no gap inside", caps.length === 2 && bars.length === 3 && seamless, `${caps.length} rules across, bars ${bars.map((b) => `${b.y.toFixed(1)}+${b.h.toFixed(1)}`).join(" ")}`);
}

{
  // Kept in one piece, and kept with what follows. A spacer of growing
  // height walks the paragraph down to the foot of the page.
  const rand = prng(5);
  const filler = Array.from({ length: 3 }, () => p(null, t(prose(rand, 95))));
  const words = prose(rand, 70);
  const tail = p(null, t("TAIL "), t(prose(rand, 60)));
  const has = (dl: DisplayList, page: number, start: string) => !!dl.pages[page] && lines(dl.pages[page], dl, body(dl)).some((l) => l.text.startsWith(start));
  const first = (dl: DisplayList, page: number) => (dl.pages[page] ? lines(dl.pages[page], dl, body(dl))[0]?.text : undefined);

  let split = -1;
  for (let gap = 0; gap < 400 && split < 0; gap += 4) {
    const plain = await layout({ type: "doc", content: [...filler, p({ sb: gap }, t("Spacer.")), p(null, t("KEPT "), t(words), t(" KEPTEND")), tail] });
    const end = plain.dl.pages.findIndex((pg) => lines(pg, plain.dl, body(plain.dl)).some((l) => l.text.includes("KEPTEND")));
    if (has(plain.dl, 0, "KEPT") && end === 1) split = gap;
  }
  const kept = await layout({ type: "doc", content: [...filler, p({ sb: Math.max(0, split) }, t("Spacer.")), p({ keepLines: true }, t("KEPT "), t(words), t(" KEPTEND")), tail] });
  check("a paragraph kept in one piece moves whole to the next page", split >= 0 && !has(kept.dl, 0, "KEPT") && (first(kept.dl, 1) ?? "").startsWith("KEPT"), `gap ${split}, page 2 starts “${(first(kept.dl, 1) ?? "").slice(0, 20)}”`);

  let stranded = -1;
  for (let gap = 0; gap < 400 && stranded < 0; gap += 3) {
    const plain = await layout({ type: "doc", content: [...filler, p({ sb: gap }, t("Spacer.")), p(null, t("LEAD line.")), tail] });
    const last = lines(plain.dl.pages[0], plain.dl, body(plain.dl)).pop();
    if (plain.dl.pages.length === 2 && last?.text === "LEAD line.") stranded = gap;
  }
  const led = await layout({ type: "doc", content: [...filler, p({ sb: Math.max(0, stranded) }, t("Spacer.")), p({ keepNext: true }, t("LEAD line.")), tail] });
  check("a paragraph kept with the next goes over the page with it", stranded >= 0 && first(led.dl, 1) === "LEAD line.", `gap ${stranded}, page 2 starts “${(first(led.dl, 1) ?? "").slice(0, 20)}”`);
}

// ---------------------------------------------- tables, notes, contents, sections

const cell = (content: string | JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({
  type: "tableCell",
  ...(attrs ? { attrs } : {}),
  content: typeof content === "string" ? [p(null, t(content))] : content,
});
const tr = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
const table = (attrs: Record<string, unknown> | null, ...rows: JSONContent[]): JSONContent => ({ type: "table", ...(attrs ? { attrs } : {}), content: rows });
const note = (text: string, kind?: "end"): JSONContent => ({ type: "footnote", ...(kind ? { attrs: { kind } } : {}), content: [t(text)] });
const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
PICTURES.push({ url: "pic:one", w: 200, h: 100, bytes: PNG_1x1, type: "image/png" } as DocRequest["images"][number]);

{
  const { dl } = await layout({
    type: "doc",
    content: [
      p(null, t("Before the table.")),
      table(
        { head: true },
        tr(cell("Name"), cell("Role"), cell("Notes")),
        tr(cell("Ada"), cell("Writer"), cell("First reader of every draft, and the one who asked for a table that wraps its text inside a cell.", { bg: "#fff2cc" })),
        tr(cell("Across two", { colspan: 2 }), cell("Down two", { rowspan: 2 })),
        tr(cell("Left"), cell("Middle")),
      ),
      p(null, t("After the table.")),
      table({ cols: "72 144", lines: "none" }, tr(cell("narrow"), cell("wide"))),
    ],
  });
  const pg = dl.pages[0];
  const left = DEFAULT_SETTINGS.ml * 72;
  const textW = dl.trim.w - (DEFAULT_SETTINGS.ml + DEFAULT_SETTINGS.mr) * 72;
  const find = (needle: string) => pg.items.find((it) => isText(it) && it.text.includes(needle)) as DLText;
  const third = textW / 3;
  check("a table's columns share the text width", Math.abs(find("Name").x - (left + 5)) < 0.01 && Math.abs(find("Role").x - (left + third + 5)) < 0.01 && Math.abs(find("Notes").x - (left + 2 * third + 5)) < 0.01, `${find("Role").x - left}`);
  check("cells in a row share a baseline", find("Ada").y === find("Writer").y && find("Name").y === find("Role").y);
  const wrapped = pg.items.filter((it): it is DLText => isText(it) && it.x >= left + 2 * third && it.x < left + textW && it.y > find("Ada").y - 1 && it.y < find("Across two").y - 1);
  check("text wraps inside its cell, and the row is as tall as it needs", new Set(wrapped.map((it) => Math.round(it.y))).size >= 3 && find("Across two").y - find("Ada").y > 40, `${wrapped.length} pieces`);
  const shaded = pg.items.find((it) => it.t === "rect" && it.color === "#fff2cc");
  check("a cell's shading fills the cell", !!shaded && shaded.t === "rect" && Math.abs(shaded.x - (left + 2 * third)) < 0.01 && Math.abs(shaded.w - third) < 0.01 && shaded.h > 40);
  check("a cell across two columns, and one down two rows", Math.abs(find("Down two").x - (left + 2 * third + 5)) < 0.01 && Math.abs(find("Middle").x - (left + third + 5)) < 0.01 && find("Left").y > find("Across two").y);
  const grid = pg.items.filter((it) => it.t === "rule" && it.w === 0.5 && it.color === "#000000");
  check("a table draws its lines", grid.length >= 10 * 4, String(grid.length));
  const narrow = find("narrow");
  const wide = find("wide");
  check("its own column widths", Math.abs(wide.x - narrow.x - 72) < 0.01);
  check("…and no lines when it says none", !grid.some((it) => it.t === "rule" && it.y1 > narrow.y - 14 && it.y1 < narrow.y + 6));
  check("text after a table follows it", find("After the table.").y > find("Left").y && find("After the table.").y < narrow.y);
}

{
  // A long table runs over the page: row by row, its header at the top again.
  const rows = Array.from({ length: 60 }, (_, i) => tr(cell(`Row ${i + 1}`), cell(`Value ${i + 1}`)));
  const { dl } = await layout({ type: "doc", content: [table({ head: true }, tr(cell("HEAD A"), cell("HEAD B")), ...rows)] });
  const heads = dl.pages.map((pg) => lines(pg, dl, body(dl)).filter((l) => l.text.startsWith("HEAD A")).length);
  check("a long table runs over pages", dl.pages.length >= 2, String(dl.pages.length));
  check("…with its header row at the top of each", heads.every((n) => n === 1) && lines(dl.pages[1], dl, body(dl))[0].text.startsWith("HEAD A"), heads.join(","));
  const all = dl.pages.flatMap((pg) => lines(pg, dl, body(dl)).map((l) => l.text));
  check("…and every row once", rows.every((_, i) => all.filter((l) => l.startsWith(`Row ${i + 1} `)).length === 1));
  const area = body(dl);
  check("no row crosses the foot of the page", dl.pages.every((pg) => pg.items.every((it) => it.t !== "rule" || it.y2 <= area.bottom + 0.6)));

  // One row taller than a page is cut between its lines.
  const rand = prng(8);
  const tall = await layout({ type: "doc", content: [table(null, tr(cell("Short"), cell(Array.from({ length: 14 }, () => p(null, t(prose(rand, 70)))))))] });
  check(
    "a row taller than a page is cut between its lines",
    tall.dl.pages.length >= 2 && tall.dl.pages.every((pg) => lines(pg, tall.dl).every((l) => l.y <= body(tall.dl).bottom || l.text === pg.folio)) && tall.dl.pages.every((pg) => pg.items.every((it) => it.t !== "rule" || it.y2 <= body(tall.dl).bottom + 0.6)),
    String(tall.dl.pages.length),
  );
}

{
  const rand = prng(12);
  const { dl, model } = await layout({
    type: "doc",
    content: [
      p(null, t("A claim"), note("Its source, in full."), t(" and another"), note("A second source."), t(", then an aside"), note("Kept for the end.", "end"), t(".")),
      ...Array.from({ length: 3 }, () => p(null, t(prose(rand, 90)))),
    ],
  });
  const pg = dl.pages[0];
  const area = body(dl);
  const refs = pg.items.filter((it): it is DLText => isText(it) && it.size < 9 && it.y < area.top + 40);
  check("notes are numbered in order — footnotes 1, 2; endnotes i", model.notes.map((n) => `${n.kind}:${n.number}`).join(" ") === "foot:1 foot:2 end:i", model.notes.map((n) => n.number).join(" "));
  check("a note's number is raised, small, in the text", refs.length === 3 && refs.map((r) => r.text).join(" ") === "1 2 i" && refs.every((r) => Math.abs(r.size - 12 * 0.65) < 0.01), refs.map((r) => r.text).join(" "));
  const foot = pg.items.find((it) => isText(it) && it.text.includes("Its source, in full.")) as DLText;
  const second = pg.items.find((it) => isText(it) && it.text.includes("A second source.")) as DLText;
  check("footnotes sit at the foot of the page that cites them", !!foot && !!second && foot.y > area.bottom - 60 && second.y > foot.y && second.y <= area.bottom, `${foot?.y} ${second?.y} of ${area.bottom}`);
  const sep = pg.items.find((it) => it.t === "rule" && it.w === 0.5 && !it.color && it.y1 < foot.y && it.y1 > foot.y - 30);
  check("…under a short rule", !!sep && sep.t === "rule" && Math.abs(sep.x2 - sep.x1 - 144) < 0.01);
  const textLines = lines(pg, dl, { top: area.top, bottom: (sep as { y1: number }).y1 });
  check("…and the text stops above them", textLines.length > 5 && textLines.every((l) => l.y < (sep as { y1: number }).y1));
  const links = pg.items.filter((it) => it.t === "link" && it.to?.startsWith("wf-note-"));
  const anchors = pg.items.filter((it) => it.t === "anchor" && it.name.startsWith("wf-note-"));
  check("a reference leads to its note", links.length === 2 && anchors.length === 2);
  const lastPage = dl.pages[dl.pages.length - 1];
  const endnote = lastPage.items.find((it) => isText(it) && it.text.includes("Kept for the end.")) as DLText;
  check("endnotes close the document, under a rule of their own", !!endnote && !pg.items.some((it) => isText(it) && it.text.includes("Kept for the end.") && it.y > area.bottom - 60) && lastPage.items.some((it) => it.t === "rule" && it.color === "#888888" && it.y1 < endnote.y));
}

{
  // A footnote cited on the last line of a page, too long for what's left:
  // it starts there and runs over to the next page's foot.
  const rand = prng(31);
  const longNote = prose(rand, 260);
  let found: Awaited<ReturnType<typeof layout>> | null = null;
  for (let gap = 0; gap < 300 && !found; gap += 6) {
    const made = await layout({
      type: "doc",
      content: [...Array.from({ length: 2 }, (_, i) => p(null, t(prose(prng(40 + i), 100)))), p({ sb: gap }, t("Spacer.")), p(null, t("CITED here"), note(`NOTESTART ${longNote} NOTEEND`), t(".")), p(null, t(prose(prng(77), 120)))],
    });
    const has = (pg: DLPage, text: string) => pg.items.some((it) => isText(it) && it.text.includes(text));
    if (made.dl.pages.length >= 2 && has(made.dl.pages[0], "CITED here") && has(made.dl.pages[0], "NOTESTART") && has(made.dl.pages[1], "NOTEEND")) found = made;
  }
  check("a long footnote starts on the page that cites it and runs over to the next", !!found);
  if (found) {
    const area = body(found.dl);
    const second = found.dl.pages[1];
    const end = second.items.find((it) => isText(it) && it.text.includes("NOTEEND")) as DLText;
    check("…at the foot of that page, under its own rule, with the text above", end.y > area.bottom - 120 && second.items.some((it) => it.t === "rule" && it.w === 0.5 && !it.color && it.y1 < end.y) && lines(second, found.dl, { top: area.top, bottom: area.top + 60 }).length > 0);
  }
}

{
  const rand = prng(17);
  const chapter = (title: string) => [h(1, title), ...Array.from({ length: 5 }, () => p(null, t(prose(rand, 110))))];
  const { dl } = await layout({
    type: "doc",
    content: [{ type: "toc" }, ...chapter("First chapter"), { type: "heading", attrs: { level: 2 }, content: [t("A part of it")] }, p(null, t(prose(rand, 60))), ...chapter("Second chapter"), ...chapter("Third chapter")],
  });
  const first = lines(dl.pages[0], dl, body(dl)).slice(0, 4).map((l) => l.text);
  const folioOf = (title: string) => dl.sections.find((sec) => sec.title === title)?.folio;
  check("the contents lists the headings, in order", first[0].startsWith("First chapter") && first[1].startsWith("A part of it") && first[2].startsWith("Second chapter") && first[3].startsWith("Third chapter"), first.join(" | "));
  check("…each with the page it landed on", first[0].endsWith(` ${folioOf("First chapter")}`) && first[2].endsWith(` ${folioOf("Second chapter")}`) && first[3].endsWith(` ${folioOf("Third chapter")}`) && Number(folioOf("Third chapter")) > Number(folioOf("Second chapter")), `${first[2]} / ${folioOf("Second chapter")}`);
  const tocLinks = dl.pages[0].items.filter((it) => it.t === "link" && /^h\d+$/.test(it.to ?? ""));
  check("…and a link to it", tocLinks.length === 4 && dl.pages.some((pg) => pg.items.some((it) => it.t === "anchor" && it.name === "h3")));
  const sub = dl.pages[0].items.find((it) => isText(it) && it.text.startsWith("A part of it")) as DLText;
  const top = dl.pages[0].items.find((it) => isText(it) && it.text.startsWith("First chapter")) as DLText;
  check("…sub-headings set in, chapters bold", sub.x > top.x + 10 && dl.faces[top.face].style === "bold" && dl.faces[sub.face].style === "regular");
}

{
  const rand = prng(23);
  const { dl } = await layout(
    {
      type: "doc",
      content: [
        p(null, t("Portrait first. "), t(prose(rand, 40))),
        p({ sect: "sect land:1 cols:2 pn:1 ml:0.5 mr:0.5" }, t("Landscape now. "), t(prose(rand, 200))),
        p({ colBreak: true }, t("NEXTCOL starts the second column.")),
        p({ sect: "sect" }, t("Back to the document's own page.")),
      ],
    },
    { fR: "{page}" },
  );
  check("a section starts a new page", dl.pages.length === 3, String(dl.pages.length));
  check("…on a sheet of its own", !dl.pages[0].size && !!dl.pages[1].size && Math.abs(dl.pages[1].size.w - 792) < 0.01 && Math.abs(dl.pages[1].size.h - 612) < 0.01 && !dl.pages[2].size);
  const second = dl.pages[1];
  const xs = second.items.filter(isText).map((it) => it.x);
  check("…with its own margins and columns", Math.abs(Math.min(...xs) - 36) < 0.01 && xs.some((x) => x > 792 / 2));
  const moved = second.items.find((it) => isText(it) && it.text.startsWith("NEXTCOL")) as DLText;
  const firstLine = second.items.find((it) => isText(it) && it.text.startsWith("Landscape now.")) as DLText;
  check("a column break goes to the top of the next column", moved.x > 792 / 2 && Math.abs(moved.y - firstLine.y) < 0.01, `${moved.x} ${moved.y} vs ${firstLine.y}`);
  check("page numbers restart where a section says", dl.pages.map((pg) => pg.folio).join(",") === "1,1,2", dl.pages.map((pg) => pg.folio).join(","));
  const footer = second.items.find((it) => isText(it) && it.text === "1" && it.y > 612 - 72) as DLText;
  check("…and the footer follows the section's sheet", !!footer && footer.x > 792 - 36 - 20);
}

{
  const { dl } = await layout({
    type: "doc",
    content: [p(null, t("A picture follows.")), { type: "image", attrs: { src: "pic:one", width: 200, height: 100, align: "center", caption: "A small picture, captioned." } }, p(null, t("After."))],
  });
  const pg = dl.pages[0];
  const left = DEFAULT_SETTINGS.ml * 72;
  const textW = dl.trim.w - (DEFAULT_SETTINGS.ml + DEFAULT_SETTINGS.mr) * 72;
  const img = pg.items.find((it) => it.t === "image");
  const caption = pg.items.find((it) => isText(it) && it.text.startsWith("A small picture")) as DLText;
  check("a picture set in the middle", !!img && img.t === "image" && Math.abs(img.x - (left + (textW - 150) / 2)) < 0.01 && img.w === 150);
  check("…with its caption under it, small and italic, centred too", !!caption && img?.t === "image" && caption.y > img.y + img.h && caption.y < img.y + img.h + 24 && Math.abs(caption.size - 10.2) < 0.01 && dl.faces[caption.face].style === "italic" && caption.x > left + 60);
}

// ------------------------------------------------- where each page starts

{
  // (The composer's count of a line's characters, walked through the
  // paragraph's runs: the place in the editor's text each line begins.)
  const offs = lineOffsets([{ text: "One two ", at: 0 }, { text: "three", at: 8 }, { text: " four", at: 13 }], [6, 5, 4]);
  check("a line's start is where its first word is in the text", JSON.stringify(offs) === "[0,8,14]", JSON.stringify(offs));
  check("a line that starts inside a word is given the word's start", JSON.stringify(lineOffsets([{ text: "alpha betagamma", at: 0 }], [9, 5])) === "[0,6]");
  check("a note's number stands where the note is; a line break's empty line goes with the next", JSON.stringify(lineOffsets([{ text: "a", at: 0 }, { text: "12", at: 1, note: 0 }, { text: "\n", at: 5 }, { text: "\n", at: 6 }, { text: "b c", at: 7 }], [3, 0, 1, 1])) === "[0,7,7,9]", JSON.stringify(lineOffsets([{ text: "a", at: 0 }, { text: "12", at: 1, note: 0 }, { text: "\n", at: 5 }, { text: "\n", at: 6 }, { text: "b c", at: 7 }], [3, 0, 1, 1])));
  check("a drop cap's initial is in no line", JSON.stringify(lineOffsets([{ text: "Once upon", at: 0 }], [3, 4], 1)) === "[0,5]", JSON.stringify(lineOffsets([{ text: "Once upon", at: 0 }], [3, 4], 1)));

  const rand = prng(11);
  const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
  const cell = (text: string): JSONContent => ({ type: "tableCell", content: [p(null, t(text))] });
  const content: JSONContent[] = [h(1, "Where pages start")];
  for (let i = 0; i < 34; i += 1) {
    if (i % 9 === 4) content.push({ type: "bulletList", content: [item(p(null, t(prose(rand, 70)))), item(p(null, t(prose(rand, 110))), { type: "orderedList", content: [item(p(null, t(prose(rand, 50))))] })] });
    else if (i % 9 === 7) content.push({ type: "blockquote", content: [p(null, t(prose(rand, 90)))] });
    else if (i === 20) content.push({ type: "table", content: Array.from({ length: 30 }, (_, r) => ({ type: "tableRow", content: [cell(`Row ${r + 1} first`), cell(prose(rand, 12))] })) });
    else if (i % 5 === 0) content.push(p(null, t(prose(rand, 60)), { type: "footnote", content: [t("A note, to take room at the foot.")] }, t(` ${prose(rand, 70)}`), { type: "hardBreak" }, t(prose(rand, 40), "italic")));
    else content.push(p(i % 4 === 0 ? { align: "justify" } : null, t(prose(rand, 80)), t(` ${prose(rand, 60)}`, "bold")));
  }
  const whole: JSONContent = { type: "doc", content };
  const { dl } = await layout(whole);
  const pm = PmNode.fromJSON(contentSchema(), whole);
  const starts = dl.starts ?? [];
  check("every page says where it starts", starts.length === dl.pages.length && dl.pages.length > 6 && starts.every((s) => s !== null), `${starts.length} of ${dl.pages.length}: ${JSON.stringify(starts.slice(0, 4))}`);
  check("the first page starts with the first block", starts[0]?.pos === 0 && starts[0]?.inline === false);
  let wrong = "";
  let mid = 0;
  let nested = 0;
  let rowStarts = 0;
  dl.pages.forEach((page, i) => {
    const start = starts[i];
    if (!start || i === 0 || wrong) return;
    // The page's first word, as set (a list's marker aside).
    const firstLine = lines(page, dl, body(dl))[0];
    const word = firstLine.text.replace(/^(?:[•◦▪]|\d+[.)]|[a-z][.)])\s+/, "").split(" ")[0].replace(/[0-9]+$/, "");
    let got: string;
    if (start.inline) {
      mid += 1;
      got = pm.textBetween(start.pos, Math.min(pm.content.size, start.pos + word.length + 2));
      const before = pm.textBetween(Math.max(0, start.pos - 1), start.pos, "|", "|");
      if (before !== " " && before !== "|" && before !== "") wrong = `page ${i + 1}: starts mid-word after "${before}"`;
    } else {
      const node = pm.nodeAt(start.pos);
      if (!node) {
        wrong = `page ${i + 1}: no node at ${start.pos}`;
        return;
      }
      if (node.type.name === "tableRow") rowStarts += 1;
      if (pm.resolve(start.pos).depth > 0) nested += 1;
      got = node.textContent;
    }
    if (!wrong && !got.startsWith(word)) wrong = `page ${i + 1} begins "${firstLine.text.slice(0, 30)}" but its start is at "${got.slice(0, 30)}"`;
  });
  check("each start is the place in the text its page's first line begins", wrong === "", wrong);
  check("pages break inside paragraphs, inside lists and between a table's rows", mid >= 3 && rowStarts >= 1, `${mid} mid-paragraph, ${nested} nested, ${rowStarts} at a table row`);
  check("each page says how tall its text is", (dl.bodyH ?? []).length === dl.pages.length && Math.abs((dl.bodyH ?? [])[0] - (792 - (0.86 + 1) * 72)) < 0.01, String(dl.bodyH?.[0]));

  // A title put in for print isn't in the editor: positions are as if it weren't there.
  const poem = scriptedAsDocument({ type: "doc", content: Array.from({ length: 120 }, (_, i) => p({ element: "line" }, t(`Line ${i + 1} of the poem`))) }, "poetry", "A Long Poem");
  const model = buildDocModel(poem.doc, { title: "A Long Poem", settings: poem.settings, virtual: poem.virtual });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const verse = (await session.layout({ kind: "document", doc: model, families: model.families, images: [] })).dl;
  const pmPoem = PmNode.fromJSON(contentSchema(), { type: "doc", content: Array.from({ length: 120 }, (_, i) => p({ element: "line" }, t(`Line ${i + 1} of the poem`))) });
  const second = verse.starts?.[1];
  const firstOnTwo = lines(verse.pages[1], verse, { top: 71, bottom: 792 - 72 + 1 })[0].text;
  check("a title put in for print doesn't shift where pages start in the editor", verse.pages.length >= 2 && !!second && !second.inline && pmPoem.nodeAt(second.pos)?.textContent === firstOnTwo && verse.starts?.[0] === null, `${JSON.stringify(second)} ${firstOnTwo} / ${second ? pmPoem.nodeAt(second.pos)?.textContent : ""}`);
}

// ------------------------------------------------- the scripted formats

{
  const el = (element: string, text: string, ...marks: string[]): JSONContent => p({ element }, t(text, ...marks));
  const script: JSONContent = {
    type: "doc",
    content: [
      el("scene_heading", "int. kitchen - night"),
      el("action", "Ana stands at the window. Rain. Ξένος at the door, Дмитрий behind him."),
      el("character", "ana"),
      el("parenthetical", "(without turning)"),
      el("dialogue", "You came back. I had stopped counting the days, and then the weeks, and then I stopped counting at all."),
      el("transition", "cut to:"),
      ...Array.from({ length: 70 }, (_, i) => el("action", `Action line ${i + 1}.`)),
    ],
  };
  const made = scriptedAsDocument(script, "screenplay", "The Kitchen");
  const { dl } = await layout(made.doc, made.settings, "The Kitchen");
  const first = dl.pages[0];
  const find = (text: string, page = first) => page.items.find((it) => isText(it) && it.text.startsWith(text)) as DLText | undefined;
  const heading = find("INT. KITCHEN");
  check("a screenplay is twelve-point Courier on US Letter", dl.trim.w === 612 && dl.trim.h === 792 && !!heading && heading.size === 12 && dl.faces[heading.face].family === "courier-prime", JSON.stringify(heading && [heading.size, dl.faces[heading.face].family]));
  check("a scene heading: capitals, at the left margin (1.5 in)", !!heading && Math.abs(heading.x - 108) < 0.01 && heading.text === "INT. KITCHEN - NIGHT", JSON.stringify(heading && [heading.x, heading.text]));
  const who = find("ANA");
  const aside = find("(without");
  const speech = find("You came back.");
  const cut = find("CUT TO:");
  check("a character's name 3.7 in from the paper's edge, in capitals", !!who && Math.abs(who.x - (108 + 2.2 * 72)) < 0.01, String(who?.x));
  check("a parenthetical at 3.1 in, dialogue at 2.5 in", !!aside && !!speech && Math.abs(aside.x - (108 + 1.6 * 72)) < 0.01 && Math.abs(speech.x - 180) < 0.01, `${aside?.x} ${speech?.x}`);
  const speechLines = lines(first, dl).filter((l) => Math.abs(l.x - 180) < 0.01);
  const cpl = Math.max(...speechLines.map((l) => l.text.length));
  check("dialogue is held to 3.5 in (thirty-five characters) and wraps", speechLines.length >= 3 && cpl <= 35, `${speechLines.length} lines, longest ${cpl}`);
  check("its lines are a sixth of an inch apart", Math.abs(speechLines[1].y - speechLines[0].y - 12) < 0.01, String(speechLines[1].y - speechLines[0].y));
  const cutEnd = cut ? cut.x + cut.text.length * 7.2 : 0;
  check("a transition ends at the right margin", !!cut && Math.abs(cutEnd - (612 - 72)) < 0.6, String(cutEnd));
  check("a name, an aside and the speech stay one under the other", !!who && !!aside && !!speech && Math.abs(aside.y - who.y - 12) < 0.01 && Math.abs(speech.y - aside.y - 12) < 0.01, `${who?.y} ${aside?.y} ${speech?.y}`);
  check("other alphabets are set, not replaced with question marks", allText(dl).includes("Ξένος") && allText(dl).includes("Дмитрий") && !allText(dl).includes("?"), allText(dl).slice(0, 160));
  const top = (page: DLPage) => page.items.filter(isText).filter((it) => it.y < 60).map((it) => it.text);
  check("pages are numbered at the top right from the second", dl.pages.length >= 2 && top(first).length === 0 && top(dl.pages[1]).join("") === "2.", `${JSON.stringify(top(first))} ${JSON.stringify(top(dl.pages[1]))}`);
  const perPage = lines(dl.pages[1], dl, { top: 72 - 1, bottom: 792 - 72 + 1 }).length;
  check(`a full page holds what a screenplay page should (${perPage} lines of action, each with a blank line after)`, perPage >= 26 && perPage <= 28, String(perPage));
  if (process.env.WF_DUMP) {
    const { writeFileSync } = await import("node:fs");
    const { req } = await layout(made.doc, made.settings, "The Kitchen");
    writeFileSync(`${process.env.WF_DUMP}/screenplay.pdf`, (await session.pdf(req)).bytes);
  }

  const play = scriptedAsDocument(
    {
      type: "doc",
      content: [el("act_heading", "Act one"), el("scene_heading", "Scene 1"), el("stage_direction", "A bare room."), el("character", "bo"), el("dialogue", "Well?"), p(null, t("An unmarked line is a stage direction."))],
    },
    "stageplay",
    "The Room",
  );
  const stage = await layout(play.doc, play.settings, "The Room");
  const sp = stage.dl.pages[0];
  const sfind = (text: string) => sp.items.find((it) => isText(it) && it.text.startsWith(text)) as DLText | undefined;
  const playTitle = sfind("THE ROOM");
  const act = sfind("ACT ONE");
  check("a play opens with its title, centred and bold", !!playTitle && stage.dl.faces[playTitle.face].style === "bold" && Math.abs(playTitle.x + (8 * 7.2) / 2 - (108 + 3 * 72)) < 1, JSON.stringify(playTitle && [playTitle.x, stage.dl.faces[playTitle.face].style]));
  check("an act heading is centred, in capitals", !!act && Math.abs(act.x + (7 * 7.2) / 2 - (108 + 3 * 72)) < 1, String(act?.x));
  check("stage directions are italic — an unmarked line too", stage.dl.faces[sfind("A bare room.")!.face].style === "italic" && stage.dl.faces[sfind("An unmarked")!.face].style === "italic");
  check("a character's name and the speech under it", sfind("BO")?.x === 108 + 2.2 * 72 && sfind("Well?")?.x === 180, `${sfind("BO")?.x} ${sfind("Well?")?.x}`);

  const poem = scriptedAsDocument(
    {
      type: "doc",
      content: [
        el("stanza_title", "I"),
        el("line", "A short line"),
        el("line", "And a line that goes on far beyond the measure of the page it is set on, turning over when it must, and then again because it is longer still"),
        p(null),
        p(null, t("\tA line set in by hand")),
      ],
    },
    "poetry",
    "Verses",
  );
  const verse = await layout(poem.doc, poem.settings, "Verses");
  const vp = verse.dl.pages[0];
  const vl = lines(vp, verse.dl, { top: 71, bottom: 792 - 72 + 1 });
  check("a poem opens with its title, larger and bold", vl[0].text === "Verses" && (vp.items.find((it) => isText(it) && it.text === "Verses") as DLText).size === 16);
  const long = vl.findIndex((l) => l.text.startsWith("And a line"));
  check("a line too long for the measure turns over, set in", long > 0 && Math.abs(vl[long].x - 108) < 0.01 && Math.abs(vl[long + 1].x - 132) < 0.01, `${vl[long]?.x} ${vl[long + 1]?.x}`);
  check("a blank line between stanzas, and a hand-set indent", vl.some((l) => l.text === "A line set in by hand" && Math.abs(l.x - 144) < 0.01), JSON.stringify(vl.map((l) => [l.x, l.text.slice(0, 12)])));
  const foot = vp.items.filter(isText).filter((it) => it.y > 792 - 72);
  check("its page number is centred at the foot", foot.length === 1 && foot[0].text === "1" && Math.abs(foot[0].x - 306) < 6, JSON.stringify(foot.map((f) => [f.x, f.text])));
}

// -------------------------------------- a table's row, cut where the page ends

{
  const schema = contentSchema();
  const cellOf = (doc: JSONContent, pos: number) => {
    const $pos = schema.nodeFromJSON(doc).resolve(pos);
    for (let d = $pos.depth; d > 0; d -= 1) if ($pos.node(d).type.name === "tableCell") return $pos.before(d);
    return -1;
  };
  const rand = prng(31);
  const long = (n: number) => Array.from({ length: n }, () => p(null, t(prose(rand, 60))));
  // Half a page of text, then a row far too tall for what is left of it.
  const doc: JSONContent = { type: "doc", content: [...long(5), table({ cols: "90 378" }, tr(cell("2024"), cell(long(10)))), p(null, t("After the table."))] };
  const { dl } = await layout(doc);
  const area = body(dl);
  const first = lines(dl.pages[0], dl, area);
  const second = lines(dl.pages[1], dl, area);
  check("a row that won't fit what is left of a page begins on it all the same", first.some((l) => l.text.startsWith("2024")) && first[first.length - 1].y > area.bottom - 40, `${first[first.length - 1].y} of ${area.bottom}`);
  check("…and goes on at the top of the next page", dl.pages.length >= 2 && second[0].y < area.top + 30 && !second[0].text.startsWith("2024"), `${second[0]?.y}`);
  /** Whether everything on every page is above its foot (its number aside). */
  const allOnPage = (list: DisplayList, foot: number) =>
    list.pages.every((pg) => pg.items.every((it) => (it.t === "rule" ? it.y2 <= foot + 0.6 : it.t !== "text" || it.y <= foot + 0.6 || it.text === pg.folio)));
  check("…with nothing set past the foot of a page", allOnPage(dl, area.bottom) && dl.pages.every((pg) => lines(pg, dl, area).length > 0));
  const start = dl.starts?.[1];
  check("the page that takes the rest begins inside the row's cell", !!start && cellOf(doc, start.pos) > 0 && !start.also, JSON.stringify(start));
  check("what follows the table still follows it", lines(dl.pages[dl.pages.length - 1], dl, area).some((l) => l.text.startsWith("After the table.")));

  // Two long cells side by side: each goes on where it was cut.
  const two: JSONContent = { type: "doc", content: [...long(5), table(null, tr(cell(long(8)), cell(long(9))))] };
  const both = await layout(two);
  const at = both.dl.starts?.[1];
  const cellsHit = at ? [at.pos, ...(at.also ?? []).map((a) => a.pos)].map((pos) => cellOf(two, pos)) : [];
  check("two cells cut by the same page: the next page begins in each of them", cellsHit.length === 2 && cellsHit.every((c) => c > 0) && cellsHit[0] !== cellsHit[1], JSON.stringify(at));

  // Rows tied by a cell that runs down them (a date beside two rows of text).
  const tied: JSONContent = {
    type: "doc",
    content: [...long(5), table({ cols: "90 378", lines: "none" }, tr(cell("2023", { rowspan: 2 }), cell(long(6))), tr(cell(long(6)))), p(null, t("After the tied rows."))],
  };
  const band = await layout(tied);
  const bandArea = body(band.dl);
  check("rows a cell runs down are cut across the page too (they once went over whole, off its foot)", band.dl.pages.length >= 2 && lines(band.dl.pages[0], band.dl, bandArea).some((l) => l.text.startsWith("2023")) && allOnPage(band.dl, bandArea.bottom), String(band.dl.pages.length));

  // A row that fits is left alone.
  const short = await layout({ type: "doc", content: [p(null, t("Before.")), table(null, tr(cell("a"), cell("b"))), p(null, t("After."))] });
  check("a row that fits is set whole, as before", short.dl.pages.length === 1);
}

// ---------------------------------------- a cell's own lines, a picture's frame

{
  const { dl } = await layout({
    type: "doc",
    content: [
      table({ cols: "100 100 100", lines: "none" }, tr(cell("a", { bdr: "r:2.25:#f38d88" }), cell("b", { bdr: "l:2.25:#f38d88" }), cell("c"))),
      table({ cols: "100 100" }, tr(cell("x", { bdr: "t:0:#000000 b:3:#0000ff" }), cell("y"))),
    ],
  });
  const rules = dl.pages[0].items.filter((it): it is Extract<DLItem, { t: "rule" }> => it.t === "rule");
  const pink = rules.filter((r) => r.color === "#f38d88");
  check("a cell's own border is drawn in its colour and weight, down the side it names", pink.length === 2 && pink.every((r) => r.w === 2.25 && r.x1 === r.x2) && Math.abs(pink[0].x1 - pink[1].x1) < 0.01, JSON.stringify(pink));
  check("…and a table that draws no lines draws none but that", rules.filter((r) => r.color !== "#f38d88" && r.y1 < pink[0].y2 + 1).length === 0);
  const blue = rules.filter((r) => r.color === "#0000ff");
  check("in a table with lines, a cell's own line replaces the table's on that side", blue.length === 1 && blue[0].w === 3 && blue[0].y1 === blue[0].y2);
  // (Its top says "none": the cell beside it still draws its own top.)
  const tops = rules.filter((r) => r.y1 === r.y2 && Math.abs(r.y1 - Math.min(...rules.filter((q) => q.color !== "#f38d88" && q.y1 > pink[0].y2).map((q) => q.y1))) < 0.01);
  check("…and a side it says has no line has none", tops.length === 1, String(tops.length));

  PICTURES.push({ url: "pic:framed", w: 120, h: 120, bytes: PNG_1x1, type: "image/png" } as DocRequest["images"][number]);
  const framed = await layout({ type: "doc", content: [{ type: "image", attrs: { src: "pic:framed", width: 120, height: 120, bdr: "2.25 #c10813", round: 16.7 } }, { type: "image", attrs: { src: "pic:framed", width: 96, height: 96, round: 50 } }] });
  const pics = framed.dl.pages[0].items.filter((it): it is Extract<DLItem, { t: "image" }> => it.t === "image");
  check("a picture's outline and rounded corners go to the page with it", pics.length === 2 && pics[0].round === 16.7 && pics[0].border?.w === 2.25 && pics[0].border.color === "#c10813" && pics[1].round === 50 && !pics[1].border);
  const pdf = await session.pdf(framed.req);
  check("…and the PDF draws them (cut to shape, the line inside)", pdf.bytes.length > 800 && pdf.pages === 1);
  if (process.env.WF_DUMP) (await import("node:fs")).writeFileSync(`${process.env.WF_DUMP}/pictures.pdf`, pdf.bytes);
}

// A look at the result: WF_DUMP=/some/dir writes sample PDFs there.
if (process.env.WF_DUMP) {
  const { writeFileSync } = await import("node:fs");
  const rand = prng(4);
  const sample: JSONContent = {
    type: "doc",
    content: [
      h(1, "The Harbour at Night"),
      p({ dropCap: true }, t(prose(rand, 70))),
      p(null, t("Plain, "), t("bold", "bold"), t(", "), t("italic", "italic"), t(", "), t("bold italic", "bold", "italic"), t(", "), t("underlined", "underline"), t(", "), t("struck", "strike"), t(", "), t("code()", "code"), t(" and "), t("a link", { type: "link", attrs: { href: "https://example.com/" } }), t(". "), t(prose(rand, 40))),
      h(2, "Lists and quotes"),
      { type: "bulletList", content: [{ type: "listItem", content: [p(null, t(prose(rand, 18)))] }, { type: "listItem", content: [p(null, t("Second item")), { type: "orderedList", attrs: { start: 1, type: "a" }, content: [{ type: "listItem", content: [p(null, t("Nested one"))] }, { type: "listItem", content: [p(null, t("Nested two"))] }] }] }] },
      { type: "orderedList", attrs: { start: 9, type: null }, content: [{ type: "listItem", content: [p(null, t("Nine"))] }, { type: "listItem", content: [p(null, t("Ten"))] }] },
      { type: "blockquote", content: [p(null, t(prose(rand, 30))), p({ align: "right" }, t("— Someone"))] },
      h(3, "Code and rules"),
      { type: "codeBlock", content: [t("function greet(name) {\n  return `Hello, ${name}`;\n}")] },
      { type: "horizontalRule" },
      p({ align: "center" }, t("Centred text")),
      p({ align: "justify" }, t(prose(rand, 90))),
      p({ font: "sans", size: 10 }, t("Sans at ten points. "), t(prose(rand, 30))),
      h(4, "Heading four"),
      h(5, "Heading five"),
      h(6, "Heading six"),
      p({ font: "garamond", size: 14, line: 1.5 }, t(prose(rand, 50))),
      ...Array.from({ length: 6 }, () => p(null, t(prose(rand, 110)))),
    ],
  };
  const { req } = await layout(sample, { hL: "{title}", hR: "{author}", fC: "Page {page} of {pages}", fR: "" }, "Sample");
  writeFileSync(`${process.env.WF_DUMP}/sample.pdf`, (await session.pdf(req)).bytes);
  const two = await layout(sample, { cols: 2, pageSize: "a4", lineNumbers: true, bodyFont: "libertinus", bodySize: 10, firstIndent: 0.25, paraSpacing: 0, hyphenate: true }, "Two columns");
  writeFileSync(`${process.env.WF_DUMP}/columns.pdf`, (await session.pdf(two.req)).bytes);
  const rich: JSONContent = {
    type: "doc",
    content: [
      p({ element: "title" }, t("Formatting, on paper")),
      p({ element: "subtitle" }, t("What schema level 2 adds")),
      h(1, "Words"),
      p(null, t("Plain, "), t("red", mk("textColor", { c: "#c00000" })), t(", "), t("blue and bold", "bold", mk("textColor", { c: "#0070c0" })), t(", "), t("highlighted in yellow", mk("highlight", { c: "#ffff00" })), t(", "), t("in soft blue", mk("highlight", { c: "#bdd7ee" })), t(", E = mc"), t("2", mk("vscript", { v: "super" })), t(", H"), t("2", mk("vscript", { v: "sub" })), t("O, a word in "), t("Garamond", mk("fontFamily", { f: "garamond" })), t(", one in "), t("sans", mk("fontFamily", { f: "sans" })), t(", and "), t("one much larger", mk("fontSize", { pt: 22 })), t(" than the rest. "), t(prose(rand, 40))),
      h(2, "Paragraphs"),
      p({ indL: 54, indR: 54 }, t("Set in from both sides. "), t(prose(rand, 40))),
      p({ indL: 36, indF: -36 }, t("Hanging. "), t(prose(rand, 45))),
      p({ indF: 36 }, t("First line set in. "), t(prose(rand, 45))),
      p({ lineRule: "exact", lineAt: 24 }, t("Exactly 24 points a line. "), t(prose(rand, 40))),
      p({ shade: "#fff2cc" }, t("Shaded. "), t(prose(rand, 30))),
      p({ bdr: "tblr 0.75 #000000" }, t("Boxed. "), t(prose(rand, 30))),
      p({ shade: "#ddebf7", bdr: "l 2.25 #0070c0" }, t("A bar at the left, on a tint. "), t(prose(rand, 30))),
      p({ bdr: "tb 0.75 #7f7f7f", align: "center" }, t("Lines above and below, centred")),
      p({ element: "u-pull01" }, t("“A style of the document’s own, used for a pull quote.”")),
      p({ element: "caption" }, t("A caption.")),
      p({ element: "nospace" }, t("No spacing: line one")),
      p({ element: "nospace" }, t("No spacing: line two")),
      h(2, "Lists"),
      { type: "taskList", content: [task(true, "Write the chapter"), task(true, "Send it to the group"), task(false, "Read the comments"), { type: "taskItem", content: [p(null, t("Revise")), { type: "taskList", content: [task(false, "The opening"), task(true, "The ending")] }] }] },
      { type: "bulletList", attrs: { marker: "dash" }, content: [li(p(null, t("A dash"))), li(p(null, t("Another")))] },
      { type: "bulletList", attrs: { marker: "arrow" }, content: [li(p(null, t("An arrow")))] },
      { type: "bulletList", attrs: { marker: "check" }, content: [li(p(null, t("A tick")))] },
      {
        type: "orderedList",
        attrs: { start: 1, type: "legal" },
        content: [
          li(p(null, t("Definitions")), { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(null, t("“The Work” means the manuscript.")), { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(null, t("Including its drafts.")))] }), li(p(null, t("“The Author” means its writer.")))] }),
          li(p(null, t("Term"))),
        ],
      },
    ],
  };
  const formatted = await layout(rich, { fC: "{page}", fR: "" }, "Formatting", {
    h1: { props: { color: "#2f5496" } },
    "u-pull01": { name: "Pull quote", props: { italic: true, align: "center", size: 15, indL: 54, indR: 54, color: "#404040" } },
  });
  writeFileSync(`${process.env.WF_DUMP}/formatting.pdf`, (await session.pdf(formatted.req)).bytes);
  const chapterText = (n: number) => Array.from({ length: n }, () => p(null, t(prose(rand, 95))));
  const structure: JSONContent = {
    type: "doc",
    content: [
      p({ element: "title" }, t("Tables, notes and contents")),
      { type: "toc" },
      h(1, "A table"),
      p(null, t("Sales by region"), note("Figures are invented for this sample."), t(", with a header row, a shaded cell, a cell across two columns and one down two rows.")),
      table(
        { head: true, cols: "120 90 90 168" },
        tr(cell([p(null, t("Region", "bold"))]), cell([p({ align: "right" }, t("Q1", "bold"))]), cell([p({ align: "right" }, t("Q2", "bold"))]), cell([p(null, t("Notes", "bold"))])),
        tr(cell("North"), cell([p({ align: "right" }, t("1,204"))]), cell([p({ align: "right" }, t("1,310"))]), cell("Steady, with a late order that wraps onto a second line of the cell.", { bg: "#e2efda" })),
        tr(cell("South"), cell([p({ align: "right" }, t("980"))]), cell([p({ align: "right" }, t("1,105"))]), cell("Both quarters: see the appendix.", { rowspan: 2 })),
        tr(cell("East and West together", { colspan: 2 }), cell([p({ align: "right" }, t("2,440"))])),
      ),
      { type: "image", attrs: { src: "pic:one", width: 240, height: 90, align: "center", caption: "Figure 1. A picture, centred, with its caption." } },
      h(1, "Footnotes"),
      p(null, t("The first claim"), note("A short note."), t(" is followed by a second"), note("A longer note, long enough to take a second line at the foot of the page so that the way notes are set — small, single spaced, their number raised — can be seen."), t(", and by an aside kept for the end"), note("An endnote: it closes the document.", "end"), t(". "), t(prose(rand, 60))),
      ...chapterText(3),
      { type: "heading", attrs: { level: 2 }, content: [t("A sub-heading")] },
      ...chapterText(2),
      { type: "heading", attrs: { level: 1, sect: "sect land:1 cols:2" }, content: [t("A landscape section, in two columns")] },
      ...chapterText(4),
      p({ colBreak: true }, t("After a column break. "), t(prose(rand, 40))),
      { type: "heading", attrs: { level: 1, sect: "sect" }, content: [t("Back to portrait")] },
      ...chapterText(2),
    ],
  };
  const structured = await layout(structure, { fC: "{page}", fR: "", hR: "{title}" }, "Structure");
  writeFileSync(`${process.env.WF_DUMP}/structure.pdf`, (await session.pdf(structured.req)).bytes);
  console.log(`Wrote samples to ${process.env.WF_DUMP}`);
}

// ------------------------------------------------------------------ speed

{
  const rand = prng(99);
  const content: JSONContent[] = [];
  let words = 0;
  while (words < 100_000) {
    const n = 40 + Math.floor(rand() * 140);
    content.push(p(null, t(prose(rand, n))));
    words += n;
    if (content.length % 25 === 0) content.push(h(2, `Part ${content.length}`));
  }
  const doc: JSONContent = { type: "doc", content };
  const settings = { ...DEFAULT_SETTINGS };
  const model = buildDocModel(doc, { title: "Long", settings });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const fresh = new TypesetSession();
  fresh.addFonts(await loadFontFiles(model.families));
  let t0 = performance.now();
  const cold = await fresh.layout({ kind: "document", doc: model, families: model.families, images: [] });
  const coldMs = performance.now() - t0;
  check(`100,000 words lay out cold in under 3 s (${coldMs.toFixed(0)} ms, ${cold.dl.pages.length} pages)`, coldMs < 3000);

  // One paragraph edited in the middle: everything else is reused.
  const edited = content.slice();
  const mid = Math.floor(edited.length / 2);
  edited[mid] = p(null, t(`${edited[mid].content![0].text} Typed just now.`));
  t0 = performance.now();
  const model2 = buildDocModel({ type: "doc", content: edited }, { title: "Long", settings });
  const buildMs = performance.now() - t0;
  t0 = performance.now();
  const warm = await fresh.layout({ kind: "document", doc: model2, families: model2.families, images: [] });
  const warmMs = performance.now() - t0;
  check(`…and an edit re-flows in under 50 ms (model ${buildMs.toFixed(0)} ms, layout ${warmMs.toFixed(0)} ms)`, warmMs < 50 && buildMs < 50);
  check("the edit shows up", allText(warm.dl).includes("Typed just now."));
  const again = await fresh.layout({ kind: "document", doc: model2, families: model2.families, images: [] });
  check("laying the same thing out twice gives the same pages", JSON.stringify(again.dl.pages) === JSON.stringify(warm.dl.pages));
  const scratch = new TypesetSession();
  scratch.addFonts(await loadFontFiles(model2.families));
  const clean = await scratch.layout({ kind: "document", doc: model2, families: model2.families, images: [] });
  check("…and reusing paragraphs equals starting over", JSON.stringify(clean.dl.pages) === JSON.stringify(warm.dl.pages));
}

finish();
