// The word and page count in the toolbar: a manuscript counts the pages of
// its paperback (the layout engine's count, an estimate until then), other
// formats their sheets, and the counts sit on one line.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { DocumentStats } from "../src/apps/documents/DocumentEditor";
import { readBook } from "../src/book/model/bookMap";
import { countDocWords } from "../src/apps/documents/stats";
import { estimatePages } from "../src/book/model/trims";
import { docContentExtensions } from "../src/editor/schema/content";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const para = (text: string, element: string | null = null): JSONContent => ({ type: "paragraph", ...(element ? { attrs: { element } } : {}), content: [{ type: "text", text }] });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const content: JSONContent[] = [];
for (let c = 1; c <= 3; c += 1) content.push(para(`Chapter ${c}`, "chapter_heading"), para(words(400)), para(words(400)));

const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content } });
const book = readBook(new Y.Doc());

const host = mountPoint();
const root = createRoot(host);
let asked = 0;
const countPages = async () => {
  asked += 1;
  return 84;
};
await act(async () => root.render(createElement(DocumentStats, { editor, format: "manuscript", goalKey: "stats-test", book, countPages, onGoTo: () => {} })));
const pagesText = () => host.querySelector(".wf-doc-pages-btn")?.textContent ?? "";
const estimate = estimatePages(countDocWords(editor.state.doc), 3, book.print, book.design);
check("a manuscript first shows the paperback's estimated pages", pagesText() === `~${estimate} pages`, pagesText());
await act(async () => {
  await wait(480);
});
check("then the pages the layout engine set, the same count as the preview", pagesText() === "84 pages" && asked === 1, `${pagesText()} ${asked}`);
check("and says what it counts", (host.querySelector(".wf-doc-pages-btn")?.getAttribute("title") ?? "").startsWith("Pages in the typeset paperback"));

const goal = host.querySelector("button.wf-doc-stats-btn:not(.wf-doc-pages-btn)") as HTMLElement;
const loose = [...goal.childNodes].filter((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
check("the words and reading time are one line in the goal button", goal.firstElementChild?.classList.contains("wf-doc-stats-line") === true && loose.length === 0 && (goal.firstElementChild?.textContent ?? "").includes("min read"), goal.innerHTML);

await act(async () => root.render(createElement(DocumentStats, { editor, format: "none", goalKey: "stats-test", onGoTo: () => {} })));
await act(async () => {
  await wait(480);
});
check("a Document still counts its sheets, and asks the engine nothing", pagesText() === "~1 page" && asked === 1, `${pagesText()} ${asked}`);
await act(async () => root.render(createElement(DocumentStats, { editor, format: "none", pagesExact: 7, onGoTo: () => {} })));
check("and page view's count is exact", pagesText() === "7 pages");

await act(async () => root.unmount());
editor.destroy();
finish();
