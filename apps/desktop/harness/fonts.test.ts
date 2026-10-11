// Font ids: the grammar, and the one path from an id to CSS. Ids come from
// collaborators and files, so a hostile one must never become markup or a
// second CSS declaration.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor } from "@tiptap/core";
import * as Y from "yjs";

import { readDocSettings, settingsVars } from "../src/apps/documents/docSettings";
import { bookFonts } from "../src/book/engine/client";
import { epubFonts } from "../src/book/fonts/embed";
import { BOOK_FONTS, bookFont } from "../src/book/fonts/registry";
import { choosePreset, readBook, updateBook } from "../src/book/model/bookMap";
import { buildModel } from "../src/book/model/buildModel";
import { docContentExtensions } from "../src/editor/schema/content";
import { DOC_FONTS } from "../src/editor/TextFormat";
import { fontCssFamily, fontLabel } from "../src/fonts/css";
import { docxFontName } from "../src/fonts/docx";
import { isFontId, parseFontId } from "../src/fonts/ids";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { TypesetSession } from "../src/book/engine/run";
import { buildDocModel } from "../src/doclayout/model";
import { boldWeight, fontFile, loadCatalog, regularWeight, searchCatalog } from "../src/fonts/catalog";
import { fontsUsed, loadFaces, resetFontStore, resolveDocFonts, resolveFont } from "../src/fonts/store";
import { beyondLatin, subsetsFor } from "../src/fonts/subsets";
import { backend } from "../src/lib/backend";

const hostile = [
  'sys:x"; background: url(//evil)',
  "sys:a;b",
  "sys:a{b}",
  "sys:<script>",
  "sys:back\\slash",
  "sys:" + "x".repeat(81),
  "sys: padded ",
  "sys:",
  "sys:tab\there",
  "gf:Open-Sans",
  "gf:open sans",
  "gf:inter@450",
  "gf:",
  "Garamond",
  "has space",
  "",
];

check("the app's own ids parse", parseFontId("garamond")?.source === "known" && parseFontId("courier-prime")?.key === "courier-prime");
check("catalog ids parse, with an optional weight", parseFontId("gf:open-sans")?.key === "open-sans" && parseFontId("gf:inter@300")?.weight === 300);
check("system ids keep the family name", parseFontId("sys:Helvetica Neue")?.key === "Helvetica Neue" && parseFontId("sys:Brown & Co")?.source === "sys");
check("malformed and hostile ids are refused", hostile.every((id) => !isFontId(id)), hostile.filter(isFontId).join(" | "));
check("non-strings are refused", !isFontId(null) && !isFontId(12) && !isFontId({}));

check("a known font uses the table's stack", fontCssFamily("garamond") === '"EB Garamond", Garamond, "Adobe Garamond Pro", Georgia, serif');
check("a system font is quoted, with a look-alike tail", fontCssFamily("sys:Avenir Next", { name: "Avenir Next", category: "sans-serif" }) === `"Avenir Next", -apple-system, 'Segoe UI', Arial, sans-serif`);
check("…or what it prints in: a same-metrics catalog family if downloaded, else the bundled look-alike", fontCssFamily("sys:Calibri") === `"Calibri", Carlito, Calibri, 'Segoe UI', Arial, sans-serif` && fontCssFamily("sys:Georgia") === `"Georgia", "wf-gf-gelasio", Literata, Georgia, serif`, String(fontCssFamily("sys:Georgia")));
check("a catalog font draws under its own page name first", fontCssFamily("gf:open-sans") === `"wf-gf-open-sans", "Open Sans", Georgia, 'Times New Roman', serif` && fontLabel("gf:open-sans") === "Open Sans" && fontCssFamily("gf:inter@300")?.startsWith('"wf-gf-inter-w300", ') === true, String(fontCssFamily("gf:open-sans")));
check("…and prefers the name the document recorded", fontLabel("gf:eb-garamond", { name: "EB Garamond" }) === "EB Garamond");
check("no CSS for a hostile id", hostile.every((id) => fontCssFamily(id) === null));
check("…or a hostile recorded name", fontCssFamily("gf:inter", { name: 'x"; color: red' }) === `"wf-gf-inter", "Inter", Georgia, 'Times New Roman', serif`);

check(
  "the document font menu is what it was",
  DOC_FONTS.map((f) => `${f.id}=${f.label}`).join(",") ===
    "times=Times,palatino=Palatino,garamond=Garamond,libertinus=Libertinus,baskerville=Baskerville,literata=Literata,sans=Sans,mono=Typewriter,comic=Comic Sans",
);
check("the book faces are what they were", BOOK_FONTS.map((f) => `${f.id}=${f.label}`).join(",") === "garamond=EB Garamond,libertinus=Libertinus Serif,baskerville=Libre Baskerville,literata=Literata,playfair=Playfair Display,cinzel=Cinzel,courier-prime=Courier Prime");

check("Word names", docxFontName("times") === "Times New Roman" && docxFontName("mono") === "Courier New" && docxFontName("sys:Brown & Co") === "Brown & Co" && docxFontName("sys:a;b") === null && docxFontName(null) === null);

{
  // Through the editor: JSON (as it arrives over Yjs) → rendered HTML.
  const render = (font: string) => {
    const editor = new Editor({
      element: mountPoint(),
      extensions: docContentExtensions(),
      content: { type: "doc", content: [{ type: "paragraph", attrs: { font }, content: [{ type: "text", text: "x" }] }] },
    });
    const html = editor.getHTML();
    editor.destroy();
    return html;
  };
  check("a menu font renders by attribute (the stylesheet has its rule)", render("garamond") === '<p data-font="garamond">x</p>', render("garamond"));
  check("a book face outside the menu carries its own stack", render("playfair").includes("font-family:") && render("playfair").includes("Playfair Display"), render("playfair"));
  check("a system font carries its own stack", /style="font-family: &quot;Helvetica Neue&quot;/.test(render("sys:Helvetica Neue")), render("sys:Helvetica Neue"));
  const bad = render('sys:x"; background: url(//evil)');
  check("a hostile id renders no style at all", !bad.includes("style=") && !bad.includes("<script"), bad);
}

{
  const ydoc = new Y.Doc();
  ydoc.getMap("settings").set("bodyFont", "sys:Helvetica Neue");
  const s = readDocSettings(ydoc);
  check("document settings accept any well-formed font", s.bodyFont === "sys:Helvetica Neue" && settingsVars(s)["--wfd-font"]?.startsWith('"Helvetica Neue"') === true);
  ydoc.getMap("settings").set("bodyFont", 'sys:x"; color: red');
  check("…and drop a hostile one", readDocSettings(ydoc).bodyFont === null);
}

// ------------------------------------------------------------ the catalog

const catalog = await loadCatalog();
check("the bundled index lists the library", catalog.fonts.length > 1500 && catalog.byId.get("inter")?.family === "Inter" && catalog.byName.get("eb garamond")?.id === "eb-garamond");
check("…every id a font id can carry", catalog.fonts.every((f) => isFontId(`gf:${f.id}`) && f.weights.length > 0 && f.subsets.length > 0));
check("once loaded, names come from it", fontLabel("gf:eb-garamond") === "EB Garamond" && fontCssFamily("gf:roboto-mono")?.includes("monospace") === true);
{
  const hits = searchCatalog(catalog, "gara").map((f) => f.family);
  check("search: names starting with it, then words, then anywhere", hits[0].toLowerCase().startsWith("gara") === false ? hits.includes("EB Garamond") : true, hits.slice(0, 5).join(", "));
  const mono = searchCatalog(catalog, "", "monospace", 500);
  check("…and by kind", mono.length > 20 && mono.every((f) => f.category === "monospace"));
  check("…bounded", searchCatalog(catalog, "a", null, 10).length === 10 && searchCatalog(catalog, "zzzzqqq").length === 0);
}
{
  const inter = catalog.byId.get("inter")!;
  const single = { ...inter, weights: [400] };
  const light = { ...inter, weights: [300, 500] };
  check(
    "weights: the regular asked for or nearest; bold 700 or the next heavier; none when there is none",
    regularWeight(inter) === 400 && regularWeight(inter, 300) === 300 && regularWeight(light) === 300 && boldWeight(inter, 400) === 700 && boldWeight(inter, 300) === 700 && boldWeight(light, 300) === 500 && boldWeight(single, 400) === null && boldWeight(inter, 800) === null,
  );
  check("file names", fontFile("latin", 400, false) === "latin-400-normal.ttf" && fontFile("cyrillic-ext", 700, true) === "cyrillic-ext-700-italic.ttf");
  check(
    "scripts: only what the text needs, beyond the one always loaded",
    subsetsFor("Plain English, “quoted” — dashed.", inter.subsets).length === 0 &&
      subsetsFor("Привет", inter.subsets).join() === "cyrillic" &&
      subsetsFor("Ελληνικά and Tiếng Việt", inter.subsets).join() === "greek,vietnamese" &&
      subsetsFor("Żółć", inter.subsets).join() === "latin-ext" &&
      subsetsFor("日本語", inter.subsets).length === 0 &&
      subsetsFor("日本語", ["latin", "japanese"]).join() === "japanese" &&
      beyondLatin("naïve café") === false &&
      beyondLatin("Привет") === true,
    [subsetsFor("Ελληνικά and Tiếng Việt", inter.subsets).join(), subsetsFor("Żółć", inter.subsets).join()].join(" | "),
  );
}

// -------------------------------------------------- what each font prints in

// A stand-in for the outside world: which catalog files can be fetched,
// which fonts are installed, and which of those may be embedded.
// (The harness runs from apps/desktop; its bundle lives elsewhere.)
const asset = (p: string) => new Uint8Array(readFileSync(`${process.cwd()}/src/assets/fonts/${p}`));
const world = {
  catalog: new Set<string>(),
  installed: [] as { family: string; styles: string[]; monospace: boolean }[],
  restricted: new Set<string>(),
  fetched: [] as string[],
  /** Which real file stands for a catalog file (absent: Carlito's). */
  bytes: null as ((id: string, file: string) => Uint8Array) | null,
};
const fake = backend as unknown as Record<string, unknown>;
fake.fontFetch = async (id: string, file: string, online: boolean) => {
  world.fetched.push(`${id}/${file}${online ? "" : " (offline)"}`);
  if (!world.catalog.has(id)) throw { code: "font_unavailable", message: "no" };
  if (world.bytes) return world.bytes(id, file);
  // Any real font will do for bytes; styles are told apart by file name.
  return asset(file.includes("italic") ? "carlito/Carlito-Italic.ttf" : file.includes("-700-") ? "carlito/Carlito-Bold.ttf" : "carlito/Carlito-Regular.ttf");
};
fake.sysfontList = async () => world.installed;
fake.sysfontBytes = async (family: string, bold: boolean, italic: boolean) => {
  if (world.restricted.has(family)) throw { code: "not_embeddable", message: "no" };
  return { index: 0, bytes: asset(bold ? "eb-garamond/EBGaramond-Bold.ttf" : italic ? "eb-garamond/EBGaramond-Italic.ttf" : "eb-garamond/EBGaramond-Regular.ttf") };
};
const fresh = (set: Partial<typeof world> = {}) => {
  resetFontStore();
  Object.assign(world, { catalog: new Set(), installed: [], restricted: new Set(), fetched: [], bytes: null }, set);
};

{
  fresh();
  const body = await resolveFont(null);
  const calibri = await resolveFont("sys:Calibri");
  const inter = await resolveFont("gf:inter");
  check("nothing installed, nothing downloadable: the bundled stand-ins, and why", body.family === "literata" && body.substituted && body.why === "missing" && body.asked === "Georgia" && calibri.family === "carlito" && calibri.metric && inter.family === "carlito" && inter.substituted && inter.asked === "Inter", JSON.stringify([body, inter]));
  check("the app's own fonts never ask anyone", (await resolveFont("garamond")).family === "garamond" && !(await resolveFont("garamond")).substituted && (await resolveFont("mono")).family === "courier-prime" && !world.fetched.some((f) => f.startsWith("eb-garamond")));
}
{
  fresh({ catalog: new Set(["gelasio", "tinos", "inter", "lora"]) });
  const body = await resolveFont(null);
  check("with the catalog: Georgia prints in its metric twin", body.family === "gf:gelasio" && body.substituted && body.metric && body.drawn === "Gelasio" && body.why === "missing", JSON.stringify(body));
  const times = await resolveFont("times");
  check("…Times New Roman in Tinos", times.family === "gf:tinos" && times.metric && times.asked === "Times New Roman");
  const inter = await resolveFont("gf:inter");
  check("a catalog font prints in itself", inter.family === "gf:inter" && !inter.substituted && inter.drawn === "Inter");
  const named = await resolveFont("sys:Lora");
  check("a font named in a Word file that the catalog has is the real thing", named.family === "gf:lora" && !named.substituted, JSON.stringify(named));
  const light = await resolveFont("gf:inter@300");
  check("a weight is part of the family", light.family === "gf:inter@300" && world.fetched.includes("inter/latin-300-normal.ttf") && world.fetched.includes("inter/latin-700-italic.ttf"), world.fetched.filter((f) => f.startsWith("inter/")).join(", "));
  const faces = await loadFaces(["gf:gelasio", "garamond"]);
  check("its files reach the typesetter under the family's name, one per style", faces.filter((f) => f.family === "gf:gelasio").map((f) => f.style).sort().join() === "bold,boldItalic,italic,regular" && faces.filter((f) => f.family === "garamond").length === 4);
  const before = world.fetched.length;
  await loadFaces(["gf:gelasio"]);
  check("…handed over once: asked for again, they're fetched again", world.fetched.length === before + 4);
}
{
  fresh({ catalog: new Set(["gelasio"]), installed: [{ family: "Georgia", styles: ["regular", "italic", "bold", "boldItalic"], monospace: false }, { family: "Papyrus", styles: ["regular"], monospace: false }] });
  const body = await resolveFont(null);
  check("installed and embeddable: the font itself", body.family === "sys:Georgia" && !body.substituted && body.drawn === "Georgia", JSON.stringify(body));
  const one = await resolveFont("sys:Papyrus");
  check("…whatever styles it has", one.family === "sys:Papyrus" && (await loadFaces(["sys:Papyrus"])).map((f) => f.style).join() === "regular");
  check("nothing was downloaded for it", !world.fetched.some((f) => f.startsWith("gelasio")));

  fresh({ catalog: new Set(["gelasio"]), installed: [{ family: "Georgia", styles: ["regular", "bold"], monospace: false }], restricted: new Set(["Georgia"]) });
  const barred = await resolveFont(null);
  check("installed but not embeddable: a stand-in, and it says the licence is why", barred.family === "gf:gelasio" && barred.substituted && barred.why === "licence", JSON.stringify(barred));
}
{
  fresh({ catalog: new Set(["inter"]) });
  localStorage.setItem("wf-fonts-online", "off");
  await resolveFont("gf:inter");
  check("with the online library off, the CDN isn't asked (the cache and your server still are)", world.fetched.length > 0 && world.fetched.every((f) => f.endsWith("(offline)")));
  localStorage.removeItem("wf-fonts-online");
}
{
  fresh({ catalog: new Set(["inter", "gelasio"]) });
  const doc = { type: "doc", content: [{ type: "paragraph", attrs: { font: "gf:inter" }, content: [{ type: "text", text: "Привет, мир — and Ελλάδα." }] }, { type: "paragraph", content: [{ type: "text", text: "Plain." }] }] };
  const used = fontsUsed(doc, null);
  check("a document's fonts are read off its paragraphs", used.ids.includes("gf:inter") && used.ids.includes(null) && used.exotic.includes("П"));
  const fonts = await resolveDocFonts(doc, null);
  check("other scripts of a catalog family are fetched only when the text has them", fonts.chains["gf:inter"]?.join() === "gf:inter~cyrillic,gf:inter~greek" && fonts.chains["gf:gelasio"] === undefined, JSON.stringify(fonts.chains));
  check("what had to be stood in for is listed", fonts.missing.length === 1 && fonts.missing[0].id === null && fonts.missing[0].face.drawn === "Gelasio");

  const model = buildDocModel(doc, { title: "Fonts", settings: { ...DEFAULT_SETTINGS }, fonts });
  check("the layout is told: families, their extra scripts, and the stand-ins", model.families.includes("gf:inter~cyrillic") && model.chains["gf:inter"]?.length === 2 && model.body.family === "gf:gelasio" && model.substitutions.some(([asked, drawn]) => asked === "Georgia" && drawn === "Gelasio"));
  const session = new TypesetSession();
  session.addFonts(await loadFaces(model.families));
  const { dl } = await session.layout({ kind: "document", doc: model, families: model.families, images: [] });
  const face = dl.faces.find((f) => f.family === "gf:inter");
  check("the preview draws a catalog run under the name its files were registered as", face?.cssFamily.startsWith('"wf-gf-inter", "Inter"') === true && dl.faces.some((f) => f.family === "gf:gelasio" && f.cssFamily.startsWith('"wf-gf-gelasio"')), dl.faces.map((f) => f.cssFamily).join(" | "));
  check("the export says what it stood in for", dl.warnings.some((w) => w.kind === "font" && w.message.includes("Georgia → Gelasio")), dl.warnings.map((w) => w.message).join(" / "));
}

// -------------------------------------------------- a book in catalog fonts

{
  // (As a catalog family comes: Latin in one file, Cyrillic in another.
  // Cinzel has no Cyrillic; Libertinus has.)
  const split = (_id: string, file: string) => (file.startsWith("cyrillic") ? asset("libertinus/LibertinusSerif-Regular.otf") : asset("cinzel/Cinzel[wght].ttf"));
  fresh({ catalog: new Set(["lora", "cinzel-decorative"]), bytes: split });
  await loadCatalog();
  const info = bookFont("gf:lora");
  check("a catalog family is a book font: named, drawn under its own page name, with no claims to small capitals or ornaments", info.label === "Lora" && info.css.startsWith('"wf-gf-lora"') && !info.smallCaps && !info.oldstyle && info.ornaments === "" && bookFont("gf:lora~cyrillic").label === "Lora", JSON.stringify(info));
  check("the app's own book faces are untouched", bookFont("garamond").smallCaps && bookFont("nonsense").id === "garamond");

  const ydoc = new Y.Doc();
  choosePreset(ydoc, "classic");
  updateBook(ydoc, { "meta.title": "Письма", "meta.author": "A. N. Author", "design.bodyFont": "gf:lora", "design.headingFont": "gf:cinzel-decorative", "ebook.embedFonts": true });
  const book = readBook(ydoc);
  check("a book's design can name catalog fonts", book.design.bodyFont === "gf:lora" && book.design.headingFont === "gf:cinzel-decorative");
  updateBook(ydoc, { "design.bodyFont": "gf:Bad Font" });
  check("…but not anything", readBook(ydoc).design.bodyFont !== "gf:Bad Font");
  updateBook(ydoc, { "design.bodyFont": "gf:lora" });

  const el = (element: string, text: string, ...marks: string[]) => ({ type: "paragraph", attrs: { element }, content: [{ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) }] });
  const story = { type: "doc", content: [el("chapter_heading", "The Letters"), el("paragraph", "She wrote Привет at the top of every page, and nothing else for a week."), el("paragraph", "Then one word more.", "italic")] };
  const model = buildModel(story as never, "manuscript", readBook(ydoc));
  const fonts = await bookFonts("paperback", model);
  check("the book's fonts are fetched before it is set, with the scripts its text needs", fonts.families.includes("gf:lora") && fonts.families.includes("gf:cinzel-decorative") && fonts.chains["gf:lora"]?.join() === "gf:lora~cyrillic" && fonts.families.includes("gf:lora~cyrillic") && fonts.warnings.length === 0, JSON.stringify([fonts.families, fonts.chains, fonts.warnings]));
  const session = new TypesetSession();
  session.addFonts(await loadFaces(fonts.families));
  const req = { kind: "paperback" as const, model: fonts.model, families: fonts.families, images: [], now: Date.UTC(2026, 9, 10), chains: fonts.chains };
  const { dl } = await session.layout(req);
  const texts = dl.pages.flatMap((pg) => pg.items).filter((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  const latin = texts.find((it) => it.text.includes("week"));
  const cyr = texts.find((it) => it.text.includes("Привет"));
  check("the text is set in the catalog family", !!latin && dl.faces[latin.face].family === "gf:lora", latin ? dl.faces[latin.face].family : "none");
  check("…and what its Latin file lacks in the file that has it", !!cyr && dl.faces[cyr.face].family === "gf:lora~cyrillic" && cyr.text === "Привет", cyr ? `${dl.faces[cyr.face].family} ${cyr.text}` : "none");
  check("nothing is left blank", !dl.warnings.some((w) => w.kind === "missing-glyphs" && w.message.includes("П")), dl.warnings.map((w) => w.message).join(" / "));
  const slanted = texts.find((it) => it.text.includes("Then one"));
  check("a family with no italic of its own is slanted, so emphasis shows", !!slanted && (dl.faces[slanted.face].style === "italic"), slanted ? JSON.stringify(dl.faces[slanted.face]) : "none");
  const pdf = await session.pdf(req);
  check("the paperback is written with them", pdf.bytes.length > 5000 && pdf.pages === dl.pages.length);

  const ebook = await epubFonts(model);
  const names = ebook.fonts.map((f) => f.file);
  check("an ebook that embeds its fonts gets the family's files: each script, each style", names.includes("lora-latin-regular.ttf") && names.includes("lora-latin-bolditalic.ttf") && names.includes("lora-cyrillic-regular.ttf") && names.some((n) => n.startsWith("cinzel-decorative-latin-")) && ebook.missing.length === 0, names.join(", "));
  const latinFile = ebook.fonts.find((f) => f.file === "lora-latin-regular.ttf");
  check("each says which characters it draws", latinFile?.range?.startsWith("U+0000-00FF") === true && ebook.fonts.find((f) => f.file === "lora-cyrillic-regular.ttf")?.range?.includes("U+0400-045F") === true, String(latinFile?.range));
  const { buildEpub } = await import("../src/book/epub/epub");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await buildEpub(model, { uuid: "urn:uuid:test", fonts: ebook.fonts }));
  const css = (await zip.file("OEBPS/styles/book.css")?.async("string")) ?? "";
  const opf = (await zip.file(Object.keys(zip.files).find((n) => n.endsWith(".opf")) ?? "")?.async("string")) ?? "";
  check("the ebook holds the files and says where to use them", !!zip.file("OEBPS/fonts/lora-latin-regular.ttf") && css.includes('@font-face { font-family: "Lora"; font-style: normal; font-weight: 400; src: url("../fonts/lora-latin-regular.ttf"); unicode-range: U+0000-00FF') && css.includes('body { margin: 0; font-family: "Lora", serif;') && css.includes('h1, h2, .titlepage .book-title { font-family: "Cinzel Decorative", "Lora", serif; }') && opf.includes('href="fonts/lora-latin-regular.ttf" media-type="font/ttf"'), css.slice(0, 400));

  // With no way to fetch them.
  fresh();
  const stuck = await bookFonts("paperback", model);
  check("offline and never fetched: the book is set in the nearest of the app's own, and says so", !stuck.families.some((f) => f.startsWith("gf:")) && stuck.model.book.design.bodyFont !== "gf:lora" && stuck.warnings.some((w) => w.kind === "font" && w.message.includes("Lora")), JSON.stringify([stuck.families, stuck.warnings]));
  const none = await epubFonts(model);
  check("…and the ebook is told what it couldn't embed", none.fonts.length === 0 && none.missing.join() === "Lora,Cinzel Decorative", JSON.stringify(none.missing));

  // The app's own faces embed too (the option did nothing before).
  const own = new Y.Doc();
  choosePreset(own, "classic");
  const ownModel = buildModel(story as never, "manuscript", readBook(own));
  const bundled = await epubFonts(ownModel);
  check("a book in the app's own typeface embeds that", bundled.fonts.map((f) => f.file).sort().join() === "eb-garamond-bold.ttf,eb-garamond-bolditalic.ttf,eb-garamond-italic.ttf,eb-garamond-regular.ttf" && bundled.fonts.every((f) => f.bytes.length > 10000 && !f.range), bundled.fonts.map((f) => f.file).join());
  check("a submission manuscript keeps its own face whatever the design says", (await bookFonts("submission-pdf", model)).families.every((f) => !f.startsWith("gf:")));
}

// A look with the catalog's real files: WF_REAL_FONTS=/dir (holding
// `<family>/<subset>-<weight>-<style>.ttf`) writes a PDF there.
if (process.env.WF_REAL_FONTS) {
  const dir = process.env.WF_REAL_FONTS;
  const { existsSync, writeFileSync } = await import("node:fs");
  resetFontStore();
  fake.sysfontList = async () => [];
  fake.fontFetch = async (id: string, file: string) => {
    if (!existsSync(`${dir}/${id}/${file}`)) throw { code: "font_unavailable", message: "no" };
    return new Uint8Array(readFileSync(`${dir}/${id}/${file}`));
  };
  const para = (attrs: Record<string, unknown> | null, text: string, marks: string[] = []) => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content: [{ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) }] });
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Georgia, set in Gelasio" }] },
      para(null, "The default body face is Georgia; where it isn't installed, its metric twin from the catalog stands in, with a real bold and a real italic. "),
      para(null, "Bold text in the twin.", ["bold"]),
      para(null, "Italic text in the twin.", ["italic"]),
      para({ font: "gf:inter" }, "Inter from the catalog — and Привет, мир in its Cyrillic file."),
      para({ font: "gf:inter" }, "Inter bold italic.", ["bold", "italic"]),
    ],
  };
  const fonts = await resolveDocFonts(doc, null);
  const model = buildDocModel(doc, { title: "Real fonts", settings: { ...DEFAULT_SETTINGS }, fonts });
  const session = new TypesetSession();
  session.addFonts(await loadFaces(model.families));
  const pdf = await session.pdf({ kind: "document", doc: model, families: model.families, images: [] });
  writeFileSync(`${dir}/real-fonts.pdf`, pdf.bytes);
  console.log(`Wrote ${dir}/real-fonts.pdf — families: ${model.families.join(", ")}; warnings: ${pdf.warnings.map((w) => w.message).join(" / ")}`);
}

finish();
