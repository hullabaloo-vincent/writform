// Formatting marks (a sign over each space, tab and line break, on what is
// in view only) and dark paper (the page dark, coloured text kept readable).
// Neither changes the text: what is copied, found and counted is the same.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readFileSync } from "node:fs";

import { Editor, type JSONContent } from "@tiptap/core";

import { findInDoc } from "../src/apps/documents/find/findInDoc";
import { countDocWords } from "../src/apps/documents/stats";
import { EDITOR_COMMANDS } from "../src/editor/commands/catalog";
import { runCommand, type CommandCtx } from "../src/editor/commands/run";
import { FormatMarks, markedStretch, marksFor, refreshFormatMarks } from "../src/editor/FormatMarks";
import { docContentExtensions } from "../src/editor/schema/content";
import { contrast, DARK_PAPER, darkPaperCss, lineColors, onDarkPaper, textColors, useDarkPaper } from "../src/editor/ui/darkPaper";

const NBSP = String.fromCharCode(0x00a0);
const SHY = String.fromCharCode(0x00ad);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const t = (text: string, ...marks: JSONContent[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
let on = true;
const editorWith = (content: JSONContent[]): Editor => new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), FormatMarks.configure({ on: () => on })], content: { type: "doc", content } });
const signs = (e: Editor) => [...(e.view.dom as HTMLElement).querySelectorAll(".wf-mk, .wf-mk-br")].map((el) => [...el.classList].find((c) => c.startsWith("wf-mk-")) ?? "");

// ------------------------------------------------------------ the marks

{
  const e = editorWith([p(t(`One two\tthree${NBSP}four ex${SHY}tra`), { type: "hardBreak" }, t("next line")), { type: "codeBlock", content: [t("a b c")] }]);
  await wait(40);
  check("each space, tab, no-break space and optional hyphen has its sign", signs(e).filter((c) => c === "wf-mk-sp").length === 3 && signs(e).includes("wf-mk-tab") && signs(e).includes("wf-mk-nb") && signs(e).includes("wf-mk-shy"), signs(e).join(" "));
  check("a line broken by hand has one before the break", signs(e).filter((c) => c === "wf-mk-br").length === 1);
  check("code is left unmarked", !(e.view.dom as HTMLElement).querySelector("pre .wf-mk"));
  const marked = (e.view.dom as HTMLElement).querySelector(".wf-mk-sp")!;
  check("a sign is a class on the character itself: the text in the page is unchanged", marked.textContent === " " && e.state.doc.textContent.startsWith("One two\tthree"));

  // Nothing the text is used for sees them.
  const json = JSON.stringify(e.getJSON());
  const words = countDocWords(e.state.doc);
  const found = findInDoc(e.state.doc, "two three".replace(" ", "\t")).matches.length;
  const copied = e.state.doc.textBetween(0, e.state.doc.content.size, "\n");
  on = false;
  refreshFormatMarks(e);
  await wait(40);
  check("switched off, every sign is gone", signs(e).length === 0 && markedStretch(e)[0] >= markedStretch(e)[1]);
  check("the document, its count, what is found in it and what is copied are the same either way", JSON.stringify(e.getJSON()) === json && countDocWords(e.state.doc) === words && findInDoc(e.state.doc, "two\tthree").matches.length === found && e.state.doc.textBetween(0, e.state.doc.content.size, "\n") === copied);
  on = true;
  refreshFormatMarks(e);
  await wait(40);
  check("and switched on again they are back", signs(e).length >= 6);

  // Typing keeps them up.
  e.commands.setTextSelection(4);
  e.commands.insertContent(" and");
  check("a space typed is marked at once", signs(e).filter((c) => c === "wf-mk-sp").length === 4, signs(e).join(" "));
  e.destroy();

  check("the marks of a stretch are only that stretch's", marksFor(editorWith([p(t("a b c d e"))]).state.doc, 0, 4).length === 1);
}

// Only what is in view (a stand-in layout: each paragraph 40 px tall, the window 400 px).
{
  const host = mountPoint();
  host.style.overflowY = "auto";
  const inner = document.createElement("div");
  host.append(inner);
  const paras = Array.from({ length: 3000 }, (_, i) => p(t(`Paragraph ${i + 1} has five words.`)));
  let scrollTop = 0;
  host.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const e = new Editor({ element: inner, extensions: [...docContentExtensions(), FormatMarks.configure({ on: () => true })], content: { type: "doc", content: paras } });
  const dom = e.view.dom as HTMLElement;
  [...dom.children].forEach((el, i) => {
    (el as HTMLElement).getBoundingClientRect = () => ({ top: i * 40 - scrollTop, bottom: i * 40 + 40 - scrollTop, left: 0, right: 600, width: 600, height: 40, x: 0, y: i * 40 - scrollTop, toJSON: () => ({}) }) as DOMRect;
  });
  refreshFormatMarks(e);
  await wait(60);
  const count = () => dom.querySelectorAll(".wf-mk").length;
  const first = count();
  check("of 3,000 paragraphs only those near the window are marked", first > 20 && first < 200, String(first));
  check("starting from the top", markedStretch(e)[0] === 0 && markedStretch(e)[1] < e.state.doc.content.size / 20);
  scrollTop = 40 * 1500;
  host.dispatchEvent(new Event("scroll"));
  await wait(60);
  const [from] = markedStretch(e);
  check("scrolled to the middle, it is the middle that is marked", count() > 20 && count() < 200 && from > e.state.doc.content.size / 3 && e.state.doc.textBetween(from, from + 30).includes("Paragraph 14"), `${count()} ${e.state.doc.textBetween(from, from + 30)}`);
  e.destroy();
}

// ------------------------------------------------------------ dark paper

{
  check("ink that reads on dark paper is left as it is", onDarkPaper("#ffd54a") === "#ffd54a" && onDarkPaper("#8fb8ff") === "#8fb8ff");
  check("ink that would not is made lighter until it does", onDarkPaper("#1f3a5f") !== "#1f3a5f" && contrast(onDarkPaper("#1f3a5f"), DARK_PAPER) >= 4.5 && contrast(onDarkPaper("#c00000"), DARK_PAPER) >= 4.5 && contrast(onDarkPaper("#006100"), DARK_PAPER) >= 4.5);
  check("keeping its colour (a navy stays blue)", (() => {
    const c = onDarkPaper("#1f3a5f");
    return parseInt(c.slice(5, 7), 16) > parseInt(c.slice(1, 3), 16);
  })());
  check("black and near black become the page's own ink", onDarkPaper("#000000") === "#dcdce2" && onDarkPaper("#202026") === "#dcdce2");
  check("what is no colour at all is the page's ink too", onDarkPaper("nonsense") === "#dcdce2");
  check("the eye's measure of contrast is the usual one", Math.abs(contrast("#000000", "#ffffff") - 21) < 0.01 && contrast("#777777", "#777777") === 1);

  const color = (c: string): JSONContent => ({ type: "textColor", attrs: { c } });
  const e = editorWith([p(t("Navy ", color("#1f3a5f")), t("gold ", color("#ffd54a")), t("plain "), t("navy again", color("#1f3a5f")))]);
  check("a document's text colours are found, each once", textColors(e).join() === "#1f3a5f,#ffd54a");
  const css = darkPaperCss(textColors(e));
  check("only the colours that need it get a rule", css.includes('[data-tc="#1f3a5f"]') && !css.includes("#ffd54a"));
  check("a rule is heard over the colour set on the text itself", css.includes("!important"));
  check("on a highlight or a shaded ground the colour is given back as it was", css.includes(':is([data-hl],[data-shade],td[data-bg]) [data-tc="#1f3a5f"]{--wf-tc:#1f3a5f !important}'));
  check("a document with no coloured text needs no rules", darkPaperCss([]) === "" && darkPaperCss(["#ffd54a"]) === "");

  // A paragraph's border is drawn in a colour of its own too (black, unless told).
  const boxed = editorWith([{ type: "paragraph", attrs: { bdr: "tblr 0.75 #000000" }, content: [t("Boxed")] }, { type: "paragraph", attrs: { bdr: "b 1 #ffd54a" }, content: [t("Ruled")] }, p(t("Plain"))]);
  check("the colours of a document's paragraph borders are found", lineColors(boxed).join() === "#000000,#ffd54a", lineColors(boxed).join());
  const lines = darkPaperCss([], lineColors(boxed));
  check("a black border is drawn in the page's ink", lines.includes('.wf-paper-dark [data-bdr-v$=" #000000"]{--wf-bc:#dcdce2 !important}'), lines);
  check("one that reads already is left alone", !lines.includes("ffd54a"));
  check("around a shaded paragraph, or in a shaded cell, it is as it was", lines.includes('[data-shade][data-bdr-v$=" #000000"]') && lines.includes('td[data-bg] [data-bdr-v$=" #000000"]') && lines.includes("{--wf-bc:#000000 !important}"));
  check("what the paragraph says of its border ends in the colour the rule looks for", (boxed.view.dom as HTMLElement).querySelector("[data-bdr-v]")?.getAttribute("data-bdr-v")?.endsWith(" #000000") === true);
  boxed.destroy();

  // What page view writes on the sheet (the first page's number, the
  // hairline in a block that runs over a page) is dark ink on white paper.
  const sheet = readFileSync("src/styles.css", "utf8");
  for (const cls of ["wf-page-num-first", "wf-page-guide", "wf-page-guide span", "wf-page-gap"]) {
    check(`dark paper has a rule for .${cls}`, sheet.includes(`.wf-paper-dark .${cls} {`));
  }
  check("and for the list of notes under the page", sheet.includes(".wf-paper-dark .wf-docnotes h4 {") && sheet.includes(".wf-paper-dark .wf-docnotes .wf-docnotes-field .ProseMirror {"));

  const ctx: CommandCtx = { format: "none", rich: null, editable: false, shell: {} };
  useDarkPaper.getState().set(false);
  check("dark paper is a command by name, for a reader too", !!EDITOR_COMMANDS.find((r) => r.id === "doc.paper") && runCommand("doc.paper", e, ctx) && useDarkPaper.getState().dark && localStorage.getItem("wf-doc-paper") === "dark");
  runCommand("doc.paper", e, ctx);
  check("and again turns it off", !useDarkPaper.getState().dark && localStorage.getItem("wf-doc-paper") === "light");
  e.destroy();
}

finish();
