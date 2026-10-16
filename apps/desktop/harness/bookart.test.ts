// A book's own pictures for its pages: a scene break that is a picture
// (or characters of the writer's own), kept apart from the design so a
// preset leaves it, laid out to its height, in the EPUB, on screen, and
// left behind where a cover is.

import { check, finish } from "./env";

import { strFromU8, unzipSync } from "fflate";
import * as Y from "yjs";

import { manuscriptVars } from "../src/apps/documents/shell/hooks";
import { Editor } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { mountPoint } from "./dom";
import { chapterArtSource } from "../src/book/editor/chapterArt";
import { ChapterArtSection } from "../src/book/ui/ChapterArt";
import { docContentExtensions } from "../src/editor/schema/content";
import { presetDesign } from "../src/book/model/presets";
import { packSource, unpackSource } from "../src/apps/documents/sourceCopy";
import { familiesFor } from "../src/book/engine/client";
import { TypesetSession, type JobImage, type LayoutRequest } from "../src/book/engine/run";
import type { DisplayList, DLImage, DLText } from "../src/book/engine/types";
import { buildEpub } from "../src/book/epub/epub";
import { loadFontFiles } from "../src/book/fonts/files";
import { bookArtUrls, choosePreset, readBook, updateBook } from "../src/book/model/bookMap";
import { buildModel } from "../src/book/model/buildModel";
import { DOC_SCHEMA_LEVEL } from "../src/editor/schema/levels";
import { manuscript } from "./manuscript";
import { GRAY_JPEG, png } from "./pix";
import { pdfxProblems } from "./pdfa";
import { keptPicture, sniff, type PdfPicture } from "../src/book/engine/pictures";

const ART = "writform-att://attachment/7";
const doc = manuscript();

const bookWith = (patch: Record<string, unknown>) => {
  const ydoc = new Y.Doc();
  updateBook(ydoc, { "meta.title": "Fangs", "meta.author": "A. N. Author", ...patch });
  return { ydoc, book: readBook(ydoc) };
};

// ------------------------------------------------------------ the settings

{
  const plain = readBook(new Y.Doc());
  check("a book starts with no pictures of its own", plain.art.ornament === null && plain.design.ornamentSize === 18);
  const { ydoc, book } = bookWith({ "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}`, "design.ornamentSize": 30 });
  check("a picture scene break is read with its size", book.design.sceneBreak === "picture" && book.art.ornament?.src === ART && book.art.ornament.w === 600 && book.design.ornamentSize === 30);
  check("its address is one the typesetter fetches", bookArtUrls(book).join() === ART);
  check("an address that isn't the app's own is no picture", bookWith({ "art.ornament": "600x200 https://example.com/fang.png" }).book.art.ornament === null);
  check("a size is held between 9 and 72 points", bookWith({ "design.ornamentSize": 400 }).book.design.ornamentSize === 72);
  check("a style nobody knows is the preset's (as an older app reads “picture”)", bookWith({ "design.sceneBreak": "sparkle" }).book.design.sceneBreak === "ornament");
  check("with a typed ornament chosen the picture isn't fetched", bookArtUrls(bookWith({ "art.ornament": `600x200 ${ART}` }).book).length === 0);
  choosePreset(ydoc, "fantasy");
  const after = readBook(ydoc);
  check("choosing another preset leaves the picture where it is", after.art.ornament?.src === ART && after.design.sceneBreak === "ornament");
}

// ------------------------------------------------------------ the pages

const session = new TypesetSession();
async function pages(patch: Record<string, unknown>, images: JobImage[]): Promise<DisplayList> {
  const { book } = bookWith(patch);
  const model = buildModel(doc as never, "manuscript", book);
  const families = familiesFor("paperback", model);
  session.addFonts(await loadFontFiles(session.missingFamilies(families)));
  const req: LayoutRequest = { kind: "paperback", model, families, images, now: Date.UTC(2026, 9, 14) };
  return (await session.layout(req)).dl;
}
const art = (dl: DisplayList) => dl.pages.flatMap((p) => p.items.filter((it): it is DLImage => it.t === "image" && it.ref === ART));

{
  const sized: JobImage[] = [{ url: ART, w: 600, h: 200 }];
  const dl = await pages({ "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}` }, sized);
  const drawn = art(dl);
  const scenes = buildModel(doc as never, "manuscript", bookWith({}).book).sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === "scene").length, 0);
  check("every scene break is the picture", scenes > 0 && drawn.length === scenes, `${drawn.length} of ${scenes}`);
  check("18 points tall, as wide as its proportions say", drawn.every((it) => Math.abs(it.h - 18) < 0.01 && Math.abs(it.w - 54) < 0.01));
  const page = dl.pages.find((p) => p.items.some((it) => it.t === "image"))!;
  const it = page.items.find((x): x is DLImage => x.t === "image")!;
  const texts = page.items.filter((x): x is DLText => x.t === "text");
  const left = Math.min(...texts.map((x) => x.x));
  const right = Math.max(...texts.map((x) => x.x + (x.w ?? 0)));
  check("centred on the text", Math.abs(it.x + it.w / 2 - (left + right) / 2) < 30, `${it.x + it.w / 2} ${(left + right) / 2}`);
  check("no ornament is typed where a picture is", !dl.pages.some((p) => p.items.some((x) => x.t === "text" && (x as DLText).text === "⁂")));

  const big = art(await pages({ "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}`, "design.ornamentSize": 36 }, sized));
  check("a larger size prints larger", big.every((x) => Math.abs(x.h - 36) < 0.01));
  const wide = art(await pages({ "design.sceneBreak": "picture", "art.ornament": `5000x100 ${ART}`, "design.ornamentSize": 36 }, [{ url: ART, w: 5000, h: 100 }]));
  check("never wider than the text", wide.length > 0 && wide.every((x) => x.w < 6 * 72 && Math.abs(x.w / x.h - 50) < 0.01));

  const unread = await pages({ "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}` }, []);
  check("a picture that couldn't be read: the typed ornament, and a warning", art(unread).length === 0 && unread.pages.some((p) => p.items.some((x) => x.t === "text" && (x as DLText).text === "⁂")) && unread.warnings.some((w) => w.kind === "image"));

  const own = await pages({ "design.ornament": "†" }, []);
  check("characters of the writer's own print when the body font has them", own.pages.some((p) => p.items.some((x) => x.t === "text" && (x as DLText).text === "†")) && !own.warnings.some((w) => w.kind === "missing-glyphs"));
  const none = await pages({ "design.ornament": "\u{1F9DB}" }, []);
  check("and asterisks, with a warning, when no font has them", none.warnings.some((w) => w.kind === "missing-glyphs"));
}

// ------------------------------------------------------------ under each chapter's title

{
  const sized: JobImage[] = [{ url: ART, w: 600, h: 200 }];
  const chapters = buildModel(doc as never, "manuscript", bookWith({}).book).sections.filter((x) => x.kind === "chapter").length;
  const openers = (dl: DisplayList) => dl.pages.filter((p) => p.role === "opener");
  const typed = (dl: DisplayList, mark: string) => openers(dl).filter((p) => p.items.some((x) => x.t === "text" && (x as DLText).text === mark)).length;

  const plain = await pages({}, []);
  check("nothing under a title unless the design says so", typed(plain, "†") === 0);
  const own = await pages({ "design.headingOrnament": "†" }, []);
  check("characters of its own under each title", typed(own, "†") === chapters, `${typed(own, "†")} of ${chapters}`);
  const scene = await pages({ "design.headingMark": "scene", "design.ornament": "†" }, []);
  check("the same as the scene breaks: their characters", typed(scene, "†") === chapters);
  const pictured = await pages({ "design.headingMark": "scene", "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}` }, sized);
  const under = openers(pictured).filter((p) => p.items.some((x) => x.t === "image" && (x as DLImage).ref === ART && (x as DLImage).y < 300)).length;
  check("…their picture, under each title", under === chapters, `${under} of ${chapters}`);
  const blank = await pages({ "design.headingMark": "scene", "design.sceneBreak": "blank", "design.headingOrnament": "†" }, []);
  check("…and nothing when the scene breaks are blank lines", typed(blank, "†") === 0);
  check("an app older than this reads the characters", bookWith({ "design.headingMark": "sparkle" }).book.design.headingMark === "own");
  const { book } = bookWith({ "design.headingMark": "scene", "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}` });
  const epub = await buildEpub(buildModel(doc as never, "manuscript", book), { uuid: "00000000-0000-4000-8000-000000000000", images: new Map([[ART, { bytes: png(60, 20, () => [120, 0, 0, 255]), type: "image/png" }]]), now: new Date(Date.UTC(2026, 9, 14)) });
  const text = Object.values(unzipSync(epub)).map((f) => strFromU8(f, true)).join("\n");
  check("the ebook's chapters have it too", /<p class="ornament"><img src="\.\.\/images\/img-1\.png" alt=""\/><\/p>/.test(text));
}

// ------------------------------------------------------------ the ebook, the screen

{
  const { book } = bookWith({ "design.sceneBreak": "picture", "art.ornament": `600x200 ${ART}` });
  const model = buildModel(doc as never, "manuscript", book);
  const bytes = png(60, 20, () => [120, 0, 0, 255]);
  const epub = await buildEpub(model, { uuid: "00000000-0000-4000-8000-000000000000", images: new Map([[ART, { bytes, type: "image/png" }]]), now: new Date(Date.UTC(2026, 9, 14)) });
  const all = (bytes: Uint8Array) => Object.values(unzipSync(bytes)).map((f) => strFromU8(f, true)).join("\n");
  const text = all(epub);
  check("the ebook's scene breaks are the picture", /<p class="scene-break" role="separator" aria-label="Scene break"><img src="\.\.\/images\/img-1\.png" alt=""\/><\/p>/.test(text));
  check("with its height beside the text", /\.scene-break img, \.ornament img \{ height: 1\.64em;/.test(text));
  const typed = await buildEpub(buildModel(doc as never, "manuscript", bookWith({}).book), { uuid: "00000000-0000-4000-8000-000000000000", now: new Date(Date.UTC(2026, 9, 14)) });
  check("a book without one writes no rule for it", !all(typed).includes(".scene-break img"));

  const vars = manuscriptVars(book);
  check("on screen the picture is drawn in place of the ornament", vars["--wfb-ornament"] === '""' && (vars["--wfb-ornament-img"] ?? "").startsWith("url(") && vars["--wfb-ornament-h"] === "1.64em");
  check("and a typed one as before", manuscriptVars(bookWith({}).book)["--wfb-ornament"] === JSON.stringify("⁂") && !("--wfb-ornament-img" in manuscriptVars(bookWith({}).book)));
}

// ------------------------------------------------------------ left behind

{
  const maps = { book: { "meta.title": "Fangs", "art.ornament": `600x200 ${ART}`, "cover.front": `600x900 ${ART}`, "design.sceneBreak": "picture" } };
  const { bytes } = await packSource({ title: "Fangs", format: "manuscript", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi." }] }] }, maps }, async () => null);
  const copy = unpackSource(bytes, DOC_SCHEMA_LEVEL);
  const kept = copy.maps.book as Record<string, unknown>;
  check("the copy inside a PDF leaves the book's pictures behind, as it does the cover", !("art.ornament" in kept) && !("cover.front" in kept) && kept["design.sceneBreak"] === "picture");
}

// ------------------------------------------------------------ chapter art

{
  const OPEN = "writform-att://attachment/21";
  const FACE = "writform-att://attachment/22";
  const OWN = "writform-att://attachment/23";
  type N = { type: string; attrs?: Record<string, unknown>; content?: N[] };
  const book3 = manuscript({ chapters: 4 }) as N;
  const headings = (book3.content ?? []).filter((n) => n.attrs?.element === "chapter_heading");
  // The second chapter has no picture behind it. The third has its own.
  headings[1].attrs = { ...headings[1].attrs, art: "none" };
  headings[2].attrs = { ...headings[2].attrs, art: `400x600 ${OWN}` };
  const ydoc = new Y.Doc();
  updateBook(ydoc, { "meta.title": "Fangs", "art.opener": `400x600 ${OPEN}`, "art.facing": `400x600 ${FACE}`, "design.openerInk": "light" });
  const book = readBook(ydoc);
  check("the book's chapter art and its ink are read", book.art.opener?.src === OPEN && book.art.facing?.src === FACE && book.design.openerInk === "light");
  const model = buildModel(book3 as never, "manuscript", book);
  const chapters = model.sections.filter((x) => x.kind === "chapter");
  check("each chapter takes the book's art unless its heading says otherwise", chapters.length === 4 && chapters[0].art?.opener === OPEN && chapters[1].art?.opener === null && chapters[1].art?.facing === FACE && chapters[2].art?.opener === OWN && chapters[3].art?.opener === OPEN);
  check("a section that isn't a chapter has none", model.sections.filter((x) => x.kind !== "chapter").every((x) => !x.art));

  const families = familiesFor("paperback", model);
  session.addFonts(await loadFontFiles(session.missingFamilies(families)));
  const sizes: JobImage[] = [OPEN, FACE, OWN].map((url) => ({ url, w: 1800, h: 2700 }));
  const request = (press?: LayoutRequest["press"], images = sizes): LayoutRequest => ({ kind: "paperback", model, families, images, now: Date.UTC(2026, 9, 14), ...(press ? { press } : {}) });
  const { dl } = await session.layout(request());
  const w = dl.trim.w;
  const h = dl.trim.h;
  const behind = (pg: DisplayList["pages"][number]) => (pg.items[0]?.t === "image" ? (pg.items[0] as DLImage) : null);
  const withArt = dl.pages.filter((pg) => pg.role === "opener" && behind(pg));
  check("three chapters open on a picture, the one that said none doesn't", withArt.length === 3 && withArt.map((pg) => behind(pg)!.ref).join() === [OPEN, OWN, OPEN].join(), withArt.map((pg) => behind(pg)!.ref).join());
  check("the picture is behind everything on the page", withArt.every((pg) => pg.items.slice(1).every((it) => it.t !== "image")));
  check("it fills the page and the bleed past its top, foot and outside edge", withArt.every((pg) => {
    const im = behind(pg)!;
    const outside = pg.side === "recto" ? im.x + im.w >= w + 9 - 0.01 && im.x <= 0.01 : im.x <= -9 + 0.01 && im.x + im.w >= w - 0.01;
    return outside && im.y <= -9 + 0.01 && im.y + im.h >= h + 9 - 0.01 && Math.abs(im.w / im.h - 1800 / 2700) < 0.001;
  }));
  check("each chapter opens on a right-hand page", withArt.every((pg) => pg.side === "recto"));
  const arts = dl.pages.filter((pg) => pg.role === "art");
  check("facing each, a left-hand page with the facing picture and nothing else", arts.length === 4 && arts.every((pg) => pg.side === "verso" && pg.items.length === 1 && behind(pg)?.ref === FACE && pg.folio === null));
  check("the page after a facing picture is its chapter's first", arts.every((pg) => dl.pages[pg.n]?.role === "opener"));
  const texts = (pg: DisplayList["pages"][number]) => pg.items.filter((it): it is DLText => it.t === "text");
  check("the text on a picture is light", withArt.every((pg) => texts(pg).length > 0 && texts(pg).every((t) => t.color === "#ffffff")));
  check("and everywhere else as it always was", dl.pages.filter((pg) => !behind(pg)).every((pg) => texts(pg).every((t) => t.color === undefined)));

  const plain = await pages({}, []);
  check("a book without art has no art pages and no pictures behind", !plain.pages.some((pg) => pg.role === "art" || behind(pg)));

  const pressed = (await session.layout(request({ x1a: true, bleed: true }))).dl;
  check("the pages are set the same whatever the press asks for", JSON.stringify(pressed) === JSON.stringify(dl));

  const unread = (await session.layout(request(undefined, []))).dl;
  check("art that couldn't be read: no picture, the chapter as before, and a warning", !unread.pages.some((pg) => pg.role === "art" || behind(pg)) && unread.warnings.some((x) => x.kind === "image" && x.message.includes("couldn’t be read")));
  const small = (await session.layout(request(undefined, [OPEN, FACE, OWN].map((url) => ({ url, w: 300, h: 450 }))))).dl;
  check("art with too few pixels for the page is warned of", small.warnings.some((x) => x.kind === "image" && /prints at \d+ pixels an inch/.test(x.message)));

  // In print: black ink only, white text as no ink at all.
  const grey = keptPicture(GRAY_JPEG, sniff(GRAY_JPEG)!, false);
  const from = async (want: { url: string }[]) => new Map(want.map((x) => [x.url, grey] as [string, PdfPicture]));
  const x1a = (await session.pdf(request({ x1a: true, bleed: true }), () => {}, from)).bytes;
  const problems = pdfxProblems(x1a);
  check("a PDF/X-1a with chapter art and light text keeps the standard", problems.length === 0, problems.join(" | "));
  const latin = Buffer.from(x1a).toString("latin1");
  check("the art goes into the file once each", (latin.match(/\/Subtype \/Image/g) ?? []).length === 3);
}

// ------------------------------------------------------------ chapter art in the app

{
  const OPEN = "writform-att://attachment/31";
  const FACE = "writform-att://attachment/32";
  const ydoc = new Y.Doc();
  updateBook(ydoc, { "meta.title": "Fangs", "art.opener": `400x600 ${OPEN}`, "art.facing": `400x600 ${FACE}` });
  const book = readBook(ydoc);
  const model = buildModel(manuscript({ chapters: 2 }) as never, "manuscript", book);
  const jpeg = { bytes: GRAY_JPEG, type: "image/jpeg" };
  const epub = await buildEpub(model, { uuid: "00000000-0000-4000-8000-000000000000", images: new Map([[OPEN, jpeg], [FACE, jpeg]]), now: new Date(Date.UTC(2026, 9, 14)) });
  const files = unzipSync(epub);
  const chapter = Object.entries(files).filter(([name]) => /text\/ch-/.test(name)).map(([, f]) => strFromU8(f, true)).find((x) => x.includes("art-page")) ?? "";
  check("in the ebook a chapter's art comes first, a page for each picture: facing, then behind", /<div class="art-page"><img src="\.\.\/images\/img-1\.jpg" alt=""\/><\/div>\n<div class="art-page"><img src="\.\.\/images\/img-2\.jpg" alt=""\/><\/div>\n<section/.test(chapter), chapter.slice(0, 300));
  const css = strFromU8(files["OEBPS/styles/book.css"], true);
  check("each picture page stands alone", css.includes(".art-page { margin: 0; text-align: center; text-indent: 0; page-break-after: always; break-after: page; }"));

  // The list in Book ▸ Design, and setting one chapter's own.
  type N = { type: string; attrs?: Record<string, unknown>; content?: N[] };
  const text = manuscript({ chapters: 3 }) as N;
  const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: text as never });
  const source = chapterArtSource(editor, presetDesign("classic"), 4);
  check("the chapters are listed, each as the book has it", source.rows.length === 3 && source.rows.every((r) => r.art === null && r.facing === null) && source.rows[0].name.length > 0);
  source.set(source.rows[1].pos, "art", "none");
  source.set(source.rows[2].pos, "artFacing", `400x600 ${OPEN}`);
  const again = chapterArtSource(editor, presetDesign("classic"), 4);
  check("one chapter can have none, and another its own", again.rows[1].art === "none" && again.rows[2].facing === `400x600 ${OPEN}` && again.rows[0].art === null);
  const before = JSON.stringify(editor.getJSON());
  source.set(source.rows[0].pos + 1, "art", "none");
  check("a place that isn't a chapter's heading any more is left alone", JSON.stringify(editor.getJSON()) === before);
  const rebuilt = buildModel(editor.getJSON(), "manuscript", book).sections.filter((x) => x.kind === "chapter");
  check("and the book then follows each chapter's choice", rebuilt[0].art?.opener === OPEN && rebuilt[1].art?.opener === null && rebuilt[2].art?.facing === OPEN);

  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(ChapterArtSection, { book, disabled: false, patch: () => {}, pictures: { upload: async () => "", limit: 1 }, chapters: again })));
  check("Book ▸ Design shows the book's two pictures and only the chapters that differ", host.querySelectorAll(".wf-cover-slot").length === 2 && host.querySelectorAll(".wf-chapter-art-row:not(.head)").length === 2 && (host.textContent ?? "").includes("2 of 3 chapters have a choice of their own"));
  check("each listed chapter says what it has", [...host.querySelectorAll(".wf-chapter-art-pick")].map((b) => b.textContent).join("|") === "None|The book’s|The book’s|Its own", [...host.querySelectorAll(".wf-chapter-art-pick")].map((b) => b.textContent).join("|"));
  // The others are a choice away, in one picker however many there are.
  const picker = host.querySelector(".wf-chapter-art-list select") as HTMLSelectElement;
  check("the rest wait in a picker", !!picker && picker.options.length === 2 && picker.options[1].textContent === again.rows[0].name);
  await act(async () => {
    picker.value = String(again.rows[0].pos);
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  check("a chapter picked joins the list, the book's for now", host.querySelectorAll(".wf-chapter-art-row:not(.head)").length === 3 && !host.querySelector(".wf-chapter-art-list select"));
  // A hundred chapters, none different: a line and a picker, no rows.
  const many = { ...again, rows: Array.from({ length: 100 }, (_, i) => ({ pos: i * 10, name: `Chapter ${i + 1}`, art: null, facing: null })) };
  await act(async () => root.render(createElement(ChapterArtSection, { book, disabled: false, patch: () => {}, chapters: many })));
  check("a hundred chapters take no room until one differs", host.querySelectorAll(".wf-chapter-art-row").length === 0 && (host.querySelector(".wf-chapter-art-list select") as HTMLSelectElement).options.length === 101 && (host.textContent ?? "").includes("Every chapter uses the pictures above"));
  await act(async () => root.render(createElement(ChapterArtSection, { book, disabled: false, patch: () => {}, chapters: { ...again, level: 3 } })));
  check("a server that can't keep a chapter's own art: no list, and a line saying why", !host.querySelector(".wf-chapter-art-list") && (host.textContent ?? "").includes("needs this server updated"));
  await act(async () => root.unmount());
  editor.destroy();
}

finish();
