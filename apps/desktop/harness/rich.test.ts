// Schema level 2 in the editor: formatting on a run of text, paragraph
// indents and borders, checklists and bullet styles, named styles, the
// format painter, and what a paste from Word or Google Docs becomes.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import * as Y from "yjs";

import { bodyLook, DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { setListStart, setNumbering } from "../src/editor/format/commands";
import { curRun, currentStyleId, type FormatContext } from "../src/editor/format/effective";
import { paintFormat, pickUpFormat } from "../src/editor/format/painter";
import { curParaFormat, setBlockAttrs, setBorder, setLineHeight, setShade, stepIndent } from "../src/editor/format/ParaFormat";
import { cleanPastedHtml, clipboardSerializer } from "../src/editor/format/paste";
import { setHighlight, setRunColor, setRunFont, setRunSize, stepRunSize, toggleScript } from "../src/editor/format/run";
import { setBulletMarker, toggleChecklist } from "../src/editor/nodes/TaskList";
import { docContentExtensions } from "../src/editor/schema/content";
import { levelOfJson } from "../src/editor/schema/levels";
import { encodeBorder, parseBorder, toHexColor } from "../src/editor/schema/sanitize";
import { applyStyle, capturedProps, clearCaptured } from "../src/editor/styles/apply";
import { stylesCss } from "../src/editor/styles/css";
import { newStyleId, readDocStyles, writeDocStyle } from "../src/editor/styles/docStyles";
import { listMarker, resolveStyles, type StyleOverrides } from "../src/editor/styles/sheet";

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
const editorWith = (content: JSONContent[]): Editor =>
  new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content } });
/** Where some words are, wherever their formatting splits them. */
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
const select = (e: Editor, needle: string) => {
  const from = find(e, needle);
  e.commands.setTextSelection({ from, to: from + needle.length });
};
const caret = (e: Editor, needle: string) => {
  e.commands.setTextSelection(find(e, needle) + 1);
};
const para = (e: Editor, i: number) => e.getJSON().content?.[i] ?? {};
/** A key, as the editor's keymaps get it (TipTap's own `keyboardShortcut`
 *  replays the steps through a second mapping, which misplaces any after
 *  the first). */
const press = (e: Editor, key: string): boolean => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};
/** The marks on some words (on their first letter). */
const marksOf = (e: Editor, text: string): string =>
  (e.state.doc.nodeAt(find(e, text))?.marks ?? [])
    .map((m) => `${m.type.name}${Object.keys(m.attrs).length ? `=${Object.values(m.attrs).join(",")}` : ""}`)
    .sort()
    .join(" ");

const styles = (overrides: StyleOverrides = {}) => resolveStyles(bodyLook(DEFAULT_SETTINGS), overrides);
const L2: FormatContext = { styles: styles(), level: 2 };
const L1: FormatContext = { styles: styles(), level: 1 };

// ---------------------------------------------------------------- formatting a run

{
  const e = editorWith([p(null, t("The quick brown fox jumps.")), p(null, t("A second paragraph."))]);
  select(e, "quick");
  setRunColor(e, "#c00000");
  select(e, "brown");
  setHighlight(e, "#ffff00");
  select(e, "fox");
  setRunSize(e, 18, 2);
  select(e, "jumps");
  setRunFont(e, "garamond", 2);
  check(
    "colour, highlight, size and typeface go on the words selected",
    marksOf(e, "quick") === "textColor=#c00000" && marksOf(e, "brown") === "highlight=#ffff00" && marksOf(e, "fox") === "fontSize=18" && marksOf(e, "jumps") === "fontFamily=garamond",
    [marksOf(e, "quick"), marksOf(e, "brown"), marksOf(e, "fox"), marksOf(e, "jumps")].join(" | "),
  );
  check("…and the paragraph's own attributes are untouched", para(e, 0).attrs?.font === null && para(e, 0).attrs?.size === null);
  check("…which needs level 2", levelOfJson(e.getJSON()) === 2);

  select(e, "fox");
  setRunColor(e, "#0070c0");
  check("a second property joins the first", marksOf(e, "fox") === "fontSize=18 textColor=#0070c0", marksOf(e, "fox"));
  setRunColor(e, null);
  setRunSize(e, null, 2);
  check("and each comes off by itself", marksOf(e, "fox") === "", marksOf(e, "fox"));

  select(e, "quick");
  check("the ribbon reads back what the words carry", curRun(e, L2).color === "#c00000" && curRun(e, L2).size === 12 && curRun(e, L2).font === null);
  select(e, "The quick brown");
  const mixed = curRun(e, L2);
  check("a selection of several colours is 'mixed'", mixed.mixed.color && mixed.mixed.highlight && !mixed.mixed.size);

  select(e, "quick");
  toggleScript(e, "super");
  check("superscript", marksOf(e, "quick").includes("vscript=super") && curRun(e, L2).vscript === "super");
  toggleScript(e, "sub");
  check("subscript replaces it", marksOf(e, "quick").includes("vscript=sub") && !marksOf(e, "quick").includes("super"));
  toggleScript(e, "sub");
  check("and the same again takes it off", !marksOf(e, "quick").includes("vscript"));

  // A whole paragraph: its own attribute follows, so an empty line in it —
  // and what's typed there later — matches.
  select(e, "A second paragraph.");
  setRunFont(e, "times", 2);
  setRunSize(e, 16, 2);
  check("a paragraph selected whole takes the face and size as its own too", para(e, 1).attrs?.font === "times" && para(e, 1).attrs?.size === 16 && marksOf(e, "A second paragraph.") === "fontFamily=times fontSize=16", JSON.stringify(para(e, 1).attrs));

  const html = e.getHTML();
  check("marks are drawn through custom properties", html.includes('data-tc="#c00000"') && html.includes("--wf-tc: #c00000") && html.includes("--wf-hl: #ffff00") && html.includes("--wf-fs: 16pt") && html.includes("--wf-ff:"), html.slice(0, 400));
  e.destroy();
}

{
  // Nothing selected: what's typed next.
  const e = editorWith([p(null, t("Type here"))]);
  e.commands.setTextSelection(10);
  setRunColor(e, "#00b050");
  e.commands.insertContent(" green");
  check("with nothing selected, the next words typed take it", marksOf(e, " green") === "textColor=#00b050", JSON.stringify(para(e, 0)));
  e.destroy();
}

{
  // Each piece steps from its own size.
  const e = editorWith([p(null, t("small ", { type: "fontSize", attrs: { pt: 9 } }), t("plain "), t("large", { type: "fontSize", attrs: { pt: 24 } }))]);
  e.commands.selectAll();
  stepRunSize(e, 1, L2);
  check("larger: every piece from its own size", marksOf(e, "small ") === "fontSize=10" && marksOf(e, "plain ") === "fontSize=14" && marksOf(e, "large") === "fontSize=26", [marksOf(e, "small "), marksOf(e, "plain "), marksOf(e, "large")].join(" | "));
  e.destroy();
}

{
  // Held to level 1: whole paragraphs, level-1 vocabulary.
  const e = editorWith([p(null, t("An older server holds this."))]);
  select(e, "older");
  setRunFont(e, "garamond", 1);
  setRunSize(e, 14, 1);
  check("at level 1, typeface and size are the paragraph's", para(e, 0).attrs?.font === "garamond" && para(e, 0).attrs?.size === 14 && marksOf(e, "An older server holds this.") === "");
  check("…and the content is still level 1", levelOfJson(e.getJSON()) === 1);
  check("…as the ribbon shows", curRun(e, L1).font === "garamond" && curRun(e, L1).size === 14);
  e.destroy();
}

// ---------------------------------------------------------------- paragraphs

{
  const e = editorWith([p(null, t("First.")), p(null, t("Second.")), { type: "heading", attrs: { level: 2 }, content: [t("A heading")] }]);
  caret(e, "First");
  stepIndent(e, 1);
  stepIndent(e, 1);
  check("indent steps by half an inch", para(e, 0).attrs?.indL === 72 && para(e, 1).attrs?.indL === null);
  setBlockAttrs(e, { indL: 50 });
  stepIndent(e, -1);
  check("out from between steps lands on the step below", para(e, 0).attrs?.indL === 36);
  stepIndent(e, -1);
  stepIndent(e, -1);
  check("and never past the margin", para(e, 0).attrs?.indL === null);

  setBlockAttrs(e, { indL: 36, indF: -18, indR: 12 });
  setShade(e, "#fff2cc");
  setBorder(e, { sides: "rlbt", width: 0.75, color: "#000000" });
  setLineHeight(e, { rule: "exact", at: 18 });
  const a = para(e, 0).attrs ?? {};
  check("a hanging indent, shading, a box and an exact line height", a.indF === -18 && a.shade === "#fff2cc" && a.bdr === "tblr 0.75 #000000" && a.lineRule === "exact" && a.lineAt === 18, JSON.stringify(a));
  check("…read back for the inspector", curParaFormat(e).indL === 36 && curParaFormat(e).bdr === "tblr 0.75 #000000" && curParaFormat(e).lineRule === "exact");
  const html = e.getHTML();
  check(
    "…and drawn through custom properties",
    html.includes("--wf-il: 36pt") && html.includes("--wf-if: -18pt") && html.includes("--wf-shade: #fff2cc") && html.includes('data-bdr="tblr"') && html.includes("--wf-bw: 0.75pt") && html.includes('data-lr="exact"') && html.includes("--wf-la: 18pt"),
    html.slice(0, 500),
  );
  setLineHeight(e, { multiple: 1.5 });
  check("a multiple clears the exact height", para(e, 0).attrs?.line === 1.5 && para(e, 0).attrs?.lineRule === null && para(e, 0).attrs?.lineAt === null);

  // Backspace at the start of an indented paragraph takes the indent off.
  e.commands.setTextSelection(1);
  press(e, "Backspace");
  check("Backspace at the start drops the hanging indent first", para(e, 0).attrs?.indF === null && para(e, 0).attrs?.indL === 36);
  press(e, "Backspace");
  check("…then the left indent", para(e, 0).attrs?.indL === null && (para(e, 0).content?.[0].text ?? "") === "First.");
  check("borders are one string, whatever order they were given in", encodeBorder(parseBorder("rb 9 #zzz")) === "br 6 #000000" || encodeBorder(parseBorder("rb 9 #zzz")) === "br 0.75 #000000", String(encodeBorder(parseBorder("rb 9 #zzz"))));
  check("a border with no sides is no border", parseBorder("x 1 #000000") === null && parseBorder(42) === null);
  e.destroy();
}

// ---------------------------------------------------------------- lists

{
  const e = editorWith([p(null, t("Milk")), p(null, t("Eggs"))]);
  e.commands.selectAll();
  toggleChecklist(e);
  const list = para(e, 0);
  check("paragraphs become a checklist", list.type === "taskList" && list.content?.length === 2 && list.content[0].type === "taskItem", JSON.stringify(list));
  const box = (e.view.dom as HTMLElement).querySelector<HTMLInputElement>('li[data-type="taskItem"] input[type="checkbox"]');
  check("each item has a box", !!box && !box.checked);
  box!.checked = true;
  box!.dispatchEvent(new Event("change", { bubbles: true }));
  check("ticking the box ticks the item", para(e, 0).content?.[0].attrs?.checked === true && para(e, 0).content?.[1].attrs?.checked == null, JSON.stringify(para(e, 0)));
  check("a checklist needs level 2", levelOfJson(e.getJSON()) === 2);

  caret(e, "Milk");
  setBulletMarker(e, "dash");
  check("a checklist becomes a dashed list, item for item", para(e, 0).type === "bulletList" && para(e, 0).attrs?.marker === "dash" && para(e, 0).content?.length === 2 && para(e, 0).content[0].type === "listItem", JSON.stringify(para(e, 0)));
  check("…drawn by its marker", e.getHTML().includes('data-marker="dash"'));
  caret(e, "Milk");
  toggleChecklist(e);
  check("and back into a checklist", para(e, 0).type === "taskList" && para(e, 0).content?.length === 2);
  caret(e, "Milk");
  toggleChecklist(e);
  check("the checklist button again makes plain paragraphs of it", (e.getJSON().content ?? []).some((n) => n.type === "paragraph" && n.content?.[0].text === "Milk"), JSON.stringify(e.getJSON()));
  e.destroy();
}

{
  const li = (text: string) => ({ type: "listItem", content: [p(null, t(text))] });
  const e = editorWith([
    { type: "orderedList", content: [li("one"), li("two")] },
    p(null, t("An aside.")),
    { type: "orderedList", content: [li("three"), li("four")] },
  ]);
  caret(e, "three");
  setListStart(e, "continue");
  check("a list carries on from the one before it", para(e, 2).attrs?.start === 3);
  setListStart(e, "restart");
  check("or starts again at 1", para(e, 2).attrs?.start === 1);
  setNumbering(e, "legal");
  check("legal numbering is a kind of numbered list (level-1 vocabulary)", para(e, 2).attrs?.type === "legal" && levelOfJson(e.getJSON()) === 1);
  check("legal markers show the levels above", listMarker(2, "legal", [1, 3]) === "1.3.2." && listMarker(4, "legal") === "4." && listMarker(3, "a") === "c.");
  e.destroy();
}

// ---------------------------------------------------------------- styles

{
  const ydoc = new Y.Doc();
  writeDocStyle(ydoc, "h1", { props: { color: "#2f5496", size: 20 } });
  const mine = newStyleId([]);
  writeDocStyle(ydoc, mine, { name: "Pull quote", base: "normal", props: { italic: true, align: "center", indL: 36 } });
  writeDocStyle(ydoc, "normal", { props: { bold: true } });
  ydoc.getMap("styles").set("u-bad", "{not json");
  ydoc.getMap("styles").set("title", JSON.stringify({ size: "huge", color: "red; }", align: "sideways" }));
  const overrides = readDocStyles(ydoc);
  const resolved = styles(overrides);
  check("a document's styles are read from its style table", Object.keys(overrides).sort().join(",") === ["h1", "title", mine].sort().join(","), Object.keys(overrides).join(","));
  check("Normal is the body text: it isn't changed here", !("normal" in overrides) && resolved.look("normal").bold === false);
  check("values that make no sense are not set", JSON.stringify(overrides.title.props) === "{}" && resolved.look("title").size === 26.4);
  check("a changed heading keeps what wasn't changed", resolved.look("h1").size === 20 && resolved.look("h1").color === "#2f5496" && resolved.look("h1").bold === true && resolved.look("h1").keepNext === true && resolved.look("h1").outline === 1);
  check("the document's own style starts from its base", resolved.look(mine).italic === true && resolved.look(mine).align === "center" && resolved.look(mine).size === 12 && resolved.look(mine).indL === 36);
  check("the gallery lists built-ins, then the document's own", resolved.list[0].id === "normal" && resolved.list[resolved.list.length - 1].name === "Pull quote" && resolved.list.find((s) => s.id === "h1")?.changed === true && resolved.list.find((s) => s.id === "h2")?.changed === false);
  check("a style nobody knows is body text", resolved.look("u-gone").size === 12 && !resolved.has("u-gone"));
  // Built-in sizes follow the body size; a changed one stays as set.
  const bigger = resolveStyles(bodyLook({ ...DEFAULT_SETTINGS, bodySize: 14 }), overrides);
  check("built-in styles follow the body size", bigger.look("h2").size === 21 && bigger.look("h1").size === 20);

  const css = stylesCss('[data-wfs="k"]', resolved);
  check(
    "only changed styles are written as CSS, at the weight of the rule they replace",
    css.includes('[data-wfs="k"] .ProseMirror h1 {') && css.includes(`[data-wfs="k"] :where(.ProseMirror) p[data-element="${mine}"] {`) && !css.includes(" h2 {") && css.includes("color: #2f5496") && css.includes("font-size: 20pt"),
    css.replace(/\n/g, " ⏎ "),
  );
  check("a centred style has no first-line indent", /text-align: center[^}]*text-indent: 0pt/.test(css));

  writeDocStyle(ydoc, "h1", null);
  writeDocStyle(ydoc, mine, null);
  check("styles are removed", !("h1" in readDocStyles(ydoc)) && !(mine in readDocStyles(ydoc)));
  ydoc.destroy();
}

{
  const overrides: StyleOverrides = { "u-abc123": { name: "Pull quote", props: { italic: true } } };
  const table = styles(overrides);
  const e = editorWith([
    p({ align: "center", size: 20, indL: 36 }, t("A paragraph", "bold", { type: "textColor", attrs: { c: "#c00000" } }), t(" set by hand", "bold", { type: "textColor", attrs: { c: "#c00000" } }, "italic")),
    p(null, t("Body text.")),
    { type: "blockquote", content: [p(null, t("Quoted."))] },
  ]);
  caret(e, "Body text");
  applyStyle(e, "title", table);
  check("a style is the paragraph's element", para(e, 1).attrs?.element === "title" && currentStyleId(e.state, table) === "title");
  check("named styles are level-1 vocabulary (an older app shows body text)", levelOfJson({ type: "doc", content: [para(e, 1)] }) === 1);
  applyStyle(e, "h2", table);
  check("a heading style makes a heading", para(e, 1).type === "heading" && para(e, 1).attrs?.level === 2 && currentStyleId(e.state, table) === "h2");
  applyStyle(e, "u-abc123", table);
  check("a style of the document's own makes it a paragraph again", para(e, 1).type === "paragraph" && para(e, 1).attrs?.element === "u-abc123");
  applyStyle(e, "normal", table);
  check("Normal clears the style", para(e, 1).type === "paragraph" && para(e, 1).attrs?.element === null);

  caret(e, "Quoted");
  check("a paragraph in a quote is in the Quote style", currentStyleId(e.state, table) === "quote");
  applyStyle(e, "normal", table);
  check("Normal takes it out of the quote", !JSON.stringify(e.getJSON()).includes("blockquote"));

  // "Update to match" and "New style from selection".
  caret(e, "A paragraph");
  const props = capturedProps(e);
  check(
    "what a paragraph has beyond its style: its own formatting, and what all its words share",
    props.align === "center" && props.size === 20 && props.indL === 36 && props.bold === true && props.color === "#c00000" && props.italic === undefined,
    JSON.stringify(props),
  );
  clearCaptured(e, "u-abc123");
  const after = para(e, 0);
  check(
    "once a style carries it, the paragraph gives it up — and keeps what only some words had",
    after.attrs?.element === "u-abc123" && after.attrs?.align === null && after.attrs?.size === null && after.attrs?.indL === null && marksOf(e, "A paragraph") === "" && marksOf(e, " set by hand") === "italic",
    JSON.stringify(after),
  );

  // Enter after a title goes back to body text.
  applyStyle(e, "title", table);
  e.commands.setTextSelection(1 + (para(e, 0).content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0));
  press(e, "Enter");
  check("Enter after a title starts body text", para(e, 0).attrs?.element === "title" && para(e, 1).type === "paragraph" && para(e, 1).attrs?.element === null && !para(e, 1).content, JSON.stringify(para(e, 1)));
  e.destroy();
}

// ---------------------------------------------------------------- the format painter

{
  const e = editorWith([
    p({ align: "center", indL: 36 }, t("Source words", "bold", { type: "textColor", attrs: { c: "#c00000" } })),
    p(null, t("Paint these words, "), t("this link", { type: "link", attrs: { href: "https://example.com" } }), t(" too.")),
  ]);
  select(e, "Source");
  const paint = pickUpFormat(e, 2);
  check("the painter picks up the words' formatting and the paragraph's", paint.marks.map((m) => m.type.name).sort().join(",") === "bold,textColor" && paint.block.align === "center" && paint.block.indL === 36);
  select(e, "these words");
  paintFormat(e, paint);
  check("painting a selection formats those words", marksOf(e, "these words") === "bold textColor=#c00000" && marksOf(e, "Paint ") === "");
  check("…and not the paragraph, unless all of it was selected", para(e, 1).attrs?.align === null);
  select(e, "this link");
  paintFormat(e, paint);
  check("a link stays a link", marksOf(e, "this link").includes("link=") && marksOf(e, "this link").includes("bold"));
  caret(e, " too");
  paintFormat(e, paint);
  check("a click paints the paragraph's formatting", para(e, 1).attrs?.align === "center" && para(e, 1).attrs?.indL === 36);
  const old = pickUpFormat(e, 1);
  check("held to level 1, the painter carries only what level 1 has", old.marks.every((m) => ["bold", "italic", "underline", "strike"].includes(m.type.name)) && !("indL" in old.block));
  e.destroy();
}

// ---------------------------------------------------------------- pasting

{
  check("colours other programs state", toHexColor("rgb(192, 0, 0)") === "#c00000" && toHexColor("#ABC") === "#aabbcc" && toHexColor("Yellow") === "#ffff00" && toHexColor("rgba(0,0,0,0)") === null && toHexColor("windowtext") === null && toHexColor("url(x)") === null);

  // Word: body text in Calibri 11 on every span, a red word, a highlight,
  // a superscript, a bigger line, and list paragraphs with typed bullets.
  const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name=Generator content="Microsoft Word 15"><style>p.MsoNormal{margin:0in}</style></head><body><!--StartFragment-->
<p class=MsoNormal><span style='font-size:11.0pt;font-family:"Calibri",sans-serif;color:black'>Plain body text with a <span style='color:#C00000'>red</span> word, a <span style='background:yellow;mso-highlight:yellow'>marked</span> one, E=mc<sup>2</sup>, and <b>bold</b>.<o:p></o:p></span></p>
<p class=MsoNormal><span style='font-size:18.0pt;font-family:"Georgia",serif'>A larger line in another face.</span></p>
<p class=MsoListParagraph style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;</span></span><![endif]><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>First item</span></p>
<p class=MsoListParagraph style='text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>o<span>&nbsp;</span></span><![endif]><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>Nested item</span></p>
<p class=MsoListParagraph style='text-indent:-.25in;mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>1.<span>&nbsp;</span></span><![endif]><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>A numbered item, long enough to outweigh the rest of this fragment so that the body face is plainly Calibri at eleven points</span></p>
<!--EndFragment--></body></html>`;
  const cleaned = cleanPastedHtml(word);
  const e = editorWith([p(null)]);
  e.commands.setContent(cleaned);
  const json = e.getJSON().content ?? [];
  check("from Word: the body face and size become this document's", marksOf(e, "Plain body text with a ") === "" && !cleaned.includes("font-family") && !cleaned.includes("font-size") && !cleaned.includes("data-ff=\"sys:Calibri"), cleaned.slice(0, 300).replace(/\n/g, " "));
  check("…colour, highlight, superscript and bold are kept", marksOf(e, "red") === "textColor=#c00000" && marksOf(e, "marked") === "highlight=#ffff00" && marksOf(e, "2") === "vscript=super" && marksOf(e, "bold") === "bold", [marksOf(e, "red"), marksOf(e, "marked"), marksOf(e, "2"), marksOf(e, "bold")].join(" | "));
  check("…text that differed from the body keeps its difference", marksOf(e, "A larger line in another face.") === "fontFamily=sys:Georgia fontSize=18", marksOf(e, "A larger line in another face."));
  check(
    "…and Word's list paragraphs become real lists, without their typed bullets",
    json[2]?.type === "bulletList" && json[2].content?.[0].content?.[1]?.type === "bulletList" && json[3]?.type === "orderedList" && !JSON.stringify(json).includes("·") && JSON.stringify(json[2]).includes("First item") && JSON.stringify(json[2]).includes("Nested item"),
    JSON.stringify(json.slice(2)).slice(0, 400),
  );
  check("…with no Office leftovers", !cleaned.includes("mso-") && !cleaned.includes("<o:p>") && !cleaned.includes("StartFragment") && !cleaned.includes("<style"));

  // Google Docs: everything inside one <b style="font-weight:normal">.
  const gdocs = `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;">Plain, </span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#ff0000;background-color:transparent;font-weight:700;">red and bold</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:#ffff00;font-style:italic;">, marked and italic</span><span style="font-size:6.6pt;font-family:Arial,sans-serif;color:#000000;vertical-align:super;">1</span></p></b>`;
  e.commands.setContent(cleanPastedHtml(gdocs));
  check("from Google Docs: not everything is bold", marksOf(e, "Plain, ") === "", marksOf(e, "Plain, "));
  check("…and its formatting is kept", marksOf(e, "red and bold") === "bold textColor=#ff0000" && marksOf(e, ", marked and italic") === "highlight=#ffff00 italic" && marksOf(e, "1").includes("vscript=super"), [marksOf(e, "red and bold"), marksOf(e, ", marked and italic"), marksOf(e, "1")].join(" | "));

  // Held to level 1: nothing is annotated.
  e.commands.setContent(cleanPastedHtml(gdocs, { level: 1 }));
  check("held to level 1, a paste brings only what level 1 has", levelOfJson(e.getJSON()) === 1 && marksOf(e, "red and bold") === "bold");

  // The editor's own clipboard passes through, and says its formatting in CSS.
  e.commands.setContent({ type: "doc", content: [p(null, t("Red", { type: "textColor", attrs: { c: "#c00000" } }), t(" and "), t("big", { type: "fontSize", attrs: { pt: 20 } }))] });
  const own = '<p data-pm-slice="1 1 []"><span data-tc="#c00000" style="color: #c00000">Red</span></p>';
  check("this editor's own clipboard is left alone", cleanPastedHtml(own) === own);
  const holder = document.createElement("div");
  holder.append(clipboardSerializer(e.schema).serializeFragment(e.state.doc.content));
  check("copied text says its formatting in plain CSS, for other programs", /style="color: (#c00000|rgb\(192, 0, 0\));?"/.test(holder.innerHTML) && holder.innerHTML.includes("font-size: 20pt") && holder.innerHTML.includes('data-tc="#c00000"'), holder.innerHTML);
  e.destroy();
}

finish();
