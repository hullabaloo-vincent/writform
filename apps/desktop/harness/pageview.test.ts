// Page view, as printed: the layout engine says where each page of the
// document begins, and the editor marks those places on the sheet — in
// the middle of a paragraph, before a list, between two rows of a table.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";

import { DEFAULT_SETTINGS, pageSpecFor } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest, type PageMap } from "../src/book/engine/run";
import type { DisplayList, DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { scriptedAsDocument } from "../src/doclayout/scripted";
import { Fragment, Slice } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { pace } from "../src/doclayout/usePageMap";
import { breakSpace, carryAcross, marginGive, pageRoom, Paginate, reflowPagination, resolvePageStart, tableColumns, type PageLayoutResult, type PageMapFor } from "../src/editor/Paginate";
import { docContentExtensions } from "../src/editor/schema/content";
import { prng } from "./manuscript";

// (jsdom lays nothing out; the paginator only needs the observer to exist.)
(globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const WORDS = "the of and a to in is that it was for on are as with his they at be this from have or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over river window morning silence letter garden winter harbour station lantern whisper shoulder evening remember beneath against between although perhaps suddenly afterwards understanding extraordinary conversation".split(" ");
const rand = prng(23);
const prose = (words: number): string => {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const s = out.join(" ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
};
const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const cell = (text: string): JSONContent => ({ type: "tableCell", content: [p(null, t(text))] });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const session = new TypesetSession();
async function pagesOf(doc: JSONContent, settings = DEFAULT_SETTINGS, virtual = 0): Promise<{ map: PageMap; dl: DisplayList }> {
  const model = buildDocModel(doc, { title: "Pages", settings, ...(virtual ? { virtual } : {}) });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req: DocRequest = { kind: "document", doc: model, families: model.families, images: [] };
  return { map: await session.pageMap(req), dl: (await session.layout(req)).dl };
}
/** The first words set on a page (a list's marker aside). */
const firstWord = (dl: DisplayList, page: number, top = DEFAULT_SETTINGS.mt * 72 - 1): string => {
  const texts = dl.pages[page].items.filter((it): it is DLText => it.t === "text" && it.y > top && it.y < dl.trim.h - 72 + 1).sort((a, b) => a.y - b.y || a.x - b.x);
  const first = texts.find((it) => !/^(?:[•◦▪]|\d+[.)]|[a-z][.)])$/.test(it.text)) ?? texts[0];
  return first.text.split(" ")[0].replace(/[0-9]+$/, "");
};

const content: JSONContent[] = [{ type: "heading", attrs: { level: 1 }, content: [t("Pages, as printed")] }];
for (let i = 0; i < 30; i += 1) {
  if (i % 8 === 3) content.push({ type: "bulletList", content: [item(p(null, t(prose(80)))), item(p(null, t(prose(120))))] });
  else if (i === 17) content.push({ type: "table", content: Array.from({ length: 36 }, (_, r) => ({ type: "tableRow", content: [cell(`Row ${r + 1}`), cell(prose(10))] })) });
  else content.push(p(null, t(prose(90)), t(` ${prose(70)}`, "italic")));
}

let layoutSeen: PageLayoutResult | null = null;
let mapNow: PageMapFor | "pending" | null = null;
let specOn = true;
// (The paginator measures against the sheet the editor sits on.)
const sheet = mountPoint();
sheet.className = "wf-page";
const editor = new Editor({
  element: sheet,
  extensions: [
    ...docContentExtensions(),
    Paginate.configure({
      getSpec: () => (specOn ? pageSpecFor("none", DEFAULT_SETTINGS) : null),
      getMap: () => mapNow,
      onLayout: (result) => {
        layoutSeen = result;
      },
    }),
  ],
  content: { type: "doc", content },
});
const spacers = () => [...editor.view.dom.querySelectorAll<HTMLElement>(".wf-pg-space")];
/** What everything else that listens to the editor hears of (the ribbon,
 *  the menus: each redraws for every one). */
let heard = 0;
editor.on("transaction", () => {
  heard += 1;
});

await wait(200);
check("with no map yet, page view is the simple one: nothing is marked in the text", spacers().length === 0 && layoutSeen !== null);

const { map, dl } = await pagesOf(editor.getJSON());
check("the engine says where every page begins", map.pages === dl.pages.length && map.pages >= 6 && map.starts.every((s) => s !== null), `${map.pages} pages`);
const kinds = map.starts.slice(1).map((s) => resolvePageStart(editor.state.doc, s!)?.kind);
check("pages begin inside paragraphs, before blocks and between a table's rows", kinds.includes("inline") && kinds.includes("row") && kinds.every((k) => k !== undefined), kinds.join(" "));

mapNow = { ...map, doc: editor.state.doc };
heard = 0;
reflowPagination(editor);
check("asking for a re-measure dispatches nothing by itself", heard === 0);
await wait(250);
const marks = spacers();
check("the spacers of a new map are put in with one transaction", heard === 1, String(heard));
check("a spacer is put where each page after the first begins", marks.length === map.pages - 1, `${marks.length} spacers for ${map.pages} pages`);
check("…and the sheet reports the engine's own count of pages", layoutSeen?.pages === map.pages && layoutSeen.bands.length === map.pages - 1, JSON.stringify(layoutSeen && [layoutSeen.pages, layoutSeen.bands.length]));
check("each is sized (never less than the gap between two sheets)", marks.every((el) => parseFloat((el.tagName === "TR" ? (el.firstElementChild as HTMLElement) : el).style.height) >= 40), marks.map((el) => el.style.height).slice(0, 3).join(" "));

// A page that turns between two rows of a table: the spacer is a row of the
// table, and must be exactly as wide as the table is. (It once claimed a
// hundred columns — and a table told it has a hundred shares its width
// among a hundred: the real ones shrank to slivers.)
{
  const rows = marks.filter((el) => el.tagName === "TR");
  const spans = rows.map((row) => (row.firstElementChild as HTMLTableCellElement).colSpan);
  check("a spacer between a table's rows spans the table's columns, no more", rows.length > 0 && spans.every((n) => n === 2), spans.join(" "));
  const tables = [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [p(null, t("wide"))] }, cell("c")] }];
  const node = editor.schema.nodeFromJSON({ type: "table", content: tables });
  check("…counting a merged cell as the columns it covers", tableColumns(node) === 3);
}

// Between two pages the sheet shows what paper has there.
{
  // Half an inch of the page left, one-inch margins.
  const space = breakSpace(48, 96, 96);
  check("between two pages: the rest of the page, its bottom margin, the gap, the next page's top margin", space.height === 48 + 96 + 40 + 96 && space.bar === 48 + 96);
  check("a page that is full still gets both margins around the gap", breakSpace(0, 96, 72).height === 96 + 40 + 72 && breakSpace(0, 96, 72).bar === 96);
  check("…so the next page's text never starts right under the gap", breakSpace(0, 96, 96).height - breakSpace(0, 96, 96).bar - 40 === 96);
  check("the sheet says how far under each gap the text begins", typeof layoutSeen?.lead === "number");
}

// The gaps are the paginator's own drawing, on the sheet (not something the
// editor's React tree renders again each time the text moves).
{
  const gaps = [...sheet.querySelectorAll<HTMLElement>(".wf-page-guides > .wf-page-gap")];
  check("a gap is drawn on the sheet for each page after the first", gaps.length === map.pages - 1 && gaps.every((el) => el.style.top !== "" && el.style.height === "40px"), String(gaps.length));
  check("…each saying which page begins under it", gaps.map((el) => el.textContent).join("|") === Array.from({ length: map.pages - 1 }, (_, i) => `Page ${i + 2}`).join("|"));
  check("…and the first page is labelled", sheet.querySelector(".wf-page-guides > .wf-page-num-first")?.textContent === "Page 1");
  check("the last page's fill is set on the sheet", /^\d+(\.\d+)?px$/.test(sheet.style.getPropertyValue("--wfd-fill")), sheet.style.getPropertyValue("--wfd-fill"));
  check("the gaps are outside the text (nothing of them is in the editor)", !editor.view.dom.querySelector(".wf-page-guides"));
  // An answer that says what is already shown: no transaction at all.
  heard = 0;
  mapNow = { ...map, doc: editor.state.doc };
  reflowPagination(editor);
  await wait(120);
  check("a new map with every page where it was changes nothing in the editor", heard === 0 && spacers().length === map.pages - 1 && spacers()[0] === marks[0], String(heard));
}

// What follows each spacer in the editor is what the printed page begins with.
let wrong = "";
const inOrder = marks
  .map((el) => ({ el, pos: editor.view.posAtDOM(el.parentNode!, [...el.parentNode!.childNodes].indexOf(el)) }))
  .sort((a, b) => a.pos - b.pos);
inOrder.forEach(({ el, pos }, i) => {
  if (wrong) return;
  const word = firstWord(dl, i + 1);
  const doc = editor.state.doc;
  const after = doc.textBetween(pos, Math.min(doc.content.size, pos + 400), " ").trimStart();
  if (!after.startsWith(word)) wrong = `page ${i + 2} begins "${word}…" but its spacer (${el.tagName}) is before "${after.slice(0, 24)}…"`;
});
check("the text after each spacer is what its printed page begins with", wrong === "", wrong);
const inline = marks.filter((el) => el.classList.contains("wf-pg-inline"));
check("a break inside a paragraph is inside that paragraph", inline.length >= 2 && inline.every((el) => !!el.closest("p")) && inline.every((el) => el.previousSibling !== null), String(inline.length));
const rows = marks.filter((el) => el.tagName === "TR");
check("a break in a table is a row of its own between two rows", rows.length >= 1 && rows.every((el) => el.parentElement?.tagName === "TBODY" && el.previousElementSibling?.tagName === "TR"), String(rows.length));
check("nothing was added to the document itself", JSON.stringify(editor.getJSON().content?.length) === JSON.stringify(content.length) && !JSON.stringify(editor.getJSON()).includes("wf-pg"));

// Typing: the marks stay with their text until the engine answers again.
const firstInline = inOrder.find((m) => m.el.classList.contains("wf-pg-inline"))!;
const before = firstInline.pos;
editor.commands.insertContentAt(1, "Typed at the very start. ");
await wait(200);
const moved = editor.view.posAtDOM(firstInline.el.parentNode!, [...firstInline.el.parentNode!.childNodes].indexOf(firstInline.el));
check("typing above moves a spacer along with its text", moved === before + "Typed at the very start. ".length, `${before} → ${moved}`);
const staleSeen = spacers().length;
mapNow = { ...map, doc: editor.state.doc, starts: map.starts.map((s) => (s ? { ...s } : s)) };
// (A map made for the text before the edit: not for this document.)
const stale: PageMapFor = { ...map, doc: null as never };
mapNow = stale;
reflowPagination(editor);
await wait(200);
check("a map made for an earlier text isn't applied", spacers().length === staleSeen && spacers()[0] === marks[0]);
const fresh = await pagesOf(editor.getJSON());
mapNow = { ...fresh.map, doc: editor.state.doc };
reflowPagination(editor);
await wait(250);
check("the next answer moves the breaks to where they now fall", spacers().length === fresh.map.pages - 1 && layoutSeen?.pages === fresh.map.pages, `${spacers().length} / ${fresh.map.pages}`);

// A change that comes through the shared document (someone else's typing, an
// undo) replaces the whole text in one step. The marks must come through it:
// they once all went, and every page break with them, until the engine had
// answered again.
{
  const doc = editor.state.doc;
  const kids: import("@tiptap/pm/model").Node[] = [];
  doc.forEach((node) => kids.push(node));
  // (As the binding does it: the nodes that didn't change are the same ones.)
  const added = editor.schema.nodes.paragraph.create(null, editor.schema.text("Typed by someone else."));
  const at = 2;
  const next = [...kids.slice(0, at), added, ...kids.slice(at)];
  const here = spacers();
  const placesBefore = here.map((el) => editor.view.posAtDOM(el.parentNode!, [...el.parentNode!.childNodes].indexOf(el)));
  editor.view.dispatch(editor.state.tr.replace(0, doc.content.size, new Slice(Fragment.from(next), 0, 0)).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
  const after = spacers();
  const placesAfter = after.map((el) => editor.view.posAtDOM(el.parentNode!, [...el.parentNode!.childNodes].indexOf(el)));
  check("a change from the shared document leaves every spacer on the sheet", after.length === here.length && after.every((el, i) => el === here[i]), `${here.length} → ${after.length}`);
  check("…each moved along by what was put in above it", placesAfter.every((pos, i) => pos === placesBefore[i] + added.nodeSize), `${placesBefore.slice(0, 2)} → ${placesAfter.slice(0, 2)}`);

  const move = carryAcross(doc, editor.state.doc);
  let start = 0;
  for (let i = 0; i < at; i += 1) start += kids[i].nodeSize;
  check("places before a change stay, places after it move by its size", move(1) === 1 && move(start) === start && move(start + 5) === start + 5 + added.nodeSize && move(doc.content.size) === doc.content.size + added.nodeSize);
  const cut = carryAcross(editor.state.doc, doc);
  check("a place inside what was taken out has nowhere to go", cut(start + 3) === null && cut(start + added.nodeSize + 5) === start + 5);
  check("two texts that are the same: every place is where it was", carryAcross(doc, doc)(77) === 77);
  await wait(60);
}

// While the text is ahead of the engine's pages the gaps hold still.
{
  // A page with room for 600 px of text; one-inch margins.
  const least = 600;
  const full = breakSpace(pageRoom(least, 600, null) - 600, 96, 96);
  // A line is typed onto it (26 px): the page keeps the room it had.
  const over = breakSpace(pageRoom(least, 626, 600) - 626, 96, 96);
  check("a line typed onto a full page: the gap stays where it was", 626 + over.bar === 600 + full.bar);
  check("…and so does the text of the page after it", 626 + over.height === 600 + full.height);
  check("…the line is in the bottom margin meanwhile", over.bar === 96 - 26);
  // The engine answers. Where the screen needs more than the paper, the page is as tall as its text.
  check("once the pages are worked out again, a page is as tall as its text needs", pageRoom(least, 626, null) === 626 && pageRoom(least, 480, null) === 600);
  // (The browser's lines are now and then one more than the engine's.)
  check("…but a line or so over goes into the bottom margin, and the page stands as tall as the rest", marginGive(96) === 48 && marginGive(48) === 24 && pageRoom(least, 626, null, 48) === 600 && pageRoom(least, 700, null, 48) === 652);
  check("text that has run past the margin too pushes the gap (it is never over the text)", breakSpace(-200, 96, 96).bar === 0 && breakSpace(-200, 96, 96).height === 40 + 96);
  check("a line taken out while typing: the gap stays as well", 574 + breakSpace(pageRoom(least, 574, 600) - 574, 96, 96).bar === 600 + full.bar);
}

// The same, on a sheet that is laid out (a stand-in for the browser's layout:
// each stretch of text has a height, each spacer the one it was given).
{
  const host = mountPoint();
  host.className = "wf-page";
  const paras = Array.from({ length: 6 }, (_, i) => p(null, t(`Paragraph ${i + 1}. ${prose(12)}`)));
  let held: PageMapFor | "pending" | null = "pending";
  let seen: PageLayoutResult | null = null;
  const small = new Editor({
    element: host,
    extensions: [...docContentExtensions(), Paginate.configure({ getSpec: () => pageSpecFor("none", DEFAULT_SETTINGS), getMap: () => held, onLayout: (r) => (seen = r) })],
    content: { type: "doc", content: paras },
  });
  const dom = small.view.dom as HTMLElement;
  dom.style.padding = "96px";
  // (What the stylesheet does: the sheet's bottom margin, and under it
  // whatever fills out the last page.)
  const setProperty = host.style.setProperty.bind(host.style);
  host.style.setProperty = (name: string, value: string | null, priority?: string) => {
    setProperty(name, value, priority);
    if (name === "--wfd-fill") dom.style.paddingBottom = `${96 + (parseFloat(value ?? "") || 0)}px`;
  };
  // Three pages of two paragraphs each.
  const pageH = 648; // pt: nine inches of text
  const mapFor = (): PageMapFor => {
    const starts: number[] = [];
    small.state.doc.forEach((_node, offset, index) => {
      if (index === 2 || index === 4) starts.push(offset);
    });
    return { doc: small.state.doc, pages: 3, starts: [{ pos: 0, inline: false }, ...starts.map((pos) => ({ pos, inline: false }))], bodyH: [pageH, pageH, pageH] };
  };
  held = mapFor();
  reflowPagination(small);
  await wait(60);
  const els = [...dom.querySelectorAll<HTMLElement>(".wf-pg-space")];
  check("(the small sheet has its two spacers)", els.length === 2);

  // The stand-in layout.
  const text = [700, 700, 700]; // px of text on each page
  const heightOf = (el: HTMLElement) => parseFloat(el.style.height) || 40;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  const topOf = (i: number) => {
    let y = 96;
    for (let k = 0; k <= i; k += 1) y += text[k] + (k < i ? heightOf(els[k]) : 0);
    return y;
  };
  els.forEach((el, i) => {
    el.getBoundingClientRect = () => rect(topOf(i), heightOf(el));
  });
  dom.getBoundingClientRect = () => rect(0, topOf(1) + heightOf(els[1]) + text[2] + 96 + (parseFloat(host.style.getPropertyValue("--wfd-fill")) || 0));
  const tops = () => [...host.querySelectorAll<HTMLElement>(".wf-page-gap")].map((el) => parseFloat(el.style.top));
  const ends = () => els.map((el, i) => topOf(i) + heightOf(el));

  reflowPagination(small);
  await wait(60);
  const scale = pageSpecFor("none", DEFAULT_SETTINGS)!;
  const least = (pageH / 72) * 96 * Math.min(4, ((scale.w - scale.ml - scale.mr) * 96) / 50);
  const gaps0 = tops();
  const ends0 = ends();
  check("each page is as tall as the paper (its text is shorter)", least > 700 && Math.abs(heightOf(els[0]) - (least - 700 + 96 + 40 + 96)) < 0.02, `${heightOf(els[0])} for ${least}`);
  check("the gap is under the page's bottom margin", gaps0.length === 2 && Math.abs(gaps0[0] - (96 + least + 96)) <= 1, gaps0.join(" "));

  // Typing on the first page: its text grows by a line.
  small.commands.insertContentAt(1, "A line more. ");
  text[0] += 26;
  await wait(60);
  check("typing: the spacer under the page gives up what the text took", Math.abs(heightOf(els[0]) - (least - 726 + 96 + 40 + 96)) < 0.02);
  check("…so the gaps are exactly where they were", tops().join(" ") === gaps0.join(" "), `${gaps0.join(" ")} → ${tops().join(" ")}`);
  check("…and nothing under the page has moved", ends().every((y, i) => Math.abs(y - ends0[i]) < 0.02));

  // The page runs over before the engine has answered: into its margin.
  text[0] = least + 30;
  small.commands.insertContentAt(1, "And more. ");
  await wait(60);
  check("a page that runs over while typing: the gaps still hold", tops().join(" ") === gaps0.join(" ") && ends().every((y, i) => Math.abs(y - ends0[i]) < 0.02), `${gaps0.join(" ")} → ${tops().join(" ")}`);
  check("…the last of its text is in the bottom margin for the moment", Math.abs(heightOf(els[0]) - (96 - 30 + 40 + 96)) < 0.02, String(heightOf(els[0])));

  // The engine answers for this text, and its pages are where they were. A
  // line or so over stays in the margin: the page stands where it stood.
  held = mapFor();
  reflowPagination(small);
  await wait(60);
  check("the engine has answered, the page is a line over: it stays as tall as the rest", tops().join(" ") === gaps0.join(" ") && Math.abs(heightOf(els[0]) - (96 - 30 + 40 + 96)) < 0.02, `${heightOf(els[0])} ${tops()[0]}`);
  // Much more than that, and the page is as tall as its text needs.
  text[0] = least + 80;
  small.commands.insertContentAt(1, "And a great deal more. ");
  await wait(60);
  check("(still typing: the gaps hold, the text is deep in the margin)", tops().join(" ") === gaps0.join(" ") && Math.abs(heightOf(els[0]) - (96 - 80 + 40 + 96)) < 0.02);
  held = mapFor();
  reflowPagination(small);
  await wait(60);
  check("a page that needs much more than the paper is made taller once the engine has answered", Math.abs(heightOf(els[0]) - (48 + 40 + 96)) < 0.02 && Math.abs(tops()[0] - (gaps0[0] + 32)) <= 1, `${heightOf(els[0])} ${tops()[0]}`);
  // The last page, the same: the foot of the sheet holds still.
  const foot0 = dom.getBoundingClientRect().bottom;
  const fillNow = () => parseFloat(host.style.getPropertyValue("--wfd-fill"));
  check("the last page is filled out to a whole sheet", Math.abs(fillNow() - (least - 700)) < 0.02, String(fillNow()));
  small.commands.insertContentAt(small.state.doc.content.size - 1, " More at the end.");
  text[2] += 26;
  await wait(60);
  check("typing on the last page: its fill gives up what the text took", Math.abs(fillNow() - (least - 726)) < 0.02 && Math.abs(dom.getBoundingClientRect().bottom - foot0) < 0.02);
  text[2] = least + 20;
  small.commands.insertContentAt(small.state.doc.content.size - 1, " And over.");
  await wait(60);
  check("the last page runs over while typing: the foot of the sheet holds still", Math.abs(fillNow() + 20) < 0.02 && Math.abs(dom.getBoundingClientRect().bottom - foot0) < 0.02, `${fillNow()}`);
  check("no one else heard of any of it but the count of pages", (seen as PageLayoutResult | null)?.pages === 3);
  small.destroy();
  check("closing the editor takes its gaps off the sheet", !host.querySelector(".wf-page-guides") && host.style.getPropertyValue("--wfd-fill") === "");
}

// A page that begins inside a table's row (the row is cut across pages): a
// spacer in each of its cells, the one that ended higher making up the
// difference so that both go on at the same height.
{
  const host = mountPoint();
  host.className = "wf-page";
  let held: PageMapFor | "pending" | null = "pending";
  const three = (name: string): JSONContent => ({ type: "tableCell", content: [1, 2, 3].map((n) => p(null, t(`${name} ${n}. ${prose(8)}`))) });
  const cut = new Editor({
    element: host,
    extensions: [...docContentExtensions(), Paginate.configure({ getSpec: () => pageSpecFor("none", DEFAULT_SETTINGS), getMap: () => held, onLayout: () => {} })],
    content: { type: "doc", content: [p(null, t("Before.")), { type: "table", content: [{ type: "tableRow", content: [three("Left"), three("Right")] }] }] },
  });
  const firsts: number[] = [];
  const seconds: number[] = [];
  cut.state.doc.descendants((node, pos, parent, index) => {
    if (node.type.name !== "paragraph" || parent?.type.name !== "tableCell") return;
    if (index === 0) firsts.push(pos);
    if (index === 1) seconds.push(pos);
  });
  const inCell = resolvePageStart(cut.state.doc, { pos: firsts[1], inline: false });
  check("a page that begins with a cell's first block begins inside that cell", inCell?.kind === "block" && inCell.pos === firsts[1], JSON.stringify(inCell));
  held = { doc: cut.state.doc, pages: 2, starts: [{ pos: 0, inline: false }, { pos: seconds[0], inline: false, also: [{ pos: seconds[1], inline: false }] }], bodyH: [648, 648] };
  reflowPagination(cut);
  await wait(60);
  const made = [...cut.view.dom.querySelectorAll<HTMLElement>(".wf-pg-space")];
  check("a row cut across pages has a spacer in each of its cells", made.length === 2 && made.every((el) => !!el.closest("td")) && made[0].closest("td") !== made[1].closest("td"), String(made.length));
  // (A stand-in for the layout: the left cell's text ends 60 px above the right one's.)
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  made[0].getBoundingClientRect = () => rect(500, parseFloat(made[0].style.height) || 40);
  made[1].getBoundingClientRect = () => rect(560, parseFloat(made[1].style.height) || 40);
  (cut.view.dom as HTMLElement).getBoundingClientRect = () => rect(0, 5000);
  reflowPagination(cut);
  await wait(60);
  const tall = made.map((el) => parseFloat(el.style.height));
  check("…the one that ended higher makes up the difference: both go on at the same height", Math.abs(tall[0] - tall[1] - 60) < 0.02 && Math.abs(500 + tall[0] - (560 + tall[1])) < 0.02, tall.join(" "));
  check("…and one gap is drawn for the page, not one for each cell", host.querySelectorAll(".wf-page-gap").length === 1);
  cut.destroy();
}

// How soon the engine is asked again, by what asking costs.
{
  const quick = pace(6);
  const slow = pace(260);
  check("a short document is asked about almost at once, and while the typing goes on", quick.quiet <= 50 && quick.longest <= 200);
  check("a long one in the pauses, and now and then all the same", slow.quiet === 350 && slow.longest > 1500 && slow.longest <= 2400);
  check("before anything is known of the cost it asks soon", pace(0).quiet === 40);
  check("a document that holds the page up to be read is only asked about in the pauses", pace(120, 40).longest === Infinity && pace(120, 40).quiet === 240 && pace(30, 8).longest === 240);
}

// While a first answer is awaited nothing is marked.
{
  let seen: PageLayoutResult | null | undefined;
  const host = mountPoint();
  host.className = "wf-page";
  const waiting = new Editor({
    element: host,
    extensions: [...docContentExtensions(), Paginate.configure({ getSpec: () => pageSpecFor("none", DEFAULT_SETTINGS), getMap: () => "pending", onLayout: (r) => (seen = r) })],
    content: { type: "doc", content },
  });
  await wait(200);
  check("while the first answer is on its way, nothing is marked (the simple view doesn't flash up)", waiting.view.dom.querySelectorAll(".wf-pg-space, .wf-pg-push").length === 0 && !seen);
  waiting.destroy();
}

// Back to the simple view; and off.
mapNow = null;
reflowPagination(editor);
await wait(300);
check("without a map the spacers go (the simple view pushes whole blocks instead)", spacers().length === 0 && layoutSeen !== null);
check("the simple view draws its gaps on the sheet too", !!sheet.querySelector(".wf-page-guides"));
specOn = false;
reflowPagination(editor);
await wait(200);
check("page view off: nothing marked, nothing reported", spacers().length === 0 && layoutSeen === null);
check("…and nothing is left drawn on the sheet", !sheet.querySelector(".wf-page-guides") && sheet.style.getPropertyValue("--wfd-fill") === "");

// A script: its pages are its format's, and a title put in for print isn't in the editor.
{
  const lines: JSONContent[] = Array.from({ length: 150 }, (_, i) => p({ element: i % 3 === 0 ? "character" : "dialogue" }, t(i % 3 === 0 ? `speaker ${i}` : `Line ${i} of the play, spoken aloud.`)));
  const play = scriptedAsDocument({ type: "doc", content: lines }, "stageplay", "A Play");
  const script = await pagesOf(play.doc, play.settings, play.virtual);
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: lines } });
  const second = script.map.starts[1];
  const at = second ? resolvePageStart(e.state.doc, second) : null;
  const word = firstWord(script.dl, 1, 71);
  check("a play's pages start at places in the editor's own text (the printed title isn't counted)", script.map.pages >= 3 && !!at && e.state.doc.textBetween(at.pos, at.pos + 60, " ").trim().toUpperCase().startsWith(word.toUpperCase()), `${JSON.stringify(second)} ${word} / ${at ? e.state.doc.textBetween(at.pos, at.pos + 30, " ") : ""}`);
}

finish();
