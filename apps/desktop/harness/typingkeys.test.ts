// Small things at the keyboard: bold, italic and underline on the word the
// caret is in, lists started from "1)", "a." and "i.", and a paragraph (or
// a list item) moved up or down by key.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

import { inputRulesFor } from "../src/apps/documents/shell/hooks";
import { keysOf, EDITOR_COMMANDS } from "../src/editor/commands/catalog";
import { CommandKeys } from "../src/editor/commands/CommandKeys";
import { canRun, type CommandCtx } from "../src/editor/commands/run";
import { ListStarts } from "../src/editor/format/listStarts";
import { canMoveBlocks, moveBlocks } from "../src/editor/format/movePicture";
import { wordNear, wordRangeAt } from "../src/editor/format/wordAt";
import { toggleWordMark, WordMarks } from "../src/editor/format/wordMark";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";

const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(content.length ? { content } : {}) });
const ctx: CommandCtx = { format: "none", rich: null, editable: true, shell: {} };
const editorWith = (content: JSONContent[]): Editor =>
  new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(), WordMarks, ListStarts, Suggesting.configure({ author: () => "Me" }), CommandKeys.configure({ ctx: () => ctx })],
    content: { type: "doc", content },
  });
/** Where some words begin in the text. */
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
const caret = (e: Editor, pos: number) => e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)));
const marked = (e: Editor, mark: string): string => {
  let out = "";
  e.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === mark)) out += node.text;
  });
  return out;
};
const press = (e: Editor, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): boolean => {
  const event = new KeyboardEvent("keydown", { key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, bubbles: true, cancelable: true } as KeyboardEventInit);
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};
/** A key at a time, through the rules for what is typed. */
const type = (e: Editor, text: string) => {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    const deflt = () => e.state.tr.insertText(ch, from, to);
    if (!e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, deflt))) e.view.dispatch(deflt());
  }
};
const shape = (e: Editor): string =>
  (e.getJSON().content ?? [])
    .map((b) => {
      if (b.type === "orderedList") return `ol[${b.attrs?.type ?? "1"}@${b.attrs?.start ?? 1}](${(b.content ?? []).map((li) => li.content?.[0]?.content?.[0]?.text ?? "").join("|")})`;
      if (b.type === "bulletList") return `ul(${(b.content ?? []).map((li) => (li.content ?? []).map((c) => (c.type === "paragraph" ? (c.content?.[0]?.text ?? "") : `${c.type}`)).join("+")).join("|")})`;
      if (b.type === "blockquote") return `quote(${(b.content ?? []).map((c) => c.content?.[0]?.text ?? "").join("|")})`;
      if (b.type === "table") return "table";
      return (b.content ?? []).map((c) => c.text ?? `<${c.type}>`).join("") || "·";
    })
    .join(" / ");

// ------------------------------------------------------------ the word under the caret

{
  const e = editorWith([p(t("The quick brown fox don't stop."))]);
  const at = (text: string, into: number) => e.state.doc.resolve(find(e, text) + into);
  const word = (text: string, into: number) => {
    const r = wordRangeAt(at(text, into));
    return r ? e.state.doc.textBetween(r.from, r.to) : null;
  };
  check("a caret inside a word is in that word", word("quick", 2) === "quick" && word("brown", 1) === "brown");
  check("at a word's start or end it is in none", word("quick", 0) === null && word("quick", 5) === null);
  check("nor in a space or at the paragraph's ends", word(" brown", 0) === null && word("The", 0) === null && word("stop.", 5) === null);
  check("an apostrophe between letters is part of its word", word("don't", 2) === "don't" && word("don't", 3) === "don't" && word("don't", 4) === "don't");
  const near = wordNear(at("quick", 0));
  check("the nearest word is found from its edge too (for growing a selection)", !!near && e.state.doc.textBetween(near.from, near.to) === "quick" && wordNear(at("stop.", 5)) === null);
  e.destroy();

  const noted = editorWith([p(t("A claim"), { type: "footnote", content: [t("source words")] }, t("made here."))]);
  const r = wordRangeAt(noted.state.doc.resolve(find(noted, "claim") + 2));
  check("a note beside a word is no part of it", !!r && noted.state.doc.textBetween(r.from, r.to) === "claim");
  const after = wordRangeAt(noted.state.doc.resolve(find(noted, "made") + 2));
  check("and the word after the note is found where it is", !!after && noted.state.doc.textBetween(after.from, after.to) === "made");
  noted.destroy();
}

{
  const e = editorWith([p(t("The quick brown fox."))]);
  const inside = find(e, "quick") + 2;
  caret(e, inside);
  check("bold with the caret in a word bolds the word", toggleWordMark(e, "bold") && marked(e, "bold") === "quick");
  check("the caret stays where it was", e.state.selection.empty && e.state.selection.from === inside);
  check("again takes it off", toggleWordMark(e, "bold") && marked(e, "bold") === "");
  check("the key does the same (Ctrl+B here)", press(e, "b", { ctrl: true }) && marked(e, "bold") === "quick" && press(e, "i", { ctrl: true }) && marked(e, "italic") === "quick" && press(e, "u", { ctrl: true }) && marked(e, "underline") === "quick");

  // A word half bold becomes all bold.
  e.commands.setContent({ type: "doc", content: [p(t("un"), t("believ", "bold"), t("able words"))] });
  caret(e, 2);
  toggleWordMark(e, "bold");
  check("a word that is partly bold becomes bold all through", marked(e, "bold") === "unbelievable");

  e.commands.setContent({ type: "doc", content: [p(t("The quick brown fox."))] });
  caret(e, find(e, "quick"));
  toggleWordMark(e, "bold");
  check("at a word's edge it sets what is typed next, as it always did", marked(e, "bold") === "" && !!e.state.storedMarks?.some((m) => m.type.name === "bold"));
  type(e, "X");
  check("so the next letter is bold", marked(e, "bold") === "X");

  e.commands.setContent({ type: "doc", content: [p(t("The quick brown fox."))] });
  e.commands.setTextSelection({ from: find(e, "quick"), to: find(e, "quick") + 11 });
  toggleWordMark(e, "italic");
  check("with words selected it is the selection that takes it", marked(e, "italic") === "quick brown");

  e.commands.setContent({ type: "doc", content: [{ type: "codeBlock", content: [t("let value = 1")] }] });
  caret(e, find(e, "value") + 2);
  toggleWordMark(e, "bold");
  check("code takes no bold", marked(e, "bold") === "");
  e.destroy();
}

// ------------------------------------------------------------ lists started by their first label

{
  const started = (keys: string, before: JSONContent[] = [p()], where?: (e: Editor) => void): { e: Editor; shape: string } => {
    const e = editorWith(before);
    if (where) where(e);
    else caret(e, e.state.doc.content.size - 1);
    type(e, keys);
    // (A list at the very end of the text is given an empty paragraph after
    // it to write on in: no part of what is looked at here.)
    return { e, shape: shape(e).replace(/ \/ ·$/, "") };
  };
  const one = (keys: string) => {
    const made = started(keys);
    made.e.destroy();
    return made.shape;
  };
  check('"1) " starts a numbered list', one("1) ") === "ol[1@1]()", one("1) "));
  check('"3) " starts one at 3', one("3) ") === "ol[1@3]()", one("3) "));
  check('"a. " and "a) " start a lettered one', one("a. ") === "ol[a@1]()" && one("a) ") === "ol[a@1]()", `${one("a. ")} ${one("a) ")}`);
  check('"c. " starts it at c', one("c. ") === "ol[a@3]()", one("c. "));
  check('"A. " capital letters', one("A. ") === "ol[A@1]()" && one("D) ") === "ol[A@4]()", `${one("A. ")} ${one("D) ")}`);
  check('"i. " and "I. " are roman, never the ninth letter', one("i. ") === "ol[i@1]()" && one("I) ") === "ol[I@1]()", `${one("i. ")} ${one("I) ")}`);
  check('"1. " is still the editor\'s own', one("1. ").startsWith("ol["), one("1. "));

  const text = started("a. ", [p(t("hello"))], (e) => caret(e, 1));
  check("typed in front of words it is left as typed", text.shape === "a. hello", text.shape);
  text.e.destroy();
  const mid = started("I. ", [p(t("So said "))]);
  check("and so it is in the middle of a sentence", mid.shape === "So said I. ", mid.shape);
  mid.e.destroy();
  const titled = started("a. ", [{ type: "paragraph", attrs: { element: "title" } }]);
  check("a paragraph in a style of its own is left alone", titled.shape === "a. ", titled.shape);
  titled.e.destroy();

  const undo = started("b. ", [p(), p(t("After."))], (e) => caret(e, 1));
  check("Backspace straight after puts back what was typed", undo.shape === "ol[a@2]() / After." && undo.e.commands.undoInputRule() && shape(undo.e) === "b.  / After.", `${undo.shape} → ${shape(undo.e)}`);
  undo.e.destroy();

  const item = (text: string): JSONContent => ({ type: "listItem", content: [p(t(text))] });
  const joined = started("c. ", [{ type: "orderedList", attrs: { type: "a", start: 1 }, content: [item("first"), item("second")] }, p()]);
  check("the next label under a list carries that list on", joined.shape === "ol[a@1](first|second|)", joined.shape);
  joined.e.destroy();
  const apart = started("e. ", [{ type: "orderedList", attrs: { type: "a", start: 1 }, content: [item("first"), item("second")] }, p()]);
  check("a label that is not the next one starts its own", apart.shape === "ol[a@1](first|second) / ol[a@5]()", apart.shape);
  apart.e.destroy();
  const other = started("i. ", [{ type: "orderedList", attrs: { type: "a", start: 1 }, content: [item("first")] }, p()]);
  check("and so does another kind of number", other.shape === "ol[a@1](first) / ol[i@1]()", other.shape);
  other.e.destroy();

  const rules = inputRulesFor("manuscript");
  check("a manuscript starts no lists by typing", Array.isArray(rules) && !rules.includes("listStarts") && inputRulesFor("none") === true);
}

// ------------------------------------------------------------ moving paragraphs

{
  const e = editorWith([p(t("One.")), p(t("Two.")), p(t("Three.")), p(t("Four."))]);
  const inTwo = find(e, "Two.") + 2;
  caret(e, inTwo);
  check("a paragraph moves down a step", moveBlocks(e, 1) && shape(e) === "One. / Three. / Two. / Four.", shape(e));
  check("the caret goes with it, on the same letter", e.state.selection.empty && e.state.doc.textBetween(e.state.selection.from - 2, e.state.selection.from) === "Tw", String(e.state.selection.from));
  check("and up again", moveBlocks(e, -1) && moveBlocks(e, -1) && shape(e) === "Two. / One. / Three. / Four.", shape(e));
  check("the first paragraph goes no higher", !canMoveBlocks(e, -1) && !moveBlocks(e, -1) && shape(e) === "Two. / One. / Three. / Four.");
  check("each step is one undo", e.commands.undo() && shape(e) === "One. / Two. / Three. / Four.", shape(e));

  e.commands.setTextSelection({ from: find(e, "Two.") + 1, to: find(e, "Three.") + 2 });
  check("the paragraphs a selection touches move together", moveBlocks(e, 1) && shape(e) === "One. / Four. / Two. / Three.", shape(e));
  check("and the same words are still selected", e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, "|") === "wo.|Th", e.state.doc.textBetween(e.state.selection.from, e.state.selection.to, "|"));
  check("the last ones go no lower", !canMoveBlocks(e, 1));

  // The keys (not on a Mac here).
  caret(e, find(e, "One.") + 1);
  const down = keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.move.down")!, false);
  check("Alt+Shift+Down is the key for it", down === "Alt-Shift-ArrowDown" && press(e, "ArrowDown", { alt: true, shift: true }) && shape(e) === "Four. / One. / Two. / Three.", shape(e));
  check("and Alt+Shift+Up", press(e, "ArrowUp", { alt: true, shift: true }) && shape(e) === "One. / Four. / Two. / Three.", shape(e));
  check("on a Mac it is Ctrl+Shift with the arrows (Option with them moves the caret there)", keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.move.up")!, true) === "Ctrl-Shift-ArrowUp");

  setReviewMode(e, "suggest");
  check("not while suggesting: a move is for Editing", !canMoveBlocks(e, 1) && !moveBlocks(e, 1) && !canRun("doc.move.down", e, ctx) && shape(e) === "One. / Four. / Two. / Three.");
  setReviewMode(e, "edit");
  check("and back in Editing it is offered again", canRun("doc.move.down", e, ctx));
  e.destroy();
}

{
  const item = (text: string, ...more: JSONContent[]): JSONContent => ({ type: "listItem", content: [p(t(text)), ...more] });
  const e = editorWith([p(t("Before.")), { type: "bulletList", content: [item("alpha"), item("beta", { type: "bulletList", content: [item("beta one")] }), item("gamma")] }, p(t("After."))]);
  caret(e, find(e, "beta") + 2);
  check("in a list it is the item that moves, with what is under it", moveBlocks(e, 1) && shape(e) === "Before. / ul(alpha|gamma|beta+bulletList) / After.", shape(e));
  check("the last item stays in its list", !canMoveBlocks(e, 1));
  check("and moves back up past two", moveBlocks(e, -1) && moveBlocks(e, -1) && shape(e) === "Before. / ul(beta+bulletList|alpha|gamma) / After.", shape(e));
  check("the first item stays in its list too", !canMoveBlocks(e, -1));
  e.destroy();

  const quoted = editorWith([p(t("Before.")), { type: "blockquote", content: [p(t("First line.")), p(t("Second line."))] }, p(t("After."))]);
  caret(quoted, find(quoted, "First line.") + 2);
  check("a paragraph at the top of a quote moves out above it", moveBlocks(quoted, -1) && shape(quoted) === "Before. / First line. / quote(Second line.) / After.", shape(quoted));
  quoted.destroy();

  const cell = (...content: JSONContent[]): JSONContent => ({ type: "tableCell", content });
  const tabled = editorWith([{ type: "table", content: [{ type: "tableRow", content: [cell(p(t("Top.")), p(t("Under."))), cell(p(t("Other.")))] }] }, p(t("After."))]);
  caret(tabled, find(tabled, "Under.") + 2);
  check("in a table's cell a paragraph moves within the cell", moveBlocks(tabled, -1) && tabled.state.doc.textBetween(0, tabled.state.doc.content.size, "|").startsWith("Under.|Top."), tabled.state.doc.textBetween(0, tabled.state.doc.content.size, "|"));
  check("and never out of it", !canMoveBlocks(tabled, -1));
  tabled.destroy();

  const pictured = editorWith([p(t("One.")), { type: "image", attrs: { src: "/api/v1/attachments/1" } }, p(t("Two."))]);
  let at = -1;
  pictured.state.doc.descendants((node, pos) => {
    if (node.type.name === "image") at = pos;
  });
  pictured.view.dispatch(pictured.state.tr.setSelection(NodeSelection.create(pictured.state.doc, at)));
  check("a selected picture moves by the same key", moveBlocks(pictured, -1) && pictured.getJSON().content?.[0]?.type === "image" && pictured.state.selection instanceof NodeSelection);
  pictured.destroy();
}

finish();
