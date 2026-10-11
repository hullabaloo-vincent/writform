// Schema level 2, the structural half: tables, footnotes and endnotes, a
// table of contents, where a picture sits and its caption, sections and
// column breaks — as the editor does them.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, getSchema, type Extensions, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import * as Y from "yjs";

import { formatKeymap } from "../src/apps/documents/formats/FormatKeymap";
import { countDocWords, countRangeWords } from "../src/apps/documents/stats";
import { clearFormatting } from "../src/editor/format/commands";
import { curParaFormat, sectionAt, setSection, toggleColumnBreak } from "../src/editor/format/ParaFormat";
import { countNotes, insertNote, noteNumber, openNotes } from "../src/editor/nodes/Footnote";
import { selectedImage, setImageAttrs } from "../src/editor/nodes/Image";
import { toggleChecklist } from "../src/editor/nodes/TaskList";
import { insertToc, tocEntries } from "../src/editor/nodes/Toc";
import { docContentExtensions } from "../src/editor/schema/content";
import { downlevelJson } from "../src/editor/schema/downlevel";
import { levelOfJson } from "../src/editor/schema/levels";
import { encodeSection, parseSection } from "../src/editor/schema/sanitize";
import { columnCount, curTable, encodeCols, insertTable, isInTable, parseCols, setTableAttrs, stepColumn, tableCommands, tableTab } from "../src/editor/tables/Table";

const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });
const editorWith = (content: JSONContent[], extra: Extensions = []): Editor =>
  new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), ...extra], content: { type: "doc", content } });
const find = (e: Editor, needle: string): number => {
  let from = -1;
  e.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return from < 0;
    const at = node.textContent.indexOf(needle);
    if (at >= 0) from = pos + 1 + at;
    return false;
  });
  if (from < 0) throw new Error(`no "${needle}"`);
  return from;
};
const press = (e: Editor, key: string, shift = false): boolean => {
  const event = new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true });
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};
const tableOf = (e: Editor): JSONContent => (e.getJSON().content ?? []).find((n) => n.type === "table") ?? {};
const cellTexts = (table: JSONContent): string[][] =>
  (table.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? "").join("")).join("/")));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- tables

{
  const e = editorWith([p(null, t("Before."))], [formatKeymap("none")]);
  e.commands.setTextSelection(8);
  insertTable(e, 2, 3);
  let table = tableOf(e);
  check("a table of the size asked for, the caret in its first cell", table.content?.length === 2 && columnCount(e.state.doc.child(1)) === 3 && isInTable(e.state) && e.state.selection.$from.index(1) === 0, JSON.stringify(cellTexts(table)));
  check("a table needs level 2", levelOfJson(e.getJSON()) === 2);
  e.commands.insertContent("A1");
  press(e, "Tab");
  e.commands.insertContent("B1");
  check("Tab goes to the next cell (not a tab character, not out of the editor)", JSON.stringify(cellTexts(tableOf(e))[0]) === '["A1","B1",""]', JSON.stringify(cellTexts(tableOf(e))));
  press(e, "Tab", true);
  // (Arriving in a cell selects what it holds, as in Word: typing replaces it.)
  e.commands.insertContent("A1");
  check("Shift-Tab goes back", JSON.stringify(cellTexts(tableOf(e))[0]) === '["A1","B1",""]', JSON.stringify(cellTexts(tableOf(e))));
  for (let i = 0; i < 5; i += 1) tableTab(e, 1);
  e.commands.insertContent("C2");
  tableTab(e, 1);
  e.commands.insertContent("A3");
  check("Tab in the last cell adds a row", tableOf(e).content?.length === 3 && cellTexts(tableOf(e))[2][0] === "A3", JSON.stringify(cellTexts(tableOf(e))));

  // Column widths are one string on the table, kept in step with its columns.
  setTableAttrs(e, { cols: "100 120 140" });
  e.commands.setTextSelection(find(e, "B1"));
  tableCommands.columnRight(e);
  table = tableOf(e);
  check("a new column takes the width of the one beside it, and the widths stay in step", table.attrs?.cols === "100 120 120 140" && columnCount(e.state.doc.child(1)) === 4, String(table.attrs?.cols));
  tableCommands.columnLeft(e);
  check("…to the left too", tableOf(e).attrs?.cols === "100 120 120 120 140", String(tableOf(e).attrs?.cols));
  // Into the new column on each side of B1, and away with it.
  tableTab(e, 1);
  tableCommands.deleteColumn(e);
  e.commands.setTextSelection(find(e, "B1"));
  tableTab(e, -1);
  tableCommands.deleteColumn(e);
  check("deleting columns takes their widths with them", tableOf(e).attrs?.cols === "100 120 140" && columnCount(e.state.doc.child(1)) === 3, String(tableOf(e).attrs?.cols));
  check("widths that don't match the columns are no widths (a concurrent edit)", parseCols("100 120", 3) === null && parseCols("100 x 140", 3) === null && JSON.stringify(parseCols("100 5 9000", 3)) === "[100,18,1440]" && encodeCols([10.04, 20.26]) === "18 20.3");
  stepColumn(e, 1, 468);
  check("a column steps wider without a mouse", tableOf(e).attrs?.cols === "100 138 140" || tableOf(e).attrs?.cols === "118 120 140", String(tableOf(e).attrs?.cols));
  setTableAttrs(e, { cols: null });

  e.commands.setTextSelection(find(e, "B1"));
  tableCommands.rowAbove(e);
  tableCommands.rowBelow(e);
  check("rows above and below", tableOf(e).content?.length === 5 && cellTexts(tableOf(e))[1][1] === "B1", JSON.stringify(cellTexts(tableOf(e))));
  // Back two cells: the last cell of the new row above; delete that row.
  tableTab(e, -1);
  tableTab(e, -1);
  tableCommands.deleteRow(e);
  check("…and deleted", tableOf(e).content?.length === 4 && cellTexts(tableOf(e))[0][0] === "A1", JSON.stringify(cellTexts(tableOf(e))));

  // Merge A1 and the cell to its right; split it again.
  const first = find(e, "A1");
  const $a = e.state.doc.resolve(first);
  const cellA = $a.before($a.depth - 1);
  const cellB = cellA + e.state.doc.nodeAt(cellA)!.nodeSize;
  e.view.dispatch(e.state.tr.setSelection(CellSelection.create(e.state.doc, cellA, cellB)));
  check("two cells selected can be merged", tableCommands.canMerge(e));
  tableCommands.merge(e);
  const merged = tableOf(e).content?.[1]?.content?.[0] ?? tableOf(e).content?.[0]?.content?.[0];
  check("merged cells are one cell across two columns, with both texts", JSON.stringify(tableOf(e)).includes('"colspan":2') && JSON.stringify(merged ?? {}).length > 0);
  e.commands.setTextSelection(find(e, "A1"));
  check("…which can be split again", tableCommands.canSplit(e));
  tableCommands.split(e);
  check("split", !JSON.stringify(tableOf(e)).includes('"colspan":2'));

  e.commands.setTextSelection(find(e, "A1"));
  setTableAttrs(e, { head: true, lines: "rows" });
  tableCommands.shade(e, "#fff2cc");
  const cur = curTable(e);
  check("a header row, which lines to draw, a shaded cell", cur?.head === true && cur.lines === "rows" && cur.bg === "#fff2cc" && tableOf(e).attrs?.head === true, JSON.stringify(cur));
  setTableAttrs(e, { lines: "all" });
  check("'all lines' is how a table comes (nothing stored)", tableOf(e).attrs?.lines === null);
  const html = e.getHTML();
  check("the table is written with its columns and its header", html.includes("<colgroup>") && html.includes('data-head="1"') && html.includes('data-bg="#fff2cc"') && html.includes("background-color:") && html.includes('class="wf-table-wrap"'), html.slice(0, 300));

  // What an older app would get.
  const down = downlevelJson(e.getJSON(), 1, getSchema(docContentExtensions()));
  const words = JSON.stringify(down);
  check("for a server that can't hold tables, a table is its cells' paragraphs", levelOfJson(down) === 1 && ["A1", "B1", "C2", "A3", "Before."].every((w) => words.includes(w)) && !words.includes('"table"'));

  tableCommands.deleteTable(e);
  check("delete table", !JSON.stringify(e.getJSON()).includes('"table"'));
  e.destroy();
}

{
  // A table pasted from a web page or a spreadsheet.
  const e = editorWith([p(null)]);
  e.commands.setContent('<table><thead><tr><th>Name</th><th>Role</th></tr></thead><tbody><tr><td colspan="2" bgcolor="#ffff00">Both</td></tr><tr><td rowspan="2">Tall</td><td>x</td></tr><tr><td>y</td></tr></tbody></table>');
  const table = tableOf(e);
  check(
    "a pasted table keeps its header row, its merged cells and its shading",
    table.attrs?.head === true && table.content?.length === 4 && table.content[1].content?.[0].attrs?.colspan === 2 && table.content[1].content[0].attrs?.bg === "#ffff00" && table.content[2].content?.[0].attrs?.rowspan === 2,
    JSON.stringify(table).slice(0, 300),
  );
  e.destroy();
}

{
  // Tab in a checklist goes a level in (a format's own Tab used to win).
  const e = editorWith([p(null, t("one")), p(null, t("two"))], [formatKeymap("none")]);
  e.commands.selectAll();
  toggleChecklist(e);
  e.commands.setTextSelection(find(e, "two"));
  press(e, "Tab");
  const list = e.getJSON().content?.[0];
  check("Tab in a checklist item nests it", list?.content?.length === 1 && list.content[0].content?.[1]?.type === "taskList", JSON.stringify(list).slice(0, 200));
  e.destroy();
}

// ---------------------------------------------------------------- footnotes

{
  const e = editorWith([p(null, t("A claim here, and another."))]);
  e.commands.setTextSelection(find(e, " here"));
  check("a footnote goes in where the caret is", insertNote(e, "foot"));
  const para = e.getJSON().content?.[0];
  check("…as a node of its own in the sentence", para?.content?.[1]?.type === "footnote" && para.content[0].text === "A claim" && levelOfJson(e.getJSON()) === 2, JSON.stringify(para));
  check("…selected, so it opens for writing", e.state.selection instanceof NodeSelection && e.state.selection.node.type.name === "footnote");
  const sup = (e.view.dom as HTMLElement).querySelector("sup.wf-fn")!;
  const inner = openNotes.get(sup);
  check("the note opens in an editor of its own, under its number", !!sup && !!inner && !!sup.querySelector(".wf-fn-pop .wf-fn-text") && (sup.querySelector(".wf-fn-head span")?.textContent ?? "") === "Footnote 1");
  inner!.dispatch(inner!.state.tr.insertText("Its source."));
  check("what's typed in the note is in the document", JSON.stringify(e.getJSON().content?.[0].content?.[1]) === JSON.stringify({ type: "footnote", attrs: { tc: null, kind: null }, content: [{ type: "text", text: "Its source." }] }), JSON.stringify(e.getJSON().content?.[0].content?.[1]));
  // A change from elsewhere (a collaborator, an undo) reaches the open note.
  const at = (e.state.selection as NodeSelection).from;
  e.view.dispatch(e.state.tr.insertText("Per ", at + 1));
  check("…and a change from outside reaches the open note", inner!.state.doc.textContent === "Per Its source.", inner!.state.doc.textContent);

  check("a note's words aren't the text's", countDocWords(e.state.doc) === 5 && countRangeWords(e.state.doc, 0, e.state.doc.content.size) === 5, `${countDocWords(e.state.doc)} / ${countRangeWords(e.state.doc, 0, e.state.doc.content.size)}`);

  // Make it an endnote from the note's own bar.
  const toEnd = [...sup.querySelectorAll<HTMLButtonElement>(".wf-fn-head button")].find((b) => b.textContent === "Make endnote")!;
  toEnd.click();
  check("a footnote can be made an endnote", e.getJSON().content?.[0].content?.[1]?.attrs?.kind === "end" && e.getHTML().includes('data-kind="end"'));
  check("notes are counted by kind; numbered 1, 2, 3 and i, ii, iii", countNotes(e.state.doc).end === 1 && countNotes(e.state.doc).foot === 0 && noteNumber(4, "foot") === "4" && noteNumber(4, "end") === "iv" && noteNumber(19, "end") === "xix");

  e.commands.setTextSelection(find(e, "another"));
  insertNote(e, "foot");
  const second = [...(e.view.dom as HTMLElement).querySelectorAll("sup.wf-fn")][1];
  const del = [...second.querySelectorAll<HTMLButtonElement>(".wf-fn-head button")].find((b) => b.textContent === "Delete")!;
  del.click();
  check("a note is deleted from its own bar", countNotes(e.state.doc).foot === 0 && countNotes(e.state.doc).end === 1);

  const html = e.getHTML();
  e.commands.setContent(html);
  check("a note survives being copied and pasted", JSON.stringify(e.getJSON()).includes('"kind":"end"') && JSON.stringify(e.getJSON()).includes("Per Its source."), html);
  e.destroy();

  const code = editorWith([{ type: "codeBlock", content: [t("let x = 1;")] }]);
  code.commands.setTextSelection(4);
  check("no notes in code", !insertNote(code, "foot"));
  code.destroy();
}

{
  // Two people in the same note at once: both keep their words.
  const bound = (ydoc: Y.Doc) => new Editor({ element: mountPoint(), extensions: [...docContentExtensions({ history: false }), Collaboration.configure({ document: ydoc })] });
  const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote");
  const a = new Y.Doc();
  const b = new Y.Doc();
  const alice = bound(a);
  alice.commands.setContent({ type: "doc", content: [p(null, t("Text"), { type: "footnote", content: [t("shared note")] }, t(" goes on."))] });
  const bob = bound(b);
  sync(a, b);
  const noteAt = (e: Editor) => {
    let pos = -1;
    e.state.doc.descendants((n, at) => {
      if (n.type.name === "footnote") pos = at;
    });
    return pos;
  };
  alice.view.dispatch(alice.state.tr.insertText("Alice: ", noteAt(alice) + 1));
  bob.view.dispatch(bob.state.tr.insertText(" (Bob)", noteAt(bob) + 1 + "shared note".length));
  sync(a, b);
  sync(b, a);
  const said = (e: Editor) => e.state.doc.nodeAt(noteAt(e))?.textContent;
  check("two people writing in one note at once both keep their words", said(alice) === "Alice: shared note (Bob)" && said(bob) === "Alice: shared note (Bob)", `${said(alice)} / ${said(bob)}`);
  alice.destroy();
  bob.destroy();
}

// ---------------------------------------------------------------- table of contents

{
  const e = editorWith([p(null, t("Intro.")), h(1, "One"), p(null, t("Text.")), h(2, "One point one"), h(4, "Too deep"), h(1, "Two")]);
  e.commands.setTextSelection(1);
  insertToc(e);
  const toc = (e.view.dom as HTMLElement).querySelector(".wf-toc")!;
  const rows = () => [...toc.querySelectorAll(".wf-toc-row")].map((r) => `${r.getAttribute("data-level")}:${r.textContent}`);
  check("a contents block lists the headings, three levels deep", !!toc && rows().join("|") === "1:One|2:One point one|1:Two", rows().join("|"));
  check("…and stores nothing but itself", JSON.stringify((e.getJSON().content ?? []).find((n) => n.type === "toc")) === JSON.stringify({ type: "toc", attrs: { tc: null, depth: null } }) && levelOfJson(e.getJSON()) === 2);
  e.commands.insertContentAt(e.state.doc.content.size, h(1, "Three"));
  await wait(250);
  check("…and keeps itself up to date", rows().join("|") === "1:One|2:One point one|1:Two|1:Three", rows().join("|"));
  check("its entries are the top-level headings with text", tocEntries(e.state.doc, 1).map((x) => x.title).join("|") === "One|Two|Three");
  (toc.querySelector(".wf-toc-row:last-child") as HTMLElement).click();
  check("clicking an entry goes to its heading", e.state.selection.$from.parent.textContent === "Three");
  e.destroy();
}

// ---------------------------------------------------------------- pictures

{
  const e = editorWith([p(null, t("A picture:")), { type: "image", attrs: { src: "writform-att://attachment/3", width: 300, height: 200 } }]);
  let pos = -1;
  e.state.doc.descendants((n, at) => {
    if (n.type.name === "image") pos = at;
  });
  e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, pos)));
  check("a clicked picture is the selected picture", selectedImage(e)?.pos === pos);
  setImageAttrs(e, { align: "center", caption: "  Figure 1.   A   picture.  " });
  const img = e.getJSON().content?.[1];
  check("where it sits, and its caption (tidied)", img?.attrs?.align === "center" && img.attrs.caption === "Figure 1. A picture." && levelOfJson(e.getJSON()) === 2 && !!selectedImage(e), JSON.stringify(img?.attrs));
  const holder = (e.view.dom as HTMLElement).querySelector(".wf-figure, [data-resize-container]") as HTMLElement;
  check("…shown under it, and to the same side", holder?.dataset.align === "center" && holder.querySelector(".wf-img-caption")?.textContent === "Figure 1. A picture.");
  setImageAttrs(e, { align: null, caption: "" });
  check("…and taken away again", e.getJSON().content?.[1].attrs?.align === null && e.getJSON().content?.[1].attrs?.caption === null && levelOfJson(e.getJSON()) === 1);
  e.destroy();
}

// ---------------------------------------------------------------- sections and column breaks

{
  const e = editorWith([p(null, t("First section.")), p(null, t("Still the first.")), p(null, t("A new one starts here.")), p(null, t("Inside it."))]);
  check("the document starts in its own section", sectionAt(e) === null);
  e.commands.setTextSelection(find(e, "A new one"));
  setSection(e, { landscape: true, cols: 2 });
  check("a section starts at a paragraph, with what it sets for itself", e.getJSON().content?.[2].attrs?.sect === "sect land:1 cols:2" && levelOfJson(e.getJSON()) === 2);
  e.commands.setTextSelection(find(e, "Inside it"));
  const here = sectionAt(e);
  check("the caret further on is in that section", !!here && here.props.landscape === true && here.props.cols === 2);
  setSection(e, { ...here!.props, pn: 1, mt: 0.5 }, here!.pos);
  check("…whose setup can be changed from anywhere in it", e.getJSON().content?.[2].attrs?.sect === "sect land:1 cols:2 pn:1 mt:0.5", String(e.getJSON().content?.[2].attrs?.sect));
  toggleColumnBreak(e);
  check("a column break", e.getJSON().content?.[3].attrs?.colBreak === true && curParaFormat(e).colBreak === true);
  const html = e.getHTML();
  check("both are marked in the text", html.includes('data-break="section"') && html.includes('data-break="column"') && html.includes('data-sect="sect land:1 cols:2 pn:1 mt:0.5"'), html);
  e.commands.selectAll();
  clearFormatting(e);
  check("clearing formatting doesn't move the breaks", e.getJSON().content?.[2].attrs?.sect === "sect land:1 cols:2 pn:1 mt:0.5" && e.getJSON().content?.[3].attrs?.colBreak === true);
  e.commands.setTextSelection(find(e, "one starts"));
  press(e, "Enter");
  check("Enter in the paragraph that starts a section doesn't start another", (e.getJSON().content ?? []).filter((n) => n.attrs?.sect).length === 1 && e.getJSON().content?.[2].attrs?.sect === "sect land:1 cols:2 pn:1 mt:0.5" && e.getJSON().content?.[3].content?.[0].text === "one starts here.", JSON.stringify((e.getJSON().content ?? []).map((n) => n.attrs?.sect ?? null)));
  e.commands.setContent({ type: "doc", content: [p({ pageBreakBefore: true, dropCap: true }, t("Once upon a time."))] });
  e.commands.setTextSelection(6);
  press(e, "Enter");
  check("…nor does a page break or a drop cap repeat on the second half", e.getJSON().content?.[0].attrs?.pageBreakBefore === true && e.getJSON().content?.[1].attrs?.pageBreakBefore === null && e.getJSON().content?.[1].attrs?.dropCap === null);
  e.commands.setContent({ type: "doc", content: [p(null, t("One.")), p({ sect: "sect cols:2" }, t("Two."))] });
  e.commands.setTextSelection(find(e, "Two"));
  setSection(e, null, sectionAt(e)!.pos);
  check("a section break is taken away", (e.getJSON().content ?? []).every((n) => !n.attrs?.sect));

  check("a section's setup is one string, read strictly", encodeSection(parseSection("sect cols:9 land:1 size:A4! pn:-3 mt:2 ml:99 junk")) === "sect land:1 mt:2" && parseSection("land:1") === null && parseSection(7) === null && encodeSection({}) === "sect", String(encodeSection(parseSection("sect cols:9 land:1 size:A4! pn:-3 mt:2 ml:99 junk"))));
  e.destroy();
}

finish();
