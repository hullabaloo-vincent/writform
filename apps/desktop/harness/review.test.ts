// Review: tracked changes as the editor makes them (suggesting, accepting,
// rejecting), reading aloud, and comparing two versions.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type Extensions, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import * as Y from "yjs";

import { compareDocs, diffWords, flattenBlocks } from "../src/apps/documents/compare";
import { formatKeymap } from "../src/apps/documents/formats/FormatKeymap";
import { countDocWords } from "../src/apps/documents/stats";
import { clearFormatting } from "../src/editor/format/commands";
import { insertNote, openNotes } from "../src/editor/nodes/Footnote";
import { breakAfter, breakStart, changesOf, changeText, groupChanges, hasChanges, trackKind } from "../src/editor/review/changes";
import { resolveChanges, resolvedDoc, resolvedJson } from "../src/editor/review/resolve";
import { resolveAll, resolveInEditor, setReviewMode, stepChange, Suggesting } from "../src/editor/review/Suggesting";
import { DELETION, INSERTION, encodeRevs, parseRevs, withRev } from "../src/editor/review/TrackMarks";
import { RATES, ReadAloud, ReadAloudHighlight, sentenceBefore, sentenceFrom, sentencesOf, splitter, type ReadAloudState } from "../src/editor/speech/readAloud";
import { contentSchema, docContentExtensions } from "../src/editor/schema/content";
import { downlevelJson } from "../src/editor/schema/downlevel";
import { levelOfJson } from "../src/editor/schema/levels";
import { insertTable, tableCommands } from "../src/editor/tables/Table";

type Marks = (string | { type: string; attrs: Record<string, unknown> })[];
const t = (text: string, ...marks: Marks): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  ...(content.length ? { content } : {}),
});
const ins = (a: string, tm = 1700000000) => ({ type: INSERTION, attrs: { a, t: tm } });
const del = (a: string, tm = 1700000000) => ({ type: DELETION, attrs: { a, t: tm } });

/** An editor someone is using: `who` suggests when the mode says so. */
const editorFor = (who: string, content: JSONContent[], extra: Extensions = []): Editor =>
  new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(), formatKeymap("none"), Suggesting.configure({ author: () => who }), ...extra],
    content: { type: "doc", content },
  });
const suggesting = (who: string, content: JSONContent[]): Editor => {
  const e = editorFor(who, content);
  setReviewMode(e, "suggest");
  return e;
};

const find = (e: Editor, needle: string): number => {
  let from = -1;
  e.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return from < 0;
    const at = node.textContent.indexOf(needle);
    if (at >= 0) from = pos + 1 + at;
    return false;
  });
  if (from < 0) throw new Error(`no "${needle}"`);
  return from;
};
const caretAfter = (e: Editor, needle: string) => e.commands.setTextSelection(find(e, needle) + needle.length);
const caretBefore = (e: Editor, needle: string) => e.commands.setTextSelection(find(e, needle));
const select = (e: Editor, needle: string) => {
  const from = find(e, needle);
  e.commands.setTextSelection({ from, to: from + needle.length });
};
const press = (e: Editor, key: string): boolean => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};
/** Typing, a letter at a time, the way the view turns keys into text. */
const type = (e: Editor, text: string) => {
  // (Over the selection, with the caret left after what was typed.)
  for (const ch of text) e.view.dispatch(e.state.tr.insertText(ch).scrollIntoView());
};
/** A paste, as the view handles one (jsdom has no ClipboardEvent). */
const paste = (e: Editor, html: string) => e.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
/** Backspace and Delete: the keymaps first, else the letter beside the caret. */
const backspace = (e: Editor, times = 1) => {
  for (let i = 0; i < times; i += 1) {
    if (press(e, "Backspace")) continue;
    const { from, empty } = e.state.selection;
    if (empty && e.state.selection.$from.parentOffset > 0) e.view.dispatch(e.state.tr.delete(from - 1, from));
  }
};
const forwardDelete = (e: Editor, times = 1) => {
  for (let i = 0; i < times; i += 1) {
    if (press(e, "Delete")) continue;
    const { from, empty, $from } = e.state.selection;
    if (empty && $from.parentOffset < $from.parent.content.size) e.view.dispatch(e.state.tr.delete(from, from + 1));
  }
};

/** The document with its tracking written out: `{+added+}`, `[-struck-]`,
 *  `¶+`/`¶-` before a paragraph whose break is tracked, blocks apart by `|`. */
const render = (doc: PmNode): string => {
  const out: string[] = [];
  const tag = (node: PmNode) => {
    const revs = parseRevs(node.attrs.tc);
    return `${revs?.ins ? "+" : ""}${revs?.del ? "-" : ""}`;
  };
  doc.descendants((node) => {
    if (node.isTextblock) {
      const revs = parseRevs(node.attrs.tc);
      let s = `${revs?.ins ? "¶+" : ""}${revs?.del ? "¶-" : ""}`;
      node.forEach((child) => {
        if (!child.isText) {
          s += `<${child.type.name}${tag(child)}>`;
          return;
        }
        let x = child.text ?? "";
        if (child.marks.some((m) => m.type.name === INSERTION)) x = `{+${x}+}`;
        if (child.marks.some((m) => m.type.name === DELETION)) x = `[-${x}-]`;
        s += x;
      });
      out.push(s);
      return false;
    }
    if (node.isLeaf || trackKind(node) === "unit") {
      out.push(`<${node.type.name}${tag(node)}>`);
      return false;
    }
    return true;
  });
  return out.join("|").split("+}{+").join("").split("-][-").join("");
};
const shows = (e: Editor) => render(e.state.doc);
const accepted = (e: Editor) => render(resolvedDoc(e.state.doc, "accept"));
const rejected = (e: Editor) => render(resolvedDoc(e.state.doc, "reject"));

// ---------------------------------------------------------------- suggesting: words

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "Hello");
  type(e, " big");
  check("typing while suggesting is an insertion, not an edit", shows(e) === "Hello{+ big+} world.", shows(e));
  const node = e.state.doc.nodeAt(find(e, " big"));
  const mark = node?.marks.find((m) => m.type.name === INSERTION);
  check("it says who and when", mark?.attrs.a === "Ana" && typeof mark.attrs.t === "number" && mark.attrs.t > 1700000000, JSON.stringify(mark?.attrs));
  check("typed a letter at a time, it is one piece of text", node?.text === " big" && e.state.doc.child(0).childCount === 3, String(e.state.doc.child(0).childCount));
  check("the caret is after what was typed", e.state.selection.from === find(e, " big") + 4);
  check("tracked changes need level 2", levelOfJson(e.getJSON()) === 2);
  check("accepting keeps the words; rejecting takes them out", accepted(e) === "Hello big world." && rejected(e) === "Hello world.", `${accepted(e)} / ${rejected(e)}`);
}

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "world");
  backspace(e, 5);
  check("Backspace strikes the words instead of removing them", shows(e) === "Hello [-world-].", shows(e));
  check("and leaves the caret before them", e.state.selection.from === find(e, "world"));
  backspace(e);
  check("the next Backspace goes on to the left", shows(e) === "Hello[- world-].", shows(e));
  check("accepting removes them; rejecting restores them", accepted(e) === "Hello." && rejected(e) === "Hello world.", `${accepted(e)} / ${rejected(e)}`);
}

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretBefore(e, "world");
  forwardDelete(e, 5);
  check("Delete strikes forwards, stepping past what it struck", shows(e) === "Hello [-world-]." && e.state.selection.from === find(e, "world") + 5, `${shows(e)} @${e.state.selection.from}`);
  forwardDelete(e);
  check("so pressing it again goes on to the right", shows(e) === "Hello [-world.-]", shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "Hello");
  type(e, " abc");
  backspace(e, 2);
  check("taking back your own suggestion just removes it", shows(e) === "Hello{+ a+} world.", shows(e));
  backspace(e, 2);
  check("all of it: nothing is left to review", shows(e) === "Hello world." && !hasChanges(e.state.doc), shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  select(e, "world");
  type(e, "moon");
  check("typing over a selection strikes it and adds the new words after", shows(e) === "Hello [-world-]{+moon+}.", shows(e));
  check("with the caret after them", e.state.selection.from === find(e, "moon") + 4);
  const groups = groupChanges(changesOf(e.state.doc));
  check("it reads as one replacement", groups.length === 1 && groups[0].kind === "replace" && groups[0].author === "Ana", JSON.stringify(groups.map((g) => g.kind)));
  check("accepted, it reads the new way; rejected, the old", accepted(e) === "Hello moon." && rejected(e) === "Hello world.", `${accepted(e)} / ${rejected(e)}`);
}

{
  // Someone else's suggestion, struck by this reviewer.
  const e = suggesting("Ana", [p(null, t("Hello "), t("big ", ins("Bo")), t("world."))]);
  caretAfter(e, "big ");
  backspace(e, 4);
  check("another person's insertion is struck, not removed", shows(e) === "Hello [-{+big +}-]world.", shows(e));
  const changes = changesOf(e.state.doc);
  check("two changes on the same words, one each", changes.length === 2 && changes.some((c) => c.kind === "ins" && c.author === "Bo") && changes.some((c) => c.kind === "del" && c.author === "Ana"), JSON.stringify(changes.map((c) => [c.kind, c.author])));
  check("accepting both removes it; rejecting both too (it was never accepted)", accepted(e) === "Hello world." && rejected(e) === "Hello world.", `${accepted(e)} / ${rejected(e)}`);
  // Rejecting only the deletion leaves Bo's suggestion standing.
  resolveInEditor(e, changes.filter((c) => c.kind === "del"), "reject");
  check("rejecting the deletion alone leaves the insertion to decide on", shows(e) === "Hello {+big +}world.", shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("Hello "), t("old", del("Bo")), t(" world."))]);
  e.commands.setTextSelection(find(e, "old") + 1);
  type(e, "X");
  check("typing inside struck text isn't struck itself", shows(e) === "Hello [-o-]{+X+}[-ld-] world.", shows(e));
}

// ---------------------------------------------------------------- suggesting: paragraphs

{
  const original = [p(null, t("Hello world."))];
  const e = suggesting("Ana", original);
  caretAfter(e, "Hello");
  press(e, "Enter");
  check("Enter makes a paragraph whose break is the suggestion", shows(e) === "Hello|¶+ world.", shows(e));
  check("the caret is in the new paragraph", e.state.selection.$from.parent === e.state.doc.child(1) && e.state.selection.$from.parentOffset === 0);
  check("accepting keeps two paragraphs; rejecting joins them again", accepted(e) === "Hello| world." && rejected(e) === "Hello world.", `${accepted(e)} / ${rejected(e)}`);
  type(e, "And");
  check("text typed there is part of the suggestion", shows(e) === "Hello|¶+{+And+} world.", shows(e));
  const changes = changesOf(e.state.doc);
  check("a break and its words are one change", changes.length === 1 && changes[0].pieces.length === 2 && changeText(e.state.doc, changes[0]) === "¶ And", `${changes.length} ${changes[0] ? changeText(e.state.doc, changes[0]) : ""}`);
  resolveAll(e, "reject");
  check("rejected, the document is exactly what it was", JSON.stringify(e.getJSON()) === JSON.stringify(editorFor("x", original).getJSON()), shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "Hello");
  press(e, "Enter");
  backspace(e);
  check("taking back your own Enter just joins the paragraphs", shows(e) === "Hello world." && e.state.doc.childCount === 1 && !hasChanges(e.state.doc), shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("First.")), p(null, t("Second."))]);
  caretBefore(e, "Second");
  backspace(e);
  check("Backspace at a paragraph's start marks the break as deleted", shows(e) === "First.|¶-Second.", shows(e));
  check("and puts the caret at the end of the one before", e.state.selection.from === find(e, "First.") + 6, String(e.state.selection.from));
  check("accepting joins them; rejecting leaves them", accepted(e) === "First.Second." && rejected(e) === "First.|Second.", `${accepted(e)} / ${rejected(e)}`);
  backspace(e);
  check("Backspace again goes on into the paragraph before", shows(e) === "First[-.-]|¶-Second.", shows(e));
  const groups = groupChanges(changesOf(e.state.doc));
  check("the words and the break are one deletion", groups.length === 1 && groups[0].kind === "del", JSON.stringify(groups.map((g) => [g.kind, g.from, g.to])));
}

{
  const e = suggesting("Ana", [p(null, t("First.")), p(null, t("Second."))]);
  caretAfter(e, "First.");
  forwardDelete(e);
  check("Delete at a paragraph's end does the same from the other side", shows(e) === "First.|¶-Second." && e.state.selection.from === find(e, "Second"), `${shows(e)} @${e.state.selection.from}`);
  forwardDelete(e);
  check("and goes on into the next paragraph", shows(e) === "First.|¶-[-S-]econd.", shows(e));
}

{
  const original = [p(null, t("Hello there.")), p(null, t("General world."))];
  const e = suggesting("Ana", original);
  e.commands.setTextSelection({ from: find(e, "llo"), to: find(e, "world") });
  type(e, "X");
  check("typing over a selection across paragraphs strikes both parts and the break", shows(e) === "He[-llo there.-]|¶-[-General -]{+X+}world.", shows(e));
  check("accepted: one paragraph, as a plain edit would leave it", accepted(e) === "HeXworld.", accepted(e));
  check("rejected: the original", JSON.stringify(resolvedDoc(e.state.doc, "reject").toJSON()) === JSON.stringify(editorFor("x", original).getJSON()), rejected(e));
  const groups = groupChanges(changesOf(e.state.doc));
  check("one replacement in the list", groups.length === 1 && groups[0].kind === "replace", JSON.stringify(groups.map((g) => g.kind)));
}

{
  const original = [p(null, t("One.")), p(null, t("Two.")), p(null, t("Three."))];
  const e = suggesting("Ana", original);
  e.commands.setTextSelection({ from: find(e, "ne."), to: find(e, "hree") });
  press(e, "Backspace");
  check("deleting across three paragraphs keeps all three, struck", shows(e) === "O[-ne.-]|¶-[-Two.-]|¶-[-T-]hree.", shows(e));
  check("accepted: joined", accepted(e) === "Ohree.", accepted(e));
  check("rejected: the original", JSON.stringify(resolvedDoc(e.state.doc, "reject").toJSON()) === JSON.stringify(editorFor("x", original).getJSON()));
}

{
  // The whole first paragraph, selected and deleted.
  const e = suggesting("Ana", [p(null, t("One.")), p(null, t("Two."))]);
  e.commands.setTextSelection({ from: 1, to: find(e, "Two") });
  press(e, "Backspace");
  check("deleting the first paragraph whole strikes its words and the break after", shows(e) === "[-One.-]|¶-Two.", shows(e));
  check("accepted, the second is what's left", accepted(e) === "Two.", accepted(e));
}

// ---------------------------------------------------------------- suggesting: lists, page breaks, everything at once

{
  const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
  const original = [{ type: "bulletList", content: [li(p(null, t("First item"))), li(p(null, t("Second item")))] }, p(null, t("After."))];
  const e = suggesting("Ana", original);
  caretAfter(e, "First");
  press(e, "Enter");
  check("Enter in a list item makes an item whose break is the suggestion", shows(e) === "First|¶+ item|Second item|After." && e.state.doc.child(0).childCount === 3, `${shows(e)} (${e.state.doc.child(0).childCount} items)`);
  check("rejected, the list is as it was", JSON.stringify(resolvedDoc(e.state.doc, "reject").toJSON()) === JSON.stringify(editorFor("x", original).getJSON()), rejected(e));
  caretBefore(e, "Second");
  press(e, "Tab");
  check("Tab nests the item: formatting, not a suggestion", e.state.doc.child(0).childCount === 2 && changesOf(e.state.doc).length === 1, `${e.state.doc.child(0).childCount} items, ${changesOf(e.state.doc).length} changes`);
  caretBefore(e, "After");
  backspace(e);
  check("Backspace into the list from the paragraph after marks that break", shows(e).endsWith("Second item|¶-After."), shows(e));
  check("accepted, it joins the last item", accepted(e).endsWith("Second itemAfter."), accepted(e));
}

{
  const e = suggesting("Ana", [p(null, t("Before.")), p({ pageBreakBefore: true }, t("Starts a page here."))]);
  caretAfter(e, "Starts a page");
  press(e, "Enter");
  const second = e.state.doc.child(2);
  check("splitting a paragraph that starts a page: the new one is the suggestion, and doesn't start a page too", shows(e) === "Before.|Starts a page|¶+ here." && second.attrs.pageBreakBefore === null && e.state.doc.child(1).attrs.pageBreakBefore === true, `${shows(e)} ${String(second.attrs.pageBreakBefore)}`);
}

{
  const original = [p(null, t("One.")), { type: "heading", attrs: { level: 2 }, content: [t("Two")] }, p(null, t("Three."))];
  const e = suggesting("Ana", original);
  e.commands.selectAll();
  type(e, "X");
  check("select all and type: everything struck, the new text after it", shows(e) === "[-One.-]|¶-[-Two-]|¶-[-Three.-]{+X+}", shows(e));
  check("accepted: just what was typed", accepted(e) === "X", accepted(e));
  type(e, "Y");
  check("and typing goes on after it", shows(e).endsWith("{+XY+}"), `${shows(e)} @${e.state.selection.from}`);
  check("rejected: all of it back", JSON.stringify(resolvedDoc(e.state.doc, "reject").toJSON()) === JSON.stringify(editorFor("x", original).getJSON()), rejected(e));
  check("one replacement to decide on", groupChanges(changesOf(e.state.doc)).length === 1 && groupChanges(changesOf(e.state.doc))[0].kind === "replace");
}

{
  // An input rule (a line that starts "- " becomes a bullet) is the app's
  // doing, on text the person just suggested.
  const e = suggesting("Ana", [p(null, t("Text.")), p(null)]);
  e.commands.setTextSelection(e.state.doc.content.size - 1);
  const typed = (text: string) => {
    const { from, to } = e.state.selection;
    const deflt = () => e.state.tr.insertText(text, from, to);
    if (!e.view.someProp("handleTextInput", (f) => f(e.view, from, to, text, deflt))) e.view.dispatch(deflt());
  };
  typed("-");
  typed(" ");
  check("an input rule still works while suggesting", e.state.doc.child(1).type.name === "bulletList", `${e.state.doc.child(1).type.name} ${shows(e)}`);
  typed("a");
  check("and what's typed after it is a suggestion", shows(e).includes("{+a+}") && changesOf(e.state.doc).length === 1, shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("Cut this out, please."))]);
  select(e, "this out");
  e.view.dispatch(e.state.tr.deleteSelection().setMeta("uiEvent", "cut"));
  check("cutting strikes what was cut", shows(e) === "Cut [-this out-], please.", shows(e));
  caretAfter(e, "please");
  paste(e, "<p>this out</p>");
  check("and pasting it elsewhere adds it there: a move is a deletion and an insertion", shows(e) === "Cut [-this out-], please{+this out+}.", shows(e));
}

// ---------------------------------------------------------------- formatting isn't tracked

{
  const e = suggesting("Ana", [p(null, t("Hello world.")), p(null, t("Next."))]);
  select(e, "world");
  e.commands.toggleBold();
  check("bold while suggesting is just bold", shows(e) === "Hello world.|Next." && !!e.state.doc.nodeAt(find(e, "world"))?.marks.some((m) => m.type.name === "bold"), shows(e));
  caretBefore(e, "Next");
  e.commands.setNode("heading", { level: 2 });
  check("so is making a heading", e.state.doc.child(1).type.name === "heading" && !hasChanges(e.state.doc), shows(e));
  e.commands.toggleBulletList();
  check("and making a list", e.state.doc.child(1).type.name === "bulletList" && !hasChanges(e.state.doc), shows(e));
}

{
  // Outside Suggesting, tracking marks aren't formatting either.
  const e = editorFor("Ana", [p(null, t("Hello "), t("big ", ins("Bo")), t("old ", del("Bo")), t("world."))]);
  e.commands.selectAll();
  clearFormatting(e);
  check("clear formatting leaves suggestions alone", shows(e) === "Hello {+big +}[-old -]world.", shows(e));
  e.commands.unsetAllMarks();
  check("so does removing all marks", shows(e) === "Hello {+big +}[-old -]world.", shows(e));
  e.commands.setTextSelection(find(e, "old ") + 1);
  type(e, "Z");
  check("typing inside a suggestion while Editing is plain text", shows(e) === "Hello {+big +}[-o-]Z[-ld -]world.", shows(e));
  e.commands.setTextSelection(find(e, "big ") + 1);
  type(e, "Q");
  check("inside an insertion too", shows(e) === "Hello {+b+}Q{+ig +}[-o-]Z[-ld -]world.", shows(e));
}

{
  const e = editorFor("Ana", [p(null, t("First.")), p({ tc: encodeRevs({ ins: { a: "Bo", t: 1700000000 } }) }, t("Second line."))]);
  caretAfter(e, "Second");
  press(e, "Enter");
  check("splitting a suggested paragraph while Editing doesn't make a second suggestion", shows(e) === "First.|¶+Second| line.", shows(e));
}

// ---------------------------------------------------------------- things taken whole

{
  const e = suggesting("Ana", [p(null, t("Before.")), p(null, t("After."))]);
  caretAfter(e, "Before.");
  insertTable(e, 2, 2);
  check("a table inserted while suggesting is one suggestion", shows(e) === "Before.|<table+>|After.", shows(e));
  type(e, "A1");
  check("what's typed in it is tracked like any text", e.state.doc.child(1).textContent === "A1" && changesOf(e.state.doc).length === 1, JSON.stringify(changesOf(e.state.doc).map((c) => [c.kind, c.from, c.to])));
  tableCommands.rowBelow(e);
  check("adding a row is an edit to the table, not a suggestion", e.state.doc.child(1).childCount === 3, String(e.state.doc.child(1).childCount));
  check("rejected, the table is gone", rejected(e) === "Before.|After.", rejected(e));
  check("accepted, it is an ordinary table", accepted(e) === "Before.|<table>|After.", accepted(e));
}

{
  const e = editorFor("Ana", [p(null, t("Before.")), p(null, t("After."))]);
  caretAfter(e, "Before.");
  insertTable(e, 2, 2);
  setReviewMode(e, "suggest");
  tableCommands.deleteTable(e);
  check("deleting a table while suggesting strikes it", shows(e) === "Before.|<table->|After.", shows(e));
  check("accepted, it goes; rejected, it stays", accepted(e) === "Before.|After." && rejected(e) === "Before.|<table>|After.", `${accepted(e)} / ${rejected(e)}`);
}

{
  const e = suggesting("Ana", [p(null, t("Text.")), { type: "horizontalRule" }, p(null, t("More."))]);
  e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, 7)));
  press(e, "Backspace");
  check("a divider deleted is struck", shows(e) === "Text.|<horizontalRule->|More.", shows(e));
  check("and goes when accepted", accepted(e) === "Text.|More.", accepted(e));
}

{
  const e = suggesting("Ana", [p(null, t("Text.")), { type: "image", attrs: { src: "/a.png", width: 100, height: 50 } }, p(null, t("More."))]);
  const at = 7;
  e.view.dispatch(e.state.tr.setNodeMarkup(at, undefined, { ...e.state.doc.nodeAt(at)!.attrs, width: 60, height: 30 }));
  check("resizing a picture isn't a suggestion", !hasChanges(e.state.doc) && e.state.doc.nodeAt(at)?.attrs.width === 60, shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("Some code:")), { type: "codeBlock", content: [t("let a = 1;")] }]);
  caretAfter(e, "let a");
  type(e, "b");
  check("text that can't carry marks (code) is edited directly", e.state.doc.child(1).textContent === "let ab = 1;" && !hasChanges(e.state.doc), shows(e));
}

{
  const e = suggesting("Ana", [p(null, t("A claim."))]);
  caretAfter(e, "claim");
  insertNote(e, "foot");
  check("a footnote added while suggesting is a suggestion", shows(e) === "A claim<footnote+>.", shows(e));
  const dom = e.view.dom.querySelector("sup.wf-fn");
  const inner = dom ? openNotes.get(dom) : undefined;
  check("its note opens to be written", !!inner);
  inner?.dispatch(inner.state.tr.insertText("Source."));
  const note = e.state.doc.child(0).child(1);
  check("what's written in it arrives in the document", note.textContent === "Source.", note.textContent);
  check("rejected, the note is gone", rejected(e) === "A claim.", rejected(e));
}

// ---------------------------------------------------------------- pasting

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "Hello");
  paste(e, "<p>one</p><p>two</p>");
  check("a paste of two paragraphs is one insertion, break and all", shows(e) === "Hello{+one+}|¶+{+two+} world.", shows(e));
  check("rejected: as before", rejected(e) === "Hello world.", rejected(e));
  check("one change in the list", changesOf(e.state.doc).length === 1, String(changesOf(e.state.doc).length));
}

{
  const e = suggesting("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "Hello");
  paste(e, '<p><ins data-rev="ins" data-a="Bo" data-t="1700000000">new</ins> <del data-rev="del" data-a="Bo" data-t="1700000000">gone</del>!</p>');
  check("pasted while suggesting, copied tracking becomes this person's insertion (struck words aren't pasted)", shows(e) === "Hello{+new !+} world.", shows(e));
  check("under their name", changesOf(e.state.doc).length === 1 && changesOf(e.state.doc)[0].author === "Ana", JSON.stringify(changesOf(e.state.doc).map((c) => c.author)));
}

{
  const e = editorFor("Ana", [p(null, t("Hello world."))]);
  caretAfter(e, "Hello");
  paste(e, '<p><ins data-rev="ins" data-a="Bo" data-t="1700000000">new</ins></p>');
  check("pasted while Editing, tracked text keeps its tracking (moving a paragraph doesn't accept it)", shows(e) === "Hello{+new+} world." && changesOf(e.state.doc)[0]?.author === "Bo", shows(e));
  paste(e, "<p><del>struck on a web page</del></p>");
  check("a web page's <del> is strikethrough, not a suggestion", !e.getJSON().content?.some((b) => JSON.stringify(b).includes(DELETION)) && JSON.stringify(e.getJSON()).includes('"strike"'), JSON.stringify(e.getJSON()).slice(0, 300));
}

// ---------------------------------------------------------------- accepting and rejecting, one at a time

{
  const e = suggesting("Ana", [p(null, t("One two three four."))]);
  select(e, "two ");
  press(e, "Backspace");
  caretAfter(e, "three");
  type(e, " and a half");
  check("two separate changes", shows(e) === "One [-two -]three{+ and a half+} four.", shows(e));
  const [first, second] = changesOf(e.state.doc);
  resolveInEditor(e, [first], "accept");
  check("accepting one leaves the other", shows(e) === "One three{+ and a half+} four.", shows(e));
  resolveInEditor(e, changesOf(e.state.doc), "reject");
  check("rejecting the other", shows(e) === "One three four." && !hasChanges(e.state.doc), shows(e));
  void second;
  e.commands.setTextSelection(1);
  check("no changes: nothing to step to", stepChange(e, 1) === null);
}

{
  const e = suggesting("Ana", [p(null, t("One two three."))]);
  select(e, "two");
  type(e, "2");
  caretAfter(e, "three");
  type(e, "!");
  e.commands.setTextSelection(1);
  const a = stepChange(e, 1);
  const b = stepChange(e, 1);
  const c = stepChange(e, 1);
  check("stepping through the changes, round again at the end", a?.kind === "replace" && b?.kind === "ins" && c?.id === a?.id, `${a?.kind} ${b?.kind} ${c?.kind}`);
  check("stepping selects the change", e.state.selection.from === a!.from && e.state.selection.to === a!.to, `${e.state.selection.from}-${e.state.selection.to} vs ${a!.from}-${a!.to}`);
  check("and backwards", stepChange(e, -1)?.id === b?.id);
}

// ---------------------------------------------------------------- the same text, without an editor

{
  const doc: JSONContent = {
    type: "doc",
    content: [p(null, t("Keep "), t("add ", ins("Bo")), t("drop ", del("Bo")), t("end.")), p({ tc: withRev(null, "del", { a: "Bo", t: 1 }) }, t("Joined."))],
  };
  const schema = contentSchema();
  const final = resolvedJson(doc, "accept", schema);
  check("JSON resolved without an editor: accepted", JSON.stringify(final.content?.map((b) => (b.content ?? []).map((c) => c.text).join(""))) === '["Keep add end.Joined."]', JSON.stringify(final));
  const first = resolvedJson(doc, "reject", schema);
  check("and rejected", JSON.stringify(first.content?.map((b) => (b.content ?? []).map((c) => c.text).join(""))) === '["Keep drop end.","Joined."]', JSON.stringify(first));
  check("nothing tracked is left in either", !JSON.stringify(final).includes(INSERTION) && !JSON.stringify(first).includes('"tc":"'), JSON.stringify(first));
  check("a document without changes is returned as it is", resolvedJson({ type: "doc", content: [p(null, t("Plain."))] }, "accept", schema).content?.length === 1);
  const rough = resolvedJson(doc, "accept", null);
  check("without a schema the words are still right", JSON.stringify(rough.content?.map((b) => (b.content ?? []).map((c) => c.text).join(""))) === '["Keep add end.","Joined."]', JSON.stringify(rough));
}

// ---------------------------------------------------------------- the same edits, tracked and not

{
  // Any run of edits made while suggesting: accepting everything must give
  // what the edits would have made directly, and rejecting everything the
  // document as it was.
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  // (No full stops: joined, "gamma.Delta" would be auto-linked as an address
  // in the plain editor, which has nothing to do with tracking.)
  const plain = [p(null, t("Alpha beta gamma;")), p(null, t("Delta epsilon")), p(null, t("Zeta eta theta iota!")), p(null, t("Kappa"))];
  // With a heading among them, a paragraph split off a heading that is
  // waiting to be joined is a heading — joined first, as a plain edit does
  // it, it would have been a paragraph. The words and breaks still agree.
  const mixed = [plain[0], { type: "heading", attrs: { level: 2 }, content: [t("Delta epsilon")] }, plain[2], plain[3]];
  for (const [label, start, strict] of [["paragraphs", plain, true], ["a heading among them", mixed, false]] as const) {
  const startJson = JSON.stringify(editorFor("x", [...start]).getJSON());
  let failures = 0;
  let firstFailure = "";
  /** Text positions (inside paragraphs) of a document. */
  const textPositions = (doc: PmNode): number[] => {
    const out: number[] = [];
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      for (let i = 0; i <= node.content.size; i += 1) out.push(pos + 1 + i);
      return false;
    });
    return out;
  };
  const ROUNDS = Number(process.env.WF_ROUNDS ?? 60);
  const ONLY = process.env.WF_ROUND ? Number(process.env.WF_ROUND) : -1;
  for (let round = ONLY >= 0 ? ONLY : 0; round < (ONLY >= 0 ? ONLY + 1 : ROUNDS); round += 1) {
    const rand = rng(round * 7919 + 13);
    const pick = (n: number) => Math.floor(rand() * n);
    const direct = editorFor("Ana", [...start]);
    const tracked = suggesting("Ana", [...start]);
    const log: string[] = [];
    const steps = 3 + pick(8);
    for (let s = 0; s < steps; s += 1) {
      // Positions are chosen in the plain document; the tracked one still
      // holds what was struck, so they are mapped across.
      const spots = textPositions(resolvedDoc(tracked.state.doc, "accept"));
      const a = spots[pick(spots.length)];
      const b = spots[pick(spots.length)];
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      const op = pick(6);
      const across = (pos: number, assoc: number) => {
        // Where the accepted text's position `pos` is in the tracked document.
        const tr = new Transform(tracked.state.doc);
        resolveChanges(tr, changesOf(tr.doc), "accept");
        return tr.mapping.invert().map(pos, assoc);
      };
      // (Where a paragraph was removed whole, "before what was struck" is
      // between blocks: the caret goes at the start of the text after.)
      const inText = (e: Editor, pos: number) => {
        const $pos = e.state.doc.resolve(pos);
        return $pos.parent.inlineContent ? pos : TextSelection.near($pos, 1).from;
      };
      const place = (e: Editor, x: number, y: number) => e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, inText(e, x), inText(e, y))));
      // Where a caret sits among struck text matters to the next key:
      // Delete has to be past it to reach the live letter after, Backspace
      // before it. A range starts after anything struck and ends before it.
      const both = (run: (e: Editor) => void, x: number, y: number, side = -1) => {
        place(direct, x, y);
        if (x === y) place(tracked, across(x, side), across(x, side));
        else place(tracked, across(x, 1), across(y, -1));
        run(direct);
        run(tracked);
      };
      // Among struck text a key first steps over it (a press that changes
      // nothing); the plain document has no such text. So before a
      // Backspace or Delete the tracked caret goes as far as those presses
      // would take it.
      const settle = (dir: -1 | 1) => {
        for (let guard = 0; guard < 200; guard += 1) {
          const { $from } = tracked.state.selection;
          const doc = tracked.state.doc;
          const beside = dir < 0 ? $from.nodeBefore : $from.nodeAfter;
          let to: number | null = null;
          if (beside?.isText && beside.marks.some((m) => m.type.name === DELETION)) to = $from.pos + dir * beside.nodeSize;
          else if (!beside && dir < 0 && parseRevs($from.parent.attrs.tc)?.del) {
            const start = breakStart(doc, $from.before());
            if (start.joins) to = start.pos;
          } else if (!beside && dir > 0) {
            const next = breakAfter(doc, $from.after());
            if (next !== null && parseRevs(doc.nodeAt(next)?.attrs.tc)?.del) to = next + 1;
          }
          if (to === null) return;
          tracked.view.dispatch(tracked.state.tr.setSelection(TextSelection.create(doc, to)));
        }
      };
      if (op === 0) {
        log.push(`type@${a}`);
        both((e) => type(e, "xy"), a, a);
      } else if (op === 1) {
        log.push(`over@${from}-${to}`);
        both((e) => type(e, "Q"), from, to);
      } else if (op === 2) {
        log.push(`cut@${from}-${to}`);
        both((e) => {
          if (!e.state.selection.empty) return void press(e, "Backspace");
          if (e === tracked) settle(-1);
          backspace(e);
        }, from, to);
      } else if (op === 3) {
        log.push(`enter@${a}`);
        both((e) => void press(e, "Enter"), a, a);
      } else if (op === 4) {
        log.push(`bksp@${a}`);
        both((e) => {
          if (e === tracked) settle(-1);
          backspace(e);
        }, a, a);
      } else {
        log.push(`del@${a}`);
        both((e) => {
          if (e === tracked) settle(1);
          forwardDelete(e);
        }, a, a, 1);
      }
      if (ONLY >= 0) console.log(`  ${log[log.length - 1]}  →  ${shows(tracked)}   ‖   ${render(direct.state.doc)}`);
      // (The editor keeps an empty paragraph after a closing heading; a
      // document resolved outside it has none. Not what is being tested.)
      const norm = (json: JSONContent) => {
        const blocks = [...(json.content ?? [])];
        while (blocks.length > 1 && (!strict || blocks[blocks.length - 1].type === "paragraph") && !blocks[blocks.length - 1].content?.length) blocks.pop();
        return strict ? JSON.stringify(blocks) : JSON.stringify(blocks.map((b) => (b.content ?? []).map((c) => c.text ?? "").join("")));
      };
      const want = norm(direct.getJSON());
      const got = norm(resolvedDoc(tracked.state.doc, "accept").toJSON() as JSONContent);
      const back = norm(resolvedDoc(tracked.state.doc, "reject").toJSON() as JSONContent);
      if (want !== got || back !== norm(JSON.parse(startJson) as JSONContent)) {
        failures += 1;
        if (!firstFailure) {
          firstFailure = `round ${round} after ${log.join(" ")}: ${want !== got ? `accepted ${render(resolvedDoc(tracked.state.doc, "accept"))} ≠ direct ${render(direct.state.doc)}` : `rejected ${render(resolvedDoc(tracked.state.doc, "reject"))}`} — tracked ${shows(tracked)}`;
        }
        break;
      }
    }
    direct.destroy();
    tracked.destroy();
  }
  check(`${ROUNDS} random runs of edits (${label}): accept-all equals the direct edits, reject-all the original`, failures === 0, `${failures} failed; ${firstFailure}`);
  }
}

// ---------------------------------------------------------------- two people at once

{
  const bound = (who: string, ydoc: Y.Doc) =>
    new Editor({
      element: mountPoint(),
      extensions: [...docContentExtensions({ history: false }), Suggesting.configure({ author: () => who }), Collaboration.configure({ document: ydoc })],
    });
  const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote");
  const ya = new Y.Doc();
  const yb = new Y.Doc();
  const a = bound("Ana", ya);
  const b = bound("Bo", yb);
  a.commands.setContent({ type: "doc", content: [p(null, t("The quick brown fox.")), p(null, t("Jumps."))] });
  sync(ya, yb);
  sync(yb, ya);
  setReviewMode(a, "suggest");
  setReviewMode(b, "suggest");
  // Both suggest at once, in different places.
  select(a, "quick ");
  press(a, "Backspace");
  caretAfter(b, "fox");
  type(b, "es");
  sync(ya, yb);
  sync(yb, ya);
  check("two people suggesting at once: both suggestions arrive, each under its own name", shows(a) === shows(b) && shows(a) === "The [-quick -]brown fox{+es+}.|Jumps.", `${shows(a)} / ${shows(b)}`);
  const authors = changesOf(a.state.doc).map((c) => c.author).sort().join(",");
  check("each under its own name", authors === "Ana,Bo", authors);
  // One accepts a change while the other is still writing theirs.
  setReviewMode(a, "edit");
  resolveInEditor(a, changesOf(a.state.doc).filter((c) => c.author === "Bo"), "accept");
  type(b, "!");
  sync(ya, yb);
  sync(yb, ya);
  check("accepting while the other is still typing converges", shows(a) === shows(b), `${shows(a)} / ${shows(b)}`);
  // (A letter typed onto the end of a suggestion in the same moment it is
  // accepted arrives accepted with it: the two edits merge that way.)
  check("and nothing typed is lost", shows(a).includes("foxes!"), shows(a));
  // Undo isn't theirs to break: a remote change is never rewritten.
  setReviewMode(b, "suggest");
  a.commands.setTextSelection(find(a, "Jumps") + 5);
  type(a, " high");
  sync(ya, yb);
  check("an edit arriving from someone who is Editing isn't turned into a suggestion by a reader who is Suggesting", shows(b).endsWith("Jumps high."), shows(b));
}

// ---------------------------------------------------------------- what else reads the text

{
  const e = editorFor("Ana", [p(null, t("One two "), t("three four ", del("Bo")), t("five "), t("six", ins("Bo")), t("."))]);
  check("the word count is of the text as it would stand: struck words out, suggested ones in", countDocWords(e.state.doc) === 4, String(countDocWords(e.state.doc)));
  const doc = e.getJSON();
  const down = downlevelJson({ type: "doc", content: [...(doc.content ?? []), p({ tc: withRev(null, "del", { a: "Bo", t: 1 }) }, t("Joined."))] }, 1, contentSchema());
  const flat = (down.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? "").join(""));
  check("for a server that can't hold tracked changes, the text goes with them accepted — struck words aren't brought back", JSON.stringify(flat) === '["One two five six.Joined."]' && levelOfJson(down) === 1, JSON.stringify(flat));
}

// ---------------------------------------------------------------- read aloud

{
  const split = splitter("en");
  const e = new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(), ReadAloudHighlight],
    content: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [t("A title")] },
        p(null, t("First sentence. Second one, with "), t("struck words and ", del("Bo")), t("an end"), { type: "footnote", content: [t("A note. Not read.")] }, t("! Third?")),
        p(null),
        { type: "table", attrs: { tc: "del:1:Bo" }, content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(null, t("In a struck table."))] }] }] },
        p(null, t("Last"), { type: "hardBreak" }, t("line.")),
      ],
    },
  });
  const doc = e.state.doc;
  const all: string[] = [];
  for (let s = sentenceFrom(doc, 0, split); s; s = sentenceFrom(doc, s.to, split)) all.push(s.text);
  check(
    "the text in sentences: a heading is one, struck words and notes aren't read, nor a struck table",
    JSON.stringify(all) === JSON.stringify(["A title", "First sentence.", "Second one, with an end!", "Third?", "Last line."]),
    JSON.stringify(all),
  );
  const second = sentencesOf(doc.child(1), doc.child(0).nodeSize, split)[1];
  // (The range runs from its first letter to its last: what is struck or
  // noted within is inside the highlight, though not read.)
  check("a sentence's range is where its words are", doc.textBetween(second.from, second.to).startsWith("Second one, with ") && doc.textBetween(second.from, second.to).endsWith("!") && second.text === "Second one, with an end!", doc.textBetween(second.from, second.to, "", "*"));
  check("the sentence a position is in", sentenceFrom(doc, second.from + 3, split)?.text === second.text && sentenceBefore(doc, second.from, split)?.text === "First sentence.");

  // A voice that says nothing, and reports what it was asked to say.
  const said: { text: string; rate: number; lang: string }[] = [];
  let current: { onend?: (() => void) | null; onerror?: ((e: { error: string }) => void) | null } | null = null;
  let cancels = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  g.SpeechSynthesisUtterance = class {
    text: string;
    rate = 1;
    lang = "";
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
  (g.window as Record<string, unknown>).speechSynthesis = {
    speak(u: { text: string; rate: number; lang: string; onend?: (() => void) | null }) {
      said.push({ text: u.text, rate: u.rate, lang: u.lang });
      current = u;
    },
    cancel() {
      cancels += 1;
      // (As engines do: the cancelled one hears about it.)
      const was = current;
      current = null;
      was?.onerror?.({ error: "interrupted" });
    },
    getVoices: () => [],
  };
  const done = () => {
    const was = current;
    current = null;
    was?.onend?.();
  };
  const shown = () => (e.view.dom.querySelector(".wf-reading")?.textContent ?? null);
  let state: ReadAloudState = { status: "idle", rate: 1, voice: null };
  const reader = new ReadAloud(e, "en-GB", (next) => {
    state = next;
  });
  e.commands.setTextSelection(second.from + 5);
  reader.play();
  check("reading starts at the sentence the caret is in", said.length === 1 && said[0].text === second.text && said[0].lang === "en-GB" && state.status === "playing", JSON.stringify(said));
  check("which is highlighted in the text (its struck words aside)", (shown() ?? "").startsWith("Second one, with ") && !!e.view.dom.querySelector(".wf-reading"), String(shown()));
  check("the highlight isn't an edit", JSON.stringify(e.getJSON()) === JSON.stringify(doc.toJSON()));
  done();
  check("when a sentence ends the next is read", said[said.length - 1].text === "Third?" && shown() === "Third?", JSON.stringify(said.map((s) => s.text)));
  reader.pause();
  done();
  check("paused, it stays where it is", state.status === "paused" && said.length === 2 && shown() === "Third?", `${state.status} ${said.length}`);
  reader.play();
  check("and goes on with the same sentence", said.length === 3 && said[2].text === "Third?" && state.status === "playing");
  // Someone types above while it reads.
  e.view.dispatch(e.state.tr.insertText("Brand new words. ", 1));
  done();
  check("an edit above doesn't lose the place", said[said.length - 1].text === "Last line." && (shown() ?? "").startsWith("Last"), `${said[said.length - 1].text} / ${shown()}`);
  reader.step(-1);
  check("back a sentence", said[said.length - 1].text === "Third?", said[said.length - 1].text);
  reader.setRate(RATES[3]);
  check("a new speed says the sentence again at it, and is remembered", said[said.length - 1].text === "Third?" && said[said.length - 1].rate === RATES[3] && localStorage.getItem("wf-read-rate") === String(RATES[3]), JSON.stringify(said[said.length - 1]));
  reader.step(1);
  done();
  check("at the end it stops, and the highlight goes", state.status === "idle" && shown() === null, `${state.status} ${shown()}`);
  reader.play();
  reader.stop();
  check("stop: silent, nothing highlighted", state.status === "idle" && shown() === null && cancels > 0);
  reader.destroy();
}

// ---------------------------------------------------------------- compare

{
  const doc = (...blocks: JSONContent[]): JSONContent => ({ type: "doc", content: blocks });
  const before = doc(
    { type: "heading", attrs: { level: 1 }, content: [t("Chapter one")] },
    p(null, t("The quick brown fox jumps over the lazy dog.")),
    p(null, t("A paragraph that will be removed entirely from the text.")),
    p(null, t("An unchanged paragraph.")),
    p(null, t("Another that stays.")),
  );
  const after = doc(
    { type: "heading", attrs: { level: 1 }, content: [t("Chapter one")] },
    p(null, t("A brand new opening paragraph nobody has seen.")),
    p(null, t("The quick red fox jumps over the lazy dog!")),
    p(null, t("An unchanged paragraph.")),
    p(null, t("Another that stays.")),
  );
  const same = compareDocs(before, before);
  check("a version compared with itself: nothing differs", same.changed === 0 && same.rows.every((r) => r.status === "same") && same.rows.length === 5);
  const result = compareDocs(before, after);
  const statuses = result.rows.map((r) => r.status).join(" ");
  check("paragraphs are aligned: one added, one rewritten, one removed, the rest the same", statuses === "same added changed removed same same", statuses);
  const changed = result.rows.find((r) => r.status === "changed")!;
  const side = (segs: { text: string; op: string }[] | null) => (segs ?? []).map((s) => (s.op === "same" ? s.text : s.op === "del" ? `[-${s.text}-]` : `{+${s.text}+}`)).join("");
  check("a rewritten paragraph differs word by word: what went on the left", side(changed.left) === "The quick [-brown-] fox jumps over the lazy dog[-.-]", side(changed.left));
  check("what came on the right", side(changed.right) === "The quick {+red+} fox jumps over the lazy dog{+!+}", side(changed.right));
  check("and both in one for a narrow screen", side(changed.merged) === "The quick [-brown-]{+red+} fox jumps over the lazy dog[-.-]{+!+}", side(changed.merged));
  check("the count of words in and out", result.changed === 3 && result.wordsAdded === 9 && result.wordsRemoved === 11, `${result.changed} +${result.wordsAdded} -${result.wordsRemoved}`);
  const words = diffWords("one two three", "one three four");
  check("words: a deletion and an insertion", side(words.left) === "one [-two -]three" && side(words.right) === "one three{+ four+}", `${side(words.left)} / ${side(words.right)}`);
  const kinds = compareDocs(doc(p(null, t("Title"))), doc({ type: "heading", attrs: { level: 2 }, content: [t("Title")] }));
  check("a paragraph made a heading is a difference, though its words are the same", kinds.changed === 1 && kinds.rows[0].status === "changed" && kinds.rows[0].rightKind === "heading 2", JSON.stringify(kinds.rows[0]));
  const tracked = doc(p(null, t("Keep "), t("gone ", del("Bo")), t("new ", ins("Bo")), t("end.")));
  check("a version's own suggestions read as accepted", flattenBlocks(tracked)[0].text === "Keep new end.", flattenBlocks(tracked)[0].text);
  const nested = doc({ type: "bulletList", content: [{ type: "listItem", content: [p(null, t("An item"))] }] }, { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(null, t("A cell"))] }] }] }, { type: "horizontalRule" });
  check("lists and tables give their paragraphs; a divider is a line of its own", flattenBlocks(nested).map((b) => `${b.kind}:${b.text}`).join("|") === "paragraph:An item|paragraph:A cell|divider:", flattenBlocks(nested).map((b) => `${b.kind}:${b.text}`).join("|"));
  // A book's worth: quick enough to open without a wait.
  const long = (edit: boolean): JSONContent =>
    doc(...Array.from({ length: 3000 }, (_, i) => p(null, t(`Paragraph ${i} of the long text, with ${edit && i % 100 === 7 ? "some altered" : "its own"} words to tell it from the others and enough of them to be a real line or two.`))));
  const started = Date.now();
  const big = compareDocs(long(false), long(true));
  const took = Date.now() - started;
  check(`3,000 paragraphs with 30 changed compare in ${took} ms`, big.changed === 30 && took < 3000, `${big.changed} changed`);
}

finish();
