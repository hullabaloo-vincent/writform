// A picture cropped and turned a quarter (schema level 4): the sums every
// painter shares, the picture on screen and its commands, the handles,
// the page layout, a PDF that holds only the part kept, and Word files.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import JSZip from "jszip";

import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { pictureKey, makePicture, sniff, viewDrawMatrix, type PictureTools, type PdfPicture, type PictureWant } from "../src/book/engine/pictures";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import type { DLImage } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { buildDocModel } from "../src/doclayout/model";
import { readDocx } from "../src/docx/read";
import { writeDocx } from "../src/docx/write";
import { cropPicture, replacePicture, turnPicture } from "../src/editor/nodes/Image";
import { dragCrop, startCrop } from "../src/editor/nodes/imageCrop";
import { docContentExtensions } from "../src/editor/schema/content";
import { downlevelJson } from "../src/editor/schema/downlevel";
import { levels } from "../src/editor/schema/levels";
import { cropToShown, encodeCrop, mulMatrix, parseCrop, shownSize, shownToCrop, viewKey, viewMatrix, type Crop, type Matrix, type QuarterTurn } from "../src/editor/schema/sanitize";
import { imageSize } from "../src/lib/imageSize";
import { png } from "./pix";

const close = (a: number, b: number, by = 1e-6) => Math.abs(a - b) <= by;
const apply = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ------------------------------------------------------------ the sums

check("a crop is four parts", JSON.stringify(parseCrop("0.25 0 0.1 0.5")) === "[0.25,0,0.1,0.5]");
check("…and none, or one that leaves too little, is no crop", parseCrop("0 0 0 0") === null && parseCrop("0.5 0 0.5 0") === null && parseCrop("0.95 0 0 0") === null && parseCrop("a b c d") === null && parseCrop("0.1 0.1") === null);
check("written as it is read", encodeCrop([0.25, 0, 0.1, 0.5]) === "0.25 0 0.1 0.5" && encodeCrop([0, 0, 0, 0]) === null);
check("the size it shows at: the part kept, turned", JSON.stringify(shownSize(400, 200, { crop: [0.25, 0, 0.25, 0] })) === '{"w":200,"h":200}' && JSON.stringify(shownSize(400, 200, { rot: 90 })) === '{"w":200,"h":400}');
check("a picture shown otherwise is known apart", viewKey("u", null) === "u" && viewKey("u", { rot: 90 }) !== viewKey("u", { rot: 270 }) && viewKey("u", { crop: [0.1, 0, 0, 0] }).startsWith("u#"));

{
  let ok = true;
  for (let i = 0; i < 200; i += 1) {
    const c: Crop = [Math.random() * 0.4, Math.random() * 0.4, Math.random() * 0.4, Math.random() * 0.4];
    for (const rot of [null, 90, 180, 270] as (QuarterTurn | null)[]) {
      const back = shownToCrop(cropToShown(c, rot), rot);
      if (!back.every((v, j) => close(v, c[j]))) ok = false;
    }
  }
  check("a crop as seen turned, and back, is the same crop", ok);
}

{
  // The kept part's upright top-left corner lands where the turn puts it.
  const where = { 0: [0, 0], 90: [1, 0], 180: [1, 1], 270: [0, 1] } as const;
  let ok = true;
  for (const rot of [0, 90, 180, 270] as const) {
    const crop: Crop = [0.2, 0.1, 0.3, 0.25];
    const view = { crop, ...(rot ? { rot } : {}) } as const;
    const box = shownSize(400, 300, view);
    const v = viewMatrix(view, box.w, box.h);
    const [x, y] = apply(v.m, v.x + crop[0] * v.fw, v.y + crop[1] * v.fh);
    const [x2, y2] = apply(v.m, v.x + (1 - crop[2]) * v.fw, v.y + (1 - crop[3]) * v.fh);
    const [ex, ey] = where[rot];
    if (!close(x, ex * box.w, 1e-6) || !close(y, ey * box.h, 1e-6) || !close(x2, (1 - ex) * box.w, 1e-6) || !close(y2, (1 - ey) * box.h, 1e-6)) ok = false;
  }
  check("the kept part fills the box, turned the right way", ok);
}

{
  // Stored on its side (EXIF 6): the stored top-left is the upright top-right.
  const { m, dw, dh } = viewDrawMatrix(6, 100, 50, { rot: 90 });
  const [x, y] = apply(m, 0, 0);
  // Upright top-right, turned a quarter more, is the box's bottom-right.
  check("a stored picture's own turning and the document's are one", dw === 100 && dh === 50 && close(x, 100) && close(y, 50), JSON.stringify({ dw, dh, x, y }));
  const plain = viewDrawMatrix(1, 100, 50, null);
  check("…and with neither it is drawn as it is", plain.dw === 100 && plain.dh === 50 && JSON.stringify(plain.m) === JSON.stringify([1, 0, 0, 1, 0, 0]));
  check("matrices make one", JSON.stringify(mulMatrix([0, 1, -1, 0, 5, 0], [1, 0, 0, 1, 2, 3])) === JSON.stringify([0, 1, -1, 0, 2, 2]));
}

{
  check("a handle at the left takes off the left", JSON.stringify(dragCrop([0, 0, 0, 0], "w", 0.2, 0)) === "[0.2,0,0,0]");
  check("…never past the other side", dragCrop([0, 0, 0.5, 0], "w", 0.9, 0)[0] <= 0.45 + 1e-9);
  check("…nor past the edge", JSON.stringify(dragCrop([0.1, 0, 0, 0], "w", -0.5, 0)) === "[0,0,0,0]");
  check("a corner moves two sides", JSON.stringify(dragCrop([0, 0, 0, 0], "se", -0.1, -0.2)) === "[0,0,0.1,0.2]");
  const moved = dragCrop([0.1, 0.1, 0.2, 0.2], "move", 0.5, -0.5);
  check("the window moves inside the picture", close(moved[0], 0.3) && close(moved[2], 0) && close(moved[1], 0) && close(moved[3], 0.3), JSON.stringify(moved));
}

// ------------------------------------------------------------ on screen

const pic = (attrs: Record<string, unknown>): JSONContent => ({ type: "image", attrs: { src: "https://example.test/p.png", ...attrs } });
const make = (content: JSONContent[]) => new Editor({ element: mountPoint(), extensions: docContentExtensions({ resizeImages: true }), content: { type: "doc", content } });
const select = (e: Editor) => {
  let at = -1;
  e.state.doc.descendants((n, p) => {
    if (at < 0 && n.type.name === "image") at = p;
    return at < 0;
  });
  e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, at)));
  return at;
};
const attrsOf = (e: Editor) => {
  let out: Record<string, unknown> = {};
  e.state.doc.descendants((n) => {
    if (n.type.name === "image") out = n.attrs;
  });
  return out;
};

{
  const e = make([pic({ width: 100, height: 200, crop: "0.25 0 0.25 0", rot: 90, alt: "A field" })]);
  const html = e.getHTML();
  check("a picture's crop and turn are said on it", html.includes('data-crop="0.25 0 0.25 0"') && html.includes('data-rot="90"'));
  check("they need level 4", levels.ofJson(e.getJSON()) === 4);
  const plain = make([pic({ width: 100, height: 200 })]);
  check("a picture without them stays as it was", levels.ofJson(plain.getJSON()) <= 3);
  plain.destroy();
  const down = downlevelJson(e.getJSON(), 3, getSchema(docContentExtensions())).content![0];
  check("for level 3 the whole picture, upright, at its width", down.attrs?.crop === undefined && down.attrs?.rot === undefined && down.attrs?.height === null && down.attrs?.width === 100, JSON.stringify(down.attrs));

  const ink = e.view.dom.querySelector(".wf-img-ink") as HTMLElement | null;
  const region = ink?.querySelector(".wf-img-ink-region") as HTMLElement | null;
  const inner = region?.querySelector("img") as HTMLImageElement | null;
  const img = e.view.dom.querySelector("img.wf-img-viewed") as HTMLImageElement | null;
  check("drawn by a layer over its box, which is not seen", !!ink && !!img && img.style.aspectRatio.replace(/\s/g, "") === "100/200");
  check("the layer turns the kept part", region?.style.transform.includes("rotate(90deg)") === true && region.style.width === "200%" && region.style.height === "50%", region?.getAttribute("style"));
  check("…and places the whole picture so the part shows", inner?.style.left === "-50%" && inner.style.width === "200%" && inner.style.top === "0%" && inner.style.height === "100%", inner?.getAttribute("style"));

  select(e);
  turnPicture(e, 1);
  check("a quarter more: its box turns with it", attrsOf(e).rot === 180 && attrsOf(e).width === 200 && attrsOf(e).height === 100, JSON.stringify(attrsOf(e)));
  turnPicture(e, 1);
  turnPicture(e, 1);
  check("…and round to upright", attrsOf(e).rot === null && attrsOf(e).width === 200 && attrsOf(e).height === 100, JSON.stringify(attrsOf(e)));
  e.destroy();
}

{
  const e = make([pic({ width: 200, height: 100 })]);
  select(e);
  cropPicture(e, [0.25, 0, 0.25, 0]);
  check("a crop keeps the scale: the box is the part kept", attrsOf(e).crop === "0.25 0 0.25 0" && attrsOf(e).width === 100 && attrsOf(e).height === 100, JSON.stringify(attrsOf(e)));
  cropPicture(e, null);
  check("…and the whole of it again", attrsOf(e).crop === null && attrsOf(e).width === 200 && attrsOf(e).height === 100);
  turnPicture(e, 1);
  cropPicture(e, [0, 0.5, 0, 0]);
  check("cropped while turned, the box follows the turned picture", attrsOf(e).width === 50 && attrsOf(e).height === 200, JSON.stringify(attrsOf(e)));
  check("…as one step to undo each", e.can().undo());
  e.destroy();
}

{
  const e = make([pic({ width: 200, height: 100, crop: "0.1 0 0 0", rot: 90, alt: "Shown", caption: "Under", bdr: "1 #ff0000" })]);
  select(e);
  replacePicture(e, "https://example.test/new.png", { w: 300, h: 600 });
  const a = attrsOf(e);
  check("another picture in its place: its width, words and border stay", a.src === "https://example.test/new.png" && a.width === 200 && a.alt === "Shown" && a.caption === "Under" && a.bdr === "1 #ff0000", JSON.stringify(a));
  check("…its height is the new picture's, and the crop and turn go", a.height === 400 && a.crop === null && a.rot === null);
  e.destroy();
}

{
  // The handles, with a stand-in layout: the box is 200 by 100 on screen.
  const e = make([pic({ width: 200, height: 100 })]);
  select(e);
  const img = e.view.dom.querySelector("img") as HTMLImageElement;
  img.getBoundingClientRect = () => ({ x: 50, y: 40, left: 50, top: 40, right: 250, bottom: 140, width: 200, height: 100, toJSON: () => ({}) });
  let ended = 0;
  const stop = startCrop(e, () => (ended += 1));
  const root = document.querySelector(".wf-crop") as HTMLElement | null;
  check("cropping shows the whole picture over its place", !!stop && !!root && root.style.left === "50px" && root.style.width === "200px", root?.getAttribute("style"));
  check("…with eight handles", document.querySelectorAll(".wf-crop-grip").length === 8);
  const grip = document.querySelector('.wf-crop-grip[data-grip="w"]') as HTMLElement;
  const fire = (type: string, target: Element, x: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 60, button: 0 }));
  fire("pointerdown", grip, 50);
  fire("pointermove", root!, 100);
  fire("pointerup", root!, 100);
  const win = document.querySelector(".wf-crop-window") as HTMLElement;
  check("a handle dragged in takes off that side", win.style.left === "25%" && win.style.width === "75%", win.getAttribute("style"));
  check("nothing changes before Done", attrsOf(e).crop === null);
  const done = [...document.querySelectorAll(".wf-crop-bar button")].find((b) => b.textContent === "Done") as HTMLButtonElement;
  done.click();
  check("Done crops it, at the scale it had", attrsOf(e).crop === "0.25 0 0 0" && attrsOf(e).width === 150 && attrsOf(e).height === 100, JSON.stringify(attrsOf(e)));
  check("…and the handles go", !document.querySelector(".wf-crop") && ended === 1);

  select(e);
  startCrop(e);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape leaves it as it was", !document.querySelector(".wf-crop") && attrsOf(e).crop === "0.25 0 0 0");
  e.destroy();
}

// ------------------------------------------------------------ on paper

const session = new TypesetSession();
const URL_ = "https://example.test/p.png";
const docOf = (attrs: Record<string, unknown>) => buildDocModel({ type: "doc", content: [{ type: "image", attrs: { src: URL_, ...attrs } }] }, { title: "Pictures", author: "", date: "", settings: { ...DEFAULT_SETTINGS } });
const layOut = async (attrs: Record<string, unknown>) => {
  const model = docOf(attrs);
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req = { kind: "document", doc: model, families: model.families, images: [{ url: URL_, w: 400, h: 200 }] } as DocRequest;
  const { dl } = await session.layout(req);
  return { req, image: dl.pages[0].items.find((it): it is DLImage => it.t === "image") };
};

{
  const cropped = (await layOut({ crop: "0.25 0 0.25 0" })).image!;
  check("a cropped picture at its own size is the part kept", close(cropped.w, cropped.h, 0.01) && JSON.stringify(cropped.crop) === "[0.25,0,0.25,0]", JSON.stringify(cropped));
  const turned = (await layOut({ rot: 90 })).image!;
  check("a turned one stands the other way", close(turned.h, turned.w * 2, 0.01) && turned.rot === 90);
  const plain = (await layOut({})).image!;
  check("a picture shown whole says nothing of either", plain.crop === undefined && plain.rot === undefined);
}

{
  const { req } = await layOut({ crop: "0.25 0 0.25 0", width: 200, height: 200 });
  const asked: PictureWant[] = [];
  const pixels = new Uint8Array(4 * 4 * 3).fill(200);
  const source = async (want: PictureWant[]) => {
    asked.push(...want);
    return new Map<string, PdfPicture>(want.map((w) => [w.key ?? w.url, { kind: "rgb", bytes: pixels, w: 4, h: 4 }]));
  };
  const made = await session.pdf(req, () => {}, source);
  const text = new TextDecoder("latin1").decode(made.bytes);
  check("a PDF asks for the part kept, by its own name", asked.length === 1 && asked[0].url === URL_ && JSON.stringify(asked[0].view) === '{"crop":[0.25,0,0.25,0]}' && asked[0].key === pictureKey({ ref: URL_, crop: [0.25, 0, 0.25, 0] }), JSON.stringify(asked));
  check("…and draws what it is given", (text.match(/\/Subtype \/Image/g) ?? []).length === 1);

  // Given the file itself (as a test may), a cropped picture is left out
  // rather than the whole of it put in.
  const whole = png(8, 4, () => [10, 20, 30, 255]);
  const given = { ...req, images: [{ url: URL_, w: 400, h: 200, bytes: whole }] } as DocRequest;
  const left = new TextDecoder("latin1").decode((await session.pdf(given)).bytes);
  check("a PDF never holds the whole of a cropped picture", !left.includes("/Subtype /Image"));
}

{
  // Made for a PDF: only the part kept, never the file, at any quality.
  const file = png(40, 20, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const info = sniff(file)!;
  const draws: { w: number; h: number; view: unknown }[] = [];
  const tools: PictureTools = {
    async draw(_bytes, _type, w, h, _o, _white, view) {
      draws.push({ w, h, view: view ?? null });
      return { pixels: () => new Uint8ClampedArray(w * h * 4).fill(255), jpeg: async () => new Uint8Array(10), free() {} };
    },
  };
  const kept = await makePicture(file, info, { w: 40, h: 20 }, "original", {}, tools);
  check("a picture shown whole may go in as its file", kept instanceof Uint8Array && draws.length === 0);
  const cut = await makePicture(file, info, { w: 20, h: 20 }, "original", { view: { crop: [0.5, 0, 0, 0] } }, tools);
  check("one cropped is drawn, the part kept alone", !(cut instanceof Uint8Array) && draws.length === 1 && draws[0].w === 20 && draws[0].h === 20 && JSON.stringify(draws[0].view) === '{"crop":[0.5,0,0,0]}', JSON.stringify(draws));
  await makePicture(file, info, { w: 20, h: 40 }, "original", { view: { rot: 90 } }, tools);
  check("one turned is drawn turned", draws[1]?.w === 20 && draws[1].h === 40);
}

// ------------------------------------------------------------ Word

{
  const bytes = png(40, 20, () => [0, 128, 0, 255]);
  const images = new Map([[URL_, { bytes, type: "image/png", ...imageSize(bytes)! }]]);
  const doc: JSONContent = { type: "doc", content: [pic({ src: URL_, width: 100, height: 50, crop: "0.25 0 0.25 0.1", rot: 90 })] };
  const written = await writeDocx(doc, { title: "Pictures", format: "none", images });
  const main = await (await JSZip.loadAsync(written.bytes)).file("word/document.xml")!.async("string");
  check("Word gets the part kept", main.includes('<a:srcRect l="25000" t="0" r="25000" b="10000"/>'));
  check("…and the turn, its box the picture's before it is turned", main.includes('<a:xfrm rot="5400000">') && main.includes('<wp:extent cx="476250" cy="952500"/>') && main.includes("<wp:effectExtent"), main.slice(main.indexOf("<wp:inline"), main.indexOf("<wp:inline") + 220));
  const back = (await readDocx(written.bytes)).content.content!.find((n) => n.type === "image")!;
  check("read back as it was", back.attrs?.crop === "0.25 0 0.25 0.1" && back.attrs?.rot === 90 && back.attrs?.width === 100 && back.attrs?.height === 50, JSON.stringify(back.attrs));
}

finish();
