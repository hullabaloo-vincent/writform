// Tab stops (level 4): a paragraph's own, how they are written down, the
// stop a tab goes to, and the stops every half inch past them.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor } from "@tiptap/core";

import { DEFAULT_SETTINGS, settingsFrom, settingsVars } from "../src/apps/documents/docSettings";
import { pickUpFormat } from "../src/editor/format/painter";
import { refreshTabStops, setTabMode, TabStops } from "../src/editor/format/TabStops";
import { docContentExtensions } from "../src/editor/schema/content";
import { levels } from "../src/editor/schema/levels";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";
import * as Y from "yjs";
import { readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";
import { styleLevel, writeDocStyle } from "../src/editor/styles/docStyles";
import { decimalMark, encodeTabs, nextTab, parseTabs, TAB_EVERY } from "../src/editor/schema/sanitize";

// ------------------------------------------------------------ written down

{
  const stops = parseTabs("72:l 216:r:dot 468:d");
  check("stops are read with their kinds and leaders", JSON.stringify(stops) === JSON.stringify([{ pt: 72, kind: "l", leader: null }, { pt: 216, kind: "r", leader: "dot" }, { pt: 468, kind: "d", leader: null }]));
  check("and written back as they were", encodeTabs(stops as never) === "72:l 216:r:dot 468:d");
  check("“none” is none at all, whatever the style says", parseTabs("none") === "none" && encodeTabs("none") === "none");
  check("anything else is nothing (the style's)", parseTabs("72:x") === null && parseTabs(12) === null && parseTabs("") === null && encodeTabs([]) === null);
  check("stops out of order or out of reach are passed over", JSON.stringify(parseTabs("216:l 72:l 99999:r 300:c")) === JSON.stringify([{ pt: 216, kind: "l", leader: null }, { pt: 300, kind: "c", leader: null }]));
  check("at most 32", (parseTabs(Array.from({ length: 40 }, (_, i) => `${(i + 1) * 10}:l`).join(" ")) as unknown[]).length === 32);
  check("writing sorts them and keeps one a place", encodeTabs([{ pt: 200, kind: "r", leader: null }, { pt: 100, kind: "l", leader: null }, { pt: 200, kind: "c", leader: "line" }]) === "100:l 200:c:line");
}

// ------------------------------------------------------------ where a tab goes

{
  const stops = parseTabs("100:l 300:r") as Exclude<ReturnType<typeof parseTabs>, "none" | null>;
  check("to the paragraph's next stop", nextTab(stops, TAB_EVERY, 0).pt === 100 && nextTab(stops, TAB_EVERY, 120).pt === 300 && nextTab(stops, TAB_EVERY, 120).kind === "r");
  check("past its last, to the next half inch beyond it", nextTab(stops, TAB_EVERY, 310).pt === 324 && nextTab(stops, TAB_EVERY, 324).pt === 360);
  check("no half-inch stops before the paragraph's own last one", nextTab(stops, TAB_EVERY, 110).pt === 300);
  check("with none of its own, every half inch", nextTab([], TAB_EVERY, 0).pt === 36 && nextTab([], TAB_EVERY, 36).pt === 72 && nextTab([], 72, 10).pt === 72);
  check("a hanging indent is a stop too", nextTab([], TAB_EVERY, 0, 18).pt === 18 && nextTab(stops, TAB_EVERY, 0, 50).pt === 50 && nextTab(stops, TAB_EVERY, 60, 50).pt === 100);
  check("a tab moves on at least as far as it must", nextTab([], TAB_EVERY, 34, null, 3).pt === 72);
  check("the decimal mark is the language's", decimalMark("en-US") === "." && decimalMark("de-DE") === "," && decimalMark("fr") === "," && decimalMark("nonsense!") === ".");
}

// ------------------------------------------------------------ on a paragraph

{
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: [{ type: "paragraph", attrs: { tabs: "72:l 216:r:dot" }, content: [{ type: "text", text: "Name\tPrice" }] }] } });
  check("a paragraph's stops need level 4", levels.ofJson(e.getJSON()) === 4 && levels.ofJson({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a\tb" }] }] }) === 1);
  check("they are written on it and read back", e.getHTML().includes('data-tabs="72:l 216:r:dot"') && new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: e.getHTML() }).getJSON().content?.[0].attrs?.tabs === "72:l 216:r:dot");
  e.commands.setTextSelection(3);
  check("the painter carries them at level 4, not below", pickUpFormat(e, 4).block.tabs === "72:l 216:r:dot" && !("tabs" in pickUpFormat(e, 3).block));
  e.destroy();
}

// ------------------------------------------------------------ the stops every half inch

{
  check("a document's stops are every half inch to begin with", DEFAULT_SETTINGS.tabStop === 0.5 && !("--wfd-tab" in settingsVars(DEFAULT_SETTINGS)));
  const from = (o: Record<string, unknown>) => settingsFrom((k) => o[k]);
  const wider = from({ tabStop: 1 });
  check("another interval is kept and drawn", wider.tabStop === 1 && settingsVars(wider)["--wfd-tab"] === "1in" && from({ tabStop: 9 }).tabStop === 2);
}

// ------------------------------------------------------------ on screen
//
// A stand-in layout: every character 8 px wide from the paragraph's left
// edge, which is the margin. A tab is as wide as it was told to be: in
// "width" mode its box, in "size" mode up to the next multiple of its
// tab-size from the paragraph's start (as a browser does).

{
  const CH = 8;
  const proto = window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  const rect = (left: number, w: number) => ({ left, right: left + w, top: 0, bottom: 16, width: w, height: 16, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  let mode: "size" | "width" = "width";
  const widthOf = (span: HTMLElement, x: number) => {
    if (mode === "width") {
      const w = parseFloat(span.style.width);
      return Number.isFinite(w) ? w : CH;
    }
    const size = parseFloat(span.style.getPropertyValue("tab-size"));
    const p = Number.isFinite(size) && size > 0 ? size : 4 * CH;
    return (Math.floor(x / p + 1e-9) + 1) * p - x;
  };
  /** Where a tab span starts in its paragraph, and how wide it is. */
  const place = (target: HTMLElement): DOMRect => {
    const para = target.closest("p") as HTMLElement;
    let x = 0;
    let found: DOMRect | null = null;
    const walk = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (found) return;
        if (child.nodeType === 3) x += (child.textContent ?? "").length * CH;
        else if (child instanceof HTMLElement && child.classList.contains("wf-tab")) {
          const w = widthOf(child, x);
          if (child === target) found = rect(x, w);
          x += w;
        } else walk(child);
      }
    };
    walk(para);
    return found ?? rect(0, 0);
  };
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("wf-tab")) return place(this);
    if (this.matches("p, .ProseMirror")) return rect(0, 624);
    return original.call(this);
  };
  const rangeRects = window.Range.prototype.getClientRects;
  window.Range.prototype.getClientRects = function (this: Range) {
    const w = this.toString().length * CH;
    return [rect(0, w)] as unknown as DOMRectList;
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const para = (tabs: string | null, text: string) => ({ type: "paragraph", ...(tabs ? { attrs: { tabs } } : {}), content: [{ type: "text", text }] });
  const make = () =>
    new Editor({
      element: mountPoint(),
      extensions: [...docContentExtensions(), TabStops.configure({ every: () => 36, lang: () => "en-US" })],
      content: { type: "doc", content: [para("144:l 288:r", "Name\tAt\tPrice"), para("200:d:dot", "\t12.50"), para(null, "a\tb"), para("100:c", "\tMid")] },
    });
  const widths = (e: Editor) => [...(e.view.dom as HTMLElement).querySelectorAll<HTMLElement>("span.wf-tab")].map((s) => Math.round(place(s).width * 100) / 100);
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await wait(25);
  };

  setTabMode("width");
  const e = make();
  await settle();
  const got = widths(e);
  // Name|tab → 144 pt (192 px) from 32 px. At|tab → right stop at 288 pt (384 px) less "Price" (40 px), from 208 px.
  check("a left stop takes the text to it", got[0] === 160, got.join(" "));
  check("a right stop ends the text at it", got[1] === 136, got.join(" "));
  // A decimal stop at 200 pt (266.67 px): the mark there, after "12" (16 px).
  check("a decimal stop lines the mark up on it", Math.abs(got[2] - 250.67) < 0.02, got.join(" "));
  check("with none of its own, the next half inch", got[3] === 40, got.join(" "));
  // A centre stop at 100 pt (133.33 px): "Mid" (24 px) centred on it.
  check("a centre stop centres the text on it", Math.abs(got[4] - 121.33) < 0.02, got.join(" "));
  const dotted = (e.view.dom as HTMLElement).querySelectorAll("span.wf-tab")[2];
  check("a leader is said on the tab", dotted.getAttribute("data-leader") === "dot" && !(e.view.dom as HTMLElement).querySelectorAll("span.wf-tab")[0].hasAttribute("data-leader"));
  check("the text is untouched: a tab is still a tab", e.state.doc.textContent.includes("Name\tAt\tPrice") && JSON.stringify(e.getJSON()).includes("\\t"));

  // Typing before a tab moves the text, and the tab makes up the rest.
  e.commands.setTextSelection(3);
  e.commands.insertContent("xx");
  await settle();
  check("text typed before a tab: the tab narrows and its text stays at the stop", widths(e)[0] === 144, widths(e).join(" "));

  // The stops of the document every inch.
  let every = 36;
  const f = new Editor({ element: mountPoint(), extensions: [...docContentExtensions(), TabStops.configure({ every: () => every, lang: () => "en-US" })], content: { type: "doc", content: [para(null, "a\tb")] } });
  await settle();
  check("stops every half inch to begin with", widths(f)[0] === 40);
  every = 72;
  refreshTabStops(f.view);
  await settle();
  check("and every inch once the document says so", widths(f)[0] === 88, widths(f).join(" "));
  f.destroy();
  e.destroy();

  // A webview that takes a tab-size of a tab's own: the size is corrected
  // until the tab ends at its stop, whatever it counts from.
  setTabMode("size");
  mode = "size";
  const g2 = make();
  await settle();
  const ends = [...(g2.view.dom as HTMLElement).querySelectorAll<HTMLElement>("span.wf-tab")].map((s) => Math.round(place(s).right * 100) / 100);
  check("by tab-size: a left stop", ends[0] === 192, ends.join(" "));
  check("by tab-size: a right stop", ends[1] === 344, ends.join(" "));
  g2.destroy();

  // In a table a tab moves to the next cell: Ctrl+Tab types one there.
  const t = new Editor({
    element: mountPoint(),
    extensions: [...docContentExtensions(), TabStops],
    content: { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [para(null, "ab")] }, { type: "tableCell", content: [para(null, "cd")] }] }] }] },
  });
  t.commands.setTextSelection(5);
  const ctrlTab = new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, ctrlKey: true, bubbles: true, cancelable: true });
  t.view.someProp("handleKeyDown", (fn) => fn(t.view, ctrlTab));
  check("Ctrl+Tab types a tab in a table cell", t.state.doc.textContent.includes("a\tb"), JSON.stringify(t.state.doc.textContent));
  t.destroy();

  proto.getBoundingClientRect = original;
  window.Range.prototype.getClientRects = rangeRects;
  setTabMode(null);
}

// ------------------------------------------------------------ on the printed page
//
// Set in Courier Prime at 12 pt: every character 7.2 pt wide. The margin
// is 1.5 in (108 pt) from the paper's edge.

{
  const CW = 7.2;
  const M = 108;
  const session = new TypesetSession();
  const p = (tabs: string | null, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({ type: "paragraph", attrs: { ...(tabs ? { tabs } : {}), ...attrs }, content: [{ type: "text", text }] });
  const set = async (content: JSONContent[], settings: Record<string, unknown> = {}) => {
    const model = buildDocModel({ type: "doc", content }, { title: "Tabs", author: "", date: "", settings: { ...DEFAULT_SETTINGS, bodyFont: "mono", bodySize: 12, ...settings } });
    session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
    const req: DocRequest = { kind: "document", doc: model, families: model.families, images: [] };
    return { model, dl: (await session.layout(req)).dl };
  };
  const texts = (dl: Awaited<ReturnType<typeof set>>["dl"]) => dl.pages.flatMap((pg) => pg.items.filter((it): it is DLText => it.t === "text"));
  const xOf = (all: DLText[], word: string, nth = 0) => {
    const found = all.filter((t) => t.text === word || t.text.startsWith(`${word} `));
    return found[nth]?.x ?? NaN;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

  const { model, dl } = await set([
    p("144:l", "Name\tPrice"),
    p("288:r", "A\tAB"),
    p("288:r", "A\tABCD"),
    p("200:d", "\t1.50"),
    p("200:d", "\t100.25"),
    p("150:c", "\tMID"),
    p("216:r:dot", "Chapter\t9"),
    p(null, "a\tb"),
    p(null, "c\td", { indL: 54 }),
    p(null, "\tIndented"),
    p(null, "No tab here."),
  ]);
  const all = texts(dl);
  check("a paragraph with a tab is given its stops, and one without none", (model.blocks[0] as { tabs?: unknown }).tabs !== undefined && (model.blocks[10] as { tabs?: unknown }).tabs === undefined);
  check("a left stop: the text after the tab starts at it", near(xOf(all, "Name"), M) && near(xOf(all, "Price"), M + 144), `${xOf(all, "Name")} ${xOf(all, "Price")}`);
  check("a right stop: the text ends at it", near(xOf(all, "AB") + 2 * CW, M + 288) && near(xOf(all, "ABCD") + 4 * CW, M + 288), `${xOf(all, "AB")} ${xOf(all, "ABCD")}`);
  check("a decimal stop: the marks line up on it", near(xOf(all, "1.50") + CW, M + 200) && near(xOf(all, "100.25") + 3 * CW, M + 200), `${xOf(all, "1.50")} ${xOf(all, "100.25")}`);
  check("a centre stop: the text centred on it", near(xOf(all, "MID") + 1.5 * CW, M + 150), String(xOf(all, "MID")));
  const dots = all.find((t) => /^\.( \.)+$/.test(t.text));
  check("a dot leader fills the gap", !!dots && dots.x > xOf(all, "Chapter") + 7 * CW && dots.xs!.length > 10 && dots.xs![dots.xs!.length - 1] < xOf(all, "9"), JSON.stringify(dots && [dots.x, dots.xs!.length]));
  check("with none of its own, the next half inch from the margin", near(xOf(all, "b"), M + 36), String(xOf(all, "b")));
  check("measured from the margin, not the indent", near(xOf(all, "d"), M + 72), String(xOf(all, "d")));
  check("a tab opening a paragraph sets it in half an inch, as it always did", near(xOf(all, "Indented"), M + 36), String(xOf(all, "Indented")));
  const wide = texts((await set([p(null, "a\tb")], { tabStop: 1 })).dl);
  check("the document's own spacing of stops", near(xOf(wide, "b"), M + 72), String(xOf(wide, "b")));
}

// ------------------------------------------------------------ in Word files

{
  const doc: JSONContent = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { tabs: "72:l 216:r:dot 468:d" }, content: [{ type: "text", text: "Name\tPrice\t12.50" }] },
      { type: "paragraph", attrs: { element: "u-tabby" }, content: [{ type: "text", text: "a\tb" }] },
      { type: "paragraph", attrs: { element: "u-tabby", tabs: "none" }, content: [{ type: "text", text: "c\td" }] },
      { type: "paragraph", content: [{ type: "text", text: "\tLeading tab" }] },
    ],
  };
  const styles = { "u-tabby": { name: "Tabby", props: { tabs: "144:c" } } };
  const written = await writeDocx(doc, { title: "Tabs", format: "none", settings: { ...DEFAULT_SETTINGS, tabStop: 1 }, styles });
  const zip = await JSZip.loadAsync(written.bytes);
  const main = await zip.file("word/document.xml")!.async("string");
  const settingsXml = await zip.file("word/settings.xml")!.async("string");
  const stylesXml = await zip.file("word/styles.xml")!.async("string");
  check("a paragraph's stops are written as Word's", main.includes('<w:tabs><w:tab w:val="left" w:pos="1440"/><w:tab w:val="right" w:leader="dot" w:pos="4320"/><w:tab w:val="decimal" w:pos="9360"/></w:tabs>'), main.slice(main.indexOf("<w:tabs>"), main.indexOf("<w:tabs>") + 200));
  check("a style's stops go with the style", /<w:style [^>]*><w:name w:val="Tabby"\/>.*?<w:tab w:val="center" w:pos="2880"\/>/.test(stylesXml));
  check("“none” clears its style's stops", main.includes('<w:tab w:val="clear" w:pos="2880"/>'));
  check("the document's own spacing of stops", settingsXml.includes('<w:defaultTabStop w:val="1440"/>'));
  check("tabs stay tab characters", main.includes("<w:tab/>"));

  const read = await readDocx(written.bytes);
  const paras = read.content.content ?? [];
  check("read back, a paragraph's own stops are its own", paras[0]?.attrs?.tabs === "72:l 216:r:dot 468:d", JSON.stringify(paras[0]?.attrs));
  check("a paragraph in the style takes the style's", !paras[1]?.attrs?.tabs && Object.values(read.styles).some((v) => (v ?? "").includes('"tabs":"144:c"')), JSON.stringify(read.styles));
  check("and one that cleared them says none", paras[2]?.attrs?.tabs === "none", JSON.stringify(paras[2]?.attrs));
  check("a tab opening a paragraph is kept", (paras[3]?.content?.[0]?.text ?? "").startsWith("\tLeading"), JSON.stringify(paras[3]));
  check("the spacing comes back", read.settings.tabStop === 1);
}

// Word's own dialect: stops inherited through styles, cleared, a bar tab,
// a list typed by hand.
{
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const stylesXml = `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:name w:val="Child"/><w:basedOn w:val="Base"/><w:pPr><w:tabs><w:tab w:val="clear" w:pos="720"/><w:tab w:val="center" w:pos="4680"/></w:tabs></w:pPr></w:style></w:styles>`;
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr><w:r><w:t>Styled</w:t></w:r><w:r><w:tab/><w:t>stop</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:tabs><w:tab w:val="bar" w:pos="1000"/><w:tab w:val="num" w:pos="2160"/></w:tabs></w:pPr><w:r><w:t>Bar</w:t><w:tab/><w:t>num</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>•</w:t><w:tab/><w:t>A typed bullet</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>•</w:t><w:tab/><w:t>Not</w:t><w:tab/><w:t>a list</w:t></w:r></w:p>`,
  ].join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("word/styles.xml", stylesXml);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  const read = await readDocx(await zip.generateAsync({ type: "uint8array" }));
  const c = read.content.content ?? [];
  const childStyle = Object.entries(read.styles).find(([, v]) => (v ?? "").includes('"name":"Child"'))?.[1] ?? "";
  check("a style's stops: its parent's, less those it clears, and its own", childStyle.includes('"tabs":"234:c 450:r"'), childStyle);
  check("a bar tab is left out, and a number tab is a left one", c[1]?.attrs?.tabs === "108:l", JSON.stringify(c[1]?.attrs));
  check("a bullet and a tab in a paragraph with no stops is a list", c[2]?.type === "bulletList", c[2]?.type);
  check("but not when it has more tabs than that one", c[3]?.type === "paragraph" && JSON.stringify(c[3]).includes("•\\t"), JSON.stringify(c[3]));
}

// ------------------------------------------------------------ styles' level

{
  const ydoc = new Y.Doc();
  check("a document's styles need nothing beyond level 1 to begin with", styleLevel(ydoc) === 1);
  writeDocStyle(ydoc, "h2", { props: { tabs: "216:r" } });
  check("a style with tab stops needs level 4", styleLevel(ydoc) === 4);
}

finish();
