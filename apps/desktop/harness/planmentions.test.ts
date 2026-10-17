// Where the cast and world appear in the text, and the timeline's story
// order against the book's.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";

import { presetDesign } from "../src/book/model/presets";
import { docContentExtensions } from "../src/editor/schema/content";
import { buildNameIndex, findMentions, mentionsByColumn } from "../src/plan/mentions";
import type { CastEntry, PlanEvent } from "../src/plan/model";
import { planColumns } from "../src/plan/resolve";
import { dateValue, sortByDate, storyVsBook } from "../src/plan/timeline";

const el = (element: string, text: string): JSONContent => ({ type: "paragraph", attrs: { element }, content: [{ type: "text", text }] });
const p = (...parts: (string | JSONContent)[]): JSONContent => ({ type: "paragraph", content: parts.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)) });
const editorOf = (content: JSONContent[]) => new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content } });
let n = 0;
const entry = (name: string, more: Partial<CastEntry> = {}): CastEntry => ({ id: `e${String(n++).padStart(7, "0")}`, kind: "person", name, aka: [], note: "", color: null, order: "V", anyCase: false, ...more });
const design = presetDesign("classic");

// ------------------------------------------------------------ finding names

const anna = entry("Anna", { aka: ["Annie"] });
const kent = entry("Anna Kent");
const will = entry("Will");
const ring = entry("the ring", { kind: "thing" });
const mary = entry("Mary-Jane");
const cast = [anna, kent, will, ring, mary];
const index = buildNameIndex(cast);
const e = editorOf([
  el("chapter_heading", "One"),
  p("Anna came home. Annie, she said. Anna's coat was wet. Ann waited. ANNA!"),
  p("Will you come? Not now, said Will. Anna Kent nodded. Mary-Jane laughed. Mary jane left."),
  el("chapter_heading", "Two"),
  p("The Ring was gold. She hid the ring. Joanna smiled. anna was asleep."),
  p({ type: "text", text: "Anna", marks: [{ type: "deletion", attrs: { a: "Me", t: 1 } }] }, " left the room."),
]);
const cols = planColumns(e.state.doc, "manuscript", design)!;
const found = mentionsByColumn(e.state.doc, cols.columns, index);
const at = (x: CastEntry, col: number) => found.byEntry.get(x.id)?.cols.get(col) ?? 0;
check("whole words only, with her other names, an 's, and capitals", at(anna, 0) === 4, String(at(anna, 0)));
check("a name written with a capital is not found without one", at(anna, 1) === 0, String(at(anna, 1)));
check("the longest name wins: Anna Kent is not also Anna", at(kent, 0) === 1);
check("a common word as a name isn't counted where it opens a sentence", at(will, 0) === 1);
check("a name in lower case is found however it is written", at(ring, 1) === 2);
check("a name of two words joined by a hyphen, written with capitals", at(mary, 0) === 1);
check("words someone suggested deleting aren't counted", (found.byEntry.get(anna.id)?.total ?? 0) === 4);
check("the first chapter it appears in", found.byEntry.get(ring.id)?.first === 1 && found.byEntry.get(anna.id)?.first === 0);
const places = findMentions(e.state.doc, index, anna.id);
check("each mention can be found in the text", places.length === 4 && places.every((m) => /^(Anna|Annie|Anna's|ANNA)$/.test(e.state.doc.textBetween(m.from, m.to))), places.map((m) => e.state.doc.textBetween(m.from, m.to)).join());
{
  const clash = buildNameIndex([entry("Kit"), entry("Marlowe", { aka: ["Kit"] })]);
  check("a name two entries share counts for the first, and is said", clash.clashes.join() === "Kit");
  const anyCase = buildNameIndex([entry("Ann", { anyCase: true })]);
  const e2 = editorOf([p("ann and ANN and Ann.")]);
  check("an entry asked to be found whatever its capitals", mentionsByColumn(e2.state.doc, [], anyCase).byEntry.values().next().value?.total === 3);
}
{
  // A 100,000-word book.
  const words = "the quick brown fox jumps over the lazy dog Anna Kent and Will went down to the river with the ring".split(" ");
  const blocks: JSONContent[] = [];
  let made = 0;
  for (let c = 0; c < 40; c += 1) {
    blocks.push(el("chapter_heading", `Chapter ${c + 1}`));
    for (let b = 0; b < 50; b += 1) {
      const text: string[] = [];
      for (let w = 0; w < 50; w += 1) text.push(words[(c * 7 + b * 3 + w) % words.length]);
      blocks.push(p(`${text.join(" ")}.`));
      made += 50;
    }
  }
  const big = editorOf(blocks);
  const columns = planColumns(big.state.doc, "manuscript", design)!;
  const idx = buildNameIndex(cast);
  let t = performance.now();
  mentionsByColumn(big.state.doc, columns.columns, idx);
  const cold = performance.now() - t;
  big.commands.setTextSelection(10);
  big.commands.insertContent("Anna ");
  t = performance.now();
  const after = mentionsByColumn(big.state.doc, columns.columns, idx);
  const warm = performance.now() - t;
  check(`a ${made.toLocaleString()}-word book is read in under 400 ms`, cold < 400, `${cold.toFixed(1)} ms`);
  check("…and after one edit in under 20 ms", warm < 20 && (after.byEntry.get(anna.id)?.total ?? 0) > 0, `${warm.toFixed(1)} ms`);
}

// ------------------------------------------------------------ the timeline

const ev = (id: string, ch: string | null, date: string | null = null): PlanEvent => ({ id, title: id, text: "", order: "V", when: "", date, chapter: ch, cast: [], card: null });
{
  // Story order A..E, told in chapters 1, 2, 5, 3, 4.
  const columnOf = (cid: string) => ({ c1: 0, c2: 1, c3: 2, c4: 3, c5: 4 })[cid] ?? -1;
  const rows = storyVsBook([ev("A", "c1"), ev("B", "c2"), ev("C", "c5"), ev("D", "c3"), ev("E", "c4")], columnOf);
  check("told 1, 2, 5, 3, 4: only the event in chapter 5 is out of order, told later than it happens", rows.map((r) => r.told).join() === "inOrder,inOrder,later,inOrder,inOrder", rows.map((r) => r.told).join());
  const forward = storyVsBook([ev("A", "c2"), ev("B", "c3"), ev("C", "c1")], columnOf);
  check("an event told before what happens before it is a flash forward", forward.map((r) => r.told).join() === "inOrder,inOrder,earlier", forward.map((r) => r.told).join());
  const other = storyVsBook([ev("A", null), ev("B", "gone")], columnOf);
  check("an event in no chapter, and one whose chapter is gone", other.map((r) => r.told).join() === "untold,lost");
  check("dates sort as years, months and days, before the common era too", (dateValue("-44-03-15") as number) < (dateValue("1066") as number) && (dateValue("1066-10") as number) < (dateValue("1066-10-14") as number) && dateValue("soon") === null);
  const sorted = sortByDate([ev("x", null, "1900"), ev("y", null), ev("z", null, "1800"), ev("w", null)]);
  check("sorted by date, an undated event stays after the one it followed", sorted.join() === "z,w,x,y", sorted.join());
}

finish();
