// The cast and world, the timeline, and the plan beside the text: entries
// with their other names and where they appear, stepping through a name's
// mentions, events in story order against the book's, and the cards of the
// chapter being written.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { presetDesign } from "../src/book/model/presets";
import { ensureChapterId } from "../src/editor/nodes/ChapterId";
import { docContentExtensions } from "../src/editor/schema/content";
import { planOps, readPlan } from "../src/plan/planMap";
import { PlanPanel } from "../src/plan/ui/PlanPanel";
import { PlanView, type PlanTab } from "../src/plan/ui/PlanView";
import { ToastHost } from "../src/platform/toast";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q.includes("min-width"), addEventListener() {}, removeEventListener() {} });
const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label || b.title === label);

const el = (element: string, text: string): JSONContent => ({ type: "paragraph", attrs: { element }, content: [{ type: "text", text }] });
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const editor = new Editor({
  element: mountPoint(),
  extensions: docContentExtensions(),
  content: { type: "doc", content: [el("chapter_heading", "One"), p("Anna waits. Annie, she said."), el("chapter_heading", "Two"), p("Kent arrives."), el("chapter_heading", "Three"), p("Anna and Kent meet.")] },
});
const ydoc = new Y.Doc();
const ops = planOps(ydoc);
const design = presetDesign("classic");

// ------------------------------------------------------------ cast and world

const host = mountPoint();
const root = createRoot(host);
const shown: string[] = [];
let tabNow: PlanTab = "cast";
const Shell = () => {
  const [tab, setTab] = useState<PlanTab>("cast");
  tabNow = tab;
  return createElement(
    "div",
    null,
    createElement(PlanView, {
      editor,
      ydoc,
      format: "manuscript",
      design,
      readonly: false,
      level: 5,
      tab,
      onTab: setTab,
      onClose: () => {},
      onShowInText: () => {},
      onShowOnly: () => {},
      onShowMentions: (id: string) => void shown.push(id),
    }),
    createElement(ToastHost),
  );
};
act(() => root.render(createElement(Shell)));
await wait();
check("an empty cast says what it is for", /people, places and things of the story/.test(host.textContent ?? ""));
await act(async () => button(host, "Add a person")!.click());
await wait(60);
const name = host.querySelector<HTMLInputElement>(".wf-plan-entry-name")!;
check("a new person opens to be named", !!name && readPlan(ydoc).cast.length === 1);
await act(async () => setValue(name, "Anna"));
const aka = host.querySelector<HTMLInputElement>(".wf-plan-aka input")!;
await act(async () => setValue(aka, "Annie"));
await act(async () => aka.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
await wait(450);
const annaEntry = readPlan(ydoc).cast[0];
check("named, with another name", annaEntry.name === "Anna" && annaEntry.aka.join() === "Annie", JSON.stringify(annaEntry));
await wait(450);
check("where she appears is found in the text", /3 mentions in 2 chapters/.test(host.textContent ?? "") && host.querySelectorAll(".wf-plan-strip-cell.low").length === 2, host.querySelector(".wf-plan-entry")?.textContent?.slice(0, 200));
await act(async () => button(host, "Step through the mentions")!.click());
check("…and her mentions can be stepped through", shown.join() === annaEntry.id);
ops.addEntry({ name: "Kent" });
await wait(450);
check("each entry in the list counts its mentions", [...host.querySelectorAll(".wf-plan-cast-row")].map((r) => r.textContent).join("|") === "Anna Annie3|Kent2", [...host.querySelectorAll(".wf-plan-cast-row")].map((r) => r.textContent).join("|"));

// The board's row of who is in each chapter.
const line = ops.addLine("Main plot")!.id;
const fall = ensureChapterId(editor, 0, { level: 5, canWrite: true })!;
ops.noteChapter(fall, "One");
ops.addCard({ title: "Anna waits", line, chapter: fall, cast: [annaEntry.id] });
await act(async () => button(host, "Board")!.click());
await wait(450);
check("the board shows who is in each chapter", tabNow === "board" && [...host.querySelectorAll(".wf-plan-castcell")].map((c) => c.textContent).slice(0, 3).join("|") === "Anna|Kent|AnnaKent", [...host.querySelectorAll(".wf-plan-castcell")].map((c) => c.textContent).join("|"));
check("…and a card names who is in it", [...host.querySelectorAll("[data-card] .wf-plan-chip")].map((c) => c.textContent).join() === "Anna");
await act(async () => (host.querySelector("[data-card] .wf-plan-chip") as HTMLButtonElement).click());
await wait();
check("a name on a card opens its entry", tabNow === "cast" && host.querySelector<HTMLInputElement>(".wf-plan-entry-name")?.value === "Anna");
await act(async () => button(host, "Delete Anna")!.click());
await wait();
check("an entry deleted is taken off its cards", readPlan(ydoc).cast.length === 1 && readPlan(ydoc).cards[0].cast.length === 0);
await act(async () => button(document.body, "Undo")!.click());
await wait();
check("…and Undo puts it back on them", readPlan(ydoc).cast.length === 2 && readPlan(ydoc).cards[0].cast.join() === annaEntry.id);

// ------------------------------------------------------------ the timeline

await act(async () => button(host, "Timeline")!.click());
await wait();
check("an empty timeline says what it is for", /Events in the order they happen/.test(host.textContent ?? ""));
const cols = () => {
  const out: number[] = [];
  editor.state.doc.forEach((n, offset) => {
    if (n.attrs.element === "chapter_heading") out.push(offset);
  });
  return out;
};
const [c1, c2, c3] = cols().map((pos) => ensureChapterId(editor, pos, { level: 5, canWrite: true })!);
ops.addEvent({ title: "They meet as children", chapter: c3 });
ops.addEvent({ title: "Anna waits", chapter: c1 });
ops.addEvent({ title: "Kent arrives", chapter: c2 });
ops.addEvent({ title: "A dream", chapter: null });
// (The chapters given ids are read again 300 ms after.)
await wait(400);
const story = () => [...host.querySelectorAll(".wf-plan-lane.story .wf-plan-event")];
check("events in story order, each with where the book tells it", story().map((e) => e.querySelector("strong")?.textContent).join("|") === "They meet as children|Anna waits|Kent arrives|A dream");
check("one told later than it happens is marked", /Told later than it happens/.test(story()[0].textContent ?? "") && !/Told/.test(story()[1].textContent ?? ""));
check("…and one in no chapter", /Not in the book/.test(story()[3].textContent ?? ""));
check("the book's own order beside it", [...host.querySelectorAll(".wf-plan-lane.book .wf-plan-event strong")].map((e) => e.textContent).join("|") === "Anna waits|Kent arrives|They meet as children");
await act(async () => story()[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })));
await wait(60);
await act(async () => story()[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })));
await wait(60);
check("Alt and an arrow moves an event in the story", story().map((e) => e.querySelector("strong")?.textContent).slice(0, 3).join("|") === "Anna waits|Kent arrives|They meet as children" && !/Told later/.test(host.textContent ?? ""));
await act(async () => (story()[3] as HTMLElement).click());
check("an event opens to be written, with the chapter it is told in", !!host.querySelector(".wf-plan-event.editing select"));
await act(async () => button(host, "Done")!.click());
await act(async () => root.unmount());

// ------------------------------------------------------------ beside the text

const side = mountPoint();
const sideRoot = createRoot(side);
let mentionsOf: string | null = null;
const render = () =>
  act(() =>
    sideRoot.render(
      createElement(PlanPanel, {
        editor,
        ydoc,
        format: "manuscript",
        design,
        readonly: false,
        level: 5,
        mentionsOf,
        onMentions: (id: string | null) => {
          mentionsOf = id;
          void render();
        },
        onOpenFull: () => {},
        onClose: () => {},
      }),
    ),
  );
editor.commands.setTextSelection(3);
await render();
await wait(450);
check("beside the text: the chapter at the caret and its cards", /One/.test(side.querySelector(".wf-plan-panel-chapter")?.textContent ?? "") && /Anna waits/.test(side.textContent ?? ""));
check("…and who is in it", [...side.querySelectorAll(".wf-plan-panel-cast .wf-plan-chip")].map((c) => c.textContent).join() === "Anna 2");
editor.commands.setTextSelection(editor.state.doc.content.size - 2);
await wait(200);
check("the caret moved to another chapter: its cards", /Three/.test(side.querySelector(".wf-plan-panel-chapter")?.textContent ?? "") && !/Anna waits/.test(side.querySelector(".wf-plan-panel-line")?.textContent ?? ""));
mentionsOf = annaEntry.id;
await render();
await wait();
check("a name's mentions, to step through", /3 mentions/.test(side.textContent ?? "") && side.querySelectorAll(".wf-plan-panel-mentions li").length === 3);
await act(async () => button(side, "Next mention")!.click());
check("Next goes to the first, selected in the text", editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === "Anna" && /1 of 3/.test(side.textContent ?? ""));
await act(async () => button(side, "Next mention")!.click());
check("…then the next", editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === "Annie");
await act(async () => sideRoot.unmount());

finish();
