// The PDF editor in Documents: a PDF picked, opened, read, searched,
// rearranged and saved as a copy. The engine runs in place here (no worker
// in Node) and nothing is drawn (no canvas), so what is held is everything
// around the drawing: what the room shows, what its tools do to the file,
// and that what is saved is the file as changed.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { JSONContent } from "@tiptap/core";
import PDFDocument from "pdfkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { TypesetSession } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { backend } from "../src/lib/backend";
import { setPdfjs } from "../src/lib/pdfjs";
import { leavePdf, looksLikePdf, pdfIntent, usePdfDesk } from "../src/pdf/desk";
import { setEngineMaker, type Engine } from "../src/pdf/engine/client";
import { EngineCore, failOf } from "../src/pdf/engine/core";
import { initSync } from "../src/pdf/engine/pkg/wfpdf.js";
import { PdfEditor } from "../src/pdf/PdfEditor";
import { selectedLines } from "../src/pdf/PdfOverlay";
import { fitStrokes } from "../src/pdf/SignDialog";
import { findInPage, findInPdf, pageText } from "../src/pdf/search";
import { PdfShelf } from "../src/pdf/PdfShelf";
import { PdfSession } from "../src/pdf/session";
import { setPdfKeeping, sizeLabel, usePdfShelf } from "../src/pdf/shelf";
import { ConfirmHost } from "../src/platform/confirm";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
// (pdf.js lays a page's words out by measuring them on a canvas, which is
// not here: the laying is left out, and the words are still read.)
setPdfjs({
  ...pdfjs,
  TextLayer: class {
    render() {
      return Promise.resolve();
    }
    cancel() {}
  },
} as never);
initSync({ module: readFileSync(join(process.cwd(), "src/pdf/engine/pkg/wfpdf_bg.wasm")) });
// (jsdom has no canvas to draw on, and says so loudly each time it is asked.)
(window as unknown as { HTMLCanvasElement: { prototype: { getContext: () => null } } }).HTMLCanvasElement.prototype.getContext = () => null;

/** The engine, run in place: what the worker does, without the worker. */
let engines = 0;
setEngineMaker((): Engine => {
  const core = new EngineCore();
  engines += 1;
  const soon = async <T,>(run: () => T): Promise<T> => {
    try {
      return run();
    } catch (e) {
      throw failOf(e);
    }
  };
  return {
    open: (bytes, password) => soon(() => core.openPdf(bytes.slice(), password)),
    info: () => soon(() => core.info()),
    call: (method, ...args) => soon(() => core.call(method, args)),
    read: (what, ...args) => soon(() => core.read(what, args)),
    bytes: (full) => soon(() => core.bytes(full)),
    extract: (pages) => soon(() => core.extract(pages)),
    saved: (bytes) => soon(() => core.saved(bytes.slice())),
    close: () => core.close(),
  };
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const typeset = new TypesetSession();
async function pdfOf(pages: string[], title = "View"): Promise<Uint8Array> {
  const doc: JSONContent = { type: "doc", content: pages.map((text, k) => ({ type: "paragraph", content: [{ type: "text", text }], ...(k ? { attrs: { pageBreakBefore: true } } : {}) })) };
  const model = buildDocModel(doc, { title, author: "A. Writer", settings: { ...DEFAULT_SETTINGS, fR: "" }, date: "October 13, 2026" });
  typeset.addFonts(await loadFontFiles(typeset.missingFamilies(model.families)));
  return (await typeset.pdf({ kind: "document", doc: model, families: model.families, images: [], pdf: { pictures: "print", tagged: false, archive: false, source: false } })).bytes;
}
async function wordsOf(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    out.push(`${(await page.getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join("").trim()}${page.rotate ? `@${page.rotate}` : ""}`);
  }
  await doc.loadingTask.destroy();
  return out.join("|");
}

const FOUR = await pdfOf(["The ferry came in at dawn.", "Nobody on the quay looked up.", "The ferry left again at noon.", "The harbour was quiet after that."], "Four pages");

// ------------------------------------------------------------- searching

{
  const session = await PdfSession.open("Four.pdf", FOUR);
  const first = await pageText(await session.pdf.getPage(1));
  check("a page's words are read as one text", first.text.replace(/\s+/g, " ").trim() === "The ferry came in at dawn.", first.text);
  const on = findInPage(first, "FERRY", 0);
  check("a word is found whatever its capitals, as a box on its page", on.length === 1 && on[0].rects.length >= 1 && on[0].rects.every((r) => r.x > 0 && r.x + r.w < 1 && r.y > 0 && r.y + r.h < 1 && r.w > 0.02), JSON.stringify(on[0]?.rects));
  const cache = new Map();
  const all = await findInPdf(session.pdf, "ferry", cache);
  check("…and through the whole document, in order", all.map((hit) => hit.page).join() === "0,2" && cache.size === 4);
  check("nothing is looked for when nothing is typed", (await findInPdf(session.pdf, "  ", cache)).length === 0 && findInPage(first, "", 0).length === 0);
  session.close();
}

// ------------------------------------------------------------- the room

const saved: { name: string; kind: string; bytes: Uint8Array }[] = [];
(backend as unknown as { saveFile: (name: string, kind: string, bytes: Uint8Array) => Promise<unknown> }).saveFile = async (name, kind, bytes) => {
  saved.push({ name, kind, bytes: bytes.slice() });
  return { status: "saved", path: `/tmp/${name}.pdf`, location: "tmp" };
};

const root = createRoot(mountPoint());
await act(async () => root.render(createElement("div", null, createElement(PdfEditor), createElement(ConfirmHost))));
const body = () => document.body.textContent ?? "";
const until = async (ok: () => boolean, tries = 300) => {
  for (let k = 0; k < tries && !ok(); k += 1) await act(async () => wait(10));
};
const button = (title: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.title === title || b.textContent?.trim() === title);
const press = async (title: string) => {
  const b = button(title);
  if (!b) throw new Error(`no ${title} button in: ${body()}`);
  await act(async () => {
    b.click();
    await wait(0);
  });
};
const settled = () => until(() => !document.querySelector<HTMLButtonElement>('button[title="Turn right"]')?.disabled || document.querySelector(".wf-pdf-note") !== null);
const typeIn = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const thumbs = () => [...document.querySelectorAll<HTMLElement>(".wf-pdf-thumb")];
const click = async (el: Element, more: Record<string, unknown> = {}) => {
  const fire = (type: string) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientY: 10, ...more }));
  await act(async () => {
    fire("pointerdown");
    fire("pointerup");
    await wait(0);
  });
};

{
  check("with no PDF picked there is no editor", document.querySelector(".wf-pdf-room") === null);
  await act(async () => usePdfDesk.getState().show({ name: "Four.pdf", bytes: FOUR }));
  await until(() => document.querySelectorAll(".wf-pdf-slot").length === 4);
  check("a PDF picked to be edited opens with its name and its pages", body().includes("Four.pdf") && body().includes("Page 1 of 4") && document.querySelectorAll(".wf-pdf-page").length === 4 && thumbs().length === 4, body().slice(0, 120));
  const page = document.querySelector<HTMLElement>(".wf-pdf-page")!;
  check("each page is shown at its own shape", Math.abs(parseFloat(page.style.height) / parseFloat(page.style.width) - 792 / 612) < 0.01, `${page.style.width} ${page.style.height}`);
  check("nothing is there to undo, and the tools are ready", button("Undo")?.disabled === true && button("Turn right")?.disabled === false && button("Save a copy") !== undefined);

  // Find.
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await typeIn(search, "ferry");
  await until(() => body().includes("1 of 2"));
  check("words typed into Find are found and counted, the places marked on their pages", body().includes("1 of 2") && document.querySelectorAll(".wf-pdf-hits span").length >= 2 && document.querySelectorAll(".wf-pdf-hits span.current").length >= 1);
  await press("Next match");
  check("…and stepped through", body().includes("2 of 2") && document.querySelectorAll('[data-index="2"] .wf-pdf-hits span.current').length >= 1);
  await typeIn(search, "zebra");
  await until(() => body().includes("None"));
  check("what is not there is said not to be", body().includes("None") && document.querySelectorAll(".wf-pdf-hits span").length === 0);
  await typeIn(search, "");

  // Page tools, on the page picked in the list.
  await click(thumbs()[3]);
  check("a page clicked in the list is picked", thumbs()[3].classList.contains("selected") && body().includes("Page 4 of 4"));
  await press("Move up");
  await settled();
  await press("Move up");
  await settled();
  check("Move up moves it, and it stays picked where it went", thumbs()[1].classList.contains("selected") && button("Undo")?.disabled === false);
  await press("Turn right");
  await settled();
  await press("Make a copy of the page");
  await settled();
  check("a copy is made after it, and is the page picked", thumbs().length === 5 && thumbs()[2].classList.contains("selected") && body().includes("of 5"));
  await press("Take the page out");
  await settled();
  await click(thumbs()[0]);
  await click(thumbs()[2], { shiftKey: true });
  check("shift picks every page from the first picked to the one clicked", thumbs().filter((t) => t.classList.contains("selected")).length === 3);
  await click(thumbs()[1], { metaKey: true });
  check("command takes one out of what is picked", thumbs().filter((t) => t.classList.contains("selected")).map((t) => t.dataset.index).join() === "0,2");
  await click(thumbs()[0]);
  await press("Add an empty page after");
  await settled();
  check("an empty page is added after the page picked, as large as it", thumbs().length === 5 && thumbs()[1].classList.contains("selected"));

  // What all that did to the file.
  await press("Save a copy");
  await until(() => saved.length === 1);
  check("Save a copy saves the PDF as changed, under its own name", saved.length === 1 && saved[0].name === "Four" && saved[0].kind === "pdf" && (await wordsOf(saved[0].bytes)) === "The ferry came in at dawn.||The harbour was quiet after that.@90|Nobody on the quay looked up.|The ferry left again at noon.", saved[0] ? await wordsOf(saved[0].bytes) : "");
  check("the copy is written afresh, with nothing of the steps in between left in it", Buffer.from(saved[0].bytes).toString("latin1").split("%%EOF").length === 2);

  // Undo, by the button.
  await press("Undo");
  await settled();
  check("Undo takes the last step back, and Redo is there to make it again", thumbs().length === 4 && button("Redo")?.disabled === false);
  await press("Redo");
  await settled();

  // Some pages as a PDF of their own.
  await click(thumbs()[0]);
  await click(thumbs()[3], { metaKey: true });
  await press("Save these pages as a PDF of their own");
  await until(() => saved.length === 2);
  check("pages picked are saved as a PDF of their own, the document left as it is", saved[1]?.name === "Four (pages)" && (await wordsOf(saved[1].bytes)) === "The ferry came in at dawn.|Nobody on the quay looked up." && thumbs().length === 5, saved[1] ? await wordsOf(saved[1].bytes) : "");

  // Closing.
  await press("Turn left");
  await settled();
  check("a change not yet in any file is known to whoever would show something else", usePdfDesk.getState().dirty === true);
  await press("Back to documents");
  await until(() => body().includes("Close without saving?"));
  check("leaving with changes unsaved asks first", body().includes("Close without saving?") && body().includes("Save a copy first"));
  await press("Cancel");
  check("…and stays when told to", document.querySelector(".wf-pdf-room") !== null && usePdfDesk.getState().open !== null);
  await press("Back to documents");
  await until(() => body().includes("Close without saving?"));
  await press("Close");
  await until(() => document.querySelector(".wf-pdf-room") === null);
  check("…or goes", usePdfDesk.getState().open === null && document.querySelector(".wf-pdf-room") === null);
}

// A file with a password, and a file its owner keeps as it is.
{
  const locked = await new Promise<Uint8Array>((resolve) => {
    const made = new PDFDocument({ font: null, autoFirstPage: false, pdfVersion: "1.6", userPassword: "open sesame", ownerPassword: "the owner", permissions: { printing: "highResolution" } } as never) as unknown as { addPage(o: unknown): unknown; on(e: string, f: (c: Buffer) => void): void; end(): void };
    const chunks: Buffer[] = [];
    made.on("data", (chunk) => chunks.push(chunk));
    made.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    made.addPage({ size: [612, 792], margin: 0 });
    made.addPage({ size: [612, 792], margin: 0 });
    made.end();
  });
  await act(async () => usePdfDesk.getState().show({ name: "Locked.pdf", bytes: locked }));
  await until(() => body().includes("has a password"));
  check("a PDF with a password asks for it before it opens", body().includes("This PDF has a password") && document.querySelector(".wf-pdf-slot") === null);
  const field = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;
  await typeIn(field(), "not it");
  await press("Open");
  await until(() => body().includes("did not open"));
  check("a wrong password is said to be wrong", body().includes("That password did not open it"));
  await typeIn(field(), "open sesame");
  await press("Open");
  await until(() => document.querySelectorAll(".wf-pdf-slot").length === 2);
  check("the right one opens it", document.querySelectorAll(".wf-pdf-slot").length === 2 && !body().includes("has a password"));
  check("what its owner does not allow is said, and those tools are off", body().includes("does not allow its pages to be changed") && button("Turn right")?.disabled === true && button("Take the page out")?.disabled === true && button("Save a copy")?.disabled === false);
  await press("Back to documents");
  await until(() => document.querySelector(".wf-pdf-room") === null);
  check("with nothing changed it closes without a word", usePdfDesk.getState().open === null);

  await act(async () => usePdfDesk.getState().show({ name: "Broken.pdf", bytes: new TextEncoder().encode("not a pdf at all") }));
  await until(() => document.querySelector(".wf-pdf-waiting")?.textContent !== "Opening the PDF");
  check("a file that is no PDF says so, and can be left", (document.querySelector(".wf-pdf-waiting")?.textContent ?? "").length > 8 && button("Back to documents") !== undefined, document.querySelector(".wf-pdf-waiting")?.textContent ?? "");
  await press("Back to documents");
}

// ------------------------------------- marks, a form, text, a signature

{
  const face = (await loadFontFiles(["carlito"])).find((f) => f.style === "regular")!;
  const form = await new Promise<Uint8Array>((resolve) => {
    const made = new PDFDocument({ font: null, autoFirstPage: false } as never) as unknown as {
      registerFont(name: string, bytes: Buffer): void;
      font(name: string): unknown;
      fontSize(n: number): unknown;
      text(text: string, x: number, y: number, o?: unknown): unknown;
      addPage(o: unknown): unknown;
      initForm(): unknown;
      formText(name: string, x: number, y: number, w: number, h: number, o?: unknown): unknown;
      formCheckbox(name: string, x: number, y: number, w: number, h: number, o?: unknown): unknown;
      on(e: string, f: (c: Buffer) => void): void;
      end(): void;
    };
    const chunks: Buffer[] = [];
    made.on("data", (chunk) => chunks.push(chunk));
    made.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    made.registerFont("body", Buffer.from(face.bytes));
    made.addPage({ size: [612, 792], margin: 0 });
    made.font("body");
    made.fontSize(12);
    made.text("An application to berth.", 72, 60, { lineBreak: false });
    made.initForm();
    made.formText("applicant", 72, 100, 240, 22, {});
    made.formCheckbox("agree", 72, 150, 16, 16, {});
    made.end();
  });
  await act(async () => usePdfDesk.getState().show({ name: "Form.pdf", bytes: form }));
  await until(() => document.querySelectorAll(".wf-pdf-field").length === 2);
  const tool = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".wf-pdf-toolbar button")].find((b) => b.textContent?.trim().startsWith(label));
  const pick = async (label: string) => {
    await act(async () => {
      tool(label)!.click();
      await wait(0);
    });
  };
  const over = () => document.querySelector<HTMLElement>(".wf-pdf-over")!;
  const point = async (el: Element, type: string, x: number, y: number) => {
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
      await wait(0);
    });
  };
  const quiet = () => until(() => tool("Highlight")?.disabled === false);
  const inEngine = async () => (await PdfSession.open("probe", (await lastSaved()) ?? form)).close();
  const lastSaved = async (): Promise<Uint8Array | null> => {
    const before = saved.length;
    await press("Save a copy");
    await until(() => saved.length > before);
    return saved[saved.length - 1]?.bytes ?? null;
  };
  void inEngine;

  // The form.
  const text = document.querySelector<HTMLInputElement>('input.wf-pdf-field[type="text"]')!;
  const tick = document.querySelector<HTMLInputElement>('input.wf-pdf-field[type="checkbox"]')!;
  check("a form's fields are there to type into and tick, each on its place on the page", !!text && !!tick && text.getAttribute("aria-label") === "applicant" && parseFloat(text.style.left) > 0 && Math.abs(parseFloat(text.style.width) / parseFloat(text.style.height) - 240 / 22) < 0.2, `${text?.style.left} ${text?.style.width}`);
  await typeIn(text, "Ada Lovelace");
  await act(async () => {
    text.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    await wait(0);
  });
  await quiet();
  await act(async () => {
    document.querySelector<HTMLInputElement>('input.wf-pdf-field[type="checkbox"]')!.click();
    await wait(0);
  });
  await quiet();
  await until(() => document.querySelector<HTMLInputElement>('input.wf-pdf-field[type="checkbox"]')?.checked === true);
  check("what is typed and ticked is in the form, and can be undone", document.querySelector<HTMLInputElement>('input.wf-pdf-field[type="text"]')?.value === "Ada Lovelace" && document.querySelector<HTMLInputElement>('input.wf-pdf-field[type="checkbox"]')?.checked === true && button("Undo")?.disabled === false);

  // A note.
  check("the tools are offered by name", ["Read", "Note", "Draw", "Box", "Arrow", "Type", "Sign", "Change text"].every((label) => !!tool(label)) && tool("Read")?.getAttribute("aria-pressed") === "true");
  await pick("Note");
  check("a tool taken up says what to do with it", body().includes("Click the page where a note goes") && over().classList.contains("making"));
  await point(over(), "pointerdown", 300, 400);
  const box = () => document.querySelector<HTMLTextAreaElement>(".wf-pdf-typing");
  check("a click on the page opens somewhere to write the note", !!box() && box()!.getAttribute("aria-label") === "What the note says");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor((window as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box()!, "Check the berth number.");
    box()!.dispatchEvent(new window.Event("input", { bubbles: true }));
    box()!.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    await wait(0);
  });
  await quiet();
  await pick("Read");
  await until(() => document.querySelectorAll(".wf-pdf-mark").length === 1);
  check("the note is a mark on the page, saying what was written", document.querySelector(".wf-pdf-mark")?.getAttribute("title") === "Check the berth number.");

  // A box drawn round something.
  await pick("Box");
  await point(over(), "pointerdown", 100, 100);
  await point(over(), "pointermove", 260, 180);
  check("a box being dragged is shown as it is dragged", document.querySelector(".wf-pdf-trail rect") !== null);
  await point(over(), "pointerup", 260, 180);
  await quiet();
  await pick("Read");
  await until(() => document.querySelectorAll(".wf-pdf-mark").length === 2);
  check("…and is a mark when let go", document.querySelectorAll(".wf-pdf-mark").length === 2);

  // A mark picked up: what can be done with it.
  const note = [...document.querySelectorAll<HTMLElement>(".wf-pdf-mark")].find((el) => el.getAttribute("title"))!;
  await point(note, "pointerdown", 5, 5);
  await point(note, "pointerup", 5, 5);
  check("a mark clicked is picked, with what can be done to it", note.classList.contains("picked") && body().includes("Change the words") && body().includes("Take it off"));
  await press("Take it off");
  await quiet();
  await until(() => document.querySelectorAll(".wf-pdf-mark").length === 1);
  check("Take it off takes it off", document.querySelectorAll(".wf-pdf-mark").length === 1 && !body().includes("Take it off"));

  // Marking the text that is selected.
  await press("Highlight the selected text");
  await until(() => body().includes("Select some text"), 60);
  check("Highlight with nothing selected says to select something", selectedLines(document.body).size === 0);

  // The page's own text.
  await pick("Change text");
  await until(() => document.querySelectorAll(".wf-pdf-block").length >= 1);
  const block = document.querySelector<HTMLButtonElement>(".wf-pdf-block")!;
  check("the page's own text is offered piece by piece", block.getAttribute("aria-label")?.includes("An application to berth.") === true, block.getAttribute("aria-label") ?? "");
  await act(async () => {
    block.click();
    await wait(0);
  });
  check("a piece clicked opens with its words to change", box()?.value === "An application to berth." && box()!.classList.contains("block"));
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor((window as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box()!, "An application to a berth.");
    box()!.dispatchEvent(new window.Event("input", { bubbles: true }));
    box()!.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    await wait(0);
  });
  await quiet();
  await until(() => document.querySelector(".wf-pdf-block")?.getAttribute("aria-label")?.includes("to a berth") === true);
  check("…and the page then says what was typed", document.querySelector(".wf-pdf-block")?.getAttribute("aria-label")?.includes("An application to a berth.") === true, document.querySelector(".wf-pdf-block")?.getAttribute("aria-label") ?? "");

  // A signature.
  await pick("Sign");
  await until(() => body().includes("Your signature"));
  check("Sign asks for the signature first, and will not go on with none", body().includes("Draw it here") && button("Use this signature")?.disabled === true);
  const pad = document.querySelector(".wf-pdf-signpad")!;
  await point(pad, "pointerdown", 20, 40);
  await point(pad, "pointermove", 120, 20);
  await point(pad, "pointermove", 200, 90);
  await point(pad, "pointerup", 200, 90);
  check("what is drawn there is the signature", document.querySelectorAll(".wf-pdf-signpad path").length === 1 && button("Use this signature")?.disabled === false);
  await press("Use this signature");
  check("it is then put down with a click on the page", !body().includes("Your signature") && over().classList.contains("making"));
  await point(over(), "pointerdown", 300, 600);
  await quiet();
  await until(() => tool("Read")?.getAttribute("aria-pressed") === "true");
  await until(() => document.querySelectorAll(".wf-pdf-mark").length === 2);
  check("…and is on the page, the tool put away", document.querySelectorAll(".wf-pdf-mark").length === 2 && tool("Read")?.getAttribute("aria-pressed") === "true");

  // All of it, in the file that is saved.
  const out = await lastSaved();
  const read = await pdfjs.getDocument({ data: out!.slice(), verbosity: 0 }).promise;
  const first = await read.getPage(1);
  const notes = (await first.getAnnotations()) as { subtype: string; fieldName?: string; fieldValue?: unknown }[];
  const words = (await first.getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join("");
  check("the saved file holds the form as filled, the marks, and the text as changed", notes.find((a) => a.fieldName === "applicant")?.fieldValue === "Ada Lovelace" && notes.some((a) => a.subtype === "Square") && notes.some((a) => a.subtype === "Ink" || a.subtype === "Stamp") && words.replace(/\s+/g, " ").includes("An application to a berth."), `${notes.map((a) => a.subtype).join()} | ${words}`);
  await read.loadingTask.destroy();

  check("a signature drawn is kept as parts of the box it fills", JSON.stringify(fitStrokes([[[10, 10], [110, 60]]])?.strokes) === "[[[0,0],[1,1]]]" && fitStrokes([[[10, 10], [110, 60]]])?.aspect === 2 && fitStrokes([[[5, 5]]]) === null);
  await press("Back to documents");
  await until(() => document.querySelector(".wf-pdf-room") === null);
}

// ------------------------------------------- kept on this device

{
  // A device to keep them on: what the app's own storage does, in memory.
  const kept = new Map<string, { name: string; bytes: Uint8Array; modified_at: number; gone: boolean }>();
  let clock = 1_700_000_000_000;
  const store = backend as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
  const meta = (id: string) => ({ id, name: kept.get(id)!.name, bytes: kept.get(id)!.bytes.length, modified_at: kept.get(id)!.modified_at });
  store.localpdfList = async () => [...kept.keys()].filter((id) => !kept.get(id)!.gone).map(meta).sort((a, b) => b.modified_at - a.modified_at);
  store.localpdfWrite = (async (id: string, name: string, bytes: Uint8Array) => {
    kept.set(id, { name, bytes: bytes.slice(), modified_at: (clock += 1000), gone: false });
    return meta(id);
  }) as never;
  store.localpdfRead = (async (id: string) => kept.get(id)!.bytes.slice()) as never;
  store.localpdfTrash = (async (id: string) => void (kept.get(id)!.gone = true)) as never;
  store.localpdfRestore = (async (id: string) => void (kept.get(id)!.gone = false)) as never;
  setPdfKeeping(true);

  const opened: string[] = [];
  const shelfRoot = createRoot(mountPoint());
  await act(async () => shelfRoot.render(createElement(PdfShelf, { onOpen: (id: string) => opened.push(id), onError: () => {} })));
  check("with nothing kept, the shelf is not shown at all", !body().includes("PDFs on this device"));

  await act(async () => usePdfDesk.getState().show({ name: "Four.pdf", bytes: FOUR }));
  await until(() => document.querySelectorAll(".wf-pdf-slot").length === 4);
  check("a PDF that was picked can be kept on this device", button("Keep on this device") !== undefined && button("Save") === undefined);
  await press("Turn right");
  await settled();
  await press("Keep on this device");
  await until(() => kept.size === 1 && button("Save") !== undefined);
  const id = [...kept.keys()][0];
  check("kept, it is on the shelf as it stands, under its name", kept.get(id)?.name === "Four.pdf" && (await wordsOf(kept.get(id)!.bytes)).startsWith("The ferry came in at dawn.@90") && usePdfDesk.getState().open?.shelfId === id && document.querySelectorAll(".wf-pdf-slot").length === 4);
  check("…and has nothing unsaved, so Save waits for a change", usePdfDesk.getState().dirty === false && button("Save")?.disabled === true);
  await until(() => body().includes("PDFs on this device"));
  check("the shelf lists it, with its size and when", body().includes("PDFs on this device") && body().includes(`PDF · ${sizeLabel(kept.get(id)!.bytes.length)}`), body().slice(-160));

  await press("Take the page out");
  await settled();
  check("a change makes Save ready", button("Save")?.disabled === false);
  await press("Save");
  await until(() => button("Save")?.disabled === true);
  check("Save writes it over the one that was kept, not beside it", kept.size === 1 && (await wordsOf(kept.get(id)!.bytes)).split("|").length === 3);
  await press("Back to documents");
  await until(() => document.querySelector(".wf-pdf-room") === null);
  check("saved, it closes without asking", usePdfDesk.getState().open === null);

  const card = [...document.querySelectorAll<HTMLButtonElement>(".wf-pdf-card .wf-doc-card-open")][0];
  await act(async () => {
    card.click();
    await wait(0);
  });
  check("a click on it opens it", opened.join() === id);
  await press("Take it off this device");
  await until(() => !body().includes("PDFs on this device"));
  check("taken off the shelf it is gone from the list, and kept thirty days to be put back", kept.get(id)?.gone === true && usePdfShelf.getState().items.length === 0);
  await act(async () => usePdfShelf.getState().restore(id));
  check("…and put back it is there again", usePdfShelf.getState().items.length === 1 && body().includes("PDFs on this device"));
  check("sizes are said as people say them", sizeLabel(340_000) === "340 KB" && sizeLabel(2_140_000) === "2.1 MB" && sizeLabel(12) === "1 KB");
  setPdfKeeping(false);
  await act(async () => shelfRoot.unmount());
}

// What is asked of a PDF that was picked.
{
  check("a file is known for a PDF by its name or its kind", looksLikePdf(new File([], "Report.PDF")) && looksLikePdf(new File([], "report", { type: "application/pdf" })) && !looksLikePdf(new File([], "report.docx")));
  const asked = pdfIntent();
  await until(() => body().includes("What would you like to do with this PDF?"));
  check("picking a PDF asks whether to edit it or make a document of it", body().includes("Edit this PDF") && body().includes("Convert to a document"));
  await press("Convert to a document");
  check("…and goes the way chosen", (await asked) === "convert");
  const again = pdfIntent();
  await until(() => body().includes("What would you like to do with this PDF?"));
  await press("Cancel");
  check("…or nowhere", (await again) === null);
  check("with no PDF open there is nothing to leave", (await leavePdf()) === true);
}

// What pdf.js needs beside itself is kept where the app serves it from.
{
  const here = join(process.cwd(), "public/pdfjs");
  const theirs = join(process.cwd(), "node_modules/pdfjs-dist");
  const list = (dir: string): string[] => readdirSync(dir).sort().filter((name) => !name.startsWith("quickjs-eval"));
  const same = ["cmaps", "standard_fonts", "wasm", "iccs"].every((dir) => {
    const a = list(join(here, dir));
    const b = list(join(theirs, dir));
    return a.length === b.length && a.every((name, k) => name === b[k] && statSync(join(here, dir, name)).size === statSync(join(theirs, dir, name)).size);
  });
  check("the data pdf.js loads (character maps, standard fonts, decoders) is the installed version's", same, "copy node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm,iccs} to public/pdfjs");
  check("…without the part that runs a PDF's own scripts, which nothing here does", !readdirSync(join(here, "wasm")).some((name) => name.startsWith("quickjs")));
}

check("each PDF opened had an engine of its own", engines >= 4, String(engines));
await act(async () => root.unmount());
finish();
