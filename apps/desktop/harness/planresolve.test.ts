// The plan laid against the text: which headings are columns in each kind
// of document, cards in their places, cards whose chapter went, the plan's
// own edits to the text, and moving about the board by keyboard.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import * as Y from "yjs";

import { presetDesign } from "../src/book/model/presets";
import { ChapterIdGuard, ensureChapterId } from "../src/editor/nodes/ChapterId";
import { docContentExtensions } from "../src/editor/schema/content";
import { moveTarget, nextFocus, type GridModel } from "../src/plan/gridNav";
import { knowsChapter, planOps, readPlan } from "../src/plan/planMap";
import { attachByTitle, cardMatches, cellKey, columnNoun, hasPlan, placeCards, planColumns, staleTitles } from "../src/plan/resolve";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { insertHeadingAfter, renameHeading } from "../src/plan/textOps";

const design = presetDesign("classic");
const el = (element: string, text: string): JSONContent => ({ type: "paragraph", attrs: { element }, content: text ? [{ type: "text", text }] : undefined });
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const editorOf = (json: JSONContent, ydoc?: Y.Doc): Editor =>
  new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(ydoc ? { history: false } : {}), ...(ydoc ? [Collaboration.configure({ document: ydoc }), ChapterIdGuard.configure({ known: (cid) => knowsChapter(ydoc, cid) })] : [])],
    content: ydoc ? undefined : json,
  });

// ------------------------------------------------------------ which headings are columns

const book = doc(
  p("Front matter words."),
  el("part_heading", "Part One"),
  el("chapter_heading", "The fall"),
  p("One two three four."),
  el("chapter_heading", "The rise"),
  p("Five six."),
  el("part_heading", "Part Two"),
  el("section_heading", "Interlude"),
  p("Seven."),
);
{
  const e = editorOf(book);
  const cols = planColumns(e.state.doc, "manuscript", design)!;
  check("a manuscript: its chapters and unnumbered chapters are the columns", cols.columns.map((c) => c.title).join("|") === "The fall|The rise|Interlude", cols.columns.map((c) => c.title).join("|"));
  check("…its parts the bands over them", cols.bands.map((b) => `${b.name}:${b.from}-${b.to}`).join("|") === "Part One:0-2|Part Two:2-3", JSON.stringify(cols.bands));
  check("…each with its words and the band it is under", cols.columns.map((c) => `${c.words}:${c.band}`).join("|") === "6:0|4:0|2:1", cols.columns.map((c) => `${c.words}:${c.band}`).join("|"));
  check("…and its name as the outline says it", cols.columns[0].name.endsWith("The fall") && cols.columns[0].label !== "", cols.columns[0].name);
  check("a chapter is called a chapter", columnNoun("manuscript") === "chapter" && columnNoun("screenplay") === "scene" && columnNoun("none") === "section");
  e.destroy();
}
{
  const e = editorOf(doc(el("scene_heading", "INT. KITCHEN - DAY"), el("action", "She waits."), el("scene_heading", "EXT. ROAD - NIGHT"), el("action", "Rain.")));
  const cols = planColumns(e.state.doc, "screenplay", design)!;
  check("a screenplay: its scenes", cols.columns.map((c) => c.title).join("|") === "INT. KITCHEN - DAY|EXT. ROAD - NIGHT" && cols.bands.length === 0);
  e.destroy();
}
{
  const e = editorOf(doc(el("act_heading", "Act One"), el("scene_heading", "Scene 1"), el("scene_heading", "Scene 2"), el("act_heading", "Act Two"), el("scene_heading", "Scene 3")));
  const cols = planColumns(e.state.doc, "stageplay", design)!;
  check("a stage play: its scenes, with its acts over them", cols.columns.length === 3 && cols.bands.map((b) => `${b.name}:${b.from}-${b.to}`).join("|") === "Act One:0-2|Act Two:2-3", JSON.stringify(cols.bands));
  e.destroy();
}
{
  const e = editorOf(doc(h(1, "Report"), h(2, "Method"), p("x"), h(2, "Results"), p("y"), h(3, "Detail")));
  const cols = planColumns(e.state.doc, "none", design)!;
  check("a Document: the first level of headings used twice", cols.columns.map((c) => c.title).join("|") === "Method|Results", cols.columns.map((c) => c.title).join("|"));
  e.destroy();
  check("poetry has no plan", !hasPlan("poetry") && planColumns(editorOf(doc(p("A line"))).state.doc, "poetry", design) === null);
}

// ------------------------------------------------------------ cards in their places

{
  const ydoc = new Y.Doc();
  const e = editorOf(book, ydoc);
  e.commands.setContent(book);
  const ops = planOps(ydoc);
  let cols = planColumns(e.state.doc, "manuscript", design)!;
  const fall = ensureChapterId(e, cols.columns[0].pos, { level: 5, canWrite: true })!;
  const rise = ensureChapterId(e, cols.columns[1].pos, { level: 5, canWrite: true })!;
  ops.noteChapter(fall, "The fall");
  ops.noteChapter(rise, "The rise");
  const main = ops.addLine("Main plot")!.id;
  const sub = ops.addLine("Subplot")!.id;
  ops.addCard({ title: "Anna leaves", line: main, chapter: fall });
  ops.addCard({ title: "The letter", line: sub, chapter: fall });
  ops.addCard({ title: "Return", line: main, chapter: rise });
  ops.addCard({ title: "An idea", line: null, chapter: null });
  ops.addCard({ title: "Lineless", line: null, chapter: rise });
  cols = planColumns(e.state.doc, "manuscript", design)!;
  let placed = placeCards(cols, readPlan(ydoc));
  check("cards in their cells", placed.cells.get(cellKey(main, cols.columns[0].key))?.map((c) => c.title).join() === "Anna leaves" && placed.cells.get(cellKey(sub, cols.columns[0].key))?.[0].title === "The letter");
  check("a card in no chapter is unassigned", placed.loose.map((c) => c.title).join() === "An idea");
  check("a card with no plot line gets a row of its own", placed.rows.map((r) => r.line?.name ?? "none").join() === "Main plot,Subplot,none");
  check("each column counts its cards", placed.perColumn.get(cols.columns[0].key) === 2);
  check("search finds a card by its plot line's name too", cardMatches(readPlan(ydoc).cards[0], "subplot", readPlan(ydoc)) || readPlan(ydoc).cards.some((c) => c.title === "The letter" && cardMatches(c, "SUBPLOT", readPlan(ydoc))));

  const apart = () => (yUndoPluginKey.getState(e.state) as { undoManager: { stopCapturing(): void } }).undoManager.stopCapturing();
  // Renamed in the text: the cards stay.
  renameHeading(e, cols.columns[0], "The long fall");
  cols = planColumns(e.state.doc, "manuscript", design)!;
  placed = placeCards(cols, readPlan(ydoc));
  check("a chapter renamed keeps its cards", cols.columns[0].title === "The long fall" && placed.cells.get(cellKey(main, cols.columns[0].key))?.[0].title === "Anna leaves");
  const stale = staleTitles(cols, readPlan(ydoc));
  check("…and its new name is the one to remember", stale.length === 1 && stale[0][0] === fall && stale[0][1] === "The long fall");
  for (const [cid, title] of stale) ops.noteChapter(cid, title);
  apart();
  // Moved: the cards go with it.
  const start = cols.columns[1].pos;
  const end = (() => {
    let at = 0;
    e.state.doc.forEach((_n, offset, i) => {
      if (i === cols.columns[1].endIndex) at = offset;
    });
    return at;
  })();
  const content = e.state.doc.slice(start, end).content;
  const firstChapter = cols.columns[0].pos;
  e.view.dispatch(e.state.tr.delete(start, end).insert(firstChapter, content));
  apart();
  cols = planColumns(e.state.doc, "manuscript", design)!;
  placed = placeCards(cols, readPlan(ydoc));
  check("a chapter moved takes its cards", cols.columns[0].title === "The rise" && placed.cells.get(cellKey(main, cols.columns[0].key))?.[0].title === "Return");
  // Deleted: its cards are lost, with its name.
  const gone = cols.columns[0];
  let goneEnd = 0;
  e.state.doc.forEach((_n, offset, i) => {
    if (i === gone.endIndex) goneEnd = offset;
  });
  e.view.dispatch(e.state.tr.delete(gone.pos, goneEnd));
  apart();
  cols = planColumns(e.state.doc, "manuscript", design)!;
  placed = placeCards(cols, readPlan(ydoc));
  check("a chapter deleted: its cards wait with its name", placed.lost.map((c) => `${c.title}@${c.lostTitle}`).sort().join() === "Lineless@The rise,Return@The rise", placed.lost.map((c) => `${c.title}@${c.lostTitle}`).join());
  e.commands.undo();
  cols = planColumns(e.state.doc, "manuscript", design)!;
  placed = placeCards(cols, readPlan(ydoc));
  check("…and come back with it", placed.lost.length === 0 && placed.perColumn.get(cols.columns.find((c) => c.title === "The rise")!.key) === 2);
  // A book published to an older server and back: its ids are gone.
  const plain = editorOf(JSON.parse(JSON.stringify(e.getJSON()).replace(/"cid":"[0-9a-z]{8}"/g, '"cid":null')));
  const bare = planColumns(plain.state.doc, "manuscript", design)!;
  const lost = placeCards(bare, readPlan(ydoc)).lost;
  const back = attachByTitle(bare, lost);
  check("cards whose chapter lost its id find it by its name", lost.length === 4 && back.size === 4 && [...back.values()].every((c) => c.title === "The long fall" || c.title === "The rise"), lost.map((c) => `${c.title}@${c.lostTitle}->${back.get(c.id)?.title}`).join());
  e.destroy();
}

// ------------------------------------------------------------ the plan's edits to the text

{
  const e = editorOf(doc(el("chapter_heading", "The fall"), p("Text.")));
  const cols = planColumns(e.state.doc, "manuscript", design)!;
  insertHeadingAfter(e, "manuscript", cols.columns[0], "The rise");
  const after = planColumns(e.state.doc, "manuscript", design)!;
  check("a chapter added after another, with a line to write on", after.columns.map((c) => c.title).join() === "The fall,The rise" && e.state.doc.lastChild?.attrs.element === null);
  e.commands.undo();
  check("…in one undo", planColumns(e.state.doc, "manuscript", design)!.columns.length === 1);
  insertHeadingAfter(e, "manuscript", null, "Prologue");
  check("the first one goes at the very start", planColumns(e.state.doc, "manuscript", design)!.columns[0].title === "Prologue");
  e.destroy();
  const numbered = editorOf(doc(el("chapter_heading", "1. Just another day"), p("x")));
  renameHeading(numbered, planColumns(numbered.state.doc, "manuscript", design)!.columns[0], "A long day");
  check("renaming a numbered chapter keeps its number", numbered.state.doc.firstChild?.textContent === "1. A long day", numbered.state.doc.firstChild?.textContent);
  const sub = editorOf(doc(el("chapter_heading", "3"), el("chapter_subtitle", "The fall"), p("x")));
  renameHeading(sub, planColumns(sub.state.doc, "manuscript", design)!.columns[0], "The drop");
  check("…and one whose title is on the line under it changes that line", sub.state.doc.child(0).textContent === "3" && sub.state.doc.child(1).textContent === "The drop");
  const scene = editorOf(doc(el("scene_heading", "INT. HALL")));
  insertHeadingAfter(scene, "screenplay", planColumns(scene.state.doc, "screenplay", design)!.columns[0], "EXT. YARD");
  check("a screenplay's new scene opens on action", scene.state.doc.child(1).attrs.element === "scene_heading" && scene.state.doc.child(2).attrs.element === "action");
  const report = editorOf(doc(h(1, "A"), h(2, "B"), h(2, "C")));
  insertHeadingAfter(report, "none", planColumns(report.state.doc, "none", design)!.columns[1], "D");
  check("a Document's new section is a heading at its columns' level", report.state.doc.child(3).type.name === "heading" && report.state.doc.child(3).attrs.level === 2);
}

// ------------------------------------------------------------ keys on the board

{
  const model: GridModel = {
    cells: [
      [["a", "b"], [], ["c"]],
      [["d"], ["e"], []],
    ],
  };
  check("down within a cell, then to the line below", JSON.stringify(nextFocus(model, { row: 0, col: 0, index: 0 }, "ArrowDown")) === '{"row":0,"col":0,"index":1}' && JSON.stringify(nextFocus(model, { row: 0, col: 0, index: 1 }, "ArrowDown")) === '{"row":1,"col":0,"index":0}');
  check("right to an empty cell lands on its +", JSON.stringify(nextFocus(model, { row: 0, col: 0, index: 1 }, "ArrowRight")) === '{"row":0,"col":1,"index":-1}');
  check("up from below lands on the last card above", JSON.stringify(nextFocus(model, { row: 1, col: 0, index: 0 }, "ArrowUp")) === '{"row":0,"col":0,"index":1}');
  check("End goes to the last column", nextFocus(model, { row: 0, col: 0, index: 0 }, "End")?.col === 2 && nextFocus(model, { row: 0, col: 2, index: 0 }, "ArrowRight") === null);
  check("Alt and right moves a card a column over", JSON.stringify(moveTarget(model, { row: 0, col: 0, index: 1 }, "ArrowRight")) === '{"row":0,"col":1,"before":null}');
  check("Alt and up moves it up in its cell", JSON.stringify(moveTarget(model, { row: 0, col: 0, index: 1 }, "ArrowUp")) === '{"row":0,"col":0,"before":"a"}');
  check("…and down past its cell's end, into the next line", JSON.stringify(moveTarget(model, { row: 0, col: 0, index: 1 }, "ArrowDown")) === '{"row":1,"col":0,"before":"d"}');
}

finish();
