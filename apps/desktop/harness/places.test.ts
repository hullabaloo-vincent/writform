// Finding the way about a long text by key: back to where it was last
// changed, the selection grown from a word to its sentence, its paragraph
// and everything, and Go to a page or a heading.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { matchHeadings, pageOf, pagePos, parseGoTo } from "../src/apps/documents/goTo";
import { GoToBox } from "../src/apps/documents/GoToBox";
import { EDITOR_COMMANDS, keysOf } from "../src/editor/commands/catalog";
import { CommandKeys } from "../src/editor/commands/CommandKeys";
import { canRun, runCommand, type CommandCtx } from "../src/editor/commands/run";
import { EditPlaces, editPlaces, goBackToEdit } from "../src/editor/EditPlaces";
import { growSelection, shrinkSelection } from "../src/editor/format/grow";
import type { PageMapFor } from "../src/editor/Paginate";
import { docContentExtensions } from "../src/editor/schema/content";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const t = (text: string): JSONContent => ({ type: "text", text });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(content.length ? { content } : {}) });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });
let went = 0;
const ctx: CommandCtx = { format: "none", rich: null, editable: true, lang: "en", shell: { goTo: () => (went += 1) } };
const editorWith = (content: JSONContent[]): Editor =>
  new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), EditPlaces, CommandKeys.configure({ ctx: () => ctx })], content: { type: "doc", content } });
const find = (e: Editor, text: string): number => {
  let at = -1;
  e.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText) {
      const i = (node.text ?? "").indexOf(text);
      if (i >= 0) at = pos + i;
    }
  });
  return at;
};
const typeAt = (e: Editor, after: string, text: string) => {
  const pos = find(e, after) + after.length;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)));
  e.view.dispatch(e.state.tr.insertText(text));
};
/** The word the caret is just after. */
const before = (e: Editor, pos: number, n: number) => e.state.doc.textBetween(Math.max(0, pos - n), pos);
const selected = (e: Editor) => e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, "|");
const press = (e: Editor, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): boolean => {
  const event = new KeyboardEvent("keydown", { key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, bubbles: true, cancelable: true } as KeyboardEventInit);
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};

// ------------------------------------------------------------ back to the last edits

{
  const e = editorWith(["One", "Two", "Three", "Four", "Five", "Six"].map((w) => p(t(`${w} begins here.`))));
  check("a text nobody has written in has nowhere to go back to", editPlaces(e).length === 0 && !goBackToEdit(e) && !canRun("doc.goback", e, ctx));
  typeAt(e, "One", "A");
  typeAt(e, "Two", "B");
  check("each paragraph written in is a place, newest first", editPlaces(e).length === 2 && before(e, editPlaces(e)[0], 4) === "TwoB" && before(e, editPlaces(e)[1], 4) === "OneA");
  typeAt(e, "TwoB", "b");
  typeAt(e, "TwoBb begins", "!");
  check("more writing in one paragraph is still one place, the latest", editPlaces(e).length === 2 && before(e, editPlaces(e)[1], 4) === "OneA");
  typeAt(e, "Three", "C");
  typeAt(e, "Four", "D");
  typeAt(e, "Five", "E");
  check("the last four are kept", editPlaces(e).length === 4 && editPlaces(e).map((pos) => before(e, pos, 1)).join("") === "EDC!", editPlaces(e).map((pos) => before(e, pos, 3)).join(" "));
  typeAt(e, "ThreeC", "c");
  check("going back into an older one moves it to the front", editPlaces(e).map((pos) => before(e, pos, 1)).join("") === "cED!");

  // Read on somewhere else, then go back.
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, find(e, "Six") + 1)));
  check("the key goes back to the last place written in", goBackToEdit(e) && before(e, e.state.selection.head, 7) === "ThreeCc");
  check("again goes to the one before", goBackToEdit(e) && before(e, e.state.selection.head, 1) === "E");
  goBackToEdit(e);
  goBackToEdit(e);
  check("and after the oldest it comes round to the newest", before(e, e.state.selection.head, 1) === "!" && goBackToEdit(e) && before(e, e.state.selection.head, 1) === "c");
  check("going back changes nothing and makes no place of its own", editPlaces(e).length === 4);

  typeAt(e, "Six", "F");
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, e.state.selection.head)));
  goBackToEdit(e);
  check("from the place just written in, the first step is to the one before", before(e, e.state.selection.head, 1) === "c", before(e, e.state.selection.head, 3));

  // Someone else's change (as the shared document delivers it: the whole text replaced).
  const kids: import("@tiptap/pm/model").Node[] = [];
  e.state.doc.forEach((node) => kids.push(node));
  const added = e.schema.nodes.paragraph.create(null, e.schema.text("Written by someone else."));
  const was = editPlaces(e).map((pos) => before(e, pos, 1)).join("");
  e.view.dispatch(e.state.tr.replace(0, e.state.doc.content.size, new Slice(Fragment.from([added, ...kids]), 0, 0)).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
  check("what someone else writes makes no place", editPlaces(e).length === 4 && editPlaces(e).map((pos) => before(e, pos, 1)).join("") === was, editPlaces(e).map((pos) => before(e, pos, 2)).join(" "));
  check("and the places are still on the same words", before(e, editPlaces(e)[0], 4) === "SixF");

  // The key (Shift+F5), after writing some more and reading on elsewhere.
  typeAt(e, "SixF", "f");
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 1)));
  check("Shift+F5 is its key", keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.goback")!, false) === "Shift-F5" && press(e, "F5", { shift: true }) && before(e, e.state.selection.head, 5) === "SixFf", before(e, e.state.selection.head, 5));
  e.destroy();
}

// ------------------------------------------------------------ select more

{
  const e = editorWith([p(t("The quick fox ran. It did not stop. Nobody saw.")), p(t("A second paragraph here."))]);
  const caret = find(e, "did") + 1;
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, caret)));
  check("first the word", growSelection(e, "en") && selected(e) === "did");
  check("then its sentence", growSelection(e, "en") && selected(e).trim() === "It did not stop.", JSON.stringify(selected(e)));
  check("then its paragraph", growSelection(e, "en") && selected(e) === "The quick fox ran. It did not stop. Nobody saw.");
  check("then everything", growSelection(e, "en") && e.state.selection instanceof AllSelection);
  check("and there it stops", !growSelection(e, "en"));
  check("less goes back the way it came", shrinkSelection(e) && selected(e) === "The quick fox ran. It did not stop. Nobody saw." && shrinkSelection(e) && selected(e).trim() === "It did not stop." && shrinkSelection(e) && selected(e) === "did");
  check("down to the caret where it began", shrinkSelection(e) && e.state.selection.empty && e.state.selection.from === caret && !shrinkSelection(e));

  e.commands.setTextSelection({ from: find(e, "quick"), to: find(e, "fox") + 3 });
  check("from two words selected it is the sentence next", growSelection(e, "en") && selected(e).trim() === "The quick fox ran.", JSON.stringify(selected(e)));
  e.commands.setTextSelection({ from: find(e, "Nobody"), to: find(e, "second") });
  check("a selection across paragraphs grows to all of both", growSelection(e, "en") && selected(e) === "The quick fox ran. It did not stop. Nobody saw.|A second paragraph here.", selected(e));
  e.commands.setTextSelection(find(e, "second") + 2);
  growSelection(e, "en");
  e.commands.setTextSelection(find(e, "quick") + 2);
  check("a selection made by hand has nothing to shrink back to", !shrinkSelection(e));
  check("F8 is the key for more (not on a Mac), Shift+F8 for less", press(e, "F8") && selected(e) === "quick" && press(e, "F8", { shift: true }) && e.state.selection.empty);
  check("on a Mac it is Option and ⌘ with the arrows", keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.grow")!, true) === "Alt-Mod-ArrowUp");
  e.destroy();

  const noted = editorWith([p(t("A claim"), { type: "footnote", content: [t("Its long source. In two sentences.")] }, t(" is made. Another follows."))]);
  noted.commands.setTextSelection(find(noted, "claim") + 2);
  growSelection(noted, "en");
  check("a note in the sentence is no part of the word", selected(noted) === "claim");
  growSelection(noted, "en");
  check("and the sentence runs on past the note", noted.state.doc.textBetween(noted.state.selection.from, noted.state.selection.to, "", " ").replace(/\s+/g, " ").trim().endsWith("is made."), JSON.stringify(selected(noted)));
  noted.destroy();
}

// ------------------------------------------------------------ go to

{
  check("a number is a page", JSON.stringify(parseGoTo("12", 3, 40)) === JSON.stringify({ kind: "page", page: 12 }) && JSON.stringify(parseGoTo(" page 7 ", 3, 40)) === JSON.stringify({ kind: "page", page: 7 }) && JSON.stringify(parseGoTo("p. 7", 3, 40)) === JSON.stringify({ kind: "page", page: 7 }));
  check("+2 and -1 are pages from here", parseGoTo("+2", 3, 40)?.kind === "page" && (parseGoTo("+2", 3, 40) as { page: number }).page === 5 && (parseGoTo("-1", 3, 40) as { page: number }).page === 2 && (parseGoTo("- 1", 3, 40) as { page: number }).page === 2);
  check("a page past either end is the end", (parseGoTo("99", 3, 40) as { page: number }).page === 40 && (parseGoTo("-9", 3, 40) as { page: number }).page === 1 && (parseGoTo("0", 3, 40) as { page: number }).page === 1);
  check("words are a heading", JSON.stringify(parseGoTo("The Harbour", 3, 40)) === JSON.stringify({ kind: "heading", words: "the harbour" }) && JSON.stringify(parseGoTo("chapter 2", 3, 40)) === JSON.stringify({ kind: "heading", words: "chapter 2" }));
  check("nothing typed asks for nothing, and a number with no pages known is not a page", parseGoTo("  ", 3, 40) === null && parseGoTo("12", 1, null) === null);

  const starts: PageMapFor["starts"] = [{ pos: 0, inline: false }, { pos: 120, inline: true }, null, { pos: 400, inline: false }];
  check("a place is on the page that began before it", pageOf(starts, 5) === 1 && pageOf(starts, 120) === 2 && pageOf(starts, 399) === 2 && pageOf(starts, 400) === 4 && pageOf(starts, 9999) === 4);
  check("a page begins where it was marked", pagePos(starts, 1) === 0 && pagePos(starts, 2) === 120 && pagePos(starts, 4) === 400);
  check("one that could not be marked gives the nearest before it", pagePos(starts, 3) === 120 && pagePos(starts, 9) === 400);
  const heads = [{ title: "The Harbour at Night" }, { title: "Night Watch" }, { title: "Morning" }];
  check("a heading is found by any of its words, all of them", matchHeadings(heads, "night").length === 2 && matchHeadings(heads, "night harbour").length === 1 && matchHeadings(heads, "noon").length === 0 && matchHeadings(heads, " ").length === 0);
}

{
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const e = editorWith([h(1, "The Harbour"), p(t("First page words.")), h(2, "Night Watch"), p(t("Second page words.")), h(1, "Morning"), p(t("Third page words."))]);
  const posOf = (text: string) => find(e, text);
  const starts: PageMapFor["starts"] = [{ pos: 0, inline: false }, { pos: posOf("Night Watch") - 1, inline: false }, { pos: posOf("Third page") - 1, inline: false }];
  const host = mountPoint();
  const root = createRoot(host);
  let asked = 0;
  let closed = 0;
  const open = async (shown: PageMapFor | null, ask: boolean) =>
    act(async () => {
      root.render(
        createElement(GoToBox, {
          key: `${closed}-${asked}-${Math.random()}`,
          editor: e,
          format: "none",
          shown: () => shown,
          ask: ask
            ? async () => {
                asked += 1;
                return { pages: 3, starts };
              }
            : null,
          onClose: () => (closed += 1),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  const field = () => document.querySelector<HTMLInputElement>(".wf-goto input")!;
  const say = async (text: string) =>
    act(async () => {
      const set = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
      set.call(field(), text);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const submit = () => act(async () => void document.querySelector(".wf-goto form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const hint = () => document.querySelector(".wf-goto-hint")?.textContent ?? "";
  const at = () => e.state.doc.textBetween(e.state.selection.head, Math.min(e.state.doc.content.size, e.state.selection.head + 5));

  e.commands.setTextSelection(posOf("Second page") + 3);
  await open({ doc: e.state.doc, pages: 3, starts, bodyH: [600, 600, 600] }, true);
  check("with page view on, its pages are used and none are asked for", asked === 0 && hint().startsWith("Page 2 of 3"), hint());
  await say("3");
  check("a page typed is said back before going", hint() === "Page 3 of 3");
  await submit();
  check("Enter goes to where that page begins", closed === 1 && at() === "Third", at());
  await open({ doc: e.state.doc, pages: 3, starts, bodyH: [600, 600, 600] }, true);
  await say("-2");
  await submit();
  check("-2 goes two pages back", at() === "The H", at());

  await open(null, true);
  check("with page view off the pages are worked out once", asked === 1 && hint().startsWith("Page 1 of 3"), hint());
  await say("night");
  const rows = () => [...document.querySelectorAll(".wf-goto-list button")].map((b) => b.textContent);
  check("words list the headings that have them", rows().join("|") === "Night Watch", rows().join("|"));
  await submit();
  check("Enter goes to the heading", at() === "Night", at());
  await open(null, true);
  await say("o");
  check("several headings may match", rows().length === 2, rows().join("|"));
  await act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await submit();
  check("the arrows choose among them", at() === "Morni", at());
  await open(null, true);
  await say("zebra");
  check("words no heading has say so", hint() === "No heading has those words." || document.body.textContent!.includes("No heading has those words."));

  await open(null, false);
  await say("2");
  check("a book goes by its headings only: a number finds no page", document.querySelector<HTMLButtonElement>(".wf-goto button.wf-primary")?.disabled === true && field().placeholder === "A heading");
  await act(async () => root.unmount());

  check("the command opens it, by name and by key", runCommand("doc.goto", e, ctx) && went === 1 && keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.goto")!, false) === "Alt-Mod-g" && press(e, "g", { ctrl: true, alt: true }) && went === 2);
  e.destroy();
}

finish();
