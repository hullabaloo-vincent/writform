// Page view, as printed: the layout engine says where each page of the
// document begins, and the editor marks those places on the sheet — in
// the middle of a paragraph, before a list, between two rows of a table.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";

import { DEFAULT_SETTINGS, pageSpecFor } from "../src/apps/documents/docSettings";
import { TypesetSession, type DocRequest, type PageMap } from "../src/book/engine/run";
import type { DisplayList, DLText } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { scriptedAsDocument } from "../src/doclayout/scripted";
import { Paginate, reflowPagination, resolvePageStart, type PageLayoutResult, type PageMapFor } from "../src/editor/Paginate";
import { docContentExtensions } from "../src/editor/schema/content";
import { prng } from "./manuscript";

// (jsdom lays nothing out; the paginator only needs the observer to exist.)
(globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const WORDS = "the of and a to in is that it was for on are as with his they at be this from have or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over river window morning silence letter garden winter harbour station lantern whisper shoulder evening remember beneath against between although perhaps suddenly afterwards understanding extraordinary conversation".split(" ");
const rand = prng(23);
const prose = (words: number): string => {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const s = out.join(" ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
};
const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (attrs: Record<string, unknown> | null, ...content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) });
const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const cell = (text: string): JSONContent => ({ type: "tableCell", content: [p(null, t(text))] });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const session = new TypesetSession();
async function pagesOf(doc: JSONContent, settings = DEFAULT_SETTINGS, virtual = 0): Promise<{ map: PageMap; dl: DisplayList }> {
  const model = buildDocModel(doc, { title: "Pages", settings, ...(virtual ? { virtual } : {}) });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req: DocRequest = { kind: "document", doc: model, families: model.families, images: [] };
  return { map: await session.pageMap(req), dl: (await session.layout(req)).dl };
}
/** The first words set on a page (a list's marker aside). */
const firstWord = (dl: DisplayList, page: number, top = DEFAULT_SETTINGS.mt * 72 - 1): string => {
  const texts = dl.pages[page].items.filter((it): it is DLText => it.t === "text" && it.y > top && it.y < dl.trim.h - 72 + 1).sort((a, b) => a.y - b.y || a.x - b.x);
  const first = texts.find((it) => !/^(?:[•◦▪]|\d+[.)]|[a-z][.)])$/.test(it.text)) ?? texts[0];
  return first.text.split(" ")[0].replace(/[0-9]+$/, "");
};

const content: JSONContent[] = [{ type: "heading", attrs: { level: 1 }, content: [t("Pages, as printed")] }];
for (let i = 0; i < 30; i += 1) {
  if (i % 8 === 3) content.push({ type: "bulletList", content: [item(p(null, t(prose(80)))), item(p(null, t(prose(120))))] });
  else if (i === 17) content.push({ type: "table", content: Array.from({ length: 36 }, (_, r) => ({ type: "tableRow", content: [cell(`Row ${r + 1}`), cell(prose(10))] })) });
  else content.push(p(null, t(prose(90)), t(` ${prose(70)}`, "italic")));
}

let layoutSeen: PageLayoutResult | null = null;
let mapNow: PageMapFor | "pending" | null = null;
let specOn = true;
// (The paginator measures against the sheet the editor sits on.)
const sheet = mountPoint();
sheet.className = "wf-page";
const editor = new Editor({
  element: sheet,
  extensions: [
    ...docContentExtensions(),
    Paginate.configure({
      getSpec: () => (specOn ? pageSpecFor("none", DEFAULT_SETTINGS) : null),
      getMap: () => mapNow,
      onLayout: (result) => {
        layoutSeen = result;
      },
    }),
  ],
  content: { type: "doc", content },
});
const spacers = () => [...editor.view.dom.querySelectorAll<HTMLElement>(".wf-pg-space")];

await wait(200);
check("with no map yet, page view is the simple one: nothing is marked in the text", spacers().length === 0 && layoutSeen !== null);

const { map, dl } = await pagesOf(editor.getJSON());
check("the engine says where every page begins", map.pages === dl.pages.length && map.pages >= 6 && map.starts.every((s) => s !== null), `${map.pages} pages`);
const kinds = map.starts.slice(1).map((s) => resolvePageStart(editor.state.doc, s!)?.kind);
check("pages begin inside paragraphs, before blocks and between a table's rows", kinds.includes("inline") && kinds.includes("row") && kinds.every((k) => k !== undefined), kinds.join(" "));

mapNow = { ...map, doc: editor.state.doc };
reflowPagination(editor);
await wait(250);
const marks = spacers();
check("a spacer is put where each page after the first begins", marks.length === map.pages - 1, `${marks.length} spacers for ${map.pages} pages`);
check("…and the sheet reports the engine's own count of pages", layoutSeen?.pages === map.pages && layoutSeen.bands.length === map.pages - 1, JSON.stringify(layoutSeen && [layoutSeen.pages, layoutSeen.bands.length]));
check("each is sized (never less than the gap between two sheets)", marks.every((el) => parseFloat((el.tagName === "TR" ? (el.firstElementChild as HTMLElement) : el).style.height) >= 40), marks.map((el) => el.style.height).slice(0, 3).join(" "));

// What follows each spacer in the editor is what the printed page begins with.
let wrong = "";
const inOrder = marks
  .map((el) => ({ el, pos: editor.view.posAtDOM(el.parentNode!, [...el.parentNode!.childNodes].indexOf(el)) }))
  .sort((a, b) => a.pos - b.pos);
inOrder.forEach(({ el, pos }, i) => {
  if (wrong) return;
  const word = firstWord(dl, i + 1);
  const doc = editor.state.doc;
  const after = doc.textBetween(pos, Math.min(doc.content.size, pos + 400), " ").trimStart();
  if (!after.startsWith(word)) wrong = `page ${i + 2} begins "${word}…" but its spacer (${el.tagName}) is before "${after.slice(0, 24)}…"`;
});
check("the text after each spacer is what its printed page begins with", wrong === "", wrong);
const inline = marks.filter((el) => el.classList.contains("wf-pg-inline"));
check("a break inside a paragraph is inside that paragraph", inline.length >= 2 && inline.every((el) => !!el.closest("p")) && inline.every((el) => el.previousSibling !== null), String(inline.length));
const rows = marks.filter((el) => el.tagName === "TR");
check("a break in a table is a row of its own between two rows", rows.length >= 1 && rows.every((el) => el.parentElement?.tagName === "TBODY" && el.previousElementSibling?.tagName === "TR"), String(rows.length));
check("nothing was added to the document itself", JSON.stringify(editor.getJSON().content?.length) === JSON.stringify(content.length) && !JSON.stringify(editor.getJSON()).includes("wf-pg"));

// Typing: the marks stay with their text until the engine answers again.
const firstInline = inOrder.find((m) => m.el.classList.contains("wf-pg-inline"))!;
const before = firstInline.pos;
editor.commands.insertContentAt(1, "Typed at the very start. ");
await wait(200);
const moved = editor.view.posAtDOM(firstInline.el.parentNode!, [...firstInline.el.parentNode!.childNodes].indexOf(firstInline.el));
check("typing above moves a spacer along with its text", moved === before + "Typed at the very start. ".length, `${before} → ${moved}`);
const staleSeen = spacers().length;
mapNow = { ...map, doc: editor.state.doc, starts: map.starts.map((s) => (s ? { ...s } : s)) };
// (A map made for the text before the edit: not for this document.)
const stale: PageMapFor = { ...map, doc: null as never };
mapNow = stale;
reflowPagination(editor);
await wait(200);
check("a map made for an earlier text isn't applied", spacers().length === staleSeen && spacers()[0] === marks[0]);
const fresh = await pagesOf(editor.getJSON());
mapNow = { ...fresh.map, doc: editor.state.doc };
reflowPagination(editor);
await wait(250);
check("the next answer moves the breaks to where they now fall", spacers().length === fresh.map.pages - 1 && layoutSeen?.pages === fresh.map.pages, `${spacers().length} / ${fresh.map.pages}`);

// While a first answer is awaited nothing is marked.
{
  let seen: PageLayoutResult | null | undefined;
  const host = mountPoint();
  host.className = "wf-page";
  const waiting = new Editor({
    element: host,
    extensions: [...docContentExtensions(), Paginate.configure({ getSpec: () => pageSpecFor("none", DEFAULT_SETTINGS), getMap: () => "pending", onLayout: (r) => (seen = r) })],
    content: { type: "doc", content },
  });
  await wait(200);
  check("while the first answer is on its way, nothing is marked (the simple view doesn't flash up)", waiting.view.dom.querySelectorAll(".wf-pg-space, .wf-pg-push").length === 0 && !seen);
  waiting.destroy();
}

// Back to the simple view; and off.
mapNow = null;
reflowPagination(editor);
await wait(300);
check("without a map the spacers go (the simple view pushes whole blocks instead)", spacers().length === 0 && layoutSeen !== null);
specOn = false;
reflowPagination(editor);
await wait(200);
check("page view off: nothing marked, nothing reported", spacers().length === 0 && layoutSeen === null);

// A script: its pages are its format's, and a title put in for print isn't in the editor.
{
  const lines: JSONContent[] = Array.from({ length: 150 }, (_, i) => p({ element: i % 3 === 0 ? "character" : "dialogue" }, t(i % 3 === 0 ? `speaker ${i}` : `Line ${i} of the play, spoken aloud.`)));
  const play = scriptedAsDocument({ type: "doc", content: lines }, "stageplay", "A Play");
  const script = await pagesOf(play.doc, play.settings, play.virtual);
  const e = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: lines } });
  const second = script.map.starts[1];
  const at = second ? resolvePageStart(e.state.doc, second) : null;
  const word = firstWord(script.dl, 1, 71);
  check("a play's pages start at places in the editor's own text (the printed title isn't counted)", script.map.pages >= 3 && !!at && e.state.doc.textBetween(at.pos, at.pos + 60, " ").trim().toUpperCase().startsWith(word.toUpperCase()), `${JSON.stringify(second)} ${word} / ${at ? e.state.doc.textBetween(at.pos, at.pos + 30, " ") : ""}`);
}

finish();
