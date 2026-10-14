// The Reports tab in a real, mounted editor: the list of reports, a
// report's numbers, chart and lists, a place shown in the text, the
// chapter table, "this is fine", and what it costs when it is closed.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { hasProofPlugin } from "../src/proof/ProofDecorations";
import { PROOF_MAP } from "../src/proof/rules/docRules";
import { useGlobalRules } from "../src/proof/rules/globalRules";
import { emptyLayer, wordId } from "../src/proof/rules/model";
import { ProofSession } from "../src/proof/session";
import { ProofPanel } from "../src/proof/ui/ProofPanel";
import { STORY } from "./prose";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const story = (): JSONContent => ({
  type: "doc",
  content: STORY.map((para) => ({ type: "paragraph", ...(para.heading ? { attrs: { element: "chapter_heading" } } : {}), content: [{ type: "text", text: para.text }] })),
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const press = async (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error("nothing to press");
    el.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    (el as HTMLElement).click();
  });

// ---------------------------------------------------- the session's part

{
  useGlobalRules.getState().load(emptyLayer(), true);
  const ydoc = new Y.Doc();
  const e = new Editor({ element: mountPoint(), extensions: [...docContentExtensions({ history: false }), Suggesting.configure({ author: () => "Ana" }), Collaboration.configure({ document: ydoc })] });
  e.commands.setContent(story());
  const s = new ProofSession(e, "manuscript", "en-GB", { ydoc, canWrite: true });
  s.start();
  s.flush();
  const all = { kind: "all" } as const;
  const sentences = s.report("sentences", all);
  check("a report is made from the reading the checks already did", !!sentences && sentences.groups.some((g) => g.id === "start"));
  check("…and the same report asked for again is the same object", s.report("sentences", all) === sentences);
  const rows = s.chapters();
  check("the chapters are the manuscript's", rows.map((r) => r.name).join() === "The Letter,The Garden,The Answer,The Road");
  const run = sentences!.groups.find((g) => g.id === "start")!.items[0];
  check("a report's place is selected in the text", s.selectHit(run.hits[1]) && e.state.doc.textBetween(e.state.selection.from, e.state.selection.to) === "She");
  s.markHits(run.hits, 1, 2);
  const drawn = [...e.view.dom.querySelectorAll(".wf-proof-hit.s2")];
  check("…and its fellows are tinted, that one marked", drawn.length === 4 && e.view.dom.querySelectorAll(".wf-proof-hit.s2.current").length === 1 && drawn.every((d) => d.textContent === "She"));
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 5)));
  check("the caret is in the first chapter", s.chapterAtCaret() === 0);
  s.goToBlock(rows[2].block);
  check("going to a chapter puts the caret in it", s.chapterAtCaret() === 2);
  const para = e.state.doc.child(1);
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 30, 30 + para.nodeSize + 10)));
  const picked = s.selectionScope();
  check("a selection is a scope of the paragraphs it touches", picked?.kind === "blocks" && picked.to - picked.from === 2 && (s.report("overview", picked!)?.summary.find((m) => m.id === "words")?.value ?? 0) < (s.report("overview", all)?.summary.find((m) => m.id === "words")?.value ?? 0));

  // After the text changes a report's old place is not trusted.
  e.view.dispatch(e.state.tr.insertText("Now ", 12));
  check("a place from before an edit is not gone to: the text is read again instead", s.selectHit(run.hits[0]) === false && s.report("sentences", all) !== sentences);
  const fresh = s.report("sentences", all)!.groups.find((g) => g.id === "start")!.items[0];
  check("…and the new report's place is right", s.selectHit(fresh.hits[0]) && e.state.doc.textBetween(e.state.selection.from, e.state.selection.to) === "She");

  // This is fine.
  const close = () => s.report("repeats", all)?.groups.find((g) => g.id === "close")?.items.map((i) => i.key) ?? [];
  check("(rope and lantern come again)", close().includes("rope") && close().includes("lantern"));
  s.allowWord("rope", "document");
  check("a word said to be fine in this document is kept in its rules", JSON.parse(String(ydoc.getMap(PROOF_MAP).get(`w:${wordId("rope")}`))).k === "allow" && !close().includes("rope") && close().includes("lantern"));
  s.allowWord("lantern", "yours");
  check("…or in your own", useGlobalRules.getState().layer.words[wordId("lantern")]?.k === "allow" && !close().includes("lantern"));
  s.watchWord("letter", "document");
  check("a word to watch becomes a finding in Checks", s.issues().some((i) => i.id === `words:l.${wordId("letter")}`));
  s.stop();
  check("closing leaves nothing in the text", e.view.dom.querySelectorAll(".wf-proof-hit").length === 0 && !hasProofPlugin(e));
  e.destroy();
  useGlobalRules.getState().load(emptyLayer(), true);
}

// ------------------------------------------- a place is brought into view

{
  // The page scrolls in an element round the editor. The row that was
  // clicked has the focus, not the text: the editor's own scrolling does
  // nothing then, so the panel scrolls the page itself.
  const scroller = mountPoint();
  scroller.style.overflowY = "auto";
  const mount = scroller.appendChild(document.createElement("div"));
  const e = new Editor({ element: mount, extensions: [...docContentExtensions({}), Suggesting.configure({ author: () => "Ana" })], content: story() });
  (scroller as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 0, right: 800, width: 800, height: 600 });
  let at = { top: 2400, bottom: 2420, left: 0, right: 0 };
  (e.view as unknown as { coordsAtPos: () => unknown }).coordsAtPos = () => at;
  const s = new ProofSession(e, "manuscript", "en-GB");
  s.start();
  s.flush();
  const button = document.body.appendChild(document.createElement("button"));
  button.focus();
  check("(the focus is in the panel, as after a click on a row)", !e.view.hasFocus());
  const run = s.report("sentences", { kind: "all" })!.groups.find((g) => g.id === "start")!.items[0];
  check("a report's place far down the page is scrolled to", s.selectHit(run.hits[0]) && scroller.scrollTop === 2400 - (100 + 200), String(scroller.scrollTop));
  check("…and the text is given the focus, to be typed over at once", e.view.hasFocus() && e.state.doc.textBetween(e.state.selection.from, e.state.selection.to) === "She");
  scroller.scrollTop = 0;
  at = { top: 300, bottom: 320, left: 0, right: 0 };
  s.selectHit(run.hits[1]);
  check("a place already in view is left where it is", scroller.scrollTop === 0);
  at = { top: 40, bottom: 60, left: 0, right: 0 };
  scroller.scrollTop = 900;
  s.selectHit(run.hits[2]);
  check("a place above what is shown is scrolled back up to", scroller.scrollTop === 900 + 40 - 300, String(scroller.scrollTop));
  // A finding's place, and a chapter, go the same way.
  at = { top: 5000, bottom: 5020, left: 0, right: 0 };
  scroller.scrollTop = 0;
  s.goToBlock(s.chapters()[3].block);
  check("going to a chapter scrolls to it", scroller.scrollTop === 4700);
  scroller.scrollTop = 0;
  e.view.dispatch(e.state.tr.insertText(" And the the end.", e.state.doc.content.size - 1));
  s.flush();
  const issue = s.issues().find((i) => i.id === "doubled:the")!;
  check("choosing a finding's place scrolls to it", s.select(s.view(issue, issue.places[0])) && scroller.scrollTop === 4700);
  // A touch screen: the text is shown and the keyboard is left down.
  button.focus();
  (window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} });
  scroller.scrollTop = 0;
  s.select(s.view(issue, issue.places[0]));
  check("on a touch screen the place is shown and the text is not given the focus", scroller.scrollTop === 4700 && !e.view.hasFocus());
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  s.stop();
  e.destroy();
}

// --------------------------------------------------------------- the tab

await (async () => {
  const ydoc = new Y.Doc();
  const e = new Editor({ element: mountPoint(), extensions: [...docContentExtensions({ history: false }), Suggesting.configure({ author: () => "Ana" }), Collaboration.configure({ document: ydoc })] });
  e.commands.setContent(story());
  const host = mountPoint();
  const root = createRoot(host);
  const render = (format: string) =>
    act(async () => {
      root.render(createElement(ProofPanel, { key: format, editor: e, format, lang: "en-GB", ydoc, canWrite: true, title: "A Story", comments: 0, changes: 0, onOpenComments() {}, onOpenChanges() {}, onClose() {} }));
      await wait(40);
    });
  await render("manuscript");
  const tabs = () => [...host.querySelectorAll('[role="tab"]')] as HTMLElement[];
  check("a manuscript has Checks, Reports and Rules", tabs().map((t) => t.textContent).join() === "Checks,Reports,Rules");
  await press(tabs()[1]);
  const cards = () => [...host.querySelectorAll(".wf-proof-reports li button")] as HTMLElement[];
  check("the reports are listed, each with what it found in a line", cards().length === 8 && /words in \d+ sentences\./.test(cards()[0].textContent ?? "") && (cards()[2].textContent ?? "").includes("Sentences average"), cards().map((c) => c.textContent).join(" | "));
  check("and nothing under them to copy", ![...host.querySelectorAll(".wf-proof-reports button")].some((b) => (b.textContent ?? "").startsWith("Copy ")));
  const scopes = () => [...host.querySelectorAll(".wf-proof-scope button")] as HTMLButtonElement[];
  check("the whole book is reported on to begin with", scopes()[0].classList.contains("active") && scopes()[0].textContent === "Whole book" && scopes()[2].disabled);

  await press(cards()[2]);
  check("a report opens with its numbers", host.querySelector(".wf-proof-title")?.textContent === "Sentences" && host.querySelectorAll(".wf-proof-measures li").length === 3);
  const bars = host.querySelectorAll(".wf-proof-strip rect");
  check("…its chart, a bar a sentence", bars.length > 30 && host.querySelector(".wf-proof-strip")?.getAttribute("role") === "img");
  check("…and how sentences begin, as named bars", [...host.querySelectorAll(".wf-proof-bars li span")].some((s) => s.textContent === "He, she, they"));
  const heads = () => [...host.querySelectorAll(".wf-proof-hits-head")].map((h) => h.textContent);
  check("…and its lists of places, each with its own colour", heads().some((h) => h?.startsWith("Sentences that begin the same way")) && host.querySelectorAll(".wf-proof-swatch.s0").length === 1 && host.querySelectorAll(".wf-proof-swatch.s1").length === 1, heads().join(" | "));
  const items = () => [...host.querySelectorAll(".wf-proof-item")] as HTMLElement[];
  const she = () => items().find((i) => i.textContent?.startsWith("She begins 4"));
  await press(she());
  check("choosing a row shows its first place in the text", e.state.doc.textBetween(e.state.selection.from, e.state.selection.to) === "She" && e.view.dom.querySelectorAll(".wf-proof-hit.current").length === 1);
  const first = e.state.selection.from;
  check("a bar appears to step through its places", host.querySelector(".wf-proof-walk .wf-proof-at")?.textContent === "1 of 4");
  await press(host.querySelector('.wf-proof-walk button[aria-label="Next place"]'));
  check("…forward", e.state.selection.from > first && host.querySelector(".wf-proof-walk .wf-proof-at")?.textContent === "2 of 4");
  await press(host.querySelector('.wf-proof-walk button[aria-label="Previous place"]'));
  await press(host.querySelector('.wf-proof-walk button[aria-label="Previous place"]'));
  check("…and round to the last", host.querySelector(".wf-proof-walk .wf-proof-at")?.textContent === "4 of 4");
  // The chart takes a click to its sentence.
  const strip = host.querySelector(".wf-proof-strip") as unknown as SVGSVGElement;
  (strip as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 240, height: 64, right: 240, bottom: 64 });
  await act(async () => strip.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 1 })));
  check("a click on the chart goes to that sentence", e.state.doc.textBetween(e.state.selection.from, e.state.selection.to).startsWith("The harbour lay under a thin mist"));

  await press(host.querySelector('button[aria-label="All reports"]'));
  check("leaving a report takes its marks out of the text", e.view.dom.querySelectorAll(".wf-proof-hit").length === 0 && cards().length === 8);

  // The chapter table.
  await press(cards()[1]);
  const chapterRows = () => [...host.querySelectorAll(".wf-proof-chapters li button")] as HTMLElement[];
  check("the chapter table has a row a chapter", chapterRows().map((r) => r.querySelector("b")?.textContent).join() === "The Letter,The Garden,The Answer,The Road" && (chapterRows()[0].textContent ?? "").includes("% speech"));
  await press(chapterRows()[2]);
  check("choosing a chapter reports on it alone", scopes()[1].classList.contains("active") && host.textContent?.includes("Reporting on The Answer.") === true);
  await press(host.querySelector('button[aria-label="All reports"]'));
  check("…in every report", /^Overview\d+ words/.test(cards()[0].textContent ?? "") && Number((cards()[0].textContent ?? "").match(/(\d+) words/)?.[1]) < 100, cards()[0].textContent ?? "");
  await press(scopes()[0]);

  // This is fine, from the list.
  await press(cards()[3]);
  const rope = () => items().find((i) => i.textContent?.startsWith("rope"));
  check("the repeats list the words that come again", !!rope());
  await press(rope()?.parentElement?.querySelector(".wf-proof-item-more"));
  const menu = [...document.querySelectorAll(".wf-flyout-item")];
  check("a word can be said to be fine, here or everywhere, or watched", menu.map((m) => m.querySelector(".wf-flyout-text")?.textContent).join() === "This is fine,This is fine,Watch this word");
  await press(menu[0]);
  check("…after which it is not listed", !rope() && `w:${wordId("rope")}` in (ydoc.getMap(PROOF_MAP).toJSON() as object));

  // Typing while a report is open.
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 40)));
  const caret = e.state.selection.from;
  await act(async () => {
    e.view.dispatch(e.state.tr.insertText("x", 3));
    await wait(500);
  });
  check("the report keeps up with the writing and never moves the caret", e.state.selection.from === caret + 1 && !!rope() === false);

  // The panel made wider.
  const panel = () => host.querySelector("aside.wf-proof") as HTMLElement;
  const widen = () => host.querySelector('button[aria-label="Make the panel wider"], button[aria-label="Make the panel narrower"]') as HTMLElement;
  check("the panel starts at its usual width", !panel().classList.contains("wide") && widen().getAttribute("aria-label") === "Make the panel wider");
  await press(widen());
  check("it can be made wider, and that is remembered on the device", panel().classList.contains("wide") && widen().getAttribute("aria-pressed") === "true" && localStorage.getItem("wf-proof-wide") === "on");
  await press(host.querySelector('button[aria-label="All reports"]'));
  await press(cards()[1]);
  check("made wider, the chapter table shows more of each chapter", [...host.querySelectorAll(".wf-proof-chapters .wf-proof-cells")][0]?.textContent?.includes("repeats in 1,000") === true && [...host.querySelectorAll(".wf-proof-chapters .wf-proof-cells")][0]?.textContent?.includes("long sentences") === true);
  await press(widen());
  check("…and narrower again", !panel().classList.contains("wide") && localStorage.getItem("wf-proof-wide") === "off");
  {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const rule = css.slice(css.indexOf(".wf-proof-row,\n.wf-proof-reports li button,"));
    check("a row that holds a sentence wraps (the app's buttons keep to one line)", rule.startsWith(".wf-proof-row,") && rule.slice(0, rule.indexOf("}")).includes("white-space: normal") && rule.slice(0, rule.indexOf("}")).includes(".wf-proof-item"));
    check("extra cells show only in the wider panel", css.includes(".wf-proof-wide-only {\n  display: none;") && css.includes(".wf-proof.wide .wf-proof-cells .wf-proof-wide-only {\n  display: inline;"));
  }

  await render("poetry");
  check("a poem has no Reports tab", tabs().map((t) => t.textContent).join() === "Checks,Rules");
  await act(async () => root.unmount());
  check("unmounting leaves the editor as it was", !hasProofPlugin(e));
  e.destroy();
})();

finish();
