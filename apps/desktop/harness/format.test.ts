// The ribbon's own commands — change case, clear formatting, sort, grow and
// shrink, numbering, links — and that sizes and spacing now take any value.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";

import { bodyLook, DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { applyLink, changeCase, clearFormatting, normalizeHref, removeLink, setNumbering, sortBlocks } from "../src/editor/format/commands";
import { stepRunSize, stepSize } from "../src/editor/format/run";
import { resolveStyles } from "../src/editor/styles/sheet";
import { docContentExtensions } from "../src/editor/schema/content";
import { levelOfJson } from "../src/editor/schema/levels";
import { setTypography } from "../src/editor/TextFormat";

const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(content.length ? { content } : {}) });

function editorWith(content: JSONContent[]): Editor {
  return new Editor({ element: mountPoint(), extensions: docContentExtensions({ resizeImages: true }), content: { type: "doc", content } });
}
const texts = (e: Editor) => (e.getJSON().content ?? []).map((n) => (n.content ?? []).map((c) => c.text ?? "").join(""));
const selectAll = (e: Editor) => e.commands.selectAll();

{
  const e = editorWith([p(t("the QUICK "), t("brown fox. it", "bold"), t(" jumped! did it? yes."))]);
  selectAll(e);
  changeCase(e, "sentence");
  check("sentence case, across formatting", texts(e)[0] === "The quick brown fox. It jumped! Did it? Yes.", texts(e)[0]);
  check("…and the formatting stays where it was", e.getJSON().content?.[0].content?.[1]?.text === "brown fox. It" && e.getJSON().content?.[0].content?.[1]?.marks?.[0].type === "bold" && e.getJSON().content?.[0].content?.length === 3, JSON.stringify(e.getJSON().content?.[0].content));
  changeCase(e, "upper");
  check("upper case", texts(e)[0] === "THE QUICK BROWN FOX. IT JUMPED! DID IT? YES.");
  changeCase(e, "lower");
  changeCase(e, "title");
  check("each word capitalized", texts(e)[0] === "The Quick Brown Fox. It Jumped! Did It? Yes.", texts(e)[0]);
  changeCase(e, "toggle");
  check("toggled", texts(e)[0] === "tHE qUICK bROWN fOX. iT jUMPED! dID iT? yES.");
  e.commands.undo();
  check("one undo step each", texts(e)[0] === "The Quick Brown Fox. It Jumped! Did It? Yes.");
  e.commands.setTextSelection(3);
  check("nothing selected, nothing to change", changeCase(e, "upper") === false);
  e.destroy();
}

{
  const e = editorWith([
    { type: "heading", attrs: { level: 2, align: "center", font: "garamond", size: 20 }, content: [t("A "), t("styled", "bold", "italic"), t(" heading")] },
    { type: "paragraph", attrs: { align: "right", line: 2, sa: 12, sb: 0, dropCap: true, pageBreakBefore: true, element: "note" }, content: [t("Body", "underline")] },
  ]);
  selectAll(e);
  clearFormatting(e);
  const json = JSON.stringify(e.getJSON());
  check("clear formatting leaves plain paragraphs", !json.includes('"heading"') && !json.includes('"bold"') && !json.includes('"underline"') && !json.includes("garamond") && !json.includes('"right"'), json);
  check("…but a page break is structure, not formatting", json.includes('"pageBreakBefore":true') && json.includes('"element":"note"'));
  check("the text is untouched", texts(e).join("|") === "A styled heading|Body");
  e.destroy();
}

{
  const e = editorWith([p(t("pear")), p(t("Apple")), p(t("item 10")), p(t("item 2")), p(t("banana"))]);
  selectAll(e);
  sortBlocks(e);
  check("paragraphs sort A to Z, numbers as numbers", texts(e).join("|") === "Apple|banana|item 2|item 10|pear", texts(e).join("|"));
  sortBlocks(e, true);
  check("and Z to A", texts(e).join("|") === "pear|item 10|item 2|banana|Apple");
  check("already sorted: nothing to do", sortBlocks(e, true) === false);
  e.destroy();

  const li = (text: string) => ({ type: "listItem", content: [p(t(text))] });
  const l = editorWith([p(t("zebra first")), { type: "bulletList", content: [li("cherry"), li("apple"), li("Banana")] }, p(t("aardvark last"))]);
  l.commands.setTextSelection(18);
  sortBlocks(l);
  const items = (l.getJSON().content?.[1].content ?? []).map((i) => i.content?.[0].content?.[0].text);
  check("in a list, its items sort and nothing else moves", items.join("|") === "apple|Banana|cherry" && l.getJSON().content?.[0].content?.[0].text === "zebra first", items.join("|"));
  l.destroy();
}

{
  check("the size ladder", stepSize(12, 1) === 14 && stepSize(12, -1) === 11 && stepSize(13, 1) === 14 && stepSize(13, -1) === 12 && stepSize(72, 1) === 82 && stepSize(8, -1) === 7 && stepSize(4, -1) === 4);
  const e = editorWith([p(t("Grow me"))]);
  // A document held to level 1 (its server hasn't been updated): the size
  // is the whole paragraph's, as it always was.
  const level1 = { styles: resolveStyles(bodyLook(DEFAULT_SETTINGS)), level: 1 };
  stepRunSize(e, 1, level1);
  check("grow from the body size", e.getJSON().content?.[0].attrs?.size === 14);
  stepRunSize(e, -1, level1);
  stepRunSize(e, -1, level1);
  check("and shrink", e.getJSON().content?.[0].attrs?.size === 11);
  setTypography(e, { size: 13.5, line: 1.08, sa: 6, sb: 10.2 });
  const a = e.getJSON().content?.[0].attrs ?? {};
  check("any size and spacing is kept", a.size === 13.5 && a.line === 1.08 && a.sa === 6 && a.sb === 10.2);
  const html = e.getHTML();
  check("…and drawn through custom properties", html.includes('data-size="13.5"') && html.includes("--wf-sz: 13.5pt") && html.includes("--wf-lh: 1.3") && html.includes("--wf-sa: 6pt") && html.includes("--wf-sb: 10.2pt"), html);
  check("…and is still level-1 vocabulary", levelOfJson(e.getJSON()) === 1);
  e.destroy();
}

{
  const e = editorWith([p(t("one"))]);
  e.commands.setTextSelection(2);
  setNumbering(e, "i");
  check("numbering makes a list in the chosen style", e.getJSON().content?.[0].type === "orderedList" && e.getJSON().content?.[0].attrs?.type === "i");
  setNumbering(e, "A");
  check("and restyles the one the cursor is in", e.getJSON().content?.[0].attrs?.type === "A" && (e.getJSON().content ?? []).filter((n) => n.type === "orderedList").length === 1, JSON.stringify(e.getJSON()));
  e.destroy();
}

{
  check(
    "addresses: schemes added, dangerous ones refused",
    normalizeHref("example.com/a b") === null &&
      normalizeHref(" example.com/page ") === "https://example.com/page" &&
      normalizeHref("http://x.org") === "http://x.org" &&
      normalizeHref("me@example.com") === "mailto:me@example.com" &&
      normalizeHref("mailto:me@example.com") === "mailto:me@example.com" &&
      normalizeHref("javascript:alert(1)") === null &&
      normalizeHref("data:text/html,x") === null &&
      normalizeHref("file:///etc/passwd") === null &&
      normalizeHref("") === null &&
      normalizeHref("just words") === null,
  );
  const e = editorWith([p(t("Read the manual today."))]);
  e.commands.setTextSelection({ from: 10, to: 16 });
  applyLink(e, "https://example.com/manual", "");
  const linked = e.getJSON().content?.[0].content ?? [];
  check("the selection becomes the link", linked[1]?.text === "manual" && linked[1]?.marks?.[0].attrs?.href === "https://example.com/manual", JSON.stringify(linked));
  e.commands.setTextSelection(12);
  applyLink(e, "https://example.org/new", "");
  check("editing a link changes the whole of it", e.getJSON().content?.[0].content?.[1]?.marks?.[0].attrs?.href === "https://example.org/new" && e.getJSON().content?.[0].content?.[1]?.text === "manual");
  removeLink(e);
  check("and removing it leaves the words", !JSON.stringify(e.getJSON()).includes('"link"') && texts(e)[0] === "Read the manual today.");
  e.commands.setTextSelection(1);
  applyLink(e, "https://example.com/", "See this");
  check("with nothing selected, the words are typed in, linked", texts(e)[0].startsWith("See thisRead") && e.getJSON().content?.[0].content?.[0].marks?.[0].attrs?.href === "https://example.com/", JSON.stringify(e.getJSON()));
  e.destroy();
}

{
  // A picture with corner handles is still the same node with the same
  // attributes: an older app (and the layout) reads it unchanged.
  const e = editorWith([{ type: "image", attrs: { src: "writform-att://attachment/3", width: 300, height: 200 } }]);
  const json = e.getJSON().content?.[0];
  check("a resizable picture is the picture it always was", json?.type === "image" && json.attrs?.width === 300 && json.attrs?.height === 200 && levelOfJson(e.getJSON()) === 1);
  const img = (e.view.dom as HTMLElement).querySelector("img");
  check("…and its address is the platform's", !!img && /attachments?\/3$/.test(img.getAttribute("src") ?? ""), img?.getAttribute("src") ?? "none");
  check("…with handles to drag", (e.view.dom as HTMLElement).querySelectorAll("[data-resize-handle]").length === 4);
  e.destroy();
}

finish();
