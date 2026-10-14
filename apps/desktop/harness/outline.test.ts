// A Document's outline: a headed section moved whole, or taken a level up
// or down with the headings under it. And "Formatting here": what the text
// at the caret has from its style, from its paragraph and from its words,
// each cleared on its own.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { bodyLook, DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { OutlinePanel } from "../src/apps/documents/OutlinePanel";
import { clearParagraphOwn, clearTextOwn, describeHere } from "../src/editor/format/describe";
import { canShiftHeadings, shiftHeadings } from "../src/editor/format/outline";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { resolveStyles } from "../src/editor/styles/sheet";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const t = (text: string, ...marks: JSONContent[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content });
const h = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [t(text)] });
const BOOK: JSONContent[] = [h(1, "One"), p(null, t("First words.")), h(2, "One A"), p(null, t("Inner words.")), h(1, "Two"), p(null, t("Second words.")), h(1, "Three"), p(null, t("Third words."))];
const editorWith = (content: JSONContent[] = BOOK): Editor => new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), Suggesting.configure({ author: () => "Me" })], content: { type: "doc", content } });
const shape = (e: Editor) => (e.getJSON().content ?? []).map((b) => (b.type === "heading" ? `h${b.attrs?.level}:${b.content?.[0]?.text}` : (b.content?.[0]?.text ?? "·"))).join(" / ");
const ctx = { styles: resolveStyles(bodyLook(DEFAULT_SETTINGS), {}), level: 3 };

// ------------------------------------------------------------ a level up, a level down

{
  const e = editorWith();
  check("a section goes down a level with the headings under it", canShiftHeadings(e, 0, 4, 1) && shiftHeadings(e, 0, 4, 1) && shape(e).startsWith("h2:One / First words. / h3:One A / Inner words. / h1:Two"), shape(e));
  check("and up again", shiftHeadings(e, 0, 4, -1) && shape(e).startsWith("h1:One / First words. / h2:One A"));
  check("each is one undo", e.commands.undo() && shape(e).startsWith("h2:One / First words. / h3:One A"));
  e.commands.undo();
  check("Heading 1 goes no higher", !canShiftHeadings(e, 0, 4, -1) && !shiftHeadings(e, 0, 4, -1) && shape(e).startsWith("h1:One"));
  const deep = editorWith([h(5, "Deep"), h(6, "Deeper"), p(null, t("Words."))]);
  check("a section whose lowest heading is Heading 6 goes no lower, all of it or none", !canShiftHeadings(deep, 0, 3, 1) && !shiftHeadings(deep, 0, 3, 1) && shape(deep) === "h5:Deep / h6:Deeper / Words.");
  check("words with no heading over them have no level to change", !canShiftHeadings(e, 1, 2, 1));
  e.setEditable(false);
  check("a reader changes no level", !canShiftHeadings(e, 0, 4, 1));
  e.destroy();
  deep.destroy();
}

// ------------------------------------------------------------ the outline panel, for a Document

{
  const e = editorWith();
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(OutlinePanel, { editor: e, format: "none" })));
  const names = () => [...host.querySelectorAll(".wf-doc-outline-text")].map((el) => el.textContent?.trim());
  check("a Document's headings are its outline", names().join("|") === "One|One A|Two|Three", names().join("|"));
  const reorder = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reorder");
  check("with a way to reorder them, as a book's chapters have", !!reorder);
  await act(async () => reorder!.click());
  const row = (name: string) => [...host.querySelectorAll("li")].find((li) => li.querySelector(".wf-doc-outline-text")?.textContent?.trim() === name)!;
  const press = async (name: string, title: string) => {
    const b = [...row(name).querySelectorAll("button")].find((x) => (x.getAttribute("title") ?? "").startsWith(title)) as HTMLButtonElement;
    await act(async () => {
      b.click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 320)));
  };
  await press("Two", "Move up");
  check("a section moves up over the one before it, with all that is in that one", shape(e) === "h1:Two / Second words. / h1:One / First words. / h2:One A / Inner words. / h1:Three / Third words.", shape(e));
  await press("One", "Move down");
  check("and down, taking its own inner section with it", shape(e) === "h1:Two / Second words. / h1:Three / Third words. / h1:One / First words. / h2:One A / Inner words.", shape(e));
  check("a move is one undo", e.commands.undo() && shape(e) === "h1:Two / Second words. / h1:One / First words. / h2:One A / Inner words. / h1:Three / Third words.");
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 320)));
  await press("Three", "Down a level");
  check("a section can be taken down a level from the outline", shape(e).endsWith("h2:Three / Third words."), shape(e));
  const up = [...row("Two").querySelectorAll("button")].find((x) => (x.getAttribute("title") ?? "").startsWith("Up a level")) as HTMLButtonElement;
  check("the button for a level it cannot go to is off", up.disabled);

  setReviewMode(e, "suggest");
  const before = shape(e);
  await press("Two", "Move down");
  check("while suggesting, a section is not moved", shape(e) === before);
  setReviewMode(e, "edit");
  await act(async () => root.unmount());
  e.destroy();
}

// ------------------------------------------------------------ formatting here

{
  const e = editorWith([
    { type: "paragraph", attrs: { element: "title", align: "center", sa: 12, indL: 36, keepNext: true }, content: [t("A "), t("styled", { type: "bold" }, { type: "textColor", attrs: { c: "#c00000" } }, { type: "link", attrs: { href: "https://example.com" } }), t(" title")] },
    p(null, t("Plain words.")),
    h(2, "A heading"),
  ]);
  e.commands.setTextSelection(5);
  const here = describeHere(e, ctx);
  check("the style is named", here.style === "Title");
  check("what the paragraph has of its own is said in words", here.paragraph.join("|") === "Centred|Space after 12 pt|Left indent 0.5 in|Kept with the next paragraph", here.paragraph.join("|"));
  check("and what the words have (a link is not formatting)", here.text.join("|") === "Bold|Coloured", here.text.join("|"));
  e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 3);
  const plain = describeHere(e, ctx);
  check("plain text in the body style has nothing of its own", plain.style === "Normal" && plain.paragraph.length === 0 && plain.text.length === 0);
  e.commands.setTextSelection(e.state.doc.child(0).nodeSize + e.state.doc.child(1).nodeSize + 3);
  check("a heading is named by its level", describeHere(e, ctx).style === "Heading 2");

  e.commands.setTextSelection(5);
  check("clearing the paragraph's own leaves its style and its words' formatting", clearParagraphOwn(e) && describeHere(e, ctx).style === "Title" && describeHere(e, ctx).paragraph.length === 0 && describeHere(e, ctx).text.join("|") === "Bold|Coloured");
  check("clearing the words' own takes it off the word at the caret, and keeps its link", clearTextOwn(e) && describeHere(e, ctx).text.length === 0 && JSON.stringify(e.getJSON().content?.[0]).includes('"link"'), JSON.stringify(e.getJSON().content?.[0]?.content));
  check("with nothing left to clear, clearing says so", !clearParagraphOwn(e));
  const broken = editorWith([p({ pageBreakBefore: true, align: "right" }, t("Starts a page."))]);
  broken.commands.setTextSelection(3);
  clearParagraphOwn(broken);
  check("where a paragraph falls on the page is not formatting, and stays", broken.getJSON().content?.[0]?.attrs?.pageBreakBefore === true && broken.getJSON().content?.[0]?.attrs?.align === null);
  e.setEditable(false);
  check("a reader clears nothing", !clearTextOwn(e) && !clearParagraphOwn(e));
  e.destroy();
  broken.destroy();
}

finish();
