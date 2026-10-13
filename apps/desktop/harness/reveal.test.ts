// Going to a place in the text from outside it: the Find field, the list
// of changes, the outline, the notes, a comment. The focus is NOT in the
// text when these are used, and ProseMirror's own scrolling does nothing
// then (it works from the browser's selection). jsdom never showed that,
// so these checks hold the page's scrolling to what was asked for, by
// giving the scroller a box and the text coordinates.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { FindBar } from "../src/apps/documents/FindBar";
import { OutlinePanel } from "../src/apps/documents/OutlinePanel";
import { showBlock } from "../src/apps/documents/shell/hooks";
import { showChange, stepChange, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { NotesList } from "../src/editor/ui/NotesList";
import { reveal, showInText, showRange } from "../src/editor/ui/reveal";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const win = window as unknown as Record<string, unknown>;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const para = (text: string, attrs?: Record<string, unknown>): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content: [{ type: "text", text }] });
const heading = (text: string): JSONContent => ({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text }] });

/** An editor in an element that scrolls, with a box 600 tall (100 to 700)
 *  and every place in the text drawn wherever `at` says. */
function page(content: JSONContent[], editable = true) {
  const scroller = mountPoint();
  scroller.style.overflowY = "auto";
  const mount = scroller.appendChild(document.createElement("div"));
  const editor = new Editor({ element: mount, editable, extensions: [...docContentExtensions({}), Suggesting.configure({ author: () => "Ana" })], content: { type: "doc", content } });
  (scroller as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 0, right: 800, width: 800, height: 600 });
  const where = { top: 2400 };
  (editor.view as unknown as { coordsAtPos: () => unknown }).coordsAtPos = () => ({ top: where.top, bottom: where.top + 20, left: 0, right: 0 });
  return { scroller, editor, where };
}

/** Somewhere else to have the focus: a row in a panel, say. */
const elsewhere = document.body.appendChild(document.createElement("button"));
/** Where a place 2,400 down ends up: a third of the way down the box. */
const THIRD = 2400 - (100 + 200);

const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: { prototype: object } }).HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
const key = async (el: Element, name: string, more: Record<string, unknown> = {}) =>
  act(async () => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...more }));
  });
const click = async (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error("nothing to click");
    (el as HTMLElement).click();
  });

// ------------------------------------------------------------- the helper

{
  const { scroller, editor, where } = page([para("One."), para("Two."), para("Three.")]);
  elsewhere.focus();
  reveal(editor.view, 8);
  check("a place far down the page is put a third of the way down what can be seen", scroller.scrollTop === THIRD, String(scroller.scrollTop));
  scroller.scrollTop = 0;
  where.top = 300;
  reveal(editor.view, 8);
  check("a place already well in view is left where it is", scroller.scrollTop === 0);
  where.top = 120;
  reveal(editor.view, 8);
  check("a place too near the top edge is moved down", scroller.scrollTop === 120 - 300, String(scroller.scrollTop));
  where.top = 690;
  scroller.scrollTop = 0;
  reveal(editor.view, 8);
  check("…and one too near the foot is moved up", scroller.scrollTop === 690 - 300);

  // A phone with its keyboard up: the page's box still reaches the foot of
  // the screen, but nothing below the keyboard can be seen.
  win.visualViewport = { offsetTop: 0, height: 420 };
  scroller.scrollTop = 0;
  where.top = 500;
  reveal(editor.view, 8);
  check("what the keyboard covers does not count as in view", scroller.scrollTop === 500 - (100 + 320 / 3), String(scroller.scrollTop));
  scroller.scrollTop = 0;
  where.top = 250;
  reveal(editor.view, 8);
  check("…and a place above the keyboard is left alone", scroller.scrollTop === 0);
  delete win.visualViewport;

  where.top = 2400;
  showRange(editor.view, 7, 10);
  check("showing a stretch selects it, scrolls to it and leaves the focus where it was", editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === "Two" && scroller.scrollTop === THIRD && document.activeElement === elsewhere);
  scroller.scrollTop = 0;
  showRange(editor.view, 7, 10, true);
  check("asked to, it gives the text the focus afterwards", scroller.scrollTop === THIRD && editor.view.hasFocus());
  elsewhere.focus();
  scroller.scrollTop = 0;
  showRange(editor.view, -40, 9000);
  check("ends outside the document are held to it", editor.state.selection.from === 1 && editor.state.selection.to === editor.state.doc.content.size - 1 && scroller.scrollTop === THIRD);
  editor.destroy();

  // A document that can only be read never has the focus: the scrolling
  // must not depend on it.
  const read = page([para("One."), para("Two.")], false);
  elsewhere.focus();
  showInText(read.editor.view, TextSelection.create(read.editor.state.doc, 7), true);
  check("in a document that can only be read the place is still scrolled to", read.scroller.scrollTop === THIRD && !read.editor.view.hasFocus() && read.editor.state.selection.from === 7);
  read.editor.destroy();
}

// ------------------------------------------------------------------- Find

await (async () => {
  const { scroller, editor } = page([para("A lamp stood by the door."), para("Nobody had lit the lamp."), para("The lamp was hers.")]);
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(FindBar, { editor, readonly: false, request: { n: 1, replace: false, prefill: "" }, onClose: () => {} })));
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Find"]')!;
  field.focus();
  await type(field, "lamp");
  check("typing in Find goes to the first match and scrolls the page to it", editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === "lamp" && scroller.scrollTop === THIRD, String(scroller.scrollTop));
  check("…with the focus still in the field being typed in", document.activeElement === field && !editor.view.hasFocus());
  const first = editor.state.selection.from;
  scroller.scrollTop = 0;
  await key(field, "Enter");
  check("Enter steps to the next match and scrolls to it", editor.state.selection.from > first && scroller.scrollTop === THIRD && document.activeElement === field);
  scroller.scrollTop = 0;
  await key(field, "Enter", { shiftKey: true });
  check("Shift+Enter steps back", editor.state.selection.from === first && scroller.scrollTop === THIRD);
  scroller.scrollTop = 0;
  await click(host.querySelector('button[title^="Next"]'));
  check("the arrow buttons scroll too", editor.state.selection.from > first && scroller.scrollTop === THIRD);
  await act(async () => root.unmount());
  editor.destroy();
})();

// ---------------------------------------------------------------- changes

{
  const rev = { type: "insertion", attrs: { a: "Ben", t: 1 } };
  const content = [
    para("It began in March."),
    { type: "paragraph", content: [{ type: "text", text: "She wrote " }, { type: "text", text: "quickly ", marks: [rev] }, { type: "text", text: "that night." }] },
    { type: "paragraph", content: [{ type: "text", text: "Nobody " }, { type: "text", text: "ever ", marks: [rev] }, { type: "text", text: "answered." }] },
  ];
  const { scroller, editor } = page(content);
  elsewhere.focus();
  const one = stepChange(editor, 1);
  check("Next change selects it and scrolls to it from outside the text", !!one && editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === "quickly " && scroller.scrollTop === THIRD);
  check("…and the text takes the focus, as it did", editor.view.hasFocus());
  elsewhere.focus();
  scroller.scrollTop = 0;
  const two = stepChange(editor, 1);
  check("…and the one after", !!two && two.id !== one!.id && scroller.scrollTop === THIRD);
  elsewhere.focus();
  scroller.scrollTop = 0;
  showChange(editor, one!, false);
  check("a change shown without the focus (a comment is being started on it) is scrolled to all the same", scroller.scrollTop === THIRD && document.activeElement === elsewhere);
  editor.setEditable(false);
  scroller.scrollTop = 0;
  showChange(editor, two!);
  check("a reader who can only look is taken to a change as well", scroller.scrollTop === THIRD && editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === "ever ");
  editor.destroy();
}

// ------------------------------------------- the outline, notes, a warning

await (async () => {
  const note = { type: "footnote", content: [{ type: "text", text: "See the letters." }] };
  const content = [heading("One"), para("First words."), heading("Two"), { type: "paragraph", content: [{ type: "text", text: "Second words" }, note, { type: "text", text: "." }] }, heading("Three"), para("Last words.")];
  const { scroller, editor } = page(content);
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement("div", null, createElement(OutlinePanel, { editor }), createElement(NotesList, { editor }))));
  const rows = [...host.querySelectorAll<HTMLButtonElement>(".wf-doc-outline-item")];
  check("(the outline lists the three headings)", rows.length === 3);
  elsewhere.focus();
  await click(rows[2]);
  check("a heading chosen in the outline is scrolled to", scroller.scrollTop === THIRD && editor.state.selection.$from.parent.textContent === "Three");
  elsewhere.focus();
  scroller.scrollTop = 0;
  await click(host.querySelector(".wf-docnotes-num"));
  check("a note's number in the list of notes scrolls to where it is cited", scroller.scrollTop === THIRD && editor.state.selection.$from.nodeAfter?.type.name === "footnote", String(scroller.scrollTop));
  elsewhere.focus();
  scroller.scrollTop = 0;
  await act(async () => showBlock(editor, 4));
  check("“Show” on a warning before export scrolls to its paragraph", scroller.scrollTop === THIRD && editor.state.selection.$from.parent.textContent === "Three");

  await act(async () => {
    editor.setEditable(false);
  });
  elsewhere.focus();
  scroller.scrollTop = 0;
  await click(rows[1]);
  check("the outline works in a document that can only be read", scroller.scrollTop === THIRD && editor.state.selection.$from.parent.textContent === "Two");
  await act(async () => root.unmount());
  editor.destroy();
})();

// ------------------------------------------------------------ the rule held

{
  // Nothing outside the text may lean on the editor's own scrolling: a
  // panel, a bar or a list goes through editor/ui/reveal.ts. (A call with
  // nothing in its brackets is the editor's. The page's own, on an element,
  // always says how.)
  const here = path.dirname(fileURLToPath(import.meta.url));
  // (The harness runs from harness/.out.)
  const src = path.resolve(here, "../../src");
  /** Where the writer's keys are what scrolls: the focus is in the text. */
  const TYPED = [/apps\/documents\/formats\/FormatKeymap\.ts$/];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.tsx?$/.test(name) && !TYPED.some((re) => re.test(file))) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\.scrollIntoView\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`${path.relative(src, file)}:${i + 1}`);
          });
      }
    }
  };
  for (const dir of ["apps", "proof", "editor/ui", "book/ui"]) walk(path.join(src, dir));
  found.push(...readFileSync(path.join(src, "editor/review/ChangesList.tsx"), "utf8").split("\n").flatMap((line, i) => (/\.scrollIntoView\(\)/.test(line) ? [`editor/review/ChangesList.tsx:${i + 1}`] : [])));
  check("no panel, bar or list leans on the editor's own scrolling", found.length === 0, found.join(", "));
}

finish();
