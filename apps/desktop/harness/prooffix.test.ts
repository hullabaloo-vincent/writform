// The checker on a real, mounted editor: how a document's paragraphs are
// read (and mapped back to positions), fixes and what they do in each
// review mode, a place found again after the text has moved, and the
// panel itself.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { changesOf } from "../src/editor/review/changes";
import { resolveAll, setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { endOf, extract, posOf, solid } from "../src/proof/extract";
import { variantsLoaded } from "../src/proof/checks/spelling";
import { hasProofPlugin } from "../src/proof/ProofDecorations";
import { ProofSession, type PlaceView } from "../src/proof/session";
import { ProofPanel } from "../src/proof/ui/ProofPanel";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

type Mark = { type: string; attrs?: Record<string, unknown> };
const t = (text: string, ...marks: Mark[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const p = (...content: (string | JSONContent)[]): JSONContent => ({ type: "paragraph", content: content.map((c) => (typeof c === "string" ? t(c) : c)) });
const el = (element: string, text: string): JSONContent => ({ type: "paragraph", attrs: { element }, content: [t(text)] });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const struck = (text: string): JSONContent => t(text, { type: "deletion", attrs: { a: "Ana", t: 1 } });
const note = (text: string): JSONContent => ({ type: "footnote", content: [t(text)] });
const list = (...items: string[]): JSONContent => ({ type: "bulletList", content: items.map((i) => ({ type: "listItem", content: [p(i)] })) });
const table = (...cells: string[]): JSONContent => ({ type: "table", content: [{ type: "tableRow", content: cells.map((c) => ({ type: "tableCell", content: [p(c)] })) }] });

const make = (content: JSONContent, more: { ydoc?: Y.Doc; who?: string } = {}) =>
  new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions({ history: !more.ydoc }), Suggesting.configure({ author: () => more.who ?? "Ana" }), ...(more.ydoc ? [Collaboration.configure({ document: more.ydoc })] : [])],
    ...(more.ydoc ? {} : { content }),
  });
const paras = (e: Editor): string[] => {
  const out: string[] = [];
  e.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent);
    return !node.isTextblock;
  });
  return out;
};
/** A checker that has read the text. */
const open = (e: Editor, format = "none") => {
  const s = new ProofSession(e, format, "en-GB");
  s.start();
  s.flush();
  return s;
};
const issueOf = (s: ProofSession, id: string) => s.issues().find((i) => i.id === id);
const viewsOf = (s: ProofSession, id: string): PlaceView[] => {
  const issue = issueOf(s, id);
  return issue ? issue.places.map((place) => s.view(issue, place)) : [];
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- a document as it is read

{
  const e = make(
    doc(
      { type: "heading", attrs: { level: 2 }, content: [t("A Heading")] },
      p("It was ", t("the the", { type: "italic" }), " end."),
      p("one ", struck("gone "), "two"),
      p("A fact", note("a note is is here"), " and more."),
      { type: "codeBlock", content: [t("the the code")] },
      p("Run ", t("the the", { type: "code" }), " now."),
      list("First item", "Second item", "Third item"),
      table("A cell", "Another"),
      { type: "blockquote", content: [p("Quoted words.")] },
      p("The end."),
    ),
  );
  const x = extract(e.state.doc, "none");
  const { blocks } = x.scan;
  const at = (text: string) => blocks.findIndex((b) => b.text === text);
  check("each paragraph is a block, a heading too", blocks[0].role === "heading" && blocks[0].heading === "h2" && at("It was the the end.") === 1);
  check("italic is noted as a span of the text", blocks[1].italic.join() === "7,14");
  const pos = x.places[1];
  check("an offset in the text is a position in the document", e.state.doc.textBetween(posOf(pos, 7) as number, endOf(pos, 14) as number) === "the the");
  check("words someone suggested deleting are not read", at("one two") === 2);
  check("…and a stretch that runs across them is not one stretch of the document", !solid(x.places[2], 0, 7) && solid(x.places[2], 0, 4) && solid(x.places[2], 4, 7));
  const n = at("a note is is here");
  check("a footnote is read on its own, and leaves no mark in its paragraph", n === 4 && blocks[n].note && at("A fact and more.") === 3);
  check("…and its words map to the note's own positions", e.state.doc.textBetween(posOf(x.places[n], 7) as number, endOf(x.places[n], 12) as number) === "is is");
  check("a stretch across the note's mark is not one stretch", !solid(x.places[3], 4, 10) && solid(x.places[3], 0, 6));
  check("a code block is not read at all", !blocks.some((b) => b.text.includes("code")));
  check("code in a sentence is one object", blocks[at("Run ￼ now.")] !== undefined);
  const items = blocks.filter((b) => b.list);
  check("list items know their list and their place in it", items.map((b) => b.list?.part).join() === "first,middle,last" && new Set(items.map((b) => x.scan.list[blocks.indexOf(b)])).size === 1 && x.scan.list[blocks.indexOf(items[0])] > 0);
  check("a table cell and a block quote say so", blocks[at("A cell")].cell && blocks[at("Quoted words.")].quoted && blocks[at("Quoted words.")].role === "extract");
  check("prose runs on from the paragraph before, a heading does not", x.scan.prev[1] === -1 && x.scan.prev[2] === 1 && x.scan.prev[at("First item")] === -1);
  const again = extract(e.state.doc, "none");
  check("an unchanged paragraph is the same object next time", again.scan.blocks.every((b, i) => b === blocks[i]));
  e.view.dispatch(e.state.tr.insertText("!", 3));
  const after = extract(e.state.doc, "none");
  check("…and after typing only the paragraph typed in is read again", after.scan.blocks.filter((b, i) => b !== blocks[i]).length === 1);
  e.destroy();

  const ms = make(doc(el("chapter_heading", "The Start"), el("paragraph", "Body."), el("epigraph", "Old words."), el("verse", "A line")));
  const m = extract(ms.state.doc, "manuscript").scan.blocks;
  check("a manuscript's elements have their roles", m.map((b) => b.role).join() === "heading,body,extract,verse" && m[0].heading === "chapter");
  const sp = extract(ms.state.doc, "screenplay").scan.blocks;
  check("…and the same paragraphs read otherwise in another kind of document", sp[0].role === "body");
  ms.destroy();
  const sc = make(doc(el("scene_heading", "INT. HOUSE - DAY"), el("character", "ANNA"), el("dialogue", "No no."), el("action", "She leaves.")));
  check("a screenplay's cues are capitals and its dialogue is speech", extract(sc.state.doc, "screenplay").scan.blocks.map((b) => b.role).join() === "caps,caps,speech,body");
  sc.destroy();
}

// ------------------------------------------------------------------- fixes

{
  const e = make(doc(p("It was the the end."), list("Two  spaces here", "Fine"), table("A cell ,then", "ok"), p("A fact", note("a note is is here"), " and more."), p("Mid ", t("the the", { type: "italic" }), " night.")));
  const s = open(e);
  check("the checker is in the editor while it is open", hasProofPlugin(e));
  const the = viewsOf(s, "doubled:the");
  check("a place is the words it says it is", the.length === 2 && the.every((v) => e.state.doc.textBetween(v.from, v.to) === "the the" && v.match === "the the"));
  check("…with the words round it", the[0].before === "It was " && the[0].after === " end.");
  const sel = e.state.selection.from;
  check("choosing a place selects it", s.select(the[0]) && e.state.selection.from === the[0].from && e.state.selection.to === the[0].to);
  check("…and draws the finding's places, that one marked", e.view.dom.querySelectorAll(".wf-proof-hit").length >= 2 && e.view.dom.querySelectorAll(".wf-proof-hit.current").length >= 1);
  check("(the selection had been elsewhere)", sel !== the[0].from);
  check("a fix changes the words", s.fix(the[0], "") === "done" && paras(e)[0] === "It was the end.");
  check("…and the finding has one place fewer", viewsOf(s, "doubled:the").length === 1);
  check("a fix inside italics keeps them", s.fix(viewsOf(s, "doubled:the")[0], "") === "done" && paras(e).includes("Mid the night.") && e.getHTML().includes("<em>the</em>"), e.getHTML());
  check("a fix in a list item", s.fix(viewsOf(s, "spaces:double")[0], "") === "done" && paras(e).includes("Two spaces here"));
  check("a fix in a table cell", s.fix(viewsOf(s, "spaces:before")[0], "") === "done" && paras(e).includes("A cell,then"));
  const inNote = viewsOf(s, "doubled:is")[0];
  check("a place in a footnote selects the note", s.select(inNote) && e.state.selection instanceof NodeSelection && (e.state.selection as NodeSelection).node.type.name === "footnote");
  const noteFix = s.fix(inNote, "");
  check("…and its fix changes the note's words", noteFix === "done" && JSON.stringify(e.getJSON()).includes("a note is here"), `${noteFix} ${JSON.stringify(e.getJSON()).match(/a note[^"]*/)?.[0]}`);
  check("a clean document has nothing left but the missing space", s.issues().map((i) => i.id).join() === "spaces:missing", s.issues().map((i) => i.id).join());
  s.stop();
  check("closing takes the checker out of the editor", !hasProofPlugin(e) && e.view.dom.querySelectorAll(".wf-proof-hit").length === 0);
  const read = s.readings;
  for (let i = 0; i < 200; i += 1) e.view.dispatch(e.state.tr.insertText("x", 1));
  check("…and nothing is read after that, however much is typed", s.readings === read);
  e.destroy();
}

// ---- fix all, and undo

{
  const e = make(doc(p("It was the the end."), p("And the the middle."), p("So the the start."), p("Two  spaces.")));
  const s = open(e);
  const issue = issueOf(s, "doubled:the");
  check("Fix all says how many it will change", !!issue && s.fixableCount(issue, "") === 3);
  check("Fix all changes them all", s.fixAll("doubled:the", "") === 3 && paras(e).slice(0, 3).join("|") === "It was the end.|And the middle.|So the start.");
  e.commands.undo();
  check("…as one step to undo", paras(e).slice(0, 3).join("|") === "It was the the end.|And the the middle.|So the the start.");
  s.flush();
  check("…after which the finding is back", viewsOf(s, "doubled:the").length === 3);
  s.stop();
  e.destroy();
}

// ---- found again, or gone

{
  const e = make(doc(p("Then it was the the end of a long day."), p("Another paragraph.")));
  const s = open(e);
  const view = viewsOf(s, "doubled:the")[0];
  e.view.dispatch(e.state.tr.insert(0, e.schema.nodes.paragraph.create(null, e.schema.text("A new first paragraph."))));
  check("a place is found again after the text above it has grown", s.fix(view, "") === "done" && paras(e)[1] === "Then it was the end of a long day.");
  e.commands.undo();
  s.flush();
  const stale = viewsOf(s, "doubled:the")[0];
  const from = stale.from;
  e.view.dispatch(e.state.tr.insertText("start", from - 12, from - 9));
  check("a place whose words have changed is not touched", s.fix(stale, "") === "changed" && paras(e)[1].includes("the the"), paras(e)[1]);
  s.stop();
  e.destroy();
}

// ---- suggesting, viewing

{
  const e = make(doc(p("It was the the end."), p("Two  spaces.")));
  const s = open(e);
  setReviewMode(e, "suggest");
  check("in Suggesting a fix is a suggestion", s.fix(viewsOf(s, "doubled:the")[0], "") === "done" && changesOf(e.state.doc).length === 1 && e.state.doc.textContent.includes("the the"));
  check("…and the finding is gone, since the text is read as it would stand", !issueOf(s, "doubled:the"));
  setReviewMode(e, "edit");
  resolveAll(e, "reject");
  s.flush();
  check("rejecting the suggestion brings the finding back", viewsOf(s, "doubled:the").length === 1);
  setReviewMode(e, "view");
  const before = e.getJSON();
  const view = viewsOf(s, "doubled:the")[0];
  check("in Viewing nothing can be fixed", view.fixes.length === 0 && s.fix(view, "") === "locked" && s.fixAll("doubled:the", "") === 0 && JSON.stringify(e.getJSON()) === JSON.stringify(before));
  s.stop();
  e.destroy();
}

// ---- a place that is not one stretch of the document

{
  const e = make(doc(p("Mid the ", struck("old "), "the night.")));
  const s = open(e);
  const view = viewsOf(s, "doubled:the")[0];
  check("words either side of a suggested deletion are still read together", !!view && view.match === "the the");
  check("…but a fix across it is not offered", view.fixes.length === 0 && s.fix(view, "") === "locked");
  s.stop();
  e.destroy();
}

// ---- reading while the writing goes on

await (async () => {
  const e = make(doc(p("It was the the end."), p("A second paragraph to type in.")));
  const s = new ProofSession(e, "none", "en-GB");
  s.start();
  check("a reading starts when the checker opens and is not there at once", s.status === "reading" && s.issues().length === 0);
  // (However busy the machine: until it has, and until the table of
  // spellings it fetches for English has come and been read with.)
  const until = async (done: () => boolean, most = 3000) => {
    for (let waited = 0; !done() && waited < most; waited += 10) await wait(10);
  };
  await until(() => s.status === "ready" && variantsLoaded());
  await wait(30);
  check("…and arrives a moment later", s.status === "ready" && !!issueOf(s, "doubled:the"));
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 30)));
  const caret = e.state.selection.from;
  e.view.dispatch(e.state.tr.insertText("So so. ", 1));
  const was = s.readings;
  await wait(120);
  check("typing is not read at once", s.readings === was);
  await until(() => s.readings > was, 2000);
  await wait(60);
  check("…but after a pause", s.readings === was + 1);
  check("a reading never moves the selection", e.state.selection.from === caret + 7);
  s.stop();
  e.destroy();
})();

// ---- every node made anew (a co-writer's change)

{
  const ya = new Y.Doc();
  const yb = new Y.Doc();
  const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote");
  const a = make(doc(), { ydoc: ya, who: "Ana" });
  const b = make(doc(), { ydoc: yb, who: "Bo" });
  a.commands.setContent(doc(...Array.from({ length: 60 }, (_, i) => p(`Paragraph ${i} was the the same as the rest.`))));
  sync(ya, yb);
  sync(yb, ya);
  const s = open(a);
  check("sixty paragraphs, sixty places", viewsOf(s, "doubled:the").length === 60 && s.made === 60);
  const first = a.state.doc.firstChild;
  b.view.dispatch(b.state.tr.insertText("Changed. ", 1));
  sync(yb, ya);
  check("(a co-writer's change makes every node anew)", a.state.doc.firstChild !== first && a.state.doc.child(30) !== undefined);
  s.flush();
  check("…and only the paragraph that changed is read again", s.made === 1, String(s.made));
  check("the places are where the text is now", viewsOf(s, "doubled:the").every((v) => a.state.doc.textBetween(v.from, v.to) === "the the"));
  s.stop();
  a.destroy();
  b.destroy();
}

// ------------------------------------------------------------------- panel

await (async () => {
  const e = make(doc(p("It was the the end."), p("And the the middle."), p("“Go,” she said. \"Stay,\" he said."), p("Two  spaces.")));
  const host = mountPoint();
  const root = createRoot(host);
  const calls: string[] = [];
  const render = (comments: number) =>
    root.render(
      createElement(ProofPanel, { editor: e, format: "none", lang: "en-GB", comments, changes: 0, onOpenComments: () => calls.push("comments"), onOpenChanges: () => calls.push("changes"), onClose: () => calls.push("close") }),
    );
  act(() => render(2));
  check("the panel says it is reading", host.textContent?.includes("Reading the text") === true, JSON.stringify(host.textContent));
  await act(async () => {
    await wait(40);
  });
  const rows = () => [...host.querySelectorAll(".wf-proof-row")] as HTMLElement[];
  const row = (title: string) => rows().find((r) => r.textContent?.includes(title)) as HTMLElement;
  check("…then lists what it found, under its groups", rows().length === 4 && [...host.querySelectorAll(".wf-proof-group:not(.wf-proof-hand) h4")].map((h) => h.textContent).join() === "Punctuation,Left in the text,Tidy up", rows().map((r) => r.textContent).join(" / "));
  check("with a count for each", row("the the").querySelector("b")?.textContent === "2" && host.querySelector(".wf-proof-sum")?.textContent === "9 places to look at.", host.querySelector(".wf-proof-sum")?.textContent ?? "");
  check("open comments are a finding of their own", row("Open comments").querySelector("b")?.textContent === "2");

  await act(async () => row("the the").click());
  const snips = () => [...host.querySelectorAll(".wf-proof-snip")] as HTMLElement[];
  check("a finding lists its places with the words marked", snips().length === 2 && snips()[0].querySelector("mark")?.textContent === "the the");
  await act(async () => snips()[1].click());
  check("choosing one selects it in the text", e.state.doc.textBetween(e.state.selection.from, e.state.selection.to) === "the the" && e.state.selection.from > 20);
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLElement;
  await act(async () => button("Fix all 2").click());
  check("Fix all changes them and the finding closes", paras(e).slice(0, 2).join("|") === "It was the end.|And the middle." && rows().length === 3 && !row("the the"));

  await act(async () => row("Straight and curly quote marks").click());
  const radios = [...host.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
  check("a thing done two ways asks which is meant, and names no winner in a tie", radios.length === 2 && radios.every((r) => !r.checked) && snips().length === 4 && !button("Fix all 2"));
  await act(async () => radios[0].click());
  check("choosing one lists the places to change", snips().length === 2 && !!button("Fix all 2"));
  await act(async () => button("Fix all 2").click());
  check("…and changes them, each mark facing the right way", paras(e)[2] === "“Go,” she said. “Stay,” he said.", paras(e)[2]);

  await act(async () => row("Open comments").click());
  await act(async () => button("Show the comments").click());
  check("a finding that lives elsewhere opens that list", calls.join() === "comments");
  await act(async () => (host.querySelector('button[aria-label="All findings"]') as HTMLElement).click());
  await act(async () => row("Two spaces").click());
  // (As a click is: a press on the element, then the click.)
  const press = async (el: Element) =>
    act(async () => {
      el.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
      (el as HTMLElement).click();
    });
  await press(host.querySelector(".wf-proof-aside") as HTMLElement);
  const choices = [...document.querySelectorAll(".wf-flyout-item")].map((b) => b.querySelector(".wf-flyout-text")?.textContent);
  check("setting aside asks for how long (with no document to keep it in, two choices)", choices.join() === "Just for now,Never flag in my documents", choices.join());
  await press([...document.querySelectorAll(".wf-flyout-item")].find((b) => b.textContent?.includes("Just for now")) as HTMLElement);
  check("a finding can be set aside", !row("Two spaces") && paras(e)[3] === "Two  spaces.");
  await act(async () => render(0));
  check("what an editor hands over is offered under the list", [...host.querySelectorAll(".wf-proof-hand button")].map((b) => b.textContent).join("|") === "Copy the names and terms|Copy a table of abbreviations|Copy what was changed here");
  check("with nothing left, it says so", host.querySelector(".wf-proof-sum")?.textContent?.startsWith("Nothing to look at") === true, host.querySelector(".wf-proof-sum")?.textContent ?? "");
  await act(async () => (host.querySelector('button[aria-label="Close"]') as HTMLElement).click());
  check("Close asks to be closed", calls.join() === "comments,close");
  await act(async () => root.unmount());
  check("unmounting takes the checker out of the editor", !hasProofPlugin(e));
  e.destroy();
})();

finish();
