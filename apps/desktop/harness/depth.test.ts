// Run formatting of level 4: capitals and letter spacing as formatting
// (the letters stay as typed). On screen, in print, in Word files, and
// for a server that can't keep them.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import JSZip from "jszip";

import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DLRule, DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";
import { curDepth, setLetterSpacing, toggleCaps } from "../src/editor/marks/RunDepth";
import { docContentExtensions } from "../src/editor/schema/content";
import { downlevelJson } from "../src/editor/schema/downlevel";
import { levels } from "../src/editor/schema/levels";

const t = (text: string, ...marks: JSONContent[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const caps = (v: string): JSONContent => ({ type: "caps", attrs: { v } });
const ls = (pt: number): JSONContent => ({ type: "letterSpacing", attrs: { pt } });
const doc: JSONContent = { type: "doc", content: [p(t("Plain, "), t("Grüße aus Köln", caps("all")), t(" and "), t("Small Words", caps("small"))), p(t("Spread out", ls(2)), t(" close", ls(-0.5)))] };

// ------------------------------------------------------------ in the editor

{
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: doc });
  const html = e.getHTML();
  check("all capitals and small capitals are said on the words, the letters as typed", html.includes('data-caps="all"') && html.includes("Grüße aus Köln") && html.includes('data-caps="small"'));
  check("letter spacing is drawn from its own value", html.includes('data-ls="2"') && html.includes("--wf-ls: 2pt") && html.includes('data-ls="-0.5"'));
  check("they need level 4", levels.ofJson(doc) === 4 && levels.ofJson({ type: "doc", content: [p(t("x"))] }) === 1);
  e.commands.setTextSelection({ from: 1, to: 6 });
  toggleCaps(e, "small");
  check("small capitals are put on the selection", curDepth(e).caps === "small");
  toggleCaps(e, "small");
  check("and taken off again", curDepth(e).caps === null);
  setLetterSpacing(e, 1);
  check("letter spacing on the selection", curDepth(e).ls === 1);
  setLetterSpacing(e, 0);
  check("and back to the font's own", curDepth(e).ls === null);
  check("nothing outside the range is accepted", levels.ofJson(new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: [p(t("x", ls(99)))] } }).getJSON()) === 4);
  e.destroy();
}

// ------------------------------------------------------------ a server that can't keep them

{
  const down = downlevelJson(doc, 3, getSchema(docContentExtensions()));
  const text = JSON.stringify(down);
  check("for level 3, all capitals become capital letters", text.includes("GRÜSSE AUS KÖLN"), text.slice(0, 300));
  check("small capitals and letter spacing go, and the words stay", !text.includes('"caps"') && !text.includes("letterSpacing") && text.includes("Small Words") && text.includes("Spread out"));
}

// ------------------------------------------------------------ in print

{
  const session = new TypesetSession();
  const model = buildDocModel(doc, { title: "Caps", author: "", date: "", settings: { ...DEFAULT_SETTINGS, bodyFont: "mono", bodySize: 12 } });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req: DocRequest = { kind: "document", doc: model, families: model.families, images: [] };
  const { dl } = await session.layout(req);
  const texts = dl.pages.flatMap((pg) => pg.items.filter((it): it is DLText => it.t === "text"));
  const words = texts.map((x) => x.text).join(" ");
  check("all capitals are drawn as capitals, letter for letter (ß as ẞ)", words.includes("GRÜẞE AUS KÖLN"), words);
  const small = texts.find((x) => x.text === "MALL");
  const big = texts.find((x) => x.text === "S" || x.text.startsWith("S"));
  check("small capitals: the small letters drawn as smaller capitals", !words.includes("Small Words") && !!small && !!big && small.size < 12, JSON.stringify(small && [small.text, small.size]));
  const spread = texts.find((x) => x.text.startsWith("Spread"));
  check("letter spacing goes into the letters' spacing", !!spread && Math.abs((spread.cs ?? 0) - 2) < 0.01, JSON.stringify(spread && spread.cs));
}

// ------------------------------------------------------------ in Word files

{
  const written = await writeDocx(doc, { title: "Caps", format: "none" });
  const main = await (await JSZip.loadAsync(written.bytes)).file("word/document.xml")!.async("string");
  check("Word gets its own capitals and spacing", main.includes("<w:caps/>") && main.includes("<w:smallCaps/>") && main.includes('<w:spacing w:val="40"/>') && main.includes('<w:spacing w:val="-10"/>'));
  check("and the letters as typed", main.includes("Grüße aus Köln"));
  const read = await readDocx(written.bytes);
  const back = JSON.stringify(read.content);
  check("read back: capitals as formatting, the letters as typed", back.includes('"text":"Grüße aus Köln","marks":[{"type":"caps","attrs":{"v":"all"}}]') && back.includes('{"type":"caps","attrs":{"v":"small"}}'), back.slice(0, 400));
  check("and the spacing", back.includes('"letterSpacing","attrs":{"pt":2}') && back.includes('"letterSpacing","attrs":{"pt":-0.5}'));
}

// ------------------------------------------------------------ underline styles, a double line through

{
  const ul = (attrs: Record<string, unknown> | null): JSONContent => (attrs ? { type: "underline", attrs } : { type: "underline" });
  const lines: JSONContent = {
    type: "doc",
    content: [
      p(t("plain", ul(null))),
      p(t("double", ul({ kind: "double", c: "#c00000" }))),
      p(t("dotted", ul({ kind: "dotted" }))),
      p(t("wavy", ul({ kind: "wavy" }))),
      p(t("struck", { type: "strike", attrs: { dbl: true } })),
      p(t("once", { type: "strike" })),
    ],
  };
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: lines });
  const html = e.getHTML();
  check("an underline's kind and colour are said on it", html.includes('data-ul="double"') && html.includes('data-ulc="#c00000"') && html.includes('data-ul="wavy"'));
  check("a double line through is said on it", html.includes('data-dbl="1"'));
  const plainOnly = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: [p(t("plain", ul(null)), t(" "), t("struck", { type: "strike" }))] } });
  check("a plain underline and line through, as this build writes them, stay level 1", levels.ofJson(plainOnly.getJSON()) === 1 && JSON.stringify(plainOnly.getJSON()).includes('"kind":null'));
  check("one with a kind of its own needs level 4", levels.ofJson(e.getJSON()) === 4);
  e.destroy();
  plainOnly.destroy();

  const down = JSON.stringify(downlevelJson(lines, 3, getSchema(docContentExtensions())));
  check("for level 3 an underline is a single one, and a line through is once", !down.includes('"kind"') && !down.includes('"dbl"') && down.includes('"underline"') && down.includes('"strike"'));

  const session = new TypesetSession();
  const model = buildDocModel(lines, { title: "Lines", author: "", date: "", settings: { ...DEFAULT_SETTINGS, bodyFont: "mono", bodySize: 12 } });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const { dl } = await session.layout({ kind: "document", doc: model, families: model.families, images: [] } as DocRequest);
  const rules = dl.pages.flatMap((pg) => pg.items.filter((it): it is DLRule => it.t === "rule"));
  const texts = dl.pages.flatMap((pg) => pg.items.filter((it): it is DLText => it.t === "text"));
  const under = (word: string) => {
    const at = texts.find((x) => x.text === word);
    return at ? rules.filter((r) => r.x1 <= at.x + 0.5 && r.x2 >= at.x + 6 && Math.abs(r.y1 - at.y) < 12) : [];
  };
  check("a double underline is two lines, in its own colour", under("double").filter((r) => r.y1 > texts.find((x) => x.text === "double")!.y).length === 2 && under("double").every((r) => r.color === "#c00000"), JSON.stringify(under("double")));
  check("a dotted one is drawn in dots", under("dotted").some((r) => r.dash && r.dash[0] < r.dash[1]));
  check("a wavy one as a wave", under("wavy").some((r) => (r.wave ?? 0) > 0));
  check("a plain one is one line", under("plain").length === 1);
  check("a double line through is two lines through the letters", under("struck").length === 2 && under("once").length === 1, JSON.stringify([under("struck").length, under("once").length]));

  const written = await writeDocx(lines, { title: "Lines", format: "none" });
  const main = await (await JSZip.loadAsync(written.bytes)).file("word/document.xml")!.async("string");
  check("Word gets its own underlines and its double line through", main.includes('<w:u w:val="double" w:color="C00000"/>') || main.includes('<w:u w:val="double" w:color="c00000"/>') ? main.includes('<w:u w:val="dotted"/>') && main.includes('<w:u w:val="wave"/>') && main.includes("<w:dstrike/>") && main.includes('<w:u w:val="single"/>') : false, main.slice(main.indexOf("<w:u "), main.indexOf("<w:u ") + 120));
  const back = JSON.stringify((await readDocx(written.bytes)).content);
  check("read back as they were", back.includes('"underline","attrs":{"kind":"double","c":"#c00000"}') && back.includes('"kind":"dotted"') && back.includes('"kind":"wavy"') && back.includes('"strike","attrs":{"dbl":true}'), back.slice(0, 600));
}

finish();
