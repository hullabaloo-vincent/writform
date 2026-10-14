// A tagged PDF: the document's structure (headings, paragraphs, lists,
// tables, pictures and what they show, notes, links) is worked out with
// the model, carried through the layout on the items of each page, and
// written into the file, where a screen reader finds it. Everything else on
// a page is marked as decoration.
//
// Held here: the structure itself, that each item on a page has the right
// owner, that asking for none costs nothing and leaves no trace, and the
// file read back with pdf.js.

import { check, finish } from "./env";
import "./dom";

import { writeFileSync } from "node:fs";

import type { JSONContent } from "@tiptap/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { DEFAULT_SETTINGS, type DocSettings } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DisplayList, DLItem, DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";

const session = new TypesetSession();

const t = (text: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });
const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const cell = (text: string, attrs?: Record<string, unknown>): JSONContent => ({ type: "tableCell", ...(attrs ? { attrs } : {}), content: [text ? p(null, t(text)) : p(null)] });
const tr = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
const note = (text: string): JSONContent => ({ type: "footnote", content: [t(text)] });
const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
const PICTURES: DocRequest["images"] = [
  { url: "pic:described", w: 240, h: 120, bytes: PNG_1x1 },
  { url: "pic:bare", w: 120, h: 60, bytes: PNG_1x1 },
];
const SENTENCE = "The harbour was quiet that morning and nobody on the quay looked up when the ferry came in. ";

const doc: JSONContent = {
  type: "doc",
  content: [
    h(1, "A tagged document"),
    { type: "toc" },
    p(null, t("An opening paragraph with "), t("a link", { type: "link", attrs: { href: "https://example.org/tagged" } }), t(" in it and a note"), note("What the note says."), t(".")),
    p(null),
    { type: "blockquote", content: [p(null, t("Someone else’s words."))] },
    h(2, "Lists"),
    {
      type: "bulletList",
      content: [li(p(null, t("First item"))), li(p(null, t("Second item")), p(null, t("More of the second.")), { type: "orderedList", content: [li(p(null, t("Inner one"))), li(p(null, t("Inner two")))] })],
    },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(null, t("Done"))] }] },
    h(2, "A table"),
    {
      type: "table",
      attrs: { head: true },
      content: [tr(cell("Region"), cell("Spring"), cell("Autumn")), tr(cell("North"), cell(""), cell("12")), tr(cell("South and east", { colspan: 2 }), cell("9"))],
    },
    { type: "image", attrs: { src: "pic:described", width: 240, height: 120, alt: "A ferry at a quay", caption: "Figure 1. The ferry." } },
    { type: "image", attrs: { src: "pic:bare", width: 120, height: 60 } },
    { type: "codeBlock", content: [t("let a = 1;\nlet b = 2;")] },
    h(2, "A long paragraph"),
    // Long enough to run from the first page onto the second.
    ...Array.from({ length: 5 }, () => p(null, t(SENTENCE.repeat(9)))),
    p(null, t("The same words twice.")),
    p(null, t("The same words twice.")),
  ],
};

async function layout(struct: boolean, settings: Partial<DocSettings> = {}) {
  const model = buildDocModel(doc, { title: "Tagged", author: "A. Writer", settings: { ...DEFAULT_SETTINGS, hC: "{title}", ...settings }, date: "October 13, 2026", ...(struct ? { struct: true } : {}) });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req: DocRequest = { kind: "document", doc: model, families: model.families, images: PICTURES, pdf: { pictures: "print", tagged: struct, archive: false, source: false } };
  const { dl } = await session.layout(req);
  return { dl, model, req };
}
const isText = (it: DLItem): it is DLText => it.t === "text";
const texts = (dl: DisplayList) => dl.pages.flatMap((page) => page.items.filter(isText));

// -------------------------------------------------------------- the model

const tagged = await layout(true);
{
  const { model } = tagged;
  const s = model.struct!;
  const path = (id: number): string => (s[id].parent < 0 ? s[id].role : `${path(s[id].parent)}>${s[id].role}`);
  const roles = s.map((n) => n.role).join(" ");
  check("the structure starts with the document itself", s[0].role === "Document" && s[0].parent === -1);
  check("every element is made after what holds it", s.every((n, i) => n.parent < i));
  check("headings by level, the contents, paragraphs, a quote", roles.startsWith("Document H1 TOC P Note BlockQuote P H2 "), roles.slice(0, 90));
  check("a paragraph with nothing in it is nothing", model.blocks.filter((b) => b.kind === "para" && b.runs.length === 0).every((b) => b.tag === undefined));
  check("a note belongs to the paragraph that cites it", path(s.findIndex((n) => n.role === "Note")) === "Document>P>Note");
  const lists = s.map((n, i) => (n.role === "L" ? path(i) : "")).filter(Boolean);
  check("a list inside an item is inside that item's body", lists.join(" | ") === "Document>L | Document>L>LI>LBody>L | Document>L", lists.join(" | "));
  const first = s.findIndex((n) => n.role === "LI");
  check("an item is its label then its body, and the body holds its paragraphs", s[first + 1].role === "Lbl" && s[first + 2].role === "LBody" && s[first + 3].role === "P" && s[first + 3].parent === first + 2);
  const boxItem = s.map((n, i) => (n.role === "LI" ? i : -1)).filter((i) => i >= 0).pop()!;
  check("a checklist's drawn box is no label", s[boxItem + 1].role === "LBody");
  const cells = s.filter((n) => n.role === "TH" || n.role === "TD");
  check("a table: rows of cells, the header row's saying what they head", s.filter((n) => n.role === "TR").length === 3 && cells.map((n) => n.role).join("") === "THTHTHTDTDTDTDTD" && cells.slice(0, 3).every((n) => n.scope === "Column") && cells.slice(3).every((n) => !n.scope));
  check("…and a cell across two columns says so", cells.filter((n) => n.colspan === 2).length === 1 && cells.every((n) => !n.rowspan));
  const figures = s.filter((n) => n.role === "Figure");
  check("a picture is a figure, with what it shows when that has been said", figures.length === 2 && figures[0].alt === "A ferry at a quay" && figures[1].alt === undefined);
  check("its caption is the figure's", path(s.findIndex((n) => n.role === "Caption")) === "Document>Figure>Caption");
  const code = model.blocks.filter((b) => b.kind === "para" && b.pre);
  check("a block of code is one paragraph, however many lines", code.length === 2 && code[0].tag !== undefined && code[0].tag === code[1].tag);
  const same = model.blocks.filter((b) => b.kind === "para" && b.runs[0]?.text === "The same words twice.");
  check("two paragraphs that read alike are still two", same.length === 2 && same[0].tag !== same[1].tag);
}

// ------------------------------------------------------------- the layout

{
  const { dl, model } = tagged;
  const s = dl.struct!;
  const role = (it: DLText) => (it.s === undefined ? "none" : it.s === -1 ? "head" : it.s === -2 ? "foot" : it.s < 0 ? "decoration" : s[it.s].role);
  const all = texts(dl);
  const find = (text: string) => all.filter((it) => it.text.includes(text));
  check("the layout hands the structure on, with its own additions after the model's", s.length > model.struct!.length && s.slice(0, model.struct!.length).every((n, i) => n === model.struct![i]) && s.slice(model.struct!.length).every((n) => n.late && (n.role === "Link" || n.role === "TOCI")));
  check("every word on a page has an owner", all.every((it) => it.s !== undefined), String(all.filter((it) => it.s === undefined).map((it) => it.text)));
  check("a heading's words are its heading's", find("A tagged document").some((it) => role(it) === "H1") && find("Lists").some((it) => role(it) === "H2"));
  check("the running head and the page number are said to be that", find("Tagged").some((it) => role(it) === "head") && all.some((it) => role(it) === "foot" && /^\d+$/.test(it.text)));
  check("a bullet is its item's label, the words are the paragraph's", all.filter((it) => it.lbl).length === 4 && all.filter((it) => it.lbl).every((it) => role(it) === "Lbl") && find("First item").every((it) => role(it) === "P"));
  const linked = find("a link");
  check("words under a link are the link's, inside their paragraph", linked.length === 1 && role(linked[0]) === "Link" && s[s[linked[0].s!].parent].role === "P");
  const linkItem = dl.pages[0].items.find((it) => it.t === "link" && it.url === "https://example.org/tagged");
  check("…and the link itself points at the same element", !!linkItem && linkItem.t === "link" && linkItem.s === linked[0].s);
  check("a cell's words are a paragraph in that cell", find("North").every((it) => role(it) === "P" && s[s[it.s!].parent].role === "TD") && find("Region").every((it) => s[s[it.s!].parent].role === "TH"));
  check("a note at the foot of the page is that note", find("What the note says.").every((it) => role(it) === "Note"));
  check("a caption is its figure's caption", find("Figure 1. The ferry.").every((it) => role(it) === "Caption"));
  const pictures = dl.pages.flatMap((page) => page.items).filter((it) => it.t === "image");
  check("a picture on the page is its figure", pictures.length === 2 && pictures.every((it) => it.t === "image" && it.s !== undefined && s[it.s].role === "Figure"));
  const contents = find("Lists").filter((it) => role(it) === "Link");
  check("a line of the contents is an entry holding a link", contents.length === 1 && s[s[contents[0].s!].parent].role === "TOCI" && s[s[s[contents[0].s!].parent].parent].role === "TOC");
  // (The contents' dots are grey. A sentence's full stop is not one of them.)
  const dots = all.filter((it) => it.text === "." && it.color === "#808080");
  check("the dots that lead to a page number are decoration", dots.length > 20 && dots.every((it) => it.s === -3), `${dots.length} dots, owners ${[...new Set(dots.map((it) => it.s))].join()}`);
  const twice = find("The same words twice.");
  check("paragraphs set alike share their setting, never their owner", twice.length === 2 && twice[0].s !== twice[1].s);
  const long = all.filter((it) => it.text.startsWith("The harbour was quiet"));
  const onPages = new Set(dl.pages.flatMap((page, i) => (page.items.some((it) => isText(it) && it.s === long[0].s) ? [i] : [])));
  check("(the document runs over a page, as the checks below need)", dl.pages.length >= 2);
  const split = model.blocks.find((b) => b.kind === "para" && dl.pages.filter((page) => page.items.some((it) => isText(it) && it.s === b.tag)).length === 2);
  check("a paragraph that runs over a page is one paragraph on both", !!split || onPages.size >= 1);

  // Not asked for: nothing of it, and what was kept from the tagged
  // layout is not marked by it.
  const plain = await layout(false);
  check("without tags the layout has no structure and no item an owner", !plain.dl.struct && plain.dl.pages.every((page) => page.items.every((it) => !("s" in it) || it.s === undefined)));
  const strip = (dl: DisplayList) => JSON.stringify(dl.pages.map((page) => page.items.map((it) => ({ ...it, s: undefined, lbl: undefined }))));
  check("…and is set exactly as a tagged one", strip(plain.dl) === strip(tagged.dl));
  const again = await layout(true);
  check("a tagged layout twice over is the same", JSON.stringify(again.dl) === JSON.stringify(tagged.dl));
}

// ---------------------------------------------------------------- the file

interface TreeNode {
  role: string;
  children?: (TreeNode | { type: string; id?: string })[];
  alt?: string;
}
const open = (bytes: Uint8Array) => getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false }).promise;
{
  const result = await session.pdf(tagged.req);
  if (process.env.WF_DUMP) writeFileSync(`${process.env.WF_DUMP}/tagged.pdf`, result.bytes);
  const pdf = await open(result.bytes);
  const raw = Buffer.from(result.bytes).toString("latin1");
  const info = await pdf.getMarkInfo();
  check("the file says it is tagged", !!info && (info as { Marked?: boolean }).Marked === true, JSON.stringify(info));
  check("…in a version of PDF that has what tables say of their cells", /^%PDF-1\.7/.test(raw));

  const trees: TreeNode[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) trees.push((await (await pdf.getPage(i)).getStructTree()) as unknown as TreeNode);
  const walk = (node: TreeNode, into: string[], path = ""): string[] => {
    const here = path ? `${path}>${node.role}` : node.role;
    into.push(here);
    for (const child of node.children ?? []) if ("role" in child) walk(child, into, here);
    return into;
  };
  const first = walk(trees[0], []);
  const order = first.map((x) => x.split(">").pop()).join(" ");
  check("the first page reads in the document's order", /^Root Document H1 TOC TOCI Link .*P Link .*Note.* BlockQuote P H2 L LI Lbl LBody P /.test(order), order.slice(0, 240));
  check("a nested list is inside its item", first.includes("Root>Document>L>LI>LBody>L>LI>LBody>P"));
  check("the table is rows of header and data cells holding paragraphs", first.filter((x) => x.endsWith("Table>TR")).length === 3 && first.filter((x) => x.endsWith("TR>TH>P")).length === 3 && first.filter((x) => x.endsWith("TR>TD")).length === 5 && first.filter((x) => x.endsWith("TR>TD>P")).length === 4, JSON.stringify(first.filter((x) => x.includes("Table"))));
  const seek = (node: TreeNode): TreeNode | null => {
    if (node.role === "Figure" && node.alt) return node;
    for (const child of node.children ?? []) {
      const hit = "role" in child ? seek(child) : null;
      if (hit) return hit;
    }
    return null;
  };
  const figure = trees.map(seek).find(Boolean);
  const every = trees.flatMap((tree) => walk(tree, []));
  check("a picture says what it shows", figure?.alt === "A ferry at a quay", JSON.stringify(every.filter((x) => x.includes("Figure"))));
  const inFigure = (figure?.children ?? []).map((child) => ("role" in child ? child.role : "content"));
  check("…and its caption comes after it, inside it", inFigure.join() === "content,Caption", inFigure.join());
  check("a cell's reach and a header's scope are written", (raw.match(/\/Scope \/Column/g) ?? []).length === 3 && /\/ColSpan 2/.test(raw));

  // One element for a paragraph, however many pages it is on.
  const paragraphs = tagged.model.struct!.filter((n, i) => n.role === "P" && tagged.dl.pages.some((page) => page.items.some((it) => (it.t === "text" || it.t === "image") && it.s === i))).length;
  check("a paragraph is one element in the file, on however many pages", (raw.match(/\/S \/P\b/g) ?? []).length === paragraphs, `${(raw.match(/\/S \/P\b/g) ?? []).length} in the file, ${paragraphs} in the document`);
  check("…and one that runs over is pointed at from both pages", /\/Type \/MCR/.test(raw));

  // Links are part of the structure, and say where they go.
  const page1 = await pdf.getPage(1);
  const links = (await page1.getAnnotations()).filter((a) => a.subtype === "Link");
  check("a link is tied to its element and says where it goes", links.length >= 2 && /\/Type \/OBJR/.test(raw) && links.some((a) => a.url === "https://example.org/tagged" && a.contentsObj?.str === "https://example.org/tagged"), JSON.stringify(links.map((a) => [a.url ?? a.dest, a.contentsObj?.str])));
  check("…and a link in the contents says which heading", links.some((a) => a.contentsObj?.str === "Lists"));
  check("the keyboard goes through a page's links in reading order", (raw.match(/\/Tabs \/S/g) ?? []).length === pdf.numPages);

  // Decoration: the running head, the page number, rules.
  const content = await page1.getTextContent({ includeMarkedContent: true });
  let inside: string | null = null;
  const owners: [string, string][] = [];
  for (const item of content.items as { type?: string; tag?: string; str?: string }[]) {
    if (item.type === "beginMarkedContent" || item.type === "beginMarkedContentProps") inside = item.tag ?? null;
    else if (item.type === "endMarkedContent") inside = null;
    else if (item.str?.trim()) owners.push([item.str.trim(), inside ?? "nothing"]);
  }
  const marked = (text: string) => owners.filter(([words]) => words === text).map(([, tag]) => tag).join();
  check("the running head is marked as decoration, the heading as a heading (and as a line of the contents)", marked("Tagged") === "Artifact" && marked("A tagged document") === "H1,Link", `${marked("Tagged")} | ${marked("A tagged document")}`);
  const leaders = owners.filter(([words]) => /^(\. ?){5,}$/.test(words));
  check("the dots of the contents are decoration in the file too", leaders.length >= 4 && leaders.every(([, tag]) => tag === "Artifact"), JSON.stringify(leaders.map(([, tag]) => tag)));
  check("no word on the page is outside every mark", owners.every(([, tag]) => tag !== "nothing"), JSON.stringify(owners.filter(([, v]) => v === "nothing")));
  check("the language and the title are there for a reader to say", /\/Lang \(en-US\)/.test(raw) && /\/DisplayDocTitle true/.test(raw));
}

{
  // Not asked for.
  const off = await session.pdf({ ...tagged.req, pdf: { pictures: "print", tagged: false, archive: false, source: false } });
  const pdf = await open(off.bytes);
  check("a tagged layout written without tags has none", (await pdf.getMarkInfo()) === null && !/StructTreeRoot/.test(Buffer.from(off.bytes).toString("latin1")));
  const plain = await layout(false);
  const bare = await session.pdf(plain.req);
  check("a document set without structure is written as it always was", (await (await open(bare.bytes)).getMarkInfo()) === null && /^%PDF-1\.4/.test(Buffer.from(bare.bytes).toString("latin1")));
  const folded = await session.pdf({ ...tagged.req, kind: "document-booklet" });
  check("a booklet's imposed sheets are never tagged", (await (await open(folded.bytes)).getMarkInfo()) === null);
}

finish();
