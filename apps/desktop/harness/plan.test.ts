// The story plan's board, mounted: plot lines, cards made and written in
// place, search, dragging a card to another chapter (by mouse, and by a
// finger held still on a phone), the keyboard, Undo, and what someone who
// may only read, or a server not yet updated, gets.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";

import { presetDesign } from "../src/book/model/presets";
import { EDITOR_COMMANDS, offered } from "../src/editor/commands/catalog";
import { RUNNERS } from "../src/editor/commands/run";
import { docContentExtensions } from "../src/editor/schema/content";
import { planOps, readPlan } from "../src/plan/planMap";
import { PlanView, type PlanTab } from "../src/plan/ui/PlanView";
import { ToastHost } from "../src/platform/toast";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
let phone = false;
(window as unknown as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q.includes("max-width") ? phone : !phone, addEventListener() {}, removeEventListener() {} });
const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

const el = (element: string, text: string): JSONContent => ({ type: "paragraph", attrs: { element }, content: [{ type: "text", text }] });
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const book = { type: "doc", content: [el("chapter_heading", "The fall"), p("Anna leaves home."), el("chapter_heading", "The rise"), p("She comes back.")] };

const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
const rect = (el: Element, left: number, top: number, w: number, h: number) =>
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) });
const fire = async (target: EventTarget, type: string, x: number, y: number, pointerType = "mouse") => {
  await act(async () => {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(ev, "pointerType", { value: pointerType });
    target.dispatchEvent(ev);
  });
};

interface Mounted {
  host: HTMLElement;
  root: Root;
  editor: Editor;
  ydoc: Y.Doc;
  closed: () => boolean;
}
function mount(opts: { readonly?: boolean; level?: number; ydoc?: Y.Doc } = {}): Mounted {
  const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: book });
  const ydoc = opts.ydoc ?? new Y.Doc();
  const host = mountPoint();
  const root = createRoot(host);
  let closed = false;
  const Shell = () => {
    const [tab, setTab] = useState<PlanTab>("board");
    return createElement(
      "div",
      null,
      createElement(PlanView, {
        editor,
        ydoc,
        format: "manuscript",
        design: presetDesign("classic"),
        readonly: !!opts.readonly,
        level: opts.level ?? 5,
        tab,
        onTab: setTab,
        onClose: () => void (closed = true),
        onShowInText: () => {},
        onShowOnly: () => {},
        onShowMentions: () => {},
      }),
      createElement(ToastHost),
    );
  };
  act(() => root.render(createElement(Shell)));
  return { host, root, editor, ydoc, closed: () => closed };
}

// ------------------------------------------------------------ lines and cards

const m = mount();
await wait();
const heads = () => [...m.host.querySelectorAll<HTMLElement>(".wf-plan-colhead[data-column]")];
check("the book's chapters are the columns", heads().map((h) => h.querySelector(".wf-plan-colhead-title")?.textContent).join("|") === "The fall|The rise");
check("…each with its words", /5 words/.test(heads()[0].textContent ?? "") && /5 words/.test(heads()[1].textContent ?? ""), heads()[0].textContent ?? "");
check("with no plot line yet, it says what one is", /Plot lines are the stories/.test(m.host.textContent ?? ""));
await act(async () => button(m.host, "Plot line")!.click());
const lineName = m.host.querySelector<HTMLInputElement>(".wf-plan-addline .wf-plan-name-in")!;
check("the first plot line is offered as the main plot", lineName.value === "Main plot");
await act(async () => lineName.blur());
await wait();
check("…and made", readPlan(m.ydoc).lines.map((l) => l.name).join() === "Main plot" && m.host.querySelectorAll(".wf-plan-linehead").length === 1);

const adds = () => [...m.host.querySelectorAll<HTMLButtonElement>(".wf-plan-add")];
await act(async () => adds()[0].click());
await wait();
const editing = m.host.querySelector<HTMLElement>("[data-editing]");
check("+ makes a card and opens it to be written", !!editing && readPlan(m.ydoc).cards.length === 1);
const title = editing!.querySelector<HTMLInputElement>(".wf-plan-card-title-in")!;
await act(async () => setValue(title, "Anna leaves"));
await act(async () => setValue(editing!.querySelector<HTMLTextAreaElement>(".wf-plan-card-text-in")!, "She takes the night train."));
await wait(450);
check("what is typed is kept as it is typed", readPlan(m.ydoc).cards[0].title === "Anna leaves" && readPlan(m.ydoc).cards[0].text === "She takes the night train.");
check("…the card's chapter got its hidden id", !!readPlan(m.ydoc).cards[0].chapter && m.editor.state.doc.child(0).attrs.cid === readPlan(m.ydoc).cards[0].chapter);
await act(async () => button(m.host, "Done")!.click());
check("Done closes it", !m.host.querySelector("[data-editing]") && !!m.host.querySelector("[data-card]"));
await act(async () => adds()[1].click());
await wait();
await act(async () => button(m.host, "Done")!.click());
check("a new card left empty is not kept", readPlan(m.ydoc).cards.length === 1);

// A second card, and a note not in any chapter.
const ops = planOps(m.ydoc);
ops.addCard({ title: "The letter", text: "", line: readPlan(m.ydoc).lines[0].id, chapter: readPlan(m.ydoc).cards[0].chapter });
ops.addCard({ title: "An idea", line: null, chapter: null });
await wait();
check("a note not in a chapter waits under the board", /Unassigned planning notes \(1\)/.test(m.host.textContent ?? "") && /An idea/.test(m.host.querySelector(".wf-plan-loose")?.textContent ?? ""));

// ------------------------------------------------------------ search

const search = m.host.querySelector<HTMLInputElement>(".wf-plan-search input")!;
check("the search says how many there are", search.placeholder === "Search 3 cards", search.placeholder);
await act(async () => setValue(search, "LETTER"));
await wait();
check("…and how many match", /1 of 3/.test(m.host.querySelector(".wf-plan-search")?.textContent ?? "") && m.host.querySelectorAll("[data-card]").length === 1);
await act(async () => setValue(search, ""));
await wait();

// ------------------------------------------------------------ dragging

const cells = () => [...m.host.querySelectorAll<HTMLElement>(".wf-plan-cell[data-drop]")];
const cardEl = (name: string) => [...m.host.querySelectorAll<HTMLElement>("[data-card]")].find((c) => c.textContent?.includes(name))!;
const layout = () => {
  cells().forEach((c, i) => rect(c, i * 250, 100, 250, 300));
  rect(m.host.querySelector(".wf-plan-loose-cards")!, 0, 500, 600, 100);
};
layout();
await fire(cardEl("Anna leaves"), "pointerdown", 50, 150);
await fire(window, "pointermove", 52, 151);
check("a mouse that hardly moves hasn't started a drag", !m.host.querySelector(".wf-plan-ghost"));
await fire(window, "pointermove", 300, 150);
check("past 6 pixels it has: the card follows the pointer", !!m.host.querySelector(".wf-plan-ghost") && cardEl("Anna leaves").classList.contains("dragging"));
await fire(window, "pointerup", 300, 150);
await wait();
const plan1 = readPlan(m.ydoc);
const anna = plan1.cards.find((c) => c.title === "Anna leaves")!;
check("dropped in the next chapter, it is there", !!anna.chapter && anna.chapter === m.editor.state.doc.child(2).attrs.cid && anna.chapter !== plan1.cards.find((c) => c.title === "The letter")!.chapter);
layout();
await fire(cardEl("Anna leaves"), "pointerdown", 300, 150);
await fire(window, "pointermove", 300, 160);
await fire(window, "pointermove", 100, 550);
await fire(window, "pointerup", 100, 550);
await wait();
check("dropped under the board, it is unassigned", readPlan(m.ydoc).cards.find((c) => c.title === "Anna leaves")!.chapter === null);
layout();
await fire(cardEl("The letter"), "pointerdown", 50, 150);
await fire(window, "pointerup", 50, 150);
await wait();
check("a press let go without moving opens the card", !!m.host.querySelector("[data-editing]"));
await act(async () => button(m.host, "Done")!.click());

// ------------------------------------------------------------ the keyboard, and Undo

const letter = cardEl("The letter");
await act(async () => letter.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
await wait();
check("Delete deletes a card, with Undo", !readPlan(m.ydoc).cards.some((c) => c.title === "The letter") && /Deleted the card “The letter”/.test(document.body.textContent ?? ""));
await act(async () => button(document.body, "Undo")!.click());
await wait();
check("…and Undo brings it back", readPlan(m.ydoc).cards.some((c) => c.title === "The letter"));
await act(async () => cardEl("The letter").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })));
await wait();
check("Alt and an arrow moves a card a chapter over", readPlan(m.ydoc).cards.find((c) => c.title === "The letter")!.chapter === m.editor.state.doc.child(2).attrs.cid);
await act(async () => m.host.querySelector(".wf-plan-overlay")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
check("Escape closes the plan", m.closed());
const shared = m.ydoc;
await act(async () => m.root.unmount());

// ------------------------------------------------------------ reading only, and an older server

{
  const r = mount({ readonly: true, ydoc: shared });
  await wait();
  check("someone who may only read sees the cards and can change nothing", r.host.querySelectorAll("[data-card]").length >= 2 && !r.host.querySelector(".wf-plan-add") && !r.host.querySelector(".wf-plan-card-more") && /Changes are off/.test(r.host.textContent ?? ""));
  await act(async () => r.root.unmount());
  const old = mount({ level: 4 });
  await wait();
  check("on a server not yet updated, cards wait to be put in chapters", /once this server is updated/.test(old.host.textContent ?? "") && !old.host.querySelector(".wf-plan-colhead[data-column]"));
  await act(async () => old.root.unmount());
}

// ------------------------------------------------------------ a phone

{
  phone = true;
  const ph = mount();
  await wait();
  const pops = planOps(ph.ydoc);
  const line = pops.addLine("Main plot")!.id;
  pops.addCard({ title: "Held", line, chapter: null });
  await wait();
  check("on a phone the board is the list", !!ph.host.querySelector(".wf-plan-board.list") && !ph.host.querySelector(".wf-plan-grid"));
  const cellsP = [...ph.host.querySelectorAll<HTMLElement>(".wf-plan-cell[data-drop]")];
  cellsP.forEach((c, i) => rect(c, 0, i * 200, 380, 180));
  rect(ph.host.querySelector(".wf-plan-loose-cards")!, 0, 900, 380, 100);
  const held = [...ph.host.querySelectorAll<HTMLElement>("[data-card]")].find((c) => c.textContent?.includes("Held"))!;
  await fire(held, "pointerdown", 50, 950, "touch");
  await fire(window, "pointermove", 50, 940, "touch");
  check("a finger moving at once is a scroll, not a drag", !ph.host.querySelector(".wf-plan-ghost"));
  await fire(window, "pointerup", 50, 940, "touch");
  await fire(held, "pointerdown", 50, 950, "touch");
  await wait(380);
  await fire(window, "pointermove", 50, 250, "touch");
  await fire(window, "pointerup", 50, 250, "touch");
  await wait();
  const moved = readPlan(ph.ydoc).cards[0];
  check("a finger held still, then moved, drags the card to a chapter", !!moved.chapter && moved.chapter === ph.editor.state.doc.child(2).attrs.cid);
  await act(async () => ph.root.unmount());
  phone = false;
}

// ------------------------------------------------------------ commands

{
  const row = EDITOR_COMMANDS.find((r) => r.id === "doc.plan")!;
  check("the plan is offered for books, scripts and Documents, not poetry", offered(row, "manuscript", 5) && offered(row, "screenplay", 5) && offered(row, "none", 5) && !offered(row, "poetry", 5));
  check("each plan command can be run", ["doc.plan", "doc.plan.panel", "doc.plan.cast", "doc.plan.timeline"].every((id) => !!RUNNERS[id]));
}

finish();
