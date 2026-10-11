// Pasting from another program: by default it matches this document — the
// words, their structure and their emphasis, without the other document's
// look — and "keep its styling" is one click away until the next thing is
// typed.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { PasteFormat, pasteChoice, settlePaste, switchPaste } from "../src/editor/format/paste";
import { docContentExtensions } from "../src/editor/schema/content";
import { PasteOptions } from "../src/editor/ui/PasteOptions";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const t = (text: string): JSONContent => ({ type: "text", text });
const para = (text: string): JSONContent => ({ type: "paragraph", content: [t(text)] });
const make = (content: JSONContent[] = [para("Before. After.")]) =>
  new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), PasteFormat], content: { type: "doc", content } });
/** Paste as the clipboard does: the HTML another program put there. */
const paste = (editor: Editor, html: string) => {
  const event = Object.assign(new window.Event("paste"), { clipboardData: { getData: (type: string) => (type === "text/html" ? html : "") } });
  editor.view.pasteHTML(html, event as never);
};
const caret = (editor: Editor, pos: number, to = pos) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos, to)));
/** Every stretch of text with the marks on it. */
const runs = (editor: Editor): string =>
  (() => {
    const out: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText) out.push(`${node.text}[${node.marks.map((m) => m.type.name).sort().join(",")}]`);
    });
    return out.join(" ");
  })();
const blocks = (editor: Editor): string => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(`${node.type.name}${node.attrs.level ? node.attrs.level : ""}${node.attrs.align ? `:${node.attrs.align}` : ""}`));
  return out.join(" ");
};

// What a web page or a word processor puts on the clipboard.
const FROM_ELSEWHERE =
  '<h2 style="text-align:center;font-family:Impact;color:#c00000">A heading</h2>' +
  '<p style="font-family:Comic Sans MS;font-size:20pt;text-align:right"><b>Bold</b> and <span style="color:#ff0000">red</span>, <span style="background-color:#ffff00">marked</span>, ' +
  '<a href="https://example.com/x">a link</a> and <i>slanted</i>.</p>' +
  "<ul><li>One</li><li>Two</li></ul>";

{
  // (Into an empty paragraph, so what is pasted keeps its own blocks.)
  const e = make([para("Start."), { type: "paragraph" }]);
  caret(e, e.state.doc.content.size - 1);
  paste(e, FROM_ELSEWHERE);
  const matched = runs(e);
  check("by default a paste matches this document: no colours, highlights, fonts or sizes come with it", !/textColor|highlight|fontFamily|fontSize/.test(matched), matched);
  check("…its emphasis and its links do", matched.includes("Bold[bold]") && matched.includes("a link[link]") && matched.includes("slanted[italic]"));
  check("…and its structure: the heading is a heading, the list a list — set as this document sets them (no alignment of its own)", blocks(e).includes("heading2") && blocks(e).includes("bulletList") && !blocks(e).includes(":center") && !blocks(e).includes(":right"), blocks(e));
  const choice = pasteChoice(e.view);
  check("the paste is remembered as one that can still be taken the other way", choice?.mode === "match" && !!choice && choice.to > choice.from);
  const asMatched = JSON.stringify(e.getJSON());

  check("“Keep its styling” brings the look back", switchPaste(e.view, "keep") && /textColor/.test(runs(e)) && /highlight/.test(runs(e)) && blocks(e).includes(":center"), `${runs(e)} / ${blocks(e)}`);
  check("…the words exactly the same", e.state.doc.textContent.includes("Bold and red, marked, a link and slanted."));
  check("…and the choice still open, now the other way round", pasteChoice(e.view)?.mode === "keep");
  check("“Match this document” goes back to exactly what it was", switchPaste(e.view, "match") && JSON.stringify(e.getJSON()) === asMatched);
  check("asking for what it already is does nothing", !switchPaste(e.view, "match"));

  // Carry on typing: the paste is settled.
  e.view.dispatch(e.state.tr.insertText(" More."));
  check("the next thing typed settles it", pasteChoice(e.view) === null && !switchPaste(e.view, "keep"));
  e.destroy();
}

{
  // Into the middle of a sentence, and with words selected.
  const e = make([para("Before. After.")]);
  caret(e, 9); // between the sentences
  paste(e, '<span style="color:#ff0000;font-size:30pt">red <b>bold</b></span>');
  check("pasted into a sentence, it joins the sentence", e.state.doc.childCount === 1 && e.state.doc.textContent === "Before. red boldAfter.", e.state.doc.textContent);
  switchPaste(e.view, "keep");
  check("…and switching touches only what was pasted", e.state.doc.textContent === "Before. red boldAfter." && runs(e).startsWith("Before. []") && runs(e).includes("After.[]") && /red \[.*textColor/.test(runs(e)), runs(e));
  switchPaste(e.view, "match");
  check("…both ways", runs(e) === "Before. red [] bold[bold] After.[]", runs(e));
  e.destroy();

  const over = make([para("Replace THIS word.")]);
  caret(over, 9, 13);
  paste(over, '<span style="color:#00b050">that</span>');
  check("pasted over selected words, it replaces them", over.state.doc.textContent === "Replace that word.");
  switchPaste(over.view, "keep");
  check("…and the other way replaces the same stretch, no more", over.state.doc.textContent === "Replace that word." && /that\[textColor\]/.test(runs(over)), runs(over));
  over.destroy();
}

{
  // What needs no choice gets none.
  const e = make();
  caret(e, 9);
  paste(e, "<p>just words</p>");
  check("a paste with no look of its own is simply pasted (nothing to choose)", pasteChoice(e.view) === null && e.state.doc.textContent.includes("just words"));

  // Copied in this app: exactly as it was.
  const own = '<p data-pm-slice="1 1 []"><span data-tc="#ff0000" style="--wf-tc:#ff0000">red here</span></p>';
  paste(e, own);
  check("what was copied in this app is pasted as it was, colour and all", pasteChoice(e.view) === null && /red here\[textColor\]/.test(runs(e)), runs(e));
  e.destroy();

  // In a table, the table decides.
  const table = make([{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [para("cell")] }, { type: "tableCell", content: [para("two")] }] }] }]);
  let inCell = 0;
  table.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "cell") inCell = pos + 1;
  });
  caret(table, inCell);
  paste(table, '<span style="color:#ff0000">red</span>');
  check("inside a table a paste is left to the table (no choice offered)", pasteChoice(table.view) === null && table.state.doc.textContent.includes("red"));
  table.destroy();
}

{
  // Someone else's typing elsewhere doesn't settle it — and doesn't lose its place.
  const e = make([para("Top."), para("Here: ")]);
  caret(e, e.state.doc.content.size - 1);
  paste(e, '<span style="color:#ff0000">pasted</span>');
  const before = pasteChoice(e.view)!;
  e.view.dispatch(e.state.tr.insertText("Remote words. ", 1).setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false }));
  const after = pasteChoice(e.view);
  check("another writer's edit above moves the paste along with the text", !!after && after.from === before.from + 14 && after.to === before.to + 14);
  switchPaste(e.view, "keep");
  check("…so the switch still lands on the pasted words", /pasted\[textColor\]/.test(runs(e)) && e.state.doc.textContent === "Remote words. Top.Here: pasted", runs(e));
  // An undo is the writer's own next act.
  e.view.dispatch(e.state.tr.insertText("x", 1).setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: true }));
  check("an undo settles it, like typing", pasteChoice(e.view) === null);
  e.destroy();
}

{
  // The strip under the paste.
  const e = make([para("Start.")]);
  const root = createRoot(mountPoint());
  await act(async () => root.render(createElement(PasteOptions, { editor: e })));
  const strip = () => document.querySelector(".wf-paste-options") as HTMLElement | null;
  const press = (el: Element) => {
    el.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  check("nothing is shown until something is pasted", strip() === null);
  await act(async () => {
    caret(e, e.state.doc.content.size - 1);
    paste(e, '<span style="color:#ff0000">red words</span>');
  });
  check("after a paste: how it was taken, and the other way offered", strip()?.textContent?.includes("Pasted to match this document") === true && strip()?.textContent?.includes("Keep its styling") === true);
  await act(async () => void press([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Keep its styling")!));
  check("one click keeps its styling — and offers the way back", /red words\[textColor\]/.test(runs(e)) && strip()?.textContent?.includes("Match this document") === true);
  await act(async () => void press([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Match this document")!));
  check("…which is taken the same way", !/textColor/.test(runs(e)) && strip()?.textContent?.includes("Keep its styling") === true);
  await act(async () => void e.view.dom.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  check("Escape puts the strip away", strip() === null && pasteChoice(e.view) === null);
  await act(async () => {
    paste(e, '<span style="color:#00b050">green</span>');
  });
  check("(it is back for the next paste)", strip() !== null);
  await act(async () => void press(strip()!.querySelector(".wf-paste-close")!));
  check("…and so does its ×", strip() === null);
  await act(async () => {
    paste(e, '<span style="color:#00b050">again</span>');
  });
  await act(async () => {
    e.view.dispatch(e.state.tr.insertText("!"));
  });
  check("typing on puts it away by itself", strip() === null);
  settlePaste(e.view);
  await act(async () => root.unmount());
  e.destroy();
}

finish();
