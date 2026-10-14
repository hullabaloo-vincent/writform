// One chapter on its own: the rest of the text hidden (never taken out),
// the caret kept inside, Select All, Backspace and Delete at its edges, a
// jump elsewhere moving to the chapter there, and what reads the text
// (Find, the word count, read aloud's start, grow selection, formatting
// marks, page view) keeping to it.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { DocumentStats } from "../src/apps/documents/DocumentEditor";
import { FindBar } from "../src/apps/documents/FindBar";
import { presetDesign } from "../src/book/model/presets";
import { canStepChapter, chapterAt, chapterFocus, ChapterFocus, focusChapterAt, showEverything, stepChapter } from "../src/editor/ChapterFocus";
import { RUNNERS } from "../src/editor/commands/run";
import { FormatMarks, markedStretch, refreshFormatMarks } from "../src/editor/FormatMarks";
import { growSelection } from "../src/editor/format/grow";
import { DEFAULT_SETTINGS, pageSpecFor } from "../src/apps/documents/docSettings";
import { Paginate, reflowPagination, type PageLayoutResult } from "../src/editor/Paginate";
import { docContentExtensions } from "../src/editor/schema/content";
import { showRange } from "../src/editor/ui/reveal";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const t = (text: string): JSONContent => ({ type: "text", text });
const p = (text: string, element: string | null = null): JSONContent => ({ type: "paragraph", ...(element ? { attrs: { element } } : {}), content: [t(text)] });
const book: JSONContent[] = [
  p("Before any chapter."),
  p("One", "chapter_heading"),
  p("The first chapter opens with a harbour."),
  p("It ends at the harbour too."),
  p("Two", "chapter_heading"),
  p("The second chapter has a harbour in it."),
  p("And a lighthouse."),
  p("Three", "chapter_heading"),
  p("The third chapter has no harbour at all, only a harbour master."),
];

let lost = 0;
const make = (content = book, format = "manuscript") =>
  new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(), ChapterFocus.configure({ format: () => format, design: () => presetDesign("classic"), onLost: () => (lost += 1) }), FormatMarks.configure({ on: () => format === "none" })],
    content: { type: "doc", content },
  });
const posOf = (e: Editor, text: string) => {
  let at = -1;
  e.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text);
  });
  return at;
};
const hidden = (e: Editor) => [...(e.view.dom as HTMLElement).children].filter((el) => el.classList.contains("wf-unfocused")).map((el) => el.textContent).join("|");
const shownText = (e: Editor) => [...(e.view.dom as HTMLElement).children].filter((el) => !el.classList.contains("wf-unfocused")).map((el) => el.textContent).join("|");
const press = (e: Editor, key: string, mods: { ctrl?: boolean } = {}): boolean => {
  const event = new KeyboardEvent("keydown", { key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : key === "Backspace" ? 8 : key === "Delete" ? 46 : 0, ctrlKey: !!mods.ctrl, bubbles: true, cancelable: true } as KeyboardEventInit);
  for (const plugin of e.view.state.plugins) if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  return false;
};
const select = (e: Editor, from: number, to = from) => e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)));

// ------------------------------------------------------------ showing one

{
  const e = make();
  check("the whole text is shown to begin with", !chapterFocus(e.state) && hidden(e) === "");
  check("the chapter at the caret is known before it is shown", chapterAt(e, posOf(e, "lighthouse"))?.label.includes("Two") === true);
  check("text before the first heading is in no chapter", chapterAt(e, posOf(e, "Before")) === null && !focusChapterAt(e, posOf(e, "Before")));

  check("a chapter can be shown on its own", focusChapterAt(e, posOf(e, "lighthouse")));
  check("only its heading and its text are shown", shownText(e) === "Two|The second chapter has a harbour in it.|And a lighthouse.", shownText(e));
  check("the rest is hidden, not taken out", hidden(e).startsWith("Before any chapter.|One|") && hidden(e).endsWith("only a harbour master.") && e.state.doc.childCount === book.length);
  check("the bar's name for it", chapterFocus(e.state)?.label === "Chapter Two · Two" || (chapterFocus(e.state)?.label ?? "").includes("Two"), chapterFocus(e.state)?.label);

  // The caret keeps inside.
  select(e, posOf(e, "master"));
  check("a caret put outside comes back inside", e.state.selection.from <= chapterFocus(e.state)!.to && e.state.selection.from >= chapterFocus(e.state)!.from);
  select(e, posOf(e, "lighthouse"));

  // Select All, Backspace, Delete.
  check("Select All selects the chapter", press(e, "a", { ctrl: true }) && e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, "|") === "Two|The second chapter has a harbour in it.|And a lighthouse.");
  const before = e.state.doc.toJSON();
  select(e, posOf(e, "Two"));
  check("Backspace at the chapter's start does nothing", press(e, "Backspace") && JSON.stringify(e.state.doc.toJSON()) === JSON.stringify(before));
  select(e, posOf(e, "lighthouse") + "lighthouse.".length);
  check("Delete at its end does nothing", press(e, "Delete") && JSON.stringify(e.state.doc.toJSON()) === JSON.stringify(before));
  select(e, posOf(e, "lighthouse") + 3);
  check("elsewhere both keys are the editor's own", !press(e, "Backspace"));

  // Writing at its end stays in it.
  select(e, posOf(e, "lighthouse") + "lighthouse.".length);
  e.commands.splitBlock();
  e.commands.insertContent("A new line.");
  check("a paragraph added at its end belongs to it", shownText(e).endsWith("And a lighthouse.|A new line."), shownText(e));

  // A change somewhere hidden (a co-writer's) stays hidden.
  const tr = e.state.tr.insert(posOf(e, "It ends") - 1, e.state.schema.nodes.paragraph.create(null, e.state.schema.text("Written elsewhere.")));
  e.view.dispatch(tr);
  check("text added to another chapter is hidden with it", hidden(e).includes("Written elsewhere.") && !shownText(e).includes("Written elsewhere."));
  check("and the chapter shown is still this one", shownText(e).startsWith("Two|"));

  // Grow selection ends at the chapter.
  select(e, posOf(e, "lighthouse") + 2);
  for (let i = 0; i < 6; i += 1) growSelection(e, "en");
  check("growing the selection stops at the chapter", e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, "|").startsWith("Two|") && e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, "|").endsWith("A new line."));

  // The ones either side.
  check("the chapter after can be shown, and the one before", canStepChapter(e, 1) && canStepChapter(e, -1));
  stepChapter(e, 1);
  check("stepping on shows the next chapter", shownText(e).startsWith("Three|") && e.state.selection.from >= chapterFocus(e.state)!.from);
  check("the last has none after it", !canStepChapter(e, 1));
  stepChapter(e, -1);
  check("and back", shownText(e).startsWith("Two|"));

  // A jump from outside the text moves to the chapter there.
  showRange(e.view, posOf(e, "first chapter"));
  check("Go to (or any jump) into another chapter shows that one", shownText(e).startsWith("One|") && e.state.selection.from === posOf(e, "first chapter"));
  showRange(e.view, posOf(e, "Before"));
  check("a jump to text in no chapter shows the whole text", !chapterFocus(e.state) && hidden(e) === "");

  // The commands.
  select(e, posOf(e, "lighthouse"));
  check("the command shows the chapter at the caret", RUNNERS["doc.chapter.only"].enabled!(e, {} as never) && !!RUNNERS["doc.chapter.only"].run(e, {} as never) && shownText(e).startsWith("Two|"));
  check("and is not offered again for the one shown", !RUNNERS["doc.chapter.only"].enabled!(e, {} as never));
  check("the whole text can be shown again", RUNNERS["doc.chapter.all"].enabled!(e, {} as never) && !!RUNNERS["doc.chapter.all"].run(e, {} as never) && hidden(e) === "" && !RUNNERS["doc.chapter.all"].enabled!(e, {} as never));

  // A heading that goes.
  focusChapterAt(e, posOf(e, "lighthouse"));
  lost = 0;
  e.view.dispatch(e.state.tr.setNodeMarkup(posOf(e, "Two") - 1, undefined, { ...e.state.doc.nodeAt(posOf(e, "Two") - 1)!.attrs, element: null }));
  await wait(0);
  check("when the chapter's heading goes, the whole text is shown and the writer told", !chapterFocus(e.state) && hidden(e) === "" && lost === 1);
  e.destroy();
}

// ------------------------------------------------------------ a Document's sections

{
  const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });
  const e = make([h(1, "Methods"), p("How it was done."), h(2, "Samples"), p("Where they came from."), h(1, "Results"), p("What was found.")], "none");
  focusChapterAt(e, posOf(e, "came from"));
  check("in a Document the top heading's section is shown, with what is under it", shownText(e) === "Methods|How it was done.|Samples|Where they came from.", shownText(e));
  e.destroy();
}

// ------------------------------------------------------------ what reads the text

{
  const e = make();
  focusChapterAt(e, posOf(e, "lighthouse"));
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(FindBar, { editor: e as never, readonly: false, request: { n: 1, replace: false, prefill: "harbour" }, onClose: () => {} })));
  await act(async () => wait(200));
  const count = host.querySelector(".wf-find-count")?.textContent ?? "";
  check("Find finds only in the chapter shown, and says so", count === "1 of 1 in this chapter", count);
  await act(async () => root.render(createElement(DocumentStats, { editor: e as never, format: "manuscript" })));
  check("the word count is the chapter's", (host.querySelector(".wf-doc-stats-line")?.textContent ?? "").startsWith("12 words in this chapter"), host.querySelector(".wf-doc-stats-line")?.textContent ?? "");
  await act(async () => {
    showEverything(e);
    await wait(0);
  });
  check("and the whole text's again after", !(host.querySelector(".wf-doc-stats-line")?.textContent ?? "").includes("this chapter"));
  await act(async () => root.unmount());
  e.destroy();
}

// Formatting marks: only the chapter's blocks are looked through (a
// stand-in layout: shown blocks 40 px tall each, hidden ones nowhere).
{
  const paras: JSONContent[] = [];
  for (let c = 1; c <= 3; c += 1) {
    paras.push({ type: "heading", attrs: { level: 1 }, content: [t(`Part ${c}`)] });
    for (let i = 0; i < 400; i += 1) paras.push(p(`Chapter ${c} paragraph ${i} has words.`));
  }
  const host = mountPoint();
  host.style.overflowY = "auto";
  const inner = document.createElement("div");
  host.append(inner);
  host.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const e = new Editor({ element: inner, extensions: [...docContentExtensions(), ChapterFocus.configure({ format: () => "none", design: () => undefined, onLost: () => {} }), FormatMarks.configure({ on: () => true })], content: { type: "doc", content: paras } });
  const dom = e.view.dom as HTMLElement;
  const layout = () => {
    let y = 0;
    [...dom.children].forEach((el) => {
      const top = el.classList.contains("wf-unfocused") ? 0 : y;
      const h = el.classList.contains("wf-unfocused") ? 0 : 40;
      y += h;
      (el as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + h, left: 0, right: 600, width: 600, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    });
  };
  focusChapterAt(e, posOf(e, "Chapter 2 paragraph 5 "));
  layout();
  refreshFormatMarks(e);
  await wait(60);
  const focus = chapterFocus(e.state)!;
  const [from, to] = markedStretch(e);
  check("formatting marks go on the chapter shown, from its top", from >= focus.from && to <= focus.to && from === focus.from && e.state.doc.textBetween(from, from + 12).includes("Part 2"), `${from} ${to} ${focus.from} ${focus.to}`);
  e.destroy();
}

// Page view (the simple one: the engine's pages are the whole text's):
// the chapter's own pages, from its first. A stand-in layout: each block
// shown is 100 px tall (and as far down as the pushes before it put it),
// a hidden one is nowhere. A page holds 864 px of text.
{
  const blocks: JSONContent[] = [];
  for (let c = 1; c <= 3; c += 1) {
    blocks.push(p(`Chapter ${c}`, "chapter_heading"));
    for (let i = 0; i < 9; i += 1) blocks.push(p(`Chapter ${c}, block ${i}.`));
  }
  let seen: PageLayoutResult | null = null;
  const sheet = mountPoint();
  sheet.className = "wf-page";
  const e = new Editor({
    element: sheet,
    extensions: [
      ...docContentExtensions(),
      ChapterFocus.configure({ format: () => "manuscript", design: () => presetDesign("classic"), onLost: () => {} }),
      Paginate.configure({ getSpec: () => pageSpecFor("none", DEFAULT_SETTINGS), getMap: () => null, onLayout: (r) => (seen = r) }),
    ],
    content: { type: "doc", content: blocks },
  });
  const dom = e.view.dom as HTMLElement;
  Object.defineProperty(dom, "clientWidth", { configurable: true, value: 624 });
  const rect = (top: number, h: number) => ({ top, bottom: top + h, left: 0, right: 624, width: 624, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  dom.getBoundingClientRect = () => rect(0, 4000);
  sheet.getBoundingClientRect = () => rect(0, 4000);
  const layout = () => {
    let y = 0;
    [...dom.children].forEach((el) => {
      const html = el as HTMLElement;
      if (html.classList.contains("wf-unfocused")) {
        html.getBoundingClientRect = () => rect(0, 0);
        return;
      }
      const push = parseFloat(html.style.paddingTop) || 0;
      const top = y;
      y += 100 + push;
      html.getBoundingClientRect = () => rect(top, 100 + push);
    });
  };
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      layout();
      reflowPagination(e);
      await wait(30);
    }
  };
  await settle();
  const whole = seen as PageLayoutResult | null;
  check("the whole text: thirty blocks on four pages", whole?.pages === 4, JSON.stringify(whole && whole.pages));
  focusChapterAt(e, posOf(e, "Chapter 2, block 4"));
  await settle();
  const one = seen as PageLayoutResult | null;
  check("one chapter shown: its ten blocks on two pages, counted from its first", one?.pages === 2, JSON.stringify(one && one.pages));
  check("nothing hidden is pushed", ![...dom.querySelectorAll(".wf-unfocused")].some((el) => (el as HTMLElement).style.paddingTop));
  showEverything(e);
  await settle();
  check("the whole text again: four pages", (seen as PageLayoutResult | null)?.pages === 4);
  e.destroy();
}

finish();
