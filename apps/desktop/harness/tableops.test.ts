// Table tools: lines on the selected cells' sides (and the side facing
// each), five table looks, rows sorted by a column, a table split in two,
// text set out as a table and a table back to text. Each is one Undo.
// Then a row's least height and keeping it whole, where a cell's words
// sit, and where a table sits: on screen, in print and in Word files.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";

import { applyTableLook, setCellBorders } from "../src/editor/tables/borders";
import { sortRows, splitTable, tableToText, textToTable } from "../src/editor/tables/convert";
import { docContentExtensions } from "../src/editor/schema/content";
import { cellEdges } from "../src/editor/schema/sanitize";
import { downlevelJson } from "../src/editor/schema/downlevel";
import { levels } from "../src/editor/schema/levels";
import { curTable, distributeColumns, distributeRows, setCellVAlign, setRowAttrs, setTableAttrs } from "../src/editor/tables/Table";
import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";

const p = (text: string): JSONContent => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) });
const cell = (text: string, attrs: Record<string, unknown> = {}): JSONContent => ({ type: "tableCell", attrs, content: [p(text)] });
const row = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
const table = (rows: JSONContent[], attrs: Record<string, unknown> = {}): JSONContent => ({ type: "table", attrs, content: rows });
const make = (content: JSONContent[]) => new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content } });

/** Each cell's own lines, by row and column. */
const edges = (e: Editor) => {
  const t = e.state.doc.firstChild!;
  const map = TableMap.get(t);
  const out: string[][] = [];
  for (let r = 0; r < map.height; r += 1) {
    out.push([]);
    for (let c = 0; c < map.width; c += 1) {
      const node = t.nodeAt(map.map[r * map.width + c])!;
      const ed = cellEdges(node.attrs.bdr) ?? {};
      out[r].push((["t", "r", "b", "l"] as const).filter((s) => ed[s] && ed[s]!.w > 0).join("") || "-");
    }
  }
  return out.map((r) => r.join(" ")).join(" | ");
};
/** Select cells by row and column, corner to corner. */
const cells = (e: Editor, r1: number, c1: number, r2: number, c2: number) => {
  const t = e.state.doc.firstChild!;
  const map = TableMap.get(t);
  const at = (r: number, c: number) => 1 + map.map[r * map.width + c];
  e.view.dispatch(e.state.tr.setSelection(CellSelection.create(e.state.doc, at(r1, c1), at(r2, c2))));
};
const grid = () => table([row(cell("a"), cell("b"), cell("c")), row(cell("d"), cell("e"), cell("f")), row(cell("g"), cell("h"), cell("i"))]);
const LINE = { w: 1, color: "#000000" };

// ------------------------------------------------------------ borders

{
  const e = make([grid()]);
  cells(e, 0, 0, 1, 1);
  setCellBorders(e, "outside", LINE);
  check("outside: the selection's edge, and the sides facing it", edges(e) === "tl tr l | bl rb l | t t -", edges(e));
  e.destroy();
}
{
  const e = make([grid()]);
  cells(e, 0, 0, 1, 1);
  setCellBorders(e, "inside", LINE);
  check("inside: the lines between the selected cells", edges(e) === "rb bl - | tr tl - | - - -", edges(e));
  e.destroy();
}
{
  const e = make([grid()]);
  e.commands.setTextSelection(e.state.doc.textContent.indexOf("e") + 1);
  e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(17))));
  setCellBorders(e, "top", LINE);
  check("one side of the cell the caret is in, and its neighbour's facing side", edges(e) === "b - - | t - - | - - -", edges(e));
  setCellBorders(e, "none", LINE);
  const t = e.state.doc.firstChild!;
  const mid = cellEdges(t.nodeAt(TableMap.get(t).map[3])!.attrs.bdr)!;
  check("none: every side said to have no line", (["t", "r", "b", "l"] as const).every((s) => mid[s]?.w === 0));
  e.commands.undo();
  check("each is one Undo", edges(e) === "b - - | t - - | - - -", edges(e));
  e.destroy();
}

// ------------------------------------------------------------ looks

{
  const e = make([table([row(cell("Name"), cell("Price")), row(cell("Pear"), cell("2", { bdr: "t:1:#ff0000" })), row(cell("Plum"), cell("3")), row(cell("Fig"), cell("4"))])]);
  e.commands.setTextSelection(5);
  applyTableLook(e, "banded");
  const t = e.state.doc.firstChild!;
  const bgs: string[] = [];
  t.forEach((r) => bgs.push(String(r.firstChild!.attrs.bg)));
  check("a look: its lines and its header row", t.attrs.lines === "rows" && t.attrs.head === true);
  check("its header shaded, and every other row", bgs.join(" ") === "#d9e2f3 null #f2f2f2 null", bgs.join(" "));
  check("and each cell's own lines taken away", !JSON.stringify(e.getJSON()).includes("#ff0000"));
  applyTableLook(e, "grid");
  check("back to a plain grid", e.state.doc.firstChild!.attrs.lines === null && !JSON.stringify(e.getJSON()).includes('"bg":"#'));
  e.destroy();
}

// ------------------------------------------------------------ sort

{
  const e = make([table([row(cell("Fruit"), cell("Count")), row(cell("Pear"), cell("10")), row(cell("apple"), cell("2")), row(cell("10"), cell("x")), row(cell("Fig"), cell("1,250"))], { head: true })]);
  const col0 = () => {
    const out: string[] = [];
    e.state.doc.firstChild!.forEach((r) => out.push(r.firstChild!.textContent));
    return out.join(" ");
  };
  e.commands.setTextSelection(4);
  check("sort A to Z: the header stays, numbers first by value, then words by the alphabet", sortRows(e, 1) && col0() === "Fruit 10 apple Fig Pear", col0());
  check("Z to A", sortRows(e, -1) && col0() === "Fruit Pear Fig apple 10", col0());
  // The second column: 1,250 is a thousand and more.
  const second = () => {
    const out: string[] = [];
    e.state.doc.firstChild!.forEach((r) => out.push(r.lastChild!.textContent));
    return out.join(" ");
  };
  e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(12))));
  check("by the column the caret is in", sortRows(e, 1) && second() === "Count 2 10 1,250 x", second());
  e.commands.undo();
  check("one Undo", second() !== "Count 2 10 1,250 x");
  e.destroy();

  const spanned = make([table([row(cell("a", { rowspan: 2 }), cell("b")), row(cell("c")), row(cell("d"), cell("e"))])]);
  spanned.commands.setTextSelection(4);
  check("a table with a cell spanning rows isn't sorted", !sortRows(spanned, 1));
  spanned.destroy();
}

// ------------------------------------------------------------ split

{
  const e = make([grid()]);
  e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(17))));
  check("a table splits before the caret's row", splitTable(e) && e.state.doc.childCount >= 3 && e.state.doc.child(0).type.name === "table" && e.state.doc.child(1).type.name === "paragraph" && e.state.doc.child(2).type.name === "table");
  check("into its rows above and the rest", e.state.doc.child(0).childCount === 1 && e.state.doc.child(2).childCount === 2);
  e.commands.setTextSelection(4);
  check("not at its first row", !splitTable(e));
  e.destroy();
}

// ------------------------------------------------------------ text and tables

{
  const e = make([p("Name\tPrice\tCount"), p("Pear\t2"), p("After")]);
  e.commands.setTextSelection({ from: 2, to: 20 });
  check("lines with tabs become a table, a row each, a cell at each tab", textToTable(e) && e.state.doc.firstChild!.type.name === "table" && e.state.doc.firstChild!.childCount === 2 && e.state.doc.firstChild!.firstChild!.childCount === 3);
  check("short lines get empty cells", e.state.doc.firstChild!.child(1).lastChild!.textContent === "");
  check("what wasn't selected stays as it was", e.state.doc.lastChild!.textContent === "After" || e.state.doc.child(1).textContent === "After");
  check("and back to text: cells parted by tabs", tableToText(e) && e.state.doc.firstChild!.textContent === "Name\tPrice\tCount" && e.state.doc.child(1).textContent === "Pear\t2\t");
  e.destroy();

  const c = make([p("a, b, c"), p("d, e")]);
  c.commands.setTextSelection({ from: 1, to: 12 });
  check("without tabs, commas part the cells", textToTable(c) && c.state.doc.firstChild!.firstChild!.child(1).textContent === "b");
  c.commands.setTextSelection(5);
  check("not inside a table", !textToTable(c));
  c.destroy();
}

// ------------------------------------------------------------ rows, cells and place (level 4)

/** The caret in a cell, by row and column. */
const caretIn = (e: Editor, r: number, c: number) => {
  const t = e.state.doc.firstChild!;
  const map = TableMap.get(t);
  e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(1 + map.map[r * map.width + c] + 2))));
};
const rowsOf = (e: Editor) => {
  const out: Record<string, unknown>[] = [];
  e.state.doc.firstChild!.forEach((r) => out.push(r.attrs));
  return out;
};

{
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "table",
        attrs: { align: "center", cols: "100 100" },
        content: [
          { type: "tableRow", attrs: { h: 40, keep: true }, content: [cell("a", { va: "middle" }), cell("b")] },
          row(cell("c"), cell("d", { va: "bottom" })),
        ],
      },
    ],
  };
  const e = make(doc.content!);
  const html = e.getHTML();
  check("a row's least height is said on it and drawn", html.includes('data-h="40"') && html.includes("height: 40pt"), html.slice(0, 400));
  check("…and a row kept whole", html.includes('data-keep="1"'));
  check("a cell's words in the middle or at the foot", html.includes('data-va="middle"') && html.includes('data-va="bottom"'));
  const shown = e.view.dom.querySelector("table") as HTMLTableElement;
  check("a table in the middle of the page has room either side", shown.getAttribute("data-align") === "center" && shown.style.marginLeft === "auto" && shown.style.marginRight === "auto", shown.getAttribute("style"));
  check("the table's own words need level 4", levels.ofJson(e.getJSON()) === 4);
  const plainTable = make([grid()]);
  check("a table without them stays at level 2", levels.ofJson(plainTable.getJSON()) === 2);
  plainTable.destroy();
  const down = downlevelJson(e.getJSON(), 3, getSchema(docContentExtensions()));
  const t3 = down.content![0];
  const r3 = t3.content![0];
  check(
    "for level 3 they are dropped and the table kept",
    t3.type === "table" && t3.attrs?.cols === "100 100" && !("align" in (t3.attrs ?? {})) && !("h" in (r3.attrs ?? {})) && !("keep" in (r3.attrs ?? {})) && !("va" in (r3.content![0].attrs ?? {})),
    JSON.stringify(t3).slice(0, 300),
  );

  caretIn(e, 1, 0);
  const now = curTable(e)!;
  check("the Table tab knows the caret's row and cell", now.align === "center" && now.rowH === null && !now.keep && now.va === null);
  caretIn(e, 0, 0);
  check("…and another's", curTable(e)!.rowH === 40 && curTable(e)!.keep && curTable(e)!.va === "middle");
  e.destroy();
}

{
  const e = make([grid()]);
  caretIn(e, 1, 1);
  setRowAttrs(e, { h: 30 });
  check("a height for the caret's row alone", JSON.stringify(rowsOf(e).map((a) => a.h)) === "[null,30,null]", JSON.stringify(rowsOf(e)));
  cells(e, 0, 0, 2, 0);
  setRowAttrs(e, { keep: true });
  check("kept: every row the selection touches", rowsOf(e).every((a) => a.keep === true));
  setRowAttrs(e, { keep: null, h: null });
  check("…and back, as one each", rowsOf(e).every((a) => a.keep === null && a.h === null));
  cells(e, 0, 1, 1, 2);
  setCellVAlign(e, "bottom");
  const vas: string[] = [];
  e.state.doc.firstChild!.descendants((n) => {
    if (n.type.name === "tableCell") vas.push(String(n.attrs.va));
    return n.type.name !== "tableCell";
  });
  check("the selected cells' words at the foot", vas.join(" ") === "null bottom bottom null bottom bottom null null null", vas.join(" "));

  // Same height: the tallest of them as drawn (a stand-in layout).
  caretIn(e, 0, 0);
  const trs = [...e.view.dom.querySelectorAll("tr")] as HTMLElement[];
  trs.forEach((tr, i) => {
    tr.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: [20, 48, 30][i], width: 100, height: [20, 48, 30][i], toJSON: () => ({}) });
  });
  distributeRows(e);
  check("the same height for every row: the tallest, as a least", JSON.stringify(rowsOf(e).map((a) => a.h)) === "[36,36,36]", JSON.stringify(rowsOf(e).map((a) => a.h)));
  e.destroy();
}

{
  const e = make([table([row(cell("a"), cell("b"), cell("c"))], { cols: "100 50 30" })]);
  caretIn(e, 0, 0);
  distributeColumns(e);
  check("the same width for every column, sharing what they had", e.state.doc.firstChild!.attrs.cols === "60 60 60", String(e.state.doc.firstChild!.attrs.cols));
  setTableAttrs(e, { ind: 36 });
  const shown = e.view.dom.querySelector("table") as HTMLTableElement;
  // (jsdom keeps no min() in a style: the node's own markup says it.)
  const spec = JSON.stringify(e.state.schema.nodes.table.spec.toDOM!(e.state.doc.firstChild!));
  check("a table set in from the left", shown.style.marginLeft === "36pt" && spec.includes("width: min(100% - 36pt, 180pt); margin-left: 36pt"), spec.slice(0, 200));
  setTableAttrs(e, { align: "right", ind: null });
  check("…or at the right", shown.style.marginLeft === "auto" && shown.style.marginRight === "");
  e.destroy();
}

// In print.
const session = new TypesetSession();
const set = async (content: JSONContent[]) => {
  const model = buildDocModel({ type: "doc", content }, { title: "Tables", author: "", date: "", settings: { ...DEFAULT_SETTINGS, bodyFont: "mono", bodySize: 12 } });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const { dl } = await session.layout({ kind: "document", doc: model, families: model.families, images: [] } as DocRequest);
  return dl;
};
const textsOf = (dl: Awaited<ReturnType<typeof set>>) => dl.pages.map((pg) => pg.items.filter((it): it is DLText => it.t === "text"));
const find = (dl: Awaited<ReturnType<typeof set>>, word: string) => {
  for (const [i, list] of textsOf(dl).entries()) {
    const at = list.find((x) => x.text === word);
    if (at) return { page: i, x: at.x, y: at.y };
  }
  return null;
};

{
  const dl = await set([
    {
      type: "table",
      attrs: { cols: "120 120 120" },
      content: [
        { type: "tableRow", attrs: { h: 100 }, content: [cell("top"), cell("mid", { va: "middle" }), cell("foot", { va: "bottom" })] },
        row(cell("next"), cell(""), cell("")),
      ],
    },
  ]);
  const top = find(dl, "top")!;
  const mid = find(dl, "mid")!;
  const foot = find(dl, "foot")!;
  const next = find(dl, "next")!;
  check("a row at least as tall as it says", next.y - top.y >= 100 - 0.5, JSON.stringify({ top, next }));
  check("a cell's words in the middle of a taller row", mid.y - top.y > 30 && mid.y - top.y < 50, JSON.stringify({ top, mid }));
  check("…and at its foot", foot.y - top.y > 65 && foot.y - top.y < 95 && Math.abs(foot.y - top.y - 2 * (mid.y - top.y)) < 1, JSON.stringify({ top, mid, foot }));
}

{
  const base = (await set([table([row(cell("left"), cell("x"))], { cols: "100 100" })]));
  const left = find(base, "left")!;
  const mid = find(await set([table([row(cell("left"), cell("x"))], { cols: "100 100", align: "center" })]), "left")!;
  const right = find(await set([table([row(cell("left"), cell("x"))], { cols: "100 100", align: "right" })]), "left")!;
  const ind = find(await set([table([row(cell("left"), cell("x"))], { cols: "100 100", ind: 36 })]), "left")!;
  check("a table at the right of the text", right.x - left.x > 150 && right.y === left.y, JSON.stringify({ left, right }));
  check("…in its middle", Math.abs(2 * (mid.x - left.x) - (right.x - left.x)) < 0.5, JSON.stringify({ left, mid, right }));
  check("…set in from the left", Math.abs(ind.x - left.x - 36) < 0.5, JSON.stringify({ left, ind }));
}

{
  // Filler that leaves room for three lines at the foot of the first page.
  const probe = await set(Array.from({ length: 80 }, (_, i) => p(`filler line ${i + 1}`)));
  const onFirst = textsOf(probe)[0].filter((x) => x.text.startsWith("filler")).length;
  const fill = Array.from({ length: onFirst - 3 }, (_, i) => p(`filler line ${i + 1}`));
  const tall = (keep: boolean, lines: number): JSONContent => ({
    type: "table",
    content: [{ type: "tableRow", ...(keep ? { attrs: { keep: true } } : {}), content: [{ type: "tableCell", attrs: {}, content: Array.from({ length: lines }, (_, i) => p(`k${i + 1}`)) }] }],
  });
  const cut = await set([...fill, tall(false, 12)]);
  const whole = await set([...fill, tall(true, 12)]);
  check("a row that will not fit is cut where the page ends", find(cut, "k1")!.page === 0 && find(cut, "k12")!.page === 1, JSON.stringify([find(cut, "k1"), find(cut, "k12")]));
  check("…and kept whole it goes to the next page", find(whole, "k1")!.page === 1 && find(whole, "k12")!.page === 1, JSON.stringify([find(whole, "k1"), find(whole, "k12")]));
  const huge = await set([tall(true, 90)]);
  check("a kept row taller than a page is cut all the same", find(huge, "k1")!.page === 0 && find(huge, "k90")!.page >= 1);
}

// In Word.
{
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "table",
        attrs: { cols: "100 100", align: "center" },
        content: [{ type: "tableRow", attrs: { h: 60, keep: true }, content: [cell("a", { va: "middle" }), cell("b", { va: "bottom" })] }, row(cell("c"), cell("d"))],
      },
      p("between"),
      table([row(cell("in"), cell("x"))], { cols: "100 100", ind: 36 }),
    ],
  };
  const written = await writeDocx(doc, { title: "Tables", format: "none" });
  const zip = await JSZip.loadAsync(written.bytes);
  const main = await zip.file("word/document.xml")!.async("string");
  check("Word gets the table's place", main.includes('<w:jc w:val="center"/>') && main.includes('<w:tblInd w:w="720" w:type="dxa"/>'));
  check("…a row's least height and keeping", main.includes('<w:cantSplit/><w:trHeight w:val="1200" w:hRule="atLeast"/>'), main.slice(main.indexOf("<w:trPr>"), main.indexOf("<w:trPr>") + 120));
  check("…and where a cell's words sit", main.includes('<w:vAlign w:val="center"/>') && main.includes('<w:vAlign w:val="bottom"/>'));
  const back = (await readDocx(written.bytes)).content;
  const tables = (back.content ?? []).filter((n) => n.type === "table");
  const [first, second] = tables;
  check(
    "read back as they were",
    first?.attrs?.align === "center" &&
      first.content?.[0].attrs?.h === 60 &&
      first.content?.[0].attrs?.keep === true &&
      first.content?.[0].content?.[0].attrs?.va === "middle" &&
      first.content?.[0].content?.[1].attrs?.va === "bottom" &&
      !first.content?.[1].attrs &&
      second?.attrs?.ind === 36,
    JSON.stringify(tables).slice(0, 700),
  );

  // Files from elsewhere: a height with no rule is a least too, "auto"
  // is none, and a few points in is a file lining up its words.
  const other = main.replace(' w:hRule="atLeast"', "").replace('<w:tblInd w:w="720"', '<w:tblInd w:w="108"');
  zip.file("word/document.xml", other);
  const again = (await readDocx(await zip.generateAsync({ type: "uint8array" }))).content;
  const [a2, b2] = (again.content ?? []).filter((n) => n.type === "table");
  check("a Word height without its rule is a least", a2?.content?.[0].attrs?.h === 60, JSON.stringify(a2?.content?.[0].attrs));
  check("a table a few points in is at the left", b2 && b2.attrs?.ind === undefined, JSON.stringify(b2?.attrs));
  zip.file("word/document.xml", main.replace('w:hRule="atLeast"', 'w:hRule="auto"'));
  const auto = (await readDocx(await zip.generateAsync({ type: "uint8array" }))).content;
  check("…and \"auto\" is no height at all", !(auto.content ?? []).find((n) => n.type === "table")?.content?.[0].attrs?.h);
}

finish();
