// Word files: what the app writes must be what it reads back, must keep the
// order WordprocessingML demands (Word calls a file "unreadable" otherwise),
// and the reader must cope with how Word itself — and others — write things.

import { check, finish } from "./env";
import "./dom";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as PmNode } from "@tiptap/pm/model";
import JSZip from "jszip";

import { bodyLook, DEFAULT_SETTINGS, settingsFrom, type DocSettings } from "../src/apps/documents/docSettings";
import { mapImages, readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";
import { ORDER } from "../src/docx/write/order";
import { parseXml, type XNode } from "../src/docx/xml";
import { finalJson } from "../src/editor/review/final";
import { docContentExtensions } from "../src/editor/schema/content";
import { levelOfJson } from "../src/editor/schema/levels";
import { stylesFromSnapshot } from "../src/editor/styles/docStyles";
import { resolveStyles, type StyleLook, type StyleOverrides } from "../src/editor/styles/sheet";
import { resetFontStore } from "../src/fonts/store";
import { backend } from "../src/lib/backend";
import { imageSize } from "../src/lib/imageSize";

const schema = getSchema(docContentExtensions());
/** Both sides through the schema, so defaults and attribute order agree. */
const norm = (doc: JSONContent) => JSON.stringify(PmNode.fromJSON(schema, doc).toJSON());

const t = (text: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  ...(content.length ? { content } : {}),
});
const h = (level: number, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: "heading",
  attrs: { level, ...attrs },
  content: [t(text)],
});
const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const link = (href: string) => ({ type: "link", attrs: { href } });

// A 2×3 PNG (the smallest thing a reader will accept as a picture).
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP8z8Dwn4EIwESMIgBMSwMDOuQ3YQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const IMG = "writform-att://attachment/7";

/** One document holding every level-1 feature. */
const everything: JSONContent = {
  type: "doc",
  content: [
    h(1, "A heading — with “quotes” & <angles>"),
    p(
      null,
      t("Plain, "),
      t("bold", "bold"),
      t(", "),
      t("italic", "italic"),
      t(", "),
      t("both", "bold", "italic"),
      t(", "),
      t("underlined", "underline"),
      t(", "),
      t("struck", "strike"),
      t(", "),
      t("code()", "code"),
      t(", and a "),
      t("link", link("https://example.com/a?b=1&c=2")),
      t(" with a "),
      t("bold link", "bold", link("https://example.com/a?b=1&c=2")),
      t("."),
    ),
    h(2, "Second"),
    h(3, "Third"),
    h(4, "Fourth"),
    h(5, "Fifth"),
    h(6, "Sixth", { align: "center" }),
    p({ align: "center" }, t("Centred")),
    p({ align: "right" }, t("Right")),
    p({ align: "justify", line: 2, sa: 6, sb: 18 }, t("Justified, double spaced, with space around it.")),
    p({ font: "garamond", size: 14 }, t("Garamond at fourteen, "), t("partly italic", "italic"), t(".")),
    p({ font: "sys:Helvetica Neue", size: 9.5 }, t("A font the app doesn't own.")),
    p({ pageBreakBefore: true }, t("Starts a page.")),
    p(null, t("A line"), { type: "hardBreak" }, t("broken in two.")),
    p(null),
    p({ font: "mono" }),
    {
      type: "bulletList",
      content: [
        li(p(null, t("One"))),
        li(
          p(null, t("Two")),
          {
            type: "orderedList",
            attrs: { start: 3, type: "a" },
            content: [
              li(p(null, t("Two c"))),
              li(p(null, t("Two d")), { type: "bulletList", content: [li(p(null, t("Deep")))] }),
            ],
          },
        ),
        li(p(null, t("Three"))),
      ],
    },
    p(null, t("Between lists.")),
    {
      type: "orderedList",
      attrs: { start: 5, type: "I" },
      content: [li(p(null, t("Five"))), li(p(null, t("Six", "bold")))],
    },
    p(null, t("Between lists again.")),
    { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(null, t("Starts over at one")))] },
    { type: "blockquote", content: [p(null, t("A quoted paragraph.")), p({ align: "right" }, t("— Someone"))] },
    { type: "codeBlock", attrs: { language: null }, content: [t("let a = 1;\n  indented();\n\nlast();")] },
    { type: "horizontalRule" },
    { type: "image", attrs: { src: IMG, alt: "A tiny picture", title: null, width: 120, height: 180 } },
    p({ dropCap: true }, t("Once upon a time, a drop cap opened the chapter.")),
    p(null, t("Ünïcödé, 日本語, emoji 🎉, a tab\there, and non‑breaking hyphens.")),
  ],
};

const settings: DocSettings = {
  ...DEFAULT_SETTINGS,
  pageSize: "a4",
  landscape: true,
  mt: 0.75,
  mr: 1.25,
  mb: 0.5,
  ml: 1,
  gutter: 0.25,
  mirror: true,
  cols: 2,
  colGap: 0.4,
  bodyFont: "libertinus",
  bodySize: 11,
  bodyLine: 1.5,
  paraSpacing: 6,
  firstIndent: 0.25,
  hyphenate: true,
  lineNumbers: true,
  hfFirst: true,
  hfEven: true,
  hd: 0.4,
  fd: 0.6,
  pnFormat: "i",
  pnStart: 3,
  hL: "{title}",
  hC: "",
  hR: "{author}",
  fL: "Draft — {date}",
  fC: "Page {page} of {pages}",
  fR: "",
  h1L: "",
  h1C: "First page only",
  h1R: "",
  f1L: "",
  f1C: "",
  f1R: "",
  heL: "{page}",
  heC: "",
  heR: "Even",
  feL: "",
  feC: "",
  feR: "",
};

async function parts(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (/\.(xml|rels)$/.test(name)) out[name] = await zip.file(name)!.async("string");
  }
  return out;
}

/** Every sequence element's children in schema order; returns the faults. */
function orderFaults(root: XNode, where: string): string[] {
  const faults: string[] = [];
  const walk = (node: XNode) => {
    const local = node.name.startsWith("w:") ? node.name.slice(2) : "";
    const order = (ORDER as Record<string, readonly string[]>)[local];
    if (order) {
      let last = -1;
      for (const c of node.children) {
        const name = c.name.startsWith("w:") ? c.name.slice(2) : c.name;
        const at = order.indexOf(name);
        if (at < 0) faults.push(`${where}: <${c.name}> is not a child of <${node.name}>`);
        else if (at < last) faults.push(`${where}: <${c.name}> out of order in <${node.name}>`);
        last = Math.max(last, at);
      }
    }
    node.children.forEach(walk);
  };
  walk(root);
  return faults;
}

/** The package holds together: every part is XML, every relationship id
 *  used exists, every part has a content type. */
function packageFaults(files: Record<string, string>, binaries: string[]): string[] {
  const faults: string[] = [];
  const Parser = (globalThis as unknown as { DOMParser: new () => { parseFromString(s: string, t: string): Document } }).DOMParser;
  for (const [name, text] of Object.entries(files)) {
    const dom = new Parser().parseFromString(text, "application/xml");
    if (dom.getElementsByTagName("parsererror").length) faults.push(`${name} is not well-formed XML`);
  }
  const types = files["[Content_Types].xml"] ?? "";
  for (const name of [...Object.keys(files), ...binaries]) {
    if (name === "[Content_Types].xml") continue;
    const ext = name.split(".").pop()!;
    const covered = types.includes(`PartName="/${name}"`) || types.includes(`Extension="${ext}"`);
    if (!covered) faults.push(`${name} has no content type`);
  }
  for (const [name, text] of Object.entries(files)) {
    if (!name.startsWith("word/") || name.includes("_rels")) continue;
    const base = name.slice(5);
    const rels = files[`word/_rels/${base}.rels`] ?? "";
    for (const m of text.matchAll(/r:(?:id|embed)="([^"]+)"/g)) {
      if (!rels.includes(`Id="${m[1]}"`)) faults.push(`${name} uses ${m[1]}, which no relationship defines`);
    }
  }
  return faults;
}

// ---------------------------------------------------------------- round trip

{
  const images = new Map([[IMG, { bytes: PNG, type: "image/png", ...imageSize(PNG)! }]]);
  const written = await writeDocx(everything, { title: "Every feature", author: "A. Writer", format: "none", settings, images });
  check("the writer embeds every picture it was given", written.missingImages === 0);

  const zip = await JSZip.loadAsync(written.bytes);
  const files = await parts(written.bytes);
  const binaries = Object.keys(zip.files).filter((n) => n.startsWith("word/media/") && !zip.files[n].dir);
  const pkgFaults = packageFaults(files, binaries);
  check("the package is well-formed and complete", pkgFaults.length === 0, pkgFaults.slice(0, 4).join(" | "));

  const faults = Object.entries(files)
    .filter(([name]) => name.startsWith("word/") && name.endsWith(".xml"))
    .flatMap(([name, text]) => orderFaults(parseXml(text), name));
  check("every property is in schema order", faults.length === 0, faults.slice(0, 4).join(" | "));
  check("the title is a property, not a first paragraph", !files["word/document.xml"].includes("Every feature") && files["docProps/core.xml"].includes("<dc:title>Every feature</dc:title>"));
  check("headings are Word's own heading styles", files["word/styles.xml"].includes('<w:name w:val="heading 3"/>') && files["word/styles.xml"].includes('<w:outlineLvl w:val="2"/>'));
  check("lists are real numbering", (files["word/numbering.xml"] ?? "").includes("<w:abstractNum ") && files["word/document.xml"].includes("<w:numPr>"));

  const read = await readDocx(written.bytes);
  check("nothing is reported lost", read.warnings.length === 0, read.warnings.join(", "));
  check("pictures come back as bytes", read.media.length === 1 && read.media[0].type === "image/png" && read.media[0].bytes.length === PNG.length);
  const back = mapImages(read.content, () => IMG);
  const a = norm(everything);
  const b = norm(back);
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  check("every feature survives the round trip", a === b, a === b ? "" : `…${a.slice(Math.max(0, at - 60), at + 80)}  ≠  …${b.slice(Math.max(0, at - 60), at + 80)}`);

  const got = settingsFrom((k) => read.settings[k]);
  const diff = (Object.keys(settings) as (keyof DocSettings)[]).filter((k) => got[k] !== settings[k]);
  check("page setup, headers and footers survive", diff.length === 0, diff.map((k) => `${k}: ${String(settings[k])} → ${String(got[k])}`).join(", "));
  check("title and author come back", read.meta.title === "Every feature" && read.meta.author === "A. Writer");

  // Written twice, read twice: stable.
  const again = await readDocx((await writeDocx(back, { title: "x", format: "none", settings: got, images })).bytes);
  check("a second trip changes nothing", norm(mapImages(again.content, () => IMG)) === b);
}

{
  const written = await writeDocx(everything, { title: "No pictures", format: "none" });
  check("a picture without bytes is left out and counted", written.missingImages === 1);
  const read = await readDocx(written.bytes);
  check("…and the rest still reads", JSON.stringify(read.content).includes("Once upon a time") && !JSON.stringify(read.content).includes('"image"'));
  const got = settingsFrom((k) => read.settings[k]);
  check("default settings: the page number, bottom right", got.fR === "{page}" && got.fL === "" && got.hL === "" && got.pageSize === "letter" && !got.landscape);
  check("the default body look comes back as itself", got.bodyFont === null && got.bodySize === 12 && got.bodyLine === 1.375 && got.firstIndent === null);
}

{
  const script: JSONContent = {
    type: "doc",
    content: [
      p({ element: "scene_heading" }, t("INT. KITCHEN - NIGHT")),
      p({ element: "action" }, t("She pours the tea.")),
      p({ element: "character" }, t("MAYA")),
      p({ element: "dialogue" }, t("It's cold.")),
    ],
  };
  const files = await parts((await writeDocx(script, { title: "Script", format: "screenplay" })).bytes);
  const doc = files["word/document.xml"];
  check("a screenplay keeps its element styles", doc.includes('w:val="SceneHeading"') && doc.includes('w:val="Dialogue"') && files["word/styles.xml"].includes("Courier New"));
  check("…and its fixed sheet", doc.includes('w:left="2160"'));
}

// ---------------------------------------------------------------- round trip: level 2 and styles

{
  const mark = (type: string, attrs: Record<string, unknown>) => ({ type, attrs });
  const task = (checked: boolean, ...content: JSONContent[]): JSONContent => ({ type: "taskItem", ...(checked ? { attrs: { checked: true } } : {}), content });
  const rich: JSONContent = {
    type: "doc",
    content: [
      p({ element: "title" }, t("A Title")),
      p({ element: "subtitle" }, t("and its subtitle")),
      h(1, "A coloured heading"),
      p(
        null,
        t("Red", mark("textColor", { c: "#c00000" })),
        t(" then "),
        t("yellow", mark("highlight", { c: "#ffff00" })),
        t(" then "),
        t("soft", mark("highlight", { c: "#bdd7ee" })),
        t(" H"),
        t("2", mark("vscript", { v: "sub" })),
        t("O and x"),
        t("2", mark("vscript", { v: "super" })),
        t(" then "),
        t("big", mark("fontSize", { pt: 20 })),
        t(" then "),
        t("sans", mark("fontFamily", { f: "sans" })),
        t(" then "),
        t("all at once", "bold", mark("fontFamily", { f: "garamond" }), mark("fontSize", { pt: 9.5 }), mark("textColor", { c: "#0070c0" }), mark("highlight", { c: "#00ff00" })),
        t("."),
      ),
      p({ indL: 36, indR: 18, indF: -18 }, t("A hanging indent, set in from both sides.")),
      p({ indF: 24 }, t("A first line set in.")),
      p({ lineRule: "exact", lineAt: 18 }, t("Exactly eighteen points a line.")),
      p({ lineRule: "atLeast", lineAt: 20 }, t("At least twenty.")),
      p({ keepNext: true, keepLines: true }, t("Kept with what follows, and in one piece.")),
      p({ shade: "#fff2cc", bdr: "tblr 0.75 #000000" }, t("Boxed and shaded.")),
      p({ bdr: "b 1.5 #c00000" }, t("Ruled below, in red.")),
      p({ element: "caption" }, t("A caption.")),
      p({ element: "nospace" }, t("No spacing.")),
      p({ element: "u-abc123" }, t("In a style of the document's own.")),
      {
        type: "taskList",
        content: [task(true, p(null, t("Done"))), task(false, p(null, t("To do")), { type: "taskList", content: [task(false, p(null, t("A part of it")))] })],
      },
      p(null, t("Between.")),
      { type: "bulletList", attrs: { marker: "dash" }, content: [li(p(null, t("Dashed")))] },
      { type: "bulletList", attrs: { marker: "check" }, content: [li(p(null, t("Ticked")))] },
      {
        type: "orderedList",
        attrs: { start: 1, type: "legal" },
        content: [
          li(p(null, t("One")), { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(null, t("One point one"))), li(p(null, t("One point two")))] }),
          li(p(null, t("Two"))),
        ],
      },
    ],
  };
  const styles: StyleOverrides = {
    h1: { props: { color: "#2f5496", size: 20 } },
    "u-abc123": { name: "Pull quote", base: "normal", props: { italic: true, indL: 36, indR: 36, align: "center", size: 14 } },
  };
  check("the level-2 document is level 2", levelOfJson(rich) === 2);
  const written = await writeDocx(rich, { title: "Rich", format: "none", settings, styles });
  const files = await parts(written.bytes);
  const faults = Object.entries(files)
    .filter(([name]) => name.startsWith("word/") && name.endsWith(".xml"))
    .flatMap(([name, text]) => orderFaults(parseXml(text), name));
  check("level 2: every property is in schema order", faults.length === 0, faults.slice(0, 4).join(" | "));
  const xml = files["word/document.xml"];
  check("colour, a highlighter pen, and shading for a colour Word has no pen for", xml.includes('<w:color w:val="C00000"/>') && xml.includes('<w:highlight w:val="yellow"/>') && xml.includes('w:fill="BDD7EE"'));
  check("sub- and superscript", xml.includes('<w:vertAlign w:val="subscript"/>') && xml.includes('<w:vertAlign w:val="superscript"/>'));
  check("indents and line rules", xml.includes('<w:ind w:left="720" w:right="360" w:hanging="360"/>') && xml.includes('w:line="360" w:lineRule="exact"') && xml.includes('w:lineRule="atLeast"'));
  check("borders and shading", xml.includes("<w:pBdr><w:top ") && xml.includes('<w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/>'));
  check("named styles are Word's own, and the document's are written", xml.includes('<w:pStyle w:val="Title"/>') && xml.includes('<w:pStyle w:val="Uuabc123"/>') && files["word/styles.xml"].includes('<w:name w:val="Pull quote"/>'));
  check("a changed heading style is written as changed", /w:styleId="Heading1">.*?<w:color w:val="2F5496"\/><w:sz w:val="40"\/>/s.test(files["word/styles.xml"]));
  check("legal numbering is one multilevel definition", (files["word/numbering.xml"] ?? "").includes('<w:lvlText w:val="%1.%2."/>') && (files["word/numbering.xml"] ?? "").includes('<w:multiLevelType w:val="multilevel"/>'));

  // Another reader's opinion: macOS's own Word importer takes the file.
  if (process.platform === "darwin") {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-docx-"));
    const file = path.join(dir, "rich.docx");
    writeFileSync(file, written.bytes);
    if (process.env.WF_DUMP) writeFileSync(path.join(process.env.WF_DUMP, "rich.docx"), written.bytes);
    let text = "";
    try {
      execFileSync("textutil", ["-convert", "txt", "-output", path.join(dir, "rich.txt"), file], { stdio: "pipe" });
      text = readFileSync(path.join(dir, "rich.txt"), "utf8");
    } catch (e) {
      text = `textutil failed: ${String(e)}`;
    }
    check("macOS reads the level-2 file: its words, lists and checklist", ["A Title", "Boxed and shaded.", "Done", "One point two", "In a style of the document's own."].every((w) => text.includes(w)), text.slice(0, 200).replace(/\n/g, " ⏎ "));
  }

  const read = await readDocx(written.bytes);
  check("level 2: nothing is reported lost", read.warnings.length === 0, read.warnings.join(", "));
  const a = norm(rich);
  const b = norm(read.content);
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  check("every level-2 feature survives the round trip", a === b, a === b ? "" : `…${a.slice(Math.max(0, at - 80), at + 100)}  ≠  …${b.slice(Math.max(0, at - 80), at + 100)}`);

  // Styles: the same looks come back (stored however the reader likes).
  const body = bodyLook(settings);
  const before = resolveStyles(body, styles);
  const after = resolveStyles(bodyLook(settingsFrom((k) => read.settings[k])), stylesFromSnapshot(read.styles));
  // (A centred style's first-line indent is never drawn, so the file
  // doesn't carry one.)
  const drawn = (look: StyleLook) => JSON.stringify({ ...look, indF: look.indF > 0 && (look.align === "center" || look.align === "right") ? 0 : look.indF });
  const differs = before.list.map((info) => info.id).filter((id) => drawn(before.look(id)) !== drawn(after.look(id)));
  check("every style looks the same after the round trip", differs.length === 0, differs.map((id) => `${id}: ${JSON.stringify(before.look(id))} ≠ ${JSON.stringify(after.look(id))}`).join(" | "));
  check("the document's own style keeps its name", after.list.some((info) => info.id === "u-abc123" && info.name === "Pull quote"));
  check("built-in styles left alone aren't recorded as changed", Object.keys(read.styles).sort().join(",") === "h1,u-abc123", Object.keys(read.styles).join(","));
}

// ------------------------------------- round trip: tables, notes, contents, sections

{
  const fn = (kind: "foot" | "end", ...content: JSONContent[]): JSONContent => ({ type: "footnote", ...(kind === "end" ? { attrs: { kind: "end" } } : {}), content });
  const cell = (content: string | JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({
    type: "tableCell",
    ...(attrs ? { attrs } : {}),
    content: typeof content === "string" ? [p(null, t(content))] : content,
  });
  const row = (...cells: JSONContent[]): JSONContent => ({ type: "tableRow", content: cells });
  const structure: JSONContent = {
    type: "doc",
    content: [
      h(1, "Chapter one"),
      { type: "toc" },
      p(null, t("A claim"), fn("foot", t("Its source, with "), t("emphasis", "italic"), t(".")), t(" and an aside"), fn("end", t("Kept for the end.")), t(".")),
      {
        type: "table",
        attrs: { head: true, cols: "120 90 200" },
        content: [
          row(cell("Name"), cell("Role"), cell("Notes")),
          row(cell("Ada"), cell("Writer", { bg: "#fff2cc" }), cell([p(null, t("Two paragraphs,")), p({ align: "right" }, t("the second set right", "bold"))])),
          row(cell("Across two", { colspan: 2 }), cell("Down two", { rowspan: 2 })),
          row(cell("Left"), cell([{ type: "bulletList", content: [li(p(null, t("A list in a cell")))] }])),
        ],
      },
      { type: "table", attrs: { lines: "rows" }, content: [row(cell("a"), cell("b")), row(cell("c"), cell("d"))] },
      { type: "table", attrs: { lines: "none" }, content: [row(cell("no lines"))] },
      { type: "table", attrs: { lines: "box" }, content: [row(cell("boxed"), cell("only"))] },
      p(null, t("Between.")),
      { type: "image", attrs: { src: IMG, alt: null, title: null, width: 120, height: 180, align: "center", caption: "A captioned picture." } },
      // (The harness's document is A4, landscape, in two columns: a section
      // of its own is one that differs.)
      { type: "heading", attrs: { level: 2, sect: "sect size:letter land:0 cols:1 pn:1 mt:1 mr:0.5 mb:1 ml:0.5" }, content: [t("A portrait section")] },
      p(null, t("In one column.")),
      p({ colBreak: true }, t("After a column break.")),
      p({ sect: "sect" }, t("Back to the document's own page.")),
      { type: "toc", attrs: { depth: 1 } },
    ],
  };
  check("the structured document is level 2", levelOfJson(structure) === 2);
  const images = new Map([[IMG, { bytes: PNG, type: "image/png", ...imageSize(PNG)! }]]);
  const written = await writeDocx(structure, { title: "Structure", format: "none", settings, images, tocPages: ["1", "2"] });
  const files = await parts(written.bytes);
  const zip = await JSZip.loadAsync(written.bytes);
  const binaries = Object.keys(zip.files).filter((n) => n.startsWith("word/media/") && !zip.files[n].dir);
  const pkgFaults = packageFaults(files, binaries);
  check("structure: the package is well-formed and complete", pkgFaults.length === 0, pkgFaults.slice(0, 4).join(" | "));
  const faults = Object.entries(files)
    .filter(([name]) => name.startsWith("word/") && name.endsWith(".xml"))
    .flatMap(([name, text]) => orderFaults(parseXml(text), name));
  check("structure: every property is in schema order", faults.length === 0, faults.slice(0, 4).join(" | "));
  const xml = files["word/document.xml"];
  check("a table is a Word table: a grid, a header row, merged cells, shading", xml.includes('<w:gridCol w:w="2400"/>') && xml.includes("<w:tblHeader/>") && xml.includes('<w:gridSpan w:val="2"/>') && xml.includes('<w:vMerge w:val="restart"/>') && xml.includes("<w:vMerge/>") && xml.includes('w:fill="FFF2CC"'));
  check("footnotes and endnotes are parts of their own", (files["word/footnotes.xml"] ?? "").includes("Its source, with ") && (files["word/endnotes.xml"] ?? "").includes("Kept for the end.") && xml.includes('<w:footnoteReference w:id="1"/>') && xml.includes('<w:endnoteReference w:id="1"/>') && files["word/settings.xml"].includes("<w:footnotePr>"));
  check("a table of contents is a field Word can update, with the pages given", xml.includes(' TOC \\o "1-3" \\h \\z \\u ') && xml.includes('<w:pStyle w:val="TOC1"/>') && /Chapter one<\/w:t><\/w:r><w:r><w:tab\/><\/w:r><w:r><w:t>1</.test(xml));
  check("sections are Word sections", (xml.match(/<w:sectPr>/g) ?? []).length === 3 && xml.includes('<w:pgSz w:w="12240" w:h="15840"/>') && xml.includes('<w:pgNumType w:fmt="lowerRoman" w:start="1"/>') && xml.includes('<w:br w:type="column"/>'), xml.match(/<w:sectPr>.*?<\/w:sectPr>/g)?.[1]);
  check("…and headers and footers are named once, by the first", (xml.match(/<w:footerReference /g) ?? []).length === (xml.match(/<w:sectPr>/)?.index !== undefined ? xml.slice(0, xml.indexOf("</w:sectPr>")).match(/<w:footerReference /g)?.length ?? 0 : -1));

  if (process.platform === "darwin") {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-docx-"));
    const file = path.join(dir, "structure.docx");
    writeFileSync(file, written.bytes);
    if (process.env.WF_DUMP) writeFileSync(path.join(process.env.WF_DUMP, "structure.docx"), written.bytes);
    let text = "";
    try {
      execFileSync("textutil", ["-convert", "txt", "-output", path.join(dir, "structure.txt"), file], { stdio: "pipe" });
      text = readFileSync(path.join(dir, "structure.txt"), "utf8");
    } catch (e) {
      text = `textutil failed: ${String(e)}`;
    }
    // (Its plain-text conversion leaves footnotes out; they are checked below.)
    check("macOS reads the structured file: its contents, tables and sections", ["Chapter one\t1", "Ada", "Down two", "A list in a cell", "A captioned picture.", "After a column break."].every((w) => text.includes(w)), text.slice(0, 300).replace(/\n/g, " ⏎ "));
  }

  const read = await readDocx(written.bytes);
  check("structure: nothing is reported lost", read.warnings.length === 0, read.warnings.join(", "));
  const a = norm(structure);
  const b = norm(mapImages(read.content, () => IMG));
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  check("tables, notes, contents, captions and sections survive the round trip", a === b, a === b ? "" : `…${a.slice(Math.max(0, at - 90), at + 110)}  ≠  …${b.slice(Math.max(0, at - 90), at + 110)}`);
  const got = settingsFrom((k) => read.settings[k]);
  const diff = (Object.keys(settings) as (keyof DocSettings)[]).filter((k) => got[k] !== settings[k]);
  check("…and the document's own page setup is the last section's, its numbering the first's", diff.length === 0, diff.map((k) => `${k}: ${String(got[k])} ≠ ${String(settings[k])}`).join(", "));
}

// ------------------------------------- round trip: tracked changes

{
  const ins = (a: string, tm: number) => ({ type: "insertion", attrs: { a, t: tm } });
  const del = (a: string, tm: number) => ({ type: "deletion", attrs: { a, t: tm } });
  /** Each paragraph's words, in order. */
  const textsOf = (doc: JSONContent): string[] => {
    const out: string[] = [];
    const walk = (n: JSONContent) => {
      if (n.type === "paragraph" || n.type === "heading") out.push((n.content ?? []).map((c) => c.text ?? "").join(""));
      else (n.content ?? []).forEach(walk);
    };
    walk(doc);
    return out;
  };
  const T1 = 1700000000;
  const T2 = 1700003600;
  const cell = (text: string): JSONContent => ({ type: "tableCell", content: [p(null, t(text))] });
  const tracked: JSONContent = {
    type: "doc",
    content: [
      p(
        null,
        t("Keep "),
        t("added ", ins("Ana Ruiz", T1)),
        t("struck ", del("Bo & Co", T2)),
        t("both ", ins("Ana Ruiz", T1), del("Bo & Co", T2)),
        t("bold added", "bold", ins("Ana Ruiz", T1)),
        t(" end"),
        { type: "footnote", attrs: { tc: `ins:${T1}:Ana Ruiz` }, content: [t("A suggested note, "), t("partly struck", del("Bo & Co", T2)), t(".")] },
        t("."),
      ),
      p({ tc: `ins:${T1}:Ana Ruiz` }, t("A paragraph whose break is new.", ins("Ana Ruiz", T1))),
      p({ tc: `del:${T2}:Bo & Co` }, t("One to be joined to the one before.")),
      h(2, "A heading after that", { tc: `del:${T2}:Bo & Co` }),
      { type: "bulletList", content: [li(p(null, t("An item"))), li(p({ tc: `ins:${T1}:Ana Ruiz` }, t("A suggested item", ins("Ana Ruiz", T1))))] },
      { type: "table", attrs: { tc: `del:${T2}:Bo & Co` }, content: [{ type: "tableRow", content: [cell("a"), cell("b")] }, { type: "tableRow", content: [cell("c"), cell("d")] }] },
      p(null, t("After the table.")),
      { type: "table", attrs: { tc: `ins:${T1}:Ana Ruiz` }, content: [{ type: "tableRow", content: [cell("new")] }] },
      p(null, t("The end.")),
    ],
  };
  check("a document with tracked changes is level 2", levelOfJson(tracked) === 2);
  const written = await writeDocx(tracked, { title: "Tracked", format: "none", settings });
  const files = await parts(written.bytes);
  const pkgFaults = packageFaults(files, []);
  check("tracked: the package is well-formed and complete", pkgFaults.length === 0, pkgFaults.slice(0, 4).join(" | "));
  const faults = Object.entries(files)
    .filter(([name]) => name.startsWith("word/") && name.endsWith(".xml"))
    .flatMap(([name, text]) => orderFaults(parseXml(text), name));
  check("tracked: every property is in schema order", faults.length === 0, faults.slice(0, 4).join(" | "));
  const xml = files["word/document.xml"];
  check(
    "an insertion is Word's w:ins, with who and when",
    /<w:ins w:id="\d+" w:author="Ana Ruiz" w:date="2023-11-14T22:13:20Z"><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:t xml:space="preserve">added <\/w:t><\/w:r><\/w:ins>/.test(xml),
    xml.slice(xml.indexOf("added") - 200, xml.indexOf("added") + 60),
  );
  check("a deletion is w:del around w:delText (the name escaped)", /<w:del w:id="\d+" w:author="Bo &amp; Co" w:date="2023-11-14T23:13:20Z"><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:delText xml:space="preserve">struck <\/w:delText>/.test(xml), xml.slice(xml.indexOf("struck") - 200, xml.indexOf("struck") + 40));
  check("struck suggested text is a deletion inside an insertion", /<w:ins [^>]*><w:del [^>]*><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:delText xml:space="preserve">both <\/w:delText><\/w:r><\/w:del><\/w:ins>/.test(xml));
  check("a tracked break is on the mark of the paragraph before it", /<w:pPr>(?:(?!<\/w:pPr>).)*<w:rPr><w:ins w:id="\d+" w:author="Ana Ruiz"[^>]*\/>/.test(xml) && /<w:rPr><w:del w:id="\d+" w:author="Bo &amp; Co"[^>]*\/>/.test(xml));
  check("a table suggested or struck whole says so on its rows", (xml.match(/<w:trPr><w:del /g) ?? []).length === 2 && (xml.match(/<w:trPr><w:ins /g) ?? []).length === 1, String((xml.match(/<w:trPr>/g) ?? []).length));
  check("a suggested footnote: its reference is tracked, and what it says", /<w:ins [^>]*><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:footnoteReference w:id="1"\/><\/w:r><\/w:ins>/.test(xml) && (files["word/footnotes.xml"] ?? "").includes("<w:delText"));
  const ids = [...Object.values(files).join("").matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]);
  check("every tracked change has an id of its own", ids.length > 8 && new Set(ids).size === ids.length, `${ids.length} / ${new Set(ids).size}`);

  if (process.platform === "darwin") {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-docx-"));
    const file = path.join(dir, "tracked.docx");
    writeFileSync(file, written.bytes);
    if (process.env.WF_DUMP) writeFileSync(path.join(process.env.WF_DUMP, "tracked.docx"), written.bytes);
    let text = "";
    try {
      execFileSync("textutil", ["-convert", "txt", "-output", path.join(dir, "tracked.txt"), file], { stdio: "pipe" });
      text = readFileSync(path.join(dir, "tracked.txt"), "utf8");
    } catch (e) {
      text = `textutil failed: ${String(e)}`;
    }
    check("macOS reads the tracked file", ["Keep", "added", "The end."].every((w) => text.includes(w)), text.slice(0, 300).replace(/\n/g, " ⏎ "));
  }

  const read = await readDocx(written.bytes);
  const a = norm(tracked);
  const b = norm(read.content);
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  check("tracked changes survive the round trip — who, when, and what", a === b, a === b ? "" : `…${a.slice(Math.max(0, at - 120), at + 140)}  ≠  …${b.slice(Math.max(0, at - 120), at + 140)}`);
  check("…and the import says they were kept", read.warnings.join(", ") === "tracked changes kept as suggestions (see Changes)", read.warnings.join(", "));
  const accepted = await readDocx(written.bytes, { changes: "accept" });
  const flat = textsOf(accepted.content).join("|");
  check("read as accepted: insertions in, deletions out, the struck table gone", flat.startsWith("Keep added bold added end.|A paragraph whose break is new.|One to be joined") && !flat.includes("struck") && !flat.includes("|a|b|") && flat.includes("new"), flat);
  const clean = await writeDocx(finalJson(tracked), { title: "Clean", format: "none", settings });
  const cleanXml = (await parts(clean.bytes))["word/document.xml"];
  const cleanText = textsOf((await readDocx(clean.bytes)).content).join("|");
  check("a clean copy has no tracked changes in it, and the joins are made", !/<w:(ins|del) /.test(cleanXml) && !cleanXml.includes("struck") && cleanText.includes("A paragraph whose break is new.One to be joined to the one before.A heading after that|An item"), cleanText);
}

// ------------------------------------------------------------------ dialects

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';

/** A minimal package around hand-written parts. */
async function pack(body: string, extra: Record<string, string | Uint8Array> = {}, opts: { rels?: string; main?: string; sect?: string } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const main = opts.main ?? "word/document.xml";
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`);
  const dir = main.slice(0, main.lastIndexOf("/") + 1);
  const base = main.slice(dir.length);
  const known = ["styles", "numbering", "settings"].filter((n) => `${dir}${n}.xml` in extra);
  zip.file(
    `${dir}_rels/${base}.rels`,
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${known
      .map((n, i) => `<Relationship Id="rIdK${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${n}" Target="${n}.xml"/>`)
      .join("")}<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${opts.rels ?? ""}</Relationships>`,
  );
  zip.file(main, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}${opts.sect ?? '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'}</w:body></w:document>`);
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return zip.generateAsync({ type: "uint8array" });
}

const texts = (doc: JSONContent): string[] => {
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "paragraph" || n.type === "heading" || n.type === "codeBlock") {
      out.push((n.content ?? []).map((c) => (c.type === "hardBreak" ? "⏎" : (c.text ?? ""))).join(""));
      return;
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
};
const shape = (doc: JSONContent): string =>
  (doc.content ?? [])
    .map((n) => (n.type === "heading" ? `h${n.attrs?.level}` : n.type === "paragraph" ? "p" : n.type))
    .join(" ");

// Word's own styles.xml in miniature: theme fonts in the defaults, heading
// styles under localized ids, a quote style, a list style.
const WORD_STYLES = `<?xml version="1.0"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi"/><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="Heading 2"/><w:basedOn w:val="berschrift1"/><w:rPr><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Zitat"><w:name w:val="Quote"/><w:basedOn w:val="Standard"/><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Listenabsatz"><w:name w:val="List Paragraph"/><w:basedOn w:val="Standard"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Aufzhlung"><w:name w:val="List Bullet"/><w:basedOn w:val="Standard"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
<w:style w:type="character" w:styleId="Fett"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Link"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
const THEME = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
const NUMBERING = `<?xml version="1.0"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>
</w:numbering>`;
const WORD = { "word/styles.xml": WORD_STYLES, "word/theme/theme1.xml": THEME, "word/numbering.xml": NUMBERING };

const r = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const wp = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;

{
  // Runs split mid-word by spell-check and revision ids; proofing marks;
  // bookmarks; a soft hyphen; a symbol; caps; hidden text.
  const body =
    wp(r("Chapter One"), '<w:pStyle w:val="berschrift1"/>') +
    wp(
      `<w:bookmarkStart w:id="0" w:name="_GoBack"/>${r("The qu")}<w:proofErr w:type="spellStart"/>${r("ick")}<w:proofErr w:type="spellEnd"/>${r(" brown ")}${r("fox", "<w:b/>")}${r(" jum", "<w:b w:val=\"0\"/>")}${r("ps.")}<w:bookmarkEnd w:id="0"/>`,
    ) +
    wp(r("shouted", "<w:caps/>") + r(" and ") + r("secret", "<w:vanish/>") + `<w:r><w:sym w:font="Symbol" w:char="F0B7"/></w:r>` + r(" co") + `<w:r><w:softHyphen/></w:r>` + r("operate")) +
    wp(r("Strong run", '<w:rStyle w:val="Fett"/>') + r(" then ") + r("double struck", "<w:dstrike/>") + r(" then ") + r("not underlined", '<w:u w:val="none"/>') + r(" then ") + r("wavy", '<w:u w:val="wave"/>')) +
    wp(r("A subheading"), '<w:pStyle w:val="berschrift2"/>') +
    wp(r("Quoted."), '<w:pStyle w:val="Zitat"/>');
  const read = await readDocx(await pack(body, WORD));
  const c = read.content.content ?? [];
  check("headings come from the style's name, not its id", shape(read.content) === "h1 p p p h2 blockquote", shape(read.content));
  check("split runs join back into words", texts(read.content)[1] === "The quick brown fox jumps.");
  check("…with marks where they were", norm({ type: "doc", content: [c[1]] }) === norm({ type: "doc", content: [p(null, t("The quick brown "), t("fox", "bold"), t(" jumps."))] }), JSON.stringify(c[1]));
  check("caps, hidden text, symbols and soft hyphens", texts(read.content)[2] === "SHOUTED and • co­operate", JSON.stringify(texts(read.content)[2]));
  check("character styles, double strike and underline kinds", norm({ type: "doc", content: [c[3]] }) === norm({ type: "doc", content: [p(null, t("Strong run", "bold"), t(" then "), t("double struck", "strike"), t(" then not underlined then "), t("wavy", "underline"))] }), JSON.stringify(c[3]));
  check("a heading's own bold and size aren't formatting", JSON.stringify(c[0]) === JSON.stringify({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Chapter One" }] }), JSON.stringify(c[0]));
  check("a quote style's italics become the document's Quote style", !JSON.stringify(c[5]).includes('"italic"') && (read.styles.quote ?? "").includes('"italic":true'), read.styles.quote);
  check(
    "a heading style's look becomes the document's heading style",
    (() => {
      const h1 = JSON.parse(read.styles.h1 ?? "{}") as Record<string, unknown>;
      return h1.size === 16 && h1.color === "#2f5496" && h1.font === "sys:Calibri Light" && h1.before === 12 && h1.after === 0;
    })(),
    read.styles.h1,
  );
  const s = settingsFrom((k) => read.settings[k]);
  check("Word's defaults become the document's body text", s.bodyFont === "sys:Calibri" && s.bodySize === 11 && s.bodyLine === 1.079 && s.paraSpacing === 8, JSON.stringify([s.bodyFont, s.bodySize, s.bodyLine, s.paraSpacing]));
  check("a Word file with no footer gets no page number", s.fR === "" && s.mt === 1 && s.ml === 1 && s.pageSize === "letter");
}

{
  // Lists: by numbering, through a style, nested, restarted, and broken up.
  const num = (id: number, lvl: number) => `<w:pStyle w:val="Listenabsatz"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr>`;
  const body =
    wp(r("one"), num(1, 0)) +
    wp(r("one a"), num(1, 1)) +
    wp(r("one b"), num(1, 1)) +
    wp(r("two"), num(1, 0)) +
    wp(r("bullet by style"), '<w:pStyle w:val="Aufzhlung"/>') +
    wp(r("nested bullet"), '<w:pStyle w:val="Aufzhlung"/><w:numPr><w:ilvl w:val="1"/></w:numPr>') +
    wp(r("plain")) +
    wp(r("seven"), num(3, 0)) +
    wp(r("not numbered"), '<w:pStyle w:val="Listenabsatz"/><w:numPr><w:numId w:val="0"/></w:numPr>');
  const read = await readDocx(await pack(body, WORD));
  const c = read.content.content ?? [];
  check("list structure", shape(read.content) === "orderedList bulletList p orderedList p", shape(read.content));
  check("an indented paragraph is indented, not a quote", c[4].attrs?.indL === 36, JSON.stringify(c[4].attrs));
  check("numbered levels nest with their formats", c[0].content?.length === 2 && c[0].content[0].content?.[1]?.type === "orderedList" && c[0].content[0].content[1].attrs?.type === "a" && c[0].content[0].content[1].content?.length === 2);
  check("a list style's numbering counts", c[1].type === "bulletList" && c[1].content?.[0].content?.[1]?.type === "bulletList");
  check("a restarted list starts where Word says", c[3].attrs?.start === 7);
}

{
  // Page breaks every way Word writes them, and a section break.
  const br = '<w:r><w:br w:type="page"/></w:r>';
  const body =
    wp(r("first")) +
    wp(br) +
    wp(r("after a break paragraph")) +
    wp(r("ends with a break") + br) +
    wp(r("after a trailing break")) +
    wp(br + r("starts with a break")) +
    wp(r("before") + br + r("after, same paragraph")) +
    wp(r("by property"), "<w:pageBreakBefore/>") +
    wp(r("ends a section"), '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>') +
    wp(r("new section")) +
    wp(r("ends a continuous section"), '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>') +
    wp(r("continuous"));
  const read = await readDocx(
    await pack(body, WORD, { sect: '<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' }),
  );
  const got = (read.content.content ?? []).map((n) => `${n.attrs?.sect ? "§" : ""}${n.attrs?.pageBreakBefore ? "⤓" : ""}${(n.content ?? []).map((x) => x.text).join("")}`);
  check(
    "page breaks land on the paragraph that starts the page; a section break starts a section",
    got.join("|") ===
      "first|⤓after a break paragraph|ends with a break|⤓after a trailing break|⤓starts with a break|before|⤓after, same paragraph|⤓by property|ends a section|§new section|ends a continuous section|continuous",
    got.join("|"),
  );
  check("a section break within a page is left out, and said", read.warnings.includes("1 section break within a page left out"), read.warnings.join(", "));
}

{
  // Fields, links, content controls, tracked changes, alternate content.
  const fld = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
  const instr = (text: string) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`;
  const body =
    wp(`${r("See ")}<w:hyperlink r:id="rIdL"><w:r><w:rPr><w:rStyle w:val="Link"/></w:rPr><w:t>the site</w:t></w:r></w:hyperlink>${r(" or ")}${fld("begin")}${instr(' HYPERLINK "https://example.org/x" ')}${fld("separate")}${r("the other", '<w:rStyle w:val="Link"/>')}${fld("end")}${r(" or ")}<w:hyperlink w:anchor="_Toc1"><w:r><w:t>this chapter</w:t></w:r></w:hyperlink>${r(".")}`) +
    wp(`${r("Page ")}<w:fldSimple w:instr=" PAGE "><w:r><w:t>4</w:t></w:r></w:fldSimple>${r(" on ")}${fld("begin")}${instr(" DATE ")}${fld("separate")}${r("1 May")}${fld("end")}`) +
    `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${wp(r("Contents"))}${wp(`${fld("begin")}${instr(' TOC \\o "1-3" ')}${fld("separate")}${r("Chapter One\t3")}`)}${wp(r("Chapter Two\t9"))}${wp(fld("end"))}</w:sdtContent></w:sdt>` +
    wp(`<w:sdt><w:sdtContent>${r("In a control")}</w:sdtContent></w:sdt><w:smartTag>${r(" and a tag")}</w:smartTag>`) +
    wp(`${r("kept ")}<w:ins w:id="1" w:author="x">${r("inserted ")}</w:ins><w:del w:id="2" w:author="x"><w:r><w:delText>deleted </w:delText></w:r></w:del><w:moveFrom>${r("moved away ")}</w:moveFrom><w:moveTo>${r("moved here")}</w:moveTo>`) +
    wp(`<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="952500" cy="952500"/><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent>${wp(r("In a text box"))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${wp(r("In a text box"))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>${r("Beside the box")}`) +
    `<w:tbl><w:tr><w:tc>${wp(r("cell one"))}</w:tc><w:tc>${wp(r("cell two"))}</w:tc></w:tr></w:tbl>` +
    wp(`${r("A note")}<w:r><w:footnoteReference w:id="2"/></w:r>${r(".")}`);
  const packed = await pack(body, WORD, { rels: '<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>' });
  const read = await readDocx(packed, { changes: "accept" });
  const kept = await readDocx(packed);
  const c = read.content.content ?? [];
  check(
    "links: by relationship, by field, and none for a place in the document",
    norm({ type: "doc", content: [c[0]] }) ===
      norm({ type: "doc", content: [p(null, t("See "), t("the site", link("https://example.com/?a=1&b=2")), t(" or "), t("the other", link("https://example.org/x")), t(" or this chapter."))] }),
    JSON.stringify(c[0]),
  );
  check("a field shows its result", texts(read.content)[1] === "Page 4 on 1 May");
  check("a table of contents is one block (its entries are Word's), its heading kept", texts(read.content).slice(2, 4).join("|") === "Contents|In a control and a tag" && c.filter((n) => n.type === "toc").length === 1 && c[3].type === "toc", shape(read.content));
  check("tracked changes read as accepted, when asked", texts(read.content)[4] === "kept inserted moved here");
  const revised = (kept.content.content ?? []).find((n) => n.content?.[0]?.text?.startsWith("kept"))?.content ?? [];
  const said = revised.map((n) => `${(n.marks ?? []).map((m) => (m.type === "insertion" ? "+" : m.type === "deletion" ? "-" : "")).join("")}${n.text}`).join("|");
  check("…and kept as suggestions otherwise: insertions, deletions, and a move as both", said === "kept |+inserted |-deleted |-moved away |+moved here", said);
  check("each under the name the file gives", revised[1]?.marks?.[0].attrs?.a === "x", JSON.stringify(revised[1]?.marks));
  check("which the import says", kept.warnings.includes("tracked changes kept as suggestions (see Changes)"), kept.warnings.join(", "));
  check("a text box's words follow its paragraph, once", texts(read.content).slice(5, 7).join("|") === "Beside the box|In a text box" && texts(read.content).filter((x) => x === "In a text box").length === 1);
  const tbl = c.find((n) => n.type === "table");
  check("a table is a table", texts(read.content).slice(7, 9).join("|") === "cell one|cell two" && tbl?.content?.length === 1 && tbl.content[0].content?.length === 2 && tbl.content[0].content[0].type === "tableCell", JSON.stringify(tbl).slice(0, 200));
  check(
    "what didn't come across is said (a note with no notes part, a text box, tracked changes)",
    read.warnings.join(", ") === "1 footnote skipped, 1 text box flattened, tracked changes accepted",
    read.warnings.join(", "),
  );
}

{
  // Pictures: DrawingML and legacy VML, a linked one, an unsupported kind.
  const drawing = (rid: string) => `<w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="952500"/><wp:docPr id="1" name="p" descr="A chart"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const body =
    wp(drawing("rIdP")) +
    wp(r("Text with a picture ") + `<w:r><w:pict><v:shape style="width:72pt;height:36pt"><v:imagedata r:id="rIdP"/></v:shape></w:pict></w:r>`) +
    wp(drawing("rIdE")) +
    wp(drawing("rIdX"));
  const rel = (id: string, target: string, ext = false) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"${ext ? ' TargetMode="External"' : ""}/>`;
  const read = await readDocx(
    await pack(body, { ...WORD, "word/media/image1.png": PNG, "word/media/chart.emf": new Uint8Array([1, 2, 3]) }, { rels: rel("rIdP", "media/image1.png") + rel("rIdE", "media/chart.emf") + rel("rIdX", "https://example.com/x.png", true) }),
  );
  const c = read.content.content ?? [];
  check("a picture paragraph becomes the picture, sized", c[0].type === "image" && c[0].attrs?.width === 200 && c[0].attrs?.height === 100 && c[0].attrs?.alt === "A chart", JSON.stringify(c[0]));
  check("a picture among text follows its paragraph", c[1].type === "paragraph" && c[2].type === "image" && c[2].attrs?.width === 96 && c[2].attrs?.src === c[0].attrs?.src);
  check("one file, stored once", read.media.length === 1);
  check("pictures that can't be shown are counted", read.warnings.includes("2 pictures skipped") && c.length === 3, `${read.warnings.join(", ")} / ${shape(read.content)}`);
}

{
  // Headers and footers: Word's page-number gallery, tabs, a first page.
  const hdr = (inner: string) => `<?xml version="1.0"?><w:hdr ${W}>${inner}</w:hdr>`;
  const ftr = (inner: string) => `<?xml version="1.0"?><w:ftr ${W}>${inner}</w:ftr>`;
  const fld = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
  const rel = (id: string, kind: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"/>`;
  const read = await readDocx(
    await pack(
      wp(r("Body")),
      {
        ...WORD,
        "word/header1.xml": hdr(wp(`${r("Smith / ")}<w:fldSimple w:instr=" TITLE  \\* MERGEFORMAT "><w:r><w:t>My Book</w:t></w:r></w:fldSimple><w:r><w:tab/></w:r><w:r><w:tab/></w:r>${fld("begin")}<w:r><w:instrText> PAGE </w:instrText></w:r>${fld("separate")}${r("12")}${fld("end")}`)),
        "word/footer1.xml": ftr(`<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Page Numbers (Bottom of Page)"/></w:docPartObj></w:sdtPr><w:sdtContent>${wp(`${fld("begin")}<w:r><w:instrText> PAGE   \\* MERGEFORMAT </w:instrText></w:r>${fld("separate")}${r("2")}${fld("end")}${r(" of ")}<w:fldSimple w:instr="NUMPAGES"/>`, '<w:jc w:val="center"/>')}</w:sdtContent></w:sdt>`),
        "word/footer2.xml": ftr(wp("")),
        "word/settings.xml": `<?xml version="1.0"?><w:settings ${W}><w:mirrorMargins/><w:evenAndOddHeaders w:val="0"/><w:autoHyphenation w:val="true"/></w:settings>`,
      },
      {
        rels: rel("rIdH", "header", "header1.xml") + rel("rIdF", "footer", "footer1.xml") + rel("rIdF1", "footer", "footer2.xml"),
        sect: '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:footerReference w:type="first" r:id="rIdF1"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080" w:header="360" w:footer="432" w:gutter="360"/><w:pgNumType w:fmt="upperRoman" w:start="5"/><w:cols w:num="2" w:space="708"/><w:titlePg/></w:sectPr>',
      },
    ),
  );
  const s = settingsFrom((k) => read.settings[k]);
  check("a header's fields and tab positions", s.hL === "Smith / {title}" && s.hC === "" && s.hR === "{page}", JSON.stringify([s.hL, s.hC, s.hR]));
  check("a centred page number from Word's gallery", s.fC === "{page} of {pages}" && s.fL === "" && s.fR === "", JSON.stringify([s.fL, s.fC, s.fR]));
  check("a different, empty first page", s.hfFirst && s.f1C === "" && !s.hfEven);
  check("paper, margins, columns and numbering", s.pageSize === "a4" && s.landscape && s.mt === 0.5 && s.ml === 0.75 && s.gutter === 0.25 && s.hd === 0.25 && s.fd === 0.3 && s.cols === 2 && s.pnFormat === "I" && s.pnStart === 5, JSON.stringify(s));
  check("document-wide switches", s.mirror && s.hyphenate);
}

{
  // The ISO "strict" namespaces, another prefix, a document part elsewhere.
  const strict = `<?xml version="1.0"?><x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:body><x:p><x:pPr><x:jc x:val="center"/></x:pPr><x:r><x:rPr><x:i/></x:rPr><x:t>Strict &amp; odd &#8212; &#x201C;fine&#x201D;</x:t></x:r></x:p></x:body></x:document>`;
  const zip = new JSZip();
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="/doc/main.xml"/></Relationships>`);
  zip.file("doc/main.xml", strict);
  const read = await readDocx(await zip.generateAsync({ type: "uint8array" }));
  check(
    "strict namespaces, any prefix, any path",
    norm(read.content) === norm({ type: "doc", content: [p({ align: "center" }, t("Strict & odd — “fine”", "italic"))] }),
    JSON.stringify(read.content),
  );
}

{
  // Fonts: the app's own, one installed here, one the online catalog has,
  // and one nobody has — and what the document remembers about them.
  (backend as unknown as Record<string, unknown>).sysfontList = async () => [{ family: "Bembo", styles: ["regular", "italic"], monospace: false }];
  resetFontStore();
  const set = (font: string, text: string) => wp(r(text, `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>`));
  const body = wp(r("Body in the default face.")) + wp(r("More body, so the default wins.")) + set("Lora", "From the catalog.") + set("Bembo", "Installed here.") + set("Mystery Sans", "Nobody has this.") + set("EB Garamond", "The app's own.") + set("bembo", "Named in another case.");
  const read = await readDocx(
    await pack(
      body,
      { ...WORD, "word/fontTable.xml": `<?xml version="1.0"?><w:fonts ${W}><w:font w:name="Mystery Sans"><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font><w:font w:name="Bembo"><w:family w:val="roman"/></w:font></w:fonts>` },
      { rels: '<Relationship Id="rIdFT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' },
    ),
  );
  const used = (read.content.content ?? []).map((n) => n.attrs?.font ?? null);
  check("a Word file's fonts: the catalog's, an installed one, one kept by name, the app's own", used.join("|") === "||gf:lora|sys:Bembo|sys:Mystery Sans|garamond|sys:Bembo", used.join("|"));
  const table = Object.fromEntries(Object.entries(read.fonts).map(([id, v]) => [id, JSON.parse(v) as { n: string; c?: string }]));
  check("the document remembers their names and kinds", table["gf:lora"]?.n === "Lora" && table["gf:lora"]?.c === "serif" && table["sys:Mystery Sans"]?.c === "sans-serif" && table["sys:Bembo"]?.c === "serif" && table.garamond === undefined, JSON.stringify(table));

  const out = await parts(
    (
      await writeDocx(
        { type: "doc", content: [p({ font: "carlito" }, t("Sans")), p({ font: "gf:gelasio" }, t("Serif")), p({ font: "sys:Mystery Sans" }, t("Unknown")), p(null, t("code", "code"))] },
        { title: "Fonts", format: "none", settings: { ...DEFAULT_SETTINGS, bodyFont: "gf:lora" } },
      )
    ).bytes,
  );
  const ft = out["word/fontTable.xml"] ?? "";
  check("an export names its fonts, their kind, and what Word may use instead", ft.includes('<w:font w:name="Carlito"><w:altName w:val="Calibri"/><w:family w:val="swiss"/>') && ft.includes('<w:font w:name="Gelasio"><w:altName w:val="Georgia"/><w:family w:val="roman"/>') && ft.includes('<w:font w:name="Lora">') && ft.includes('<w:font w:name="Mystery Sans"><w:family w:val="auto"/>') && ft.includes('<w:font w:name="Courier New"><w:family w:val="modern"/><w:pitch w:val="fixed"/>'), ft);
  check("…under real family names", out["word/document.xml"].includes('w:ascii="Gelasio"') && out["word/styles.xml"].includes('w:ascii="Lora"'));
  resetFontStore();
}

{
  let code = "";
  try {
    await readDocx(new TextEncoder().encode("not a zip at all"));
  } catch (e) {
    code = (e as { code?: string }).code ?? "threw";
  }
  check("a file that isn't a Word document says so", code === "docx_unreadable", code);
  const empty = new JSZip();
  empty.file("hello.txt", "hi");
  code = "";
  try {
    await readDocx(await empty.generateAsync({ type: "uint8array" }));
  } catch (e) {
    code = (e as { code?: string }).code ?? "threw";
  }
  check("…and so does a zip that isn't one", code === "docx_unreadable", code);
}

// A file written by someone else entirely: macOS's own converter.
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-docx-"));
  const html = path.join(dir, "in.html");
  writeFileSync(
    html,
    `<html><body><h1>Apple heading</h1><p>A paragraph with <b>bold</b>, <i>italic</i> and a <a href="https://example.com/">link</a>.</p><ul><li>First</li><li>Second</li></ul><p style="text-align:center">Centred</p></body></html>`,
  );
  execFileSync("textutil", ["-convert", "docx", html, "-output", path.join(dir, "out.docx")], { stdio: "ignore" });
  const read = await readDocx(readFileSync(path.join(dir, "out.docx")));
  const all = texts(read.content);
  check("macOS's writer: the text arrives", all.join("|") === "Apple heading|A paragraph with bold, italic and a link.|First|Second|Centred", all.join("|"));
  const json = JSON.stringify(read.content);
  check("macOS's writer: marks, and a typed-out list becomes a list", json.includes('"bold"') && json.includes('"italic"') && shape(read.content) === "p p bulletList p", shape(read.content));
  const s = settingsFrom((k) => read.settings[k]);
  check("macOS's writer: body text is what most of the text is", s.bodyFont === "times" && s.bodySize === 12 && JSON.stringify(read.content.content?.[1].attrs ?? {}) === "{}", JSON.stringify([s.bodyFont, s.bodySize, read.content.content?.[1].attrs]));
  const back = await readDocx((await writeDocx(read.content, { title: "x", format: "none", settings: settingsFrom((k) => read.settings[k]) })).bytes);
  check("macOS's writer: read → write → read keeps the text", texts(back.content).join("|") === all.join("|"), `${all.join("|")} ≠ ${texts(back.content).join("|")}`);
} catch (e) {
  console.log(`SKIP  macOS's writer (${(e as Error).message.split("\n")[0]})`);
}

finish();
