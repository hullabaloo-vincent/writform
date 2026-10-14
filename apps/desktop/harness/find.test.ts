// Find and replace reach the words inside footnotes and endnotes. A note is
// a run of its own: its words are found and replaced, nothing matches from
// the sentence into the note, and stepping to a match in a note marks the
// note's number and leaves the focus in the Find field.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { findInDoc, replaceAll } from "../src/apps/documents/find/findInDoc";
import { FindBar } from "../src/apps/documents/FindBar";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const note = (text: string, kind?: "end"): JSONContent => ({ type: "footnote", ...(kind ? { attrs: { kind } } : {}), content: [t(text)] });
const CONTENT: JSONContent[] = [
  p(t("The harbours were busy"), note("See the harbour records of 1890."), t(" and the harbour master slept.")),
  p(t("Nothing of the kind here.")),
  p(t("A last word"), note("Harbour is spelled with a u here.", "end"), t(".")),
];
const editorWith = (content: JSONContent[] = CONTENT): Editor =>
  new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), Suggesting.configure({ author: () => "Me" })], content: { type: "doc", content } });
const notesOf = (e: Editor): { pos: number; text: string }[] => {
  const out: { pos: number; text: string }[] = [];
  e.state.doc.descendants((node, pos) => {
    if (node.type.name === "footnote") out.push({ pos, text: node.textContent });
  });
  return out;
};
const found = (e: Editor, query: string, opts = {}) => findInDoc(e.state.doc, query, opts);
const words = (e: Editor, m: { from: number; to: number }) => e.state.doc.textBetween(m.from, m.to);

// ------------------------------------------------------------ the search

{
  const e = editorWith();
  const [foot, end] = notesOf(e);
  const r = found(e, "harbour");
  check("words in a footnote and in an endnote are found with those of the text", r.matches.length === 4 && r.matches.map((m) => words(e, m)).join("|") === "harbour|harbour|harbour|Harbour", r.matches.map((m) => words(e, m)).join("|"));
  check("in the order they stand in the text", r.matches.every((m, i) => i === 0 || m.from > r.matches[i - 1].from));
  check("a match in a note says which note it is in", r.matches.map((m) => m.note).join(",") === `,${foot.pos},,${end.pos}`, r.matches.map((m) => m.note).join(","));
  check("and lies inside that note", r.matches[1].from > foot.pos && r.matches[1].to < foot.pos + e.state.doc.nodeAt(foot.pos)!.nodeSize);
  check("matching case still narrows it", found(e, "Harbour", { caseSensitive: true }).matches.length === 1 && found(e, "Harbour", { caseSensitive: true }).matches[0].note === end.pos);
  check("whole words too, in a note as in the text", found(e, "harbour", { wholeWord: true }).matches.length === 3 && found(e, "record", { wholeWord: true }).matches.length === 0 && found(e, "records", { wholeWord: true }).matches.length === 1);
  check("nothing is found running from the sentence into its note", found(e, "busySee").matches.length === 0 && found(e, "busy See").matches.length === 0);
  check("nor out of the note into the sentence", found(e, "1890. and").matches.length === 0 && found(e, "1890.and").matches.length === 0);
  check("nor across the note from one side of it to the other", found(e, "busy and").matches.length === 0);
  const pattern = found(e, "harbou?r\\w*", { pattern: true });
  check("a pattern finds in notes as well, with what it found", pattern.matches.length === 4 && pattern.matches[1].text === "harbour" && pattern.matches[0].text === "harbours" && pattern.matches[1].note === foot.pos, pattern.matches.map((m) => m.text).join("|"));
  check("a pattern that would match across the note's edge does not", found(e, "busy.See", { pattern: true }).matches.length === 0);
  const capped = findInDoc(e.state.doc, "harbour", {}, 2);
  check("the count is capped as before", capped.capped && capped.matches.length === 2);
  check("a text with no notes is searched as it was", findInDoc(editorWith([p(t("One two one."))]).state.doc, "one").matches.map((m) => m.from).join(",") === "1,9");

  // Italic inside a note is one run with the rest of it.
  const styled = editorWith([p(t("Claim"), { type: "footnote", content: [t("See "), t("the harbour", "italic"), t(" records.")] })]);
  check("a phrase in a note is found across its italics", found(styled, "see the harbour records").matches.length === 1);
  styled.destroy();

  const tr = replaceAll(e.state.tr, r.matches, "port");
  e.view.dispatch(tr);
  check("replace all changes the notes with the text, in one step", e.state.doc.textContent.includes("The ports were busy") && notesOf(e).map((n) => n.text).join("|") === "See the port records of 1890.|port is spelled with a u here.", notesOf(e).map((n) => n.text).join("|"));
  let valid = true;
  try {
    e.state.doc.check();
  } catch {
    valid = false;
  }
  check("and leaves a sound document", valid);
  check("one undo puts every one back", e.commands.undo() && found(e, "harbour").matches.length === 4);
  e.destroy();
}

// ------------------------------------------------------------ the Find bar

{
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const e = editorWith();
  const host = mountPoint();
  const root = createRoot(host);
  const open = async (prefill: string, replace = false, n = 1) => act(async () => root.render(createElement(FindBar, { editor: e, readonly: false, request: { n, replace, prefill }, onClose: () => {} })));
  const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 200)));
  const count = () => host.querySelector(".wf-find-count")?.textContent ?? "";
  const field = () => host.querySelector('input[aria-label="Find"]') as HTMLInputElement;
  const sups = () => [...(e.view.dom as HTMLElement).querySelectorAll("sup.wf-fn")] as HTMLElement[];
  const boxes = () => [...document.body.children].filter((el) => el.classList.contains("wf-fn-pop")).length;
  const next = () => act(async () => void field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const [foot, end] = notesOf(e);

  e.commands.setTextSelection(1);
  await open("harbour");
  await settle();
  field().focus();
  check("the bar counts the matches in notes with the rest", count() === "1 of 4", count());
  check("a note with a match in it has its number marked", sups()[0].classList.contains("wf-find-note") && sups()[1].classList.contains("wf-find-note") && !sups()[0].classList.contains("current"));
  check("the matches in the text are marked as ever", (e.view.dom as HTMLElement).querySelectorAll(".wf-find-hit").length === 2);

  await next();
  check("stepping to a match in a note says so", count() === "2 of 4 (in a note)", count());
  check("that note's number is the current mark", sups()[0].classList.contains("current") && !sups()[1].classList.contains("current") && (e.view.dom as HTMLElement).querySelectorAll(".wf-find-hit.current").length === 0);
  check("the caret is beside the note, and the note is not opened", e.state.selection.empty && e.state.selection.from === foot.pos && boxes() === 0, `${e.state.selection.from} ${foot.pos}`);
  check("the field being typed in keeps the focus", document.activeElement === field());
  await next();
  check("the next step is back in the text", count() === "3 of 4" && !sups()[0].classList.contains("current") && words(e, e.state.selection) === "harbour");
  await next();
  check("and the one after is in the endnote", count() === "4 of 4 (in a note)" && sups()[1].classList.contains("current") && e.state.selection.from === end.pos);

  // Replace the match in the endnote, then all the rest.
  await open("harbour", true, 2);
  await settle();
  const replaceField = host.querySelector('input[aria-label="Replace with"]') as HTMLInputElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
    set.call(replaceField, "port");
    replaceField.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // (Opening Replace went back to the first match at the caret: the endnote's.)
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
  await act(async () => button("Replace").click());
  await settle();
  check("Replace changes the match in the note", notesOf(e)[1].text === "port is spelled with a u here." && notesOf(e)[0].text.includes("harbour"), notesOf(e).map((n) => n.text).join("|"));
  await act(async () => button("Replace all").click());
  await settle();
  check("Replace all reaches the footnote too", notesOf(e)[0].text === "See the port records of 1890." && e.state.doc.textContent.includes("The ports were busy") && found(e, "harbour").matches.length === 0, e.state.doc.textContent);
  check("and is one undo", e.commands.undo() && notesOf(e)[0].text.includes("harbour") && e.state.doc.textContent.includes("The harbours were busy") && notesOf(e)[1].text.startsWith("port"));

  // While suggesting.
  setReviewMode(e, "suggest");
  let threw = "";
  try {
    const all = found(e, "harbour").matches;
    e.view.dispatch(replaceAll(e.state.tr, all, "port"));
    e.state.doc.check();
  } catch (err) {
    threw = String(err);
  }
  check("replacing inside a note while suggesting does not break the document", threw === "", threw);
  setReviewMode(e, "edit");
  await act(async () => root.unmount());
  e.destroy();
}

finish();
