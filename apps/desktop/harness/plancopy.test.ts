// The plan where a document is copied or rebuilt: copies carry it, a
// version put back keeps the chapters' ids, documents combined have one
// plan with ids that stay unique, and the plan written out as Markdown.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import * as Y from "yjs";

import { docMapsUpdate, snapshotDocMaps } from "../src/apps/documents/docMaps";
import { applyRestore } from "../src/apps/documents/restore";
import { presetDesign } from "../src/book/model/presets";
import { chapterIdHolders, ensureChapterId } from "../src/editor/nodes/ChapterId";
import { docContentExtensions } from "../src/editor/schema/content";
import { combinePlans } from "../src/plan/carry";
import { planToMarkdown } from "../src/plan/markdown";
import { buildNameIndex, mentionsByColumn } from "../src/plan/mentions";
import { planFromSnapshot } from "../src/plan/model";
import { PLAN_MAP, planOps, readPlan } from "../src/plan/planMap";
import { placeCards, planColumns } from "../src/plan/resolve";

const el = (element: string, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({ type: "paragraph", attrs: { element, ...attrs }, content: [{ type: "text", text }] });
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const design = presetDesign("classic");

// ------------------------------------------------------------ copies carry it

{
  const ydoc = new Y.Doc();
  const ops = planOps(ydoc);
  ops.addLine("Main plot");
  const snap = snapshotDocMaps(ydoc);
  check("a copy of a document's maps holds its plan", Object.keys(snap.plan ?? {}).length === 1);
  const copy = new Y.Doc();
  Y.applyUpdate(copy, docMapsUpdate(snap)!);
  check("…and a copy made from them has it", readPlan(copy).lines[0]?.name === "Main plot" && copy.getMap(PLAN_MAP).size === 1);
}

// ------------------------------------------------------------ a version put back

{
  const saved = { type: "doc", content: [el("chapter_heading", "The fall"), p("Old words."), el("chapter_heading", "The rise"), p("More.")] };
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: saved });
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  e.commands.setTextSelection(e.state.doc.content.size - 1);
  e.commands.insertContent(" New words.");
  await applyRestore(e, saved);
  check("a version saved before a chapter was planned, put back: the chapter keeps its id", e.state.doc.child(0).attrs.cid === cid && e.state.doc.lastChild?.textContent === "More.", JSON.stringify(e.state.doc.child(0).attrs));
  check("…and nothing else is given one", chapterIdHolders(e.state.doc).size === 1);
}

// ------------------------------------------------------------ documents combined

{
  const a = new Y.Doc();
  const aOps = planOps(a);
  const aLine = aOps.addLine("Main plot")!.id;
  const anna = aOps.addEntry({ name: "Anna" })!.id;
  aOps.addCard({ title: "Leaves", line: aLine, chapter: "aaaaaaaa", cast: [anna] });
  aOps.addCard({ title: "An idea", line: null, chapter: null });
  aOps.noteChapter("aaaaaaaa", "The fall");
  aOps.addEvent({ title: "She leaves", chapter: "aaaaaaaa" });
  const aJson = { type: "doc", content: [el("chapter_heading", "The fall", { cid: "aaaaaaaa" }), p("Text.")] };
  const parts = [
    { json: aJson, plan: snapshotDocMaps(a).plan },
    { json: aJson, plan: snapshotDocMaps(a).plan },
  ];
  const both = combinePlans(parts, true);
  const ids = both.jsons.map((j) => j.content?.[0].attrs?.cid as string);
  check("a document combined with itself: each copy of a chapter has its own id", ids[0] === "aaaaaaaa" && /^[0-9a-z]{8}$/.test(ids[1]) && ids[1] !== ids[0], ids.join());
  const plan = planFromSnapshot(both.plan!);
  check("plot lines and people of the same name are one", plan.lines.length === 1 && plan.cast.length === 1);
  check("every card comes, the second copy's in the second chapter", plan.cards.filter((c) => c.title === "Leaves").map((c) => c.chapter).sort().join() === [ids[0], ids[1]].sort().join() && plan.cards.every((c) => !c.line || c.line === plan.lines[0].id));
  check("…naming the one person", plan.cards.filter((c) => c.title === "Leaves").every((c) => c.cast.join() === plan.cast[0].id));
  check("the unassigned notes follow each other", plan.cards.filter((c) => !c.chapter).length === 2);
  check("the events follow in the sources' order", plan.events.length === 2 && plan.events[0].chapter === ids[0] && plan.events[1].chapter === ids[1]);
  check("each chapter is remembered by name", plan.chapters[ids[1]]?.title === "The fall");
  const old = combinePlans(parts, false);
  check("for a server not yet updated: no ids, the cards wait unassigned", old.jsons.every((j) => !j.content?.[0].attrs?.cid) && planFromSnapshot(old.plan!).cards.every((c) => c.chapter === null));
  check("documents with no plan make none", combinePlans([{ json: aJson }], true).plan === null);
}

// ------------------------------------------------------------ as Markdown

{
  const ydoc = new Y.Doc();
  const ops = planOps(ydoc);
  const e = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions(),
    content: { type: "doc", content: [el("part_heading", "Part One"), el("chapter_heading", "The fall"), p("Anna leaves."), el("chapter_heading", "The rise"), p("Anna returns.")] },
  });
  const fall = ensureChapterId(e, e.state.doc.child(0).nodeSize, { level: 5, canWrite: true })!;
  ops.noteChapter(fall, "The fall");
  const main = ops.addLine("Main plot")!.id;
  const anna = ops.addEntry({ name: "Anna", aka: ["Annie"], note: "Leaves first." })!.id;
  ops.addCard({ title: "Anna leaves", text: "Night train.\nNo goodbye.", line: main, chapter: fall, cast: [anna], done: true });
  ops.addCard({ title: "Return?", line: null, chapter: null });
  ops.addEvent({ title: "The train", when: "Day 1", chapter: fall });
  ops.addEvent({ title: "Childhood", date: "1990", chapter: null });
  const plan = readPlan(ydoc);
  const columns = planColumns(e.state.doc, "manuscript", design)!;
  check("(the fixture's plan is placed)", placeCards(columns, plan).perColumn.size === 1);
  const md = planToMarkdown({ plan, columns, noun: "chapter" }, mentionsByColumn(e.state.doc, columns.columns, buildNameIndex(plan.cast)));
  const want = [
    "# Plan",
    "",
    "## Plot lines",
    "",
    "- Main plot",
    "",
    `## ${columns.columns[0].name}`,
    "",
    "### Main plot",
    "",
    "- **Anna leaves**: Night train. No goodbye. (Anna) [written]",
    "",
    "## Unassigned planning notes",
    "",
    "- **Return?**",
    "",
    "## Cast and world",
    "",
    "### People",
    "",
    `- **Anna** (also called Annie): Leaves first. In ${columns.columns[0].name}, ${columns.columns[1].name}.`,
    "",
    "## Timeline",
    "",
    `1. **The train** (Day 1). Told in ${columns.columns[0].name}.`,
    "2. **Childhood** (1990). Not in a chapter.",
    "",
  ].join("\n");
  check("the plan as Markdown", md === want, `\n${md}`);
}

finish();
