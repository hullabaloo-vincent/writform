// A chapter's hidden id (level 5): what the story plan ties its cards to.
// It is given once, kept out of undo and suggestions, and kept on one
// heading through splits, copies, cuts, moves and pastes.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { DOMParser as PmDOMParser, Slice } from "@tiptap/pm/model";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { clearFormatting } from "../src/editor/format/commands";
import { paintFormat, pickUpFormat } from "../src/editor/format/painter";
import { ChapterIdGuard, chapterIdHolders, ensureChapterId } from "../src/editor/nodes/ChapterId";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { SchemaGuard } from "../src/editor/schema/guard";

const heading = (text: string, attrs: Record<string, unknown> = {}): JSONContent => ({ type: "paragraph", attrs: { element: "chapter_heading", ...attrs }, content: [{ type: "text", text }] });
const p = (text: string): JSONContent => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined });
const book = (): JSONContent => ({ type: "doc", content: [heading("One"), p("The first chapter."), heading("Two"), p("The second chapter.")] });
const schema = getSchema(docContentExtensions());

const known = new Set<string>();
const shared = (ydoc: Y.Doc, opts: { level?: number; suggest?: boolean } = {}): Editor =>
  new Editor({
    element: mountPoint(),
    extensions: [
      ...docContentExtensions({ history: false }),
      Collaboration.configure({ document: ydoc }),
      ChapterIdGuard.configure({ known: (cid) => known.has(cid) }),
      SchemaGuard.configure({ level: () => opts.level ?? 5 }),
      ...(opts.suggest ? [Suggesting.configure({ author: () => "Me" })] : []),
    ],
  });
const seeded = (json: JSONContent = book()): Y.Doc => {
  const ydoc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(schema, json, ydoc.getXmlFragment("default"));
  return ydoc;
};
/** Where each top-level block starts. */
const starts = (e: Editor): number[] => {
  const out: number[] = [];
  e.state.doc.forEach((_n, offset) => out.push(offset));
  return out;
};
const ids = (e: Editor): (string | null)[] => {
  const out: (string | null)[] = [];
  e.state.doc.forEach((n) => out.push((n.attrs.cid as string | null) ?? null));
  return out;
};
const texts = (e: Editor): string[] => {
  const out: string[] = [];
  e.state.doc.forEach((n) => out.push(n.textContent));
  return out;
};
/** Whole blocks pasted at the end (as copying across blocks gives them). */
const paste = (e: Editor, html: string) => {
  const dom = document.createElement("div");
  dom.innerHTML = html;
  const slice = PmDOMParser.fromSchema(e.state.schema).parseSlice(dom);
  const end = e.state.doc.content.size;
  e.view.dispatch(e.state.tr.replace(end, end, new Slice(slice.content, 0, 0)));
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

// ------------------------------------------------------------ giving one

{
  const ydoc = seeded();
  const e = shared(ydoc);
  const at = starts(e)[0];
  const cid = ensureChapterId(e, at, { level: 5, canWrite: true });
  check("a heading is given an id", !!cid && /^[0-9a-z]{8}$/.test(cid) && ids(e)[0] === cid, String(cid));
  check("…and asked again it is the same one", ensureChapterId(e, at, { level: 5, canWrite: true }) === cid);
  check("nothing else changed", texts(e).join("|") === "One|The first chapter.|Two|The second chapter.");
  // Typing, then Undo: the id stays.
  e.commands.setTextSelection(at + 4);
  e.commands.insertContent(" again");
  e.commands.undo();
  check("Undo after typing leaves the id", texts(e)[0] === "One" && ids(e)[0] === cid, `${texts(e)[0]} ${ids(e)[0]}`);
  e.commands.undo();
  check("…and Undo again doesn't take it away (it was never in undo)", ids(e)[0] === cid);
  check("it is in the shared document", ydoc.getXmlFragment("default").get(0) instanceof Y.XmlElement && (ydoc.getXmlFragment("default").get(0) as Y.XmlElement).getAttribute("cid") === cid);
  e.destroy();
}
{
  const e = shared(seeded(), { level: 4 });
  check("below level 5 none is given", ensureChapterId(e, 0, { level: 4, canWrite: true }) === null && ids(e)[0] === null);
  check("…nor when the document is held to level 4 whatever is asked", ensureChapterId(e, 0, { level: 5, canWrite: true }) === null && ids(e)[0] === null);
  e.destroy();
  const r = shared(seeded());
  check("someone who may only read gives none", ensureChapterId(r, 0, { level: 5, canWrite: false }) === null && ids(r)[0] === null);
  r.destroy();
}
{
  const e = shared(seeded(), { suggest: true });
  setReviewMode(e, "suggest");
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true });
  let tracked = false;
  e.state.doc.descendants((n) => {
    if (n.attrs.tc || n.marks.some((m) => m.type.name === "insertion" || m.type.name === "deletion")) tracked = true;
  });
  check("while suggesting, the id is given and is not a suggestion", !!cid && ids(e)[0] === cid && !tracked);
  e.destroy();
}
{
  // Two people give the same heading an id at once: the same id.
  const a = seeded();
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const ea = shared(a);
  const eb = shared(b);
  const ca = ensureChapterId(ea, starts(ea)[2], { level: 5, canWrite: true });
  const cb = ensureChapterId(eb, starts(eb)[2], { level: 5, canWrite: true });
  check("two people giving one heading an id at once give the same one", !!ca && ca === cb, `${ca} ${cb}`);
  sync(a, b);
  check("…and once their changes meet it is still that one, on one heading", ids(ea)[2] === ca && ids(eb)[2] === ca && ids(ea).filter(Boolean).length === 1);
  // What comes from someone else is left as it is.
  const c1 = ensureChapterId(ea, starts(ea)[0], { level: 5, canWrite: true });
  sync(a, b);
  check("an id given by someone else arrives", ids(eb)[0] === c1);
  ea.destroy();
  eb.destroy();
}

// ------------------------------------------------------------ one heading per id

{
  const e = shared(seeded());
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  known.add(cid);
  // Enter at the end: the new paragraph has none.
  e.commands.setTextSelection(4);
  e.commands.splitBlock();
  check("Enter at a heading's end: the new paragraph has no id", ids(e)[0] === cid && ids(e)[1] === null, JSON.stringify(ids(e)));
  e.commands.undo();
  // In the middle: the first half keeps it.
  e.commands.setTextSelection(2);
  e.commands.splitBlock();
  check("Enter in a heading's middle: the first half keeps it", texts(e).slice(0, 2).join("|") === "O|ne" && ids(e)[0] === cid && ids(e)[1] === null, JSON.stringify(ids(e)));
  e.commands.undo();
  // At the start: the heading's words keep it, not the empty line before.
  e.commands.setTextSelection(1);
  e.commands.splitBlock();
  check("Enter at a heading's start: its words keep the id", texts(e)[0] === "" && texts(e)[1] === "One" && ids(e)[0] === null && ids(e)[1] === cid, JSON.stringify([texts(e), ids(e)]));
  e.commands.undo();
  check("one holder after all of it", chapterIdHolders(e.state.doc).get(cid)?.length === 1);
  e.destroy();
}
{
  const e = shared(seeded());
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  known.add(cid);
  const html = `<p data-element="chapter_heading" data-cid="${cid}">One</p>`;
  // Copy and paste: the copy has none.
  paste(e, html);
  check("a heading copied and pasted gives up its id: the first keeps it", ids(e)[0] === cid && chapterIdHolders(e.state.doc).get(cid)?.length === 1, JSON.stringify(ids(e)));
  e.destroy();
}
{
  const e = shared(seeded());
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  known.add(cid);
  // Cut, then paste somewhere else: it keeps its id.
  const [one, , two] = starts(e);
  e.view.dispatch(e.state.tr.delete(one, two));
  check("cut", !ids(e).includes(cid));
  paste(e, `<p data-element="chapter_heading" data-cid="${cid}">One</p><p>The first chapter.</p>`);
  check("…and pasted back elsewhere it keeps its id", ids(e).includes(cid), JSON.stringify(ids(e)));
  e.destroy();
}
{
  const e = shared(seeded());
  ensureChapterId(e, 0, { level: 5, canWrite: true });
  // From another document: an id this plan has never heard of.
  paste(e, `<p data-element="chapter_heading" data-cid="zzzzzzzz">Elsewhere</p>`);
  check("a heading pasted from another document arrives without an id", !ids(e).includes("zzzzzzzz") && texts(e).includes("Elsewhere"), JSON.stringify(ids(e)));
  e.destroy();
}
{
  // A move in one step (a drag, or the Outline's move): the id goes with it.
  const e = shared(seeded());
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  const [one, , two] = starts(e);
  const end = e.state.doc.content.size;
  const content = e.state.doc.slice(one, two).content;
  const tr = e.state.tr;
  tr.insert(end, content);
  tr.delete(one, two);
  e.view.dispatch(tr);
  check("a chapter moved in one step keeps its id", texts(e).join("|") === "Two|The second chapter.|One|The first chapter." && ids(e)[2] === cid, JSON.stringify([texts(e), ids(e)]));
  e.destroy();
}
{
  // A drop is a slice moved: the same.
  const e = shared(seeded());
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  const [one, , two] = starts(e);
  const slice = e.state.doc.slice(one, two);
  const tr = e.state.tr.delete(one, two);
  tr.replace(tr.doc.content.size, tr.doc.content.size, new Slice(slice.content, 0, 0));
  e.view.dispatch(tr);
  check("…and so does one dragged", ids(e).filter(Boolean).join() === cid);
  e.destroy();
}
{
  const e = shared(seeded());
  const cid = ensureChapterId(e, 0, { level: 5, canWrite: true })!;
  const third = starts(e)[2];
  ensureChapterId(e, third, { level: 5, canWrite: true });
  e.commands.setTextSelection({ from: 1, to: 4 });
  clearFormatting(e);
  check("Clear Formatting leaves the id", ids(e)[0] === cid, JSON.stringify(ids(e)));
  e.commands.setTextSelection(third + 2);
  const paint = pickUpFormat(e, 5);
  e.commands.setTextSelection({ from: 1, to: 4 });
  paintFormat(e, paint);
  check("copying a chapter heading's formatting onto another copies no id", ids(e)[0] === cid && chapterIdHolders(e.state.doc).size === 2);
  e.destroy();
}

finish();
