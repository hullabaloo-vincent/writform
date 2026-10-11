// A document's footnotes and endnotes, listed under its last page: seen
// while writing, changed right there, and each a click from the place
// that cites it.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { listNotes, openNotes } from "../src/editor/nodes/Footnote";
import { docContentExtensions } from "../src/editor/schema/content";
import { NotesList } from "../src/editor/ui/NotesList";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const t = (text: string): JSONContent => ({ type: "text", text });
const note = (text: string, kind?: "end"): JSONContent => ({ type: "footnote", ...(kind ? { attrs: { kind } } : {}), ...(text ? { content: [t(text)] } : {}) });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const withNotes = (): JSONContent => ({
  type: "doc",
  content: [
    para(t("The bridge fell"), note("In December 1879."), t(" in a storm"), note("Sources differ on the wind.", "end"), t(".")),
    para(t("An inquiry followed"), note(""), t(".")),
  ],
});

{
  const entries = listNotes(new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: withNotes() }).state.doc);
  check(
    "a document's notes, in the order they're cited, numbered as beside the text",
    entries.map((e) => `${e.kind}${e.label}:${e.text}`).join("|") === "foot1:In December 1879.|endi:Sources differ on the wind.|foot2:",
    entries.map((e) => `${e.kind}${e.label}:${e.text}`).join("|"),
  );
}

{
  const plain = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: [para(t("No notes."))] } });
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(NotesList, { editor: plain })));
  check("a document without notes shows no list", host.querySelector(".wf-notes") === null);
  // One is added: the list appears.
  await act(async () => {
    plain.view.dispatch(plain.state.tr.insert(4, plain.schema.nodes.footnote.create(null, plain.schema.text("A first note."))));
  });
  check("…until it has one", host.querySelector(".wf-notes")?.textContent?.includes("A first note.") === true);
  await act(async () => root.unmount());
  plain.destroy();
}

{
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: withNotes() });
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(NotesList, { editor: e })));
  const groups = () => [...host.querySelectorAll(".wf-notes-group")] as HTMLElement[];
  const rows = (g: number) => [...groups()[g].querySelectorAll("li")] as HTMLElement[];
  const textOf = (row: HTMLElement) => (row.querySelector(".wf-notes-text") as HTMLElement | null)?.textContent ?? null;
  const field = () => host.querySelector(".wf-notes-field") as HTMLElement | null;
  const noteAt = (pos: number) => e.state.doc.nodeAt(pos);
  const positions = () => listNotes(e.state.doc).map((n) => n.pos);

  check("footnotes and endnotes are listed apart, each under its name", groups().length === 2 && groups()[0].querySelector("h4")?.textContent === "Footnotes" && groups()[1].querySelector("h4")?.textContent === "Endnotes");
  check("…with their numbers and their words", rows(0).length === 2 && rows(0)[0].textContent?.startsWith("1") === true && textOf(rows(0)[0]) === "In December 1879." && rows(1)[0].querySelector(".wf-notes-num")?.textContent === "i" && textOf(rows(1)[0]) === "Sources differ on the wind.");
  check("…an empty one says so", textOf(rows(0)[1]) === "Empty note");
  check("…and where each kind is printed", groups()[0].textContent?.includes("foot of the page") === true && groups()[1].textContent?.includes("end of the document") === true);

  // Click a note's words: it is written right there.
  await act(async () => void (rows(1)[0].querySelector(".wf-notes-text") as HTMLButtonElement).click());
  const inner = field() ? openNotes.get(field()!) : undefined;
  check("a click on a note's words opens it for writing, in the list", !!field() && !!inner && inner.state.doc.textContent === "Sources differ on the wind.");
  const endPos = positions()[1];
  await act(async () => {
    inner!.dispatch(inner!.state.tr.insertText(" Badly.", inner!.state.doc.content.size));
  });
  check("what's typed there is the note's text in the document", noteAt(endPos)?.textContent === "Sources differ on the wind. Badly." && field() !== null);

  // The text before it changes (someone types above): still the same note.
  await act(async () => {
    e.view.dispatch(e.state.tr.insertText("Indeed. ", 1));
  });
  const moved = positions()[1];
  check("the text above it moving doesn't lose the note being written", moved === endPos + 8 && field() !== null);
  await act(async () => {
    inner!.dispatch(inner!.state.tr.insertText(" Very.", inner!.state.doc.content.size));
  });
  check("…and typing goes on into the right note", noteAt(moved)?.textContent === "Sources differ on the wind. Badly. Very." && noteAt(positions()[0])?.textContent === "In December 1879.");

  // A change from elsewhere (an undo, another writer) shows in the open field.
  await act(async () => {
    const at = moved + 1;
    e.view.dispatch(e.state.tr.insertText("NB: ", at));
  });
  check("a change to the note from elsewhere arrives in the field", inner!.state.doc.textContent.startsWith("NB: Sources differ"));

  // Enter: done.
  await act(async () => {
    inner!.someProp("handleKeyDown", (f) => f(inner!, new window.KeyboardEvent("keydown", { key: "Enter" })));
  });
  check("Enter finishes, and the list shows the new words", field() === null && textOf(rows(1)[0]) === "NB: Sources differ on the wind. Badly. Very.");

  // Its number goes to the place that cites it.
  await act(async () => void (rows(0)[1].querySelector(".wf-notes-num") as HTMLButtonElement).click());
  const sel = e.state.selection;
  check("a click on its number selects the note where it's cited (and opens it there)", sel instanceof NodeSelection && sel.from === positions()[2] && !!e.view.dom.querySelector("sup.wf-fn.open"));

  // The note being written is deleted from the text: the field goes.
  await act(async () => void (rows(0)[0].querySelector(".wf-notes-text") as HTMLButtonElement).click());
  check("(a footnote opens for writing the same way)", field() !== null);
  await act(async () => {
    const at = positions()[0];
    e.view.dispatch(e.state.tr.delete(at, at + noteAt(at)!.nodeSize));
  });
  check("the note being written is deleted from the text: its field goes with it", field() === null && rows(0).length === 1 && rows(0)[0].querySelector(".wf-notes-num")?.textContent === "1");

  // A document that can't be edited: the list is for finding, not writing.
  await act(async () => e.setEditable(false));
  await act(async () => void (rows(1)[0].querySelector(".wf-notes-text") as HTMLButtonElement).click());
  // (With the first footnote gone, the endnote is the first note cited.)
  const endnote = listNotes(e.state.doc).find((n) => n.kind === "end")!.pos;
  check("where the document can't be edited, a click goes to the citation instead", field() === null && e.state.selection instanceof NodeSelection && e.state.selection.from === endnote);

  await act(async () => root.unmount());
  e.destroy();
}

finish();
