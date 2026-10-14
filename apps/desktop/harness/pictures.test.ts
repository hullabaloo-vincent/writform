// Pictures on their way into a PDF: what a file is read to be, what is
// decided for the size it prints at, what a camera wrote that is left out,
// and what the file ends up holding (read back with pdf.js, pixel for pixel
// where nothing was meant to be lost).

import { check, finish } from "./env";
import "./dom";

import { writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import PDFDocument from "pdfkit";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

import { FaceSet } from "../src/book/engine/faces";
import {
  cleanJpeg,
  filterRows,
  jpegProfile,
  keptPicture,
  makePicture,
  orientationMatrix,
  planes,
  planPicture,
  RAW_PIXELS,
  sayUpright,
  sniff,
  storedSize,
  type PdfPicture,
  type PictureTools,
  type RawPicture,
} from "../src/book/engine/pictures";
import type { DisplayList, DLItem, DLPage } from "../src/book/engine/types";
import { loadFontFiles } from "../src/book/fonts/files";
import { renderPdf } from "../src/book/render/pdf";
import { fakeProfile, GRAY_JPEG, join, latin, png, pngProfile, QUAD_JPEG, QUAD_PROGRESSIVE, unfilter, withExif, withPart, withProfile } from "./pix";

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const holds = (hay: Uint8Array, needle: Uint8Array | string) => Buffer.from(hay).indexOf(typeof needle === "string" ? Buffer.from(needle, "latin1") : Buffer.from(needle)) >= 0;

// A drawing: two flat colours. A photograph: no two neighbours alike.
const flatPixel = (x: number, y: number) => (x < 6 && y < 5 ? [200, 40, 40] : [250, 250, 240]);
const noisyPixel = (x: number, y: number) => [(x * 37 + y * 91) & 255, (x * 113 + y * 7) & 255, (x * 59 + y * 151) & 255];
const DRAWING = png(12, 10, flatPixel);
const PHOTO_PNG = png(12, 10, noisyPixel);
const CUTOUT = png(12, 10, (x, y) => [...flatPixel(x, y), x < 3 ? 0 : x < 6 ? 128 : 255], { alpha: true });

// ------------------------------------------------------------- reading

{
  const drawing = sniff(DRAWING);
  check("a PNG says its size, and that the writer can take it as it is", drawing?.type === "png" && drawing.w === 12 && drawing.h === 10 && drawing.plain && !drawing.alpha && drawing.orientation === 1, JSON.stringify(drawing));
  const cutout = sniff(CUTOUT);
  check("one that is see-through has to be drawn first", !!cutout && cutout.alpha && !cutout.plain);
  const keyed = sniff(png(4, 4, flatPixel, { chunks: [["tRNS", Uint8Array.of(0, 250, 0, 250, 0, 240)]] }));
  check("…as has one with a colour that stands for nothing", !!keyed && keyed.alpha && !keyed.plain);
  check("…and one stored in passes, or sixteen bits deep", sniff(png(4, 4, flatPixel, { interlaced: true }))?.plain === false && sniff(png(4, 4, flatPixel, { deep: true }))?.plain === false);
  check("a PNG in a screen's own colours is drawn, so they are converted", sniff(png(4, 4, flatPixel, { chunks: [pngProfile("Display P3")] }))?.plain === false);
  check("…one that says it is in the usual colours is not", sniff(png(4, 4, flatPixel, { chunks: [pngProfile("sRGB IEC61966-2.1")] }))?.plain === true);

  const quad = sniff(QUAD_JPEG);
  check("a JPEG says its size", quad?.type === "jpeg" && quad.w === 16 && quad.h === 8 && quad.plain && quad.orientation === 1 && !quad.orientAt && !quad.gray, JSON.stringify(quad));
  check("…one that sharpens as it loads too", sniff(QUAD_PROGRESSIVE)?.plain === true && sniff(QUAD_PROGRESSIVE)?.w === 16);
  check("…and one in greys", sniff(GRAY_JPEG)?.gray === true && sniff(GRAY_JPEG)?.plain === true && sniff(GRAY_JPEG)?.w === 8);

  const pdfkit = new PDFDocument({ font: null, autoFirstPage: false } as never) as unknown as { openImage(b: Uint8Array): { orientation: number; width: number; height: number } };
  let agreed = true;
  for (const little of [true, false]) {
    for (let o = 1; o <= 8; o += 1) {
      const info = sniff(withExif(QUAD_JPEG, o, little));
      const turned = o > 4;
      if (!info || info.orientation !== o || info.w !== (turned ? 8 : 16) || info.h !== (turned ? 16 : 8) || !info.orientAt || !info.plain) agreed = false;
      const theirs = pdfkit.openImage(withExif(QUAD_JPEG, o, little));
      if (theirs.orientation !== o || theirs.width !== 16) agreed = false;
    }
  }
  check("a photograph taken on its side says how it is turned, and its size is as it is shown (in either byte order, as the writer reads it too)", agreed);
  check("a turning that makes no sense is none", sniff(withExif(QUAD_JPEG, 9))?.orientation === 1 && sniff(withExif(QUAD_JPEG, 0))?.w === 16);
  check("stored, a turned picture is its own way up", JSON.stringify(storedSize(sniff(withExif(QUAD_JPEG, 6))!)) === JSON.stringify({ w: 16, h: 8 }));

  // (Only the header is changed: such a file is read, never drawn.)
  const frame = Buffer.from(QUAD_JPEG).indexOf(Buffer.from([0xff, 0xc0]));
  const inks = QUAD_JPEG.slice();
  inks[frame + 9] = 4;
  const twelve = QUAD_JPEG.slice();
  twelve[frame + 4] = 12;
  check("a JPEG in four inks, or twelve bits deep, has to be drawn first", sniff(inks)?.plain === false && sniff(twelve)?.plain === false);
  const gif = join(latin("GIF89a"), Uint8Array.of(40, 0, 30, 0), new Uint8Array(20));
  check("a GIF says its size, and is always drawn", sniff(gif)?.type === "gif" && sniff(gif)?.w === 40 && sniff(gif)?.h === 30 && sniff(gif)?.plain === false);
  check("anything else is not a picture", sniff(latin("%PDF-1.4 and so on, for long enough")) === null && sniff(QUAD_JPEG.subarray(0, 40)) === null && sniff(new Uint8Array(3)) === null);
}

// --------------------------------------------- what a camera wrote, left out

{
  const profile = fakeProfile();
  const camera = join(withPart(withProfile(withExif(QUAD_JPEG, 6), profile), 0xfe, latin("Shot on a phone")), latin("A SECOND PICTURE AFTER THE FIRST"));
  const clean = cleanJpeg(camera);
  check("a JPEG is tidied to its picture alone: byte for byte the picture it was", same(clean, QUAD_JPEG), `${clean.length} against ${QUAD_JPEG.length}`);
  check("…with nothing of where it was taken, no comment, and nothing after its end", !holds(clean, "51.5074") && !holds(clean, "Shot on") && !holds(clean, "SECOND") && holds(camera, "51.5074"));
  check("one with nothing to leave out is the same bytes, not a copy", cleanJpeg(QUAD_JPEG) === QUAD_JPEG);
  check("one that sharpens as it loads keeps every pass", same(cleanJpeg(join(withExif(QUAD_PROGRESSIVE, 3), latin("TRAILING"))), QUAD_PROGRESSIVE));
  check("what is not a JPEG is left as it is", cleanJpeg(DRAWING) === DRAWING);

  check("its colour profile is read whole", same(jpegProfile(camera, 3) ?? [], profile));
  const big = fakeProfile("RGB ", 900);
  check("…from several pieces, in whatever order they come", same(jpegProfile(withProfile(QUAD_JPEG, big, 3, [1, 2, 0]), 3) ?? [], big));
  const two = withProfile(QUAD_JPEG, big, 3, [2, 0]);
  check("…and not at all with a piece missing", jpegProfile(two, 3) === null);
  check("a profile for another kind of picture is not this one's", jpegProfile(withProfile(QUAD_JPEG, fakeProfile("GRAY")), 3) === null && !!jpegProfile(withProfile(GRAY_JPEG, fakeProfile("GRAY")), 1));
  check("no profile: none", jpegProfile(QUAD_JPEG, 3) === null);
  check("one too new for a PDF, or not a device's, is not carried", jpegProfile(withProfile(QUAD_JPEG, fakeProfile("RGB ", 200, 5)), 3) === null && jpegProfile(withProfile(QUAD_JPEG, fakeProfile("RGB ", 200, 4, "link")), 3) === null && !!jpegProfile(withProfile(QUAD_JPEG, fakeProfile("RGB ", 200, 4, "scnr")), 3));

  for (const little of [true, false]) {
    const turned = withExif(QUAD_JPEG, 6, little);
    const info = sniff(turned)!;
    const upright = sayUpright(turned, info);
    const now = sniff(upright);
    check(`a turned JPEG can be told it is upright (${little ? "one" : "the other"} byte order), in a copy`, now?.orientation === 1 && now.w === 16 && upright !== turned && sniff(turned)?.orientation === 6 && upright.length === turned.length);
  }
  check("an upright one is left alone", sayUpright(QUAD_JPEG, sniff(QUAD_JPEG)!) === QUAD_JPEG);
}

// ------------------------------------------------------------- turning

{
  // Where the stored picture's first corner and the end of its first row
  // land once it is shown the right way up (what EXIF's eight values mean).
  const corners: Record<number, [string, string]> = {
    1: ["TL", "TR"],
    2: ["TR", "TL"],
    3: ["BR", "BL"],
    4: ["BL", "BR"],
    5: ["TL", "BL"],
    6: ["TR", "BR"],
    7: ["BR", "TR"],
    8: ["BL", "TL"],
  };
  const sw = 16;
  const sh = 8;
  let right = true;
  for (let o = 1; o <= 8; o += 1) {
    const turned = o > 4;
    const w = turned ? sh : sw;
    const h = turned ? sw : sh;
    const [a, b, c, d, e, f] = orientationMatrix(o, w, h);
    const at = (x: number, y: number) => `${a * x + c * y + e === 0 ? "" : ""}${b * x + d * y + f === 0 ? "T" : "B"}${a * x + c * y + e === 0 ? "L" : "R"}`;
    // The whole picture stays on the sheet too.
    const far = [a * sw + c * sh + e, b * sw + d * sh + f];
    const inside = [0, w].includes(far[0]) && [0, h].includes(far[1]);
    if (at(0, 0) !== corners[o][0] || at(sw, 0) !== corners[o][1] || !inside) right = false;
  }
  check("each of the eight ways a photograph can be turned lands the right way up", right);
}

// ------------------------------------------------------------ deciding

{
  const photo = { type: "jpeg" as const, w: 3000, h: 2000, orientation: 1, alpha: false, plain: true };
  const sixInches = { w: 432, h: 288 };
  const forPrint = planPicture(photo, sixInches, "print");
  check("a photograph with more pixels than paper shows is brought to 300 an inch", forPrint.act === "draw" && forPrint.w === 1800 && forPrint.h === 1200 && forPrint.fallback && !forPrint.photoOnly && forPrint.jpeg === 0.9, JSON.stringify(forPrint));
  const forScreen = planPicture(photo, sixInches, "screen");
  check("…and to 150 for a screen, pressed harder", forScreen.act === "draw" && forScreen.w === 900 && forScreen.h === 600 && forScreen.jpeg === 0.75, JSON.stringify(forScreen));
  check("asked for as it is, it is left as it is", planPicture(photo, sixInches, "original").act === "keep");
  check("a little over is not worth encoding it a second time", planPicture({ ...photo, w: 2400, h: 1600 }, sixInches, "print").act === "keep" && planPicture({ ...photo, w: 2400, h: 1600 }, sixInches, "screen").act === "draw");
  const turned = planPicture({ ...photo, w: 2000, h: 3000, orientation: 6 }, { w: 288, h: 432 }, "print");
  check("a turned one is measured as it is shown", turned.act === "draw" && turned.w === 1200 && turned.h === 1800, JSON.stringify(turned));
  const small = planPicture({ ...photo, type: "png" }, { w: 2000, h: 1333 }, "print");
  check("a PNG that is not too large is looked at (a photograph saved as one is worth making a JPEG)", small.act === "draw" && small.photoOnly && small.fallback && small.w === 3000, JSON.stringify(small));
  const cutout = planPicture({ ...photo, type: "png", alpha: true, plain: false }, sixInches, "original");
  check("what the writer cannot take is drawn even when nothing was asked of it, at its own size", cutout.act === "draw" && cutout.w === 3000 && !cutout.fallback && cutout.jpeg === 0.95, JSON.stringify(cutout));
  const huge = planPicture({ ...photo, type: "png", w: 8000, h: 6000, alpha: true, plain: false }, sixInches, "original");
  check("…but never with more pixels than a canvas holds", huge.act === "draw" && huge.w * huge.h <= 16_000_000 && Math.abs(huge.w / huge.h - 8000 / 6000) < 0.01, JSON.stringify(huge));
  const phone = planPicture({ ...photo, type: "png", w: 8000, h: 6000, alpha: true, plain: false }, sixInches, "original", { maxPixels: 5_000_000 });
  check("…and fewer on a phone", phone.act === "draw" && phone.w * phone.h <= 5_000_000);
  check("a huge photograph kept as it is never meets a canvas", planPicture({ ...photo, w: 12000, h: 9000 }, sixInches, "original").act === "keep");
  check("a size of nothing changes nothing", planPicture(photo, { w: 0, h: 0 }, "print").act === "keep");
}

// ------------------------------------------------- pixels, and packing them

{
  const rgba = new Uint8ClampedArray(12 * 10 * 4);
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 12; x += 1) rgba.set([...flatPixel(x, y), 255], (y * 12 + x) * 4);
  const drawing = planes(rgba, 12, 10);
  check("pixels come apart into colours, with nothing said of what shows through where nothing does", drawing.rgb.length === 360 && drawing.alpha === null && drawing.rgb[0] === 200 && drawing.rgb[359] === 240);
  check("a drawing is known for one (most pixels are their neighbour's colour)", drawing.flat);
  const noise = new Uint8ClampedArray(12 * 10 * 4);
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 12; x += 1) noise.set([...noisyPixel(x, y), x === 0 ? 100 : 255], (y * 12 + x) * 4);
  const photo = planes(noise, 12, 10);
  check("a photograph is not, and what shows through is kept beside its colours", !photo.flat && photo.alpha?.length === 120 && photo.alpha[0] === 100 && photo.alpha[1] === 255);

  // A slope of colour: each pixel a little more than the one before.
  const slope = new Uint8Array(64 * 40 * 3);
  for (let y = 0; y < 40; y += 1) for (let x = 0; x < 64; x += 1) slope.set([x * 3 + y, x * 2 + y * 2, 255 - x * 3], (y * 64 + x) * 3);
  const rows = filterRows(slope, 64, 3);
  check("rows are written as they differ from their neighbours, and come back exactly", rows.length === 40 * (64 * 3 + 1) && same(unfilter(new Uint8Array(deflateSync(rows)), 64, 3), slope));
  check("…which packs far smaller than the pixels as they are", deflateSync(rows).length < deflateSync(slope).length * 0.6, `${deflateSync(rows).length} against ${deflateSync(slope).length}`);
  const types = new Set(Array.from({ length: 40 }, (_, y) => rows[y * 193]));
  check("…each row in the way that suits it", types.size >= 1 && [...types].every((t) => t === 0 || t === 1 || t === 2) && rows[0] === 1, [...types].join(" "));
  const mask = new Uint8Array(30).fill(255);
  check("one number a pixel packs the same way", same(unfilter(new Uint8Array(deflateSync(filterRows(mask, 6, 1))), 6, 1), mask));
}

// -------------------------------------------------------------- making

/** A canvas that is not one: it says what it was asked, and draws what the
 *  test gives it. */
const fakeTools = (pixel: (x: number, y: number) => number[], jpegBytes: (w: number, h: number, quality: number) => number) => {
  const log = { draws: [] as { bytes: Uint8Array; type: string; w: number; h: number; orientation: number; white: boolean }[], jpegs: [] as { quality: number; opaque: boolean | null }[], freed: 0 };
  const tools: PictureTools = {
    async draw(bytes, type, w, h, orientation, white) {
      log.draws.push({ bytes, type, w, h, orientation, white });
      return {
        pixels() {
          const out = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const p = pixel(x, y);
              out.set([p[0], p[1], p[2], white ? 255 : (p[3] ?? 255)], (y * w + x) * 4);
            }
          }
          return out;
        },
        async jpeg(quality, opaque) {
          log.jpegs.push({ quality, opaque: opaque ? Array.prototype.every.call(opaque, (v: number, i: number) => i % 4 !== 3 || v === 255) : null });
          return new Uint8Array(jpegBytes(w, h, quality)).fill(7);
        },
        free() {
          log.freed += 1;
        },
      };
    },
  };
  return { tools, log };
};
const raw = (p: PdfPicture): RawPicture | null => (p instanceof Uint8Array ? null : p);

await (async () => {
  const big = { w: 3000, h: 1500 };
  // A photograph far larger than it prints (its header says so: only its
  // header is read here).
  const bigJpeg = QUAD_JPEG.slice();
  const frame = Buffer.from(bigJpeg).indexOf(Buffer.from([0xff, 0xc0]));
  bigJpeg.set([1500 >> 8, 1500 & 255, 3000 >> 8, 3000 & 255], frame + 5);
  const info = sniff(bigJpeg)!;
  check("(a photograph of 3,000 by 1,500 to work with)", info.w === big.w && info.h === big.h);

  {
    const { tools, log } = fakeTools(noisyPixel, () => 300);
    const made = raw(await makePicture(bigJpeg, info, { w: 360, h: 180 }, "print", {}, tools));
    check("a photograph too large for its place is drawn at 300 pixels an inch and encoded once", made?.kind === "jpeg" && made.w === 1500 && made.h === 750 && made.bytes.length === 300 && log.draws.length === 1 && log.draws[0].w === 1500 && log.draws[0].white && log.jpegs[0].quality === 0.9 && log.freed === 1, JSON.stringify(log.draws.map((d) => [d.w, d.h])));
    check("…with no profile and no turning to carry", !made?.icc && !made?.orientation && !made?.alpha);
  }
  {
    const { tools, log } = fakeTools(noisyPixel, () => 5000);
    const made = raw(await makePicture(bigJpeg, info, { w: 360, h: 180 }, "print", {}, tools));
    check("made smaller yet no smaller a file: the picture it was goes in", made?.kind === "jpeg" && made.w === 3000 && same(made.bytes, bigJpeg) && log.freed === 1);
  }
  {
    const { tools, log } = fakeTools(noisyPixel, () => 300);
    const camera = withProfile(withExif(QUAD_JPEG, 6), fakeProfile());
    const made = raw(await makePicture(camera, sniff(camera)!, { w: 72, h: 144 }, "print", {}, tools));
    check("a photograph that is good enough is not drawn at all", log.draws.length === 0 && made?.kind === "jpeg");
    check("…it goes in tidied, with how it is turned and its colours said beside it", !!made && same(made.bytes, QUAD_JPEG) && made.orientation === 6 && made.w === 16 && made.h === 8 && made.icc?.length === 200);
    const grey = raw(await makePicture(GRAY_JPEG, sniff(GRAY_JPEG)!, { w: 72, h: 72 }, "original", {}, tools));
    check("…one in greys as greys", grey?.gray === true && same(grey.bytes, GRAY_JPEG));
  }
  {
    const { tools, log } = fakeTools(noisyPixel, () => 300);
    const turned = withExif(bigJpeg, 8, false);
    const made = raw(await makePicture(turned, sniff(turned)!, { w: 180, h: 360 }, "print", {}, tools));
    const drawn = log.draws[0];
    check("a turned photograph that is drawn is drawn as shown, from a file told it is upright", drawn.w === 750 && drawn.h === 1500 && drawn.orientation === 8 && sniff(drawn.bytes)?.orientation === 1 && made?.w === 750 && made.h === 1500 && !made.orientation, JSON.stringify([drawn.w, drawn.h, drawn.orientation]));
  }
  {
    const { tools, log } = fakeTools(flatPixel, () => 10);
    const made = await makePicture(DRAWING, sniff(DRAWING)!, { w: 144, h: 120 }, "print", {}, tools);
    check("a drawing saved as a PNG goes in as the file it is", made === DRAWING && log.draws.length === 1 && log.jpegs.length === 0 && log.freed === 1);
    const kept = await makePicture(DRAWING, sniff(DRAWING)!, { w: 144, h: 120 }, "original", {}, tools);
    check("…and asked for as it is, it is not even looked at", kept === DRAWING && log.draws.length === 1);
  }
  {
    const { tools, log } = fakeTools(noisyPixel, () => 60);
    const made = raw(await makePicture(PHOTO_PNG, sniff(PHOTO_PNG)!, { w: 144, h: 120 }, "print", {}, tools));
    check("a photograph saved as a PNG becomes a JPEG where that is smaller", made?.kind === "jpeg" && made.bytes.length === 60 && made.w === 12 && !log.draws[0].white && log.jpegs[0].opaque === null);
    const { tools: dear } = fakeTools(noisyPixel, () => 5000);
    check("…and stays the file it is where it is not", (await makePicture(PHOTO_PNG, sniff(PHOTO_PNG)!, { w: 144, h: 120 }, "screen", {}, dear)) === PHOTO_PNG);
  }
  {
    // 1,200 by 1,000 pixels in a place two inches wide.
    const wide = png(4, 4, flatPixel).slice();
    wide.set([0, 0, 1200 >> 8, 1200 & 255, 0, 0, 1000 >> 8, 1000 & 255], 16);
    const { tools, log } = fakeTools((x, y) => flatPixel(x / 50, y / 50), () => 10);
    const made = raw(await makePicture(wide, sniff(wide)!, { w: 144, h: 120 }, "print", {}, tools));
    check("a drawing too large for its place is made smaller and kept pixel for pixel", made?.kind === "rgb" && made.w === 600 && made.h === 500 && made.bytes.length === 600 * 500 * 3 && !made.alpha && log.jpegs.length === 0);
    check("…with the file it came from beside it, for the writer to weigh", made?.file === wide);
  }
  {
    const { tools, log } = fakeTools((x, y) => [...flatPixel(x, y), x < 3 ? 0 : 255], () => 10);
    const made = raw(await makePicture(CUTOUT, sniff(CUTOUT)!, { w: 144, h: 120 }, "print", {}, tools));
    check("a see-through drawing keeps what shows through, beside its colours", made?.kind === "rgb" && made.alpha?.length === 120 && made.alpha[0] === 0 && made.alpha[5] === 255 && !made.file && !log.draws[0].white);
    const flat = raw(await makePicture(CUTOUT, sniff(CUTOUT)!, { w: 144, h: 120 }, "print", { flatten: true }, tools));
    check("for a press it is drawn on white, and nothing shows through", flat?.kind === "rgb" && !flat.alpha && log.draws[1].white);
  }
  {
    const { tools, log } = fakeTools((x, y) => [...noisyPixel(x, y), x < 3 ? 40 : 255], () => 60);
    const made = raw(await makePicture(CUTOUT, sniff(CUTOUT)!, { w: 144, h: 120 }, "screen", {}, tools));
    check("a see-through photograph is a JPEG of its colours as they are, with what shows through beside it", made?.kind === "jpeg" && made.alpha?.[0] === 40 && log.jpegs[0].opaque === true && log.jpegs[0].quality === 0.75);
  }
  {
    const broken: PictureTools = {
      async draw() {
        throw new Error("cannot read it");
      },
    };
    let said = "";
    await makePicture(CUTOUT, sniff(CUTOUT)!, { w: 10, h: 10 }, "print", {}, broken).catch((e) => (said = String(e)));
    check("a picture that cannot be drawn says so (and is left out by whoever asked)", said.includes("cannot read"));
    check("(a page of pixels is what is kept exactly, at most)", RAW_PIXELS >= 2550 * 3300);
  }
  {
    const kept = raw(keptPicture(withExif(QUAD_JPEG, 3), sniff(withExif(QUAD_JPEG, 3))!));
    check("the file itself, for the writer: a JPEG tidied, a PNG as it is", kept?.orientation === 3 && same(kept.bytes, QUAD_JPEG) && keptPicture(DRAWING, sniff(DRAWING)!) === DRAWING);
  }
})();

// ----------------------------------------------------------- in the file

const faces = new FaceSet(await loadFontFiles(["garamond"]));
const regular = faces.face("garamond", "regular");
const picture = (ref: string, x: number, y: number, w: number, h: number, more: Partial<Extract<DLItem, { t: "image" }>> = {}): DLItem => ({ t: "image", x, y, w, h, ref, ...more });
const sheet = (n: number, items: DLItem[]): DLPage => ({ n, folio: String(n), side: n % 2 ? "recto" : "verso", role: "body", section: 0, items });
const listOf = (...pages: DLItem[][]): DisplayList => ({
  trim: { w: 612, h: 792 },
  faces: faces.faces,
  meta: { title: "Pictures", author: "", subject: "", lang: "en-US" },
  warnings: [],
  insideMargin: 1,
  sections: [],
  pages: pages.map((items, i) => sheet(i + 1, [{ t: "text", x: 72, y: 60, face: regular, size: 12, text: `Page ${i + 1}` }, ...items])),
});
const fonts = faces.faces.map((_, i) => faces.font(i));

interface Drawn {
  w: number;
  h: number;
  /** Red, green and blue of each pixel (and how opaque, where the file says). */
  rgb: number[][];
  alpha: number[] | null;
  /** Where the stored picture's corners land on the page (points, from the top left). */
  corners: { tl: number[]; tr: number[]; bl: number[] };
}
/** Every picture drawn on a page, as a reader of the file finds it. */
const drawnOn = async (bytes: Uint8Array, pageNo = 1): Promise<Drawn[]> => {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const page = await pdf.getPage(pageNo);
  const ops = await page.getOperatorList();
  const height = page.view[3];
  const out: Drawn[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() ?? m;
    else if (fn === OPS.transform) m = mul(m, args as number[]);
    else if (fn === OPS.paintImageXObject) {
      const id = args[0] as string;
      const image = await new Promise<{ width: number; height: number; kind: number; data: Uint8Array }>((resolve) => (id.startsWith("g_") ? page.commonObjs : page.objs).get(id, resolve));
      const parts = image.kind === 3 ? 4 : image.kind === 2 ? 3 : 1;
      const rgb: number[][] = [];
      const alpha: number[] = [];
      for (let p = 0; p < image.width * image.height; p += 1) {
        const at = p * parts;
        rgb.push(parts === 1 ? [image.data[at], image.data[at], image.data[at]] : [image.data[at], image.data[at + 1], image.data[at + 2]]);
        if (parts === 4) alpha.push(image.data[at + 3]);
      }
      // A picture fills the square from (0, 0) to (1, 1), its top at 1.
      const to = (x: number, y: number) => [Math.round(m[0] * x + m[2] * y + m[4]), Math.round(height - (m[1] * x + m[3] * y + m[5]))];
      out.push({ w: image.width, h: image.height, rgb, alpha: parts === 4 ? alpha : null, corners: { tl: to(0, 1), tr: to(1, 1), bl: to(0, 0) } });
    }
  }
  return out;
};
const count = (bytes: Uint8Array, what: string) => Buffer.from(bytes).toString("latin1").split(what).length - 1;
const near = (a: number[], b: number[], by = 40) => a.every((v, i) => Math.abs(v - b[i]) <= by);
const RED = [230, 30, 30];
const GREEN = [30, 200, 30];
const BLUE = [30, 30, 230];
const dump = process.env.WF_DUMP;

await (async () => {
  // A JPEG as it is.
  const camera = withProfile(withExif(QUAD_JPEG, 6), fakeProfile());
  const kept = keptPicture(camera, sniff(camera)!);
  const upright = keptPicture(QUAD_JPEG, sniff(QUAD_JPEG)!);
  const bytes = await renderPdf(
    listOf([picture("upright", 72, 100, 160, 80), picture("turned", 72, 300, 80, 160), picture("upright", 300, 100, 80, 40)]),
    fonts,
    new Map<string, PdfPicture>([
      ["upright", upright],
      ["turned", kept],
    ]),
    undefined,
    { color: "rgb" },
  );
  if (dump) writeFileSync(path.join(dump, "pictures-jpeg.pdf"), bytes);
  const drawn = await drawnOn(bytes);
  check("a JPEG is in the file byte for byte, not encoded again", holds(bytes, QUAD_JPEG) && count(bytes, "/DCTDecode") === 2, `${count(bytes, "/DCTDecode")} JPEGs`);
  check("…and nothing of what the camera wrote beside it", !holds(bytes, "51.5074") && !holds(bytes, "Exif"));
  check("a picture drawn twice is in the file once", drawn.length === 3 && count(bytes, "/Subtype /Image") === 2, `${count(bytes, "/Subtype /Image")} pictures`);
  const first = drawn[0];
  check("its pixels are the picture's own", first.w === 16 && first.h === 8 && near(first.rgb[0], RED) && near(first.rgb[15], GREEN) && near(first.rgb[7 * 16], BLUE), JSON.stringify([first.rgb[0], first.rgb[15], first.rgb[7 * 16]]));
  check("…set where the page puts it", JSON.stringify(first.corners) === JSON.stringify({ tl: [72, 100], tr: [232, 100], bl: [72, 180] }), JSON.stringify(first.corners));
  const turned = drawn[1];
  // Turned a quarter to the right: the stored top left is the shown top
  // right, and the stored top edge runs down the right-hand side.
  check("a photograph taken on its side is turned the right way up on the page", JSON.stringify(turned.corners) === JSON.stringify({ tl: [152, 300], tr: [152, 460], bl: [72, 300] }), JSON.stringify(turned.corners));
  check("…its colours said to be in the profile it came with, which is written once", count(bytes, "/ICCBased") === 1 && count(bytes, "/N 3") === 1);

  // Every way of turning, against what each means.
  const where: Record<number, { tl: number[]; tr: number[] }> = {
    1: { tl: [100, 100], tr: [260, 100] },
    2: { tl: [260, 100], tr: [100, 100] },
    3: { tl: [260, 180], tr: [100, 180] },
    4: { tl: [100, 180], tr: [260, 180] },
    5: { tl: [100, 100], tr: [100, 260] },
    6: { tl: [180, 100], tr: [180, 260] },
    7: { tl: [180, 260], tr: [180, 100] },
    8: { tl: [100, 260], tr: [100, 100] },
  };
  let right = true;
  const said: string[] = [];
  for (let o = 1; o <= 8; o += 1) {
    const file = withExif(QUAD_JPEG, o);
    const tall = o > 4;
    const one = await renderPdf(listOf([picture("p", 100, 100, tall ? 80 : 160, tall ? 160 : 80)]), fonts, new Map([["p", keptPicture(file, sniff(file)!)]]), undefined, { color: "rgb" });
    const got = (await drawnOn(one))[0].corners;
    if (JSON.stringify([got.tl, got.tr]) !== JSON.stringify([where[o].tl, where[o].tr])) {
      right = false;
      said.push(`${o}: ${JSON.stringify([got.tl, got.tr])}`);
    }
  }
  check("…in each of the eight ways there are", right, said.join(" "));

  const grey = await renderPdf(listOf([picture("g", 72, 100, 80, 80)]), fonts, new Map([["g", keptPicture(GRAY_JPEG, sniff(GRAY_JPEG)!)]]), undefined, { color: "rgb" });
  check("a JPEG in greys is written as greys", count(grey, "/DeviceGray") >= 1 && holds(grey, GRAY_JPEG) && (await drawnOn(grey))[0].w === 8);
})();

await (async () => {
  // Pixels kept exactly, with and without what shows through.
  const w = 40;
  const h = 24;
  const rgb = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      rgb.set(x < 20 ? [200 + (y & 3), 40, 40 + x] : [20, 90 + y, 240], (y * w + x) * 3);
      alpha[y * w + x] = x < 10 ? 0 : x < 20 ? 128 : 255;
    }
  }
  const bytes = await renderPdf(
    listOf([picture("solid", 72, 100, 200, 120), picture("cutout", 72, 300, 200, 120, { round: 20 })]),
    fonts,
    new Map<string, PdfPicture>([
      ["solid", { kind: "rgb", bytes: rgb, w, h }],
      ["cutout", { kind: "rgb", bytes: rgb, w, h, alpha }],
    ]),
    undefined,
    { color: "rgb" },
  );
  if (dump) writeFileSync(path.join(dump, "pictures-pixels.pdf"), bytes);
  const [solid, cutout] = await drawnOn(bytes);
  check("pixels kept exactly come back exactly", solid.w === w && solid.h === h && same(solid.rgb.flat(), rgb) && solid.alpha === null);
  check("…packed the way a PNG packs them", count(bytes, "/Predictor 15") >= 2 && count(bytes, "/FlateDecode") >= 3);
  check("a see-through picture has what shows through beside it, exactly too", count(bytes, "/SMask") === 1 && !!cutout.alpha && same(cutout.alpha, alpha), cutout.alpha ? `${cutout.alpha.length} values` : "no alpha read");
  check("…and its colours are untouched where it is not see-through", same(cutout.rgb.slice(20, 40).flat(), Array.from(rgb.subarray(60, 120))));

  // The file a drawing came from, where packing its pixels again came out larger.
  const noise = new Uint8Array(w * h * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
  const tiny = png(w, h, () => [10, 20, 30]);
  const weighed = await renderPdf(listOf([picture("a", 72, 100, 200, 120)]), fonts, new Map<string, PdfPicture>([["a", { kind: "rgb", bytes: noise, w, h, file: tiny }]]), undefined, { color: "rgb" });
  const used = (await drawnOn(weighed))[0];
  check("the file a picture came from is what goes in where that is the smaller", used.w === w && same(used.rgb[0], [10, 20, 30]) && same(used.rgb[w * h - 1], [10, 20, 30]));
  const flatFile = png(w, h, (x, y) => [(x * 37 + y * 91) & 255, (x * 113 + y * 7) & 255, (x * 59) & 255]);
  const flat = new Uint8Array(w * h * 3).fill(99);
  const lighter = await renderPdf(listOf([picture("a", 72, 100, 200, 120)]), fonts, new Map<string, PdfPicture>([["a", { kind: "rgb", bytes: flat, w, h, file: flatFile }]]), undefined, { color: "rgb" });
  check("…and the pixels where they are", same((await drawnOn(lighter))[0].rgb[5], [99, 99, 99]));

  // A PNG file the writer reads itself.
  const own = await renderPdf(listOf([picture("d", 72, 100, 120, 100)]), fonts, new Map<string, PdfPicture>([["d", DRAWING]]), undefined, { color: "rgb" });
  const read = (await drawnOn(own))[0];
  check("a PNG file goes in as its own pixels", read.w === 12 && read.h === 10 && same(read.rgb[0], [200, 40, 40]) && same(read.rgb[119], [250, 250, 240]));

  // Something that is not a picture after all.
  const bad = await renderPdf(listOf([picture("x", 72, 100, 120, 100), picture("d", 72, 300, 120, 100)]), fonts, new Map<string, PdfPicture>([["x", latin("not a picture at all, whatever it was called")], ["d", DRAWING]]), undefined, { color: "rgb" });
  check("a file that turns out not to be a picture is left out, and the rest is written", (await drawnOn(bad)).length === 1);
})();

await (async () => {
  // Asked for as the pages that show them are reached.
  const asked: string[][] = [];
  const dl = listOf([picture("one", 72, 100, 120, 100)], [], [picture("two", 72, 100, 120, 100), picture("one", 72, 300, 60, 50), picture("gone", 72, 500, 60, 50)], [picture("two", 72, 100, 120, 100)]);
  const bytes = await renderPdf(dl, fonts, new Map(), undefined, {
    color: "rgb",
    feed: async (refs) => {
      asked.push(refs);
      return new Map<string, PdfPicture>(refs.filter((r) => r !== "gone").map((r) => [r, r === "one" ? DRAWING : keptPicture(QUAD_JPEG, sniff(QUAD_JPEG)!)]));
    },
  });
  check("pictures are asked for a page at a time, each once", JSON.stringify(asked) === JSON.stringify([["one"], ["two", "gone"]]), JSON.stringify(asked));
  const third = await drawnOn(bytes, 3);
  check("…and drawn wherever they are shown, the one that never came left out", (await drawnOn(bytes, 1)).length === 1 && third.length === 2 && (await drawnOn(bytes, 4)).length === 1 && count(bytes, "/Subtype /Image") === 2);
  const given = await renderPdf(listOf([picture("one", 72, 100, 120, 100), picture("two", 72, 300, 120, 100)]), fonts, new Map<string, PdfPicture>([["one", DRAWING]]), undefined, {
    color: "rgb",
    feed: async (refs) => {
      asked.push(["again", ...refs]);
      return new Map();
    },
  });
  check("one handed over with the rest is not asked for", JSON.stringify(asked[asked.length - 1]) === JSON.stringify(["again", "two"]) && (await drawnOn(given)).length === 1);
  const failing = await renderPdf(listOf([picture("one", 72, 100, 120, 100)]), fonts, new Map(), undefined, {
    color: "rgb",
    feed: async () => {
      throw new Error("no pictures today");
    },
  });
  check("pictures that cannot be had do not stop the file being written", (await drawnOn(failing)).length === 0 && Buffer.from(failing.subarray(0, 5)).toString("latin1") === "%PDF-");
  const folded = await renderPdf(listOf([picture("one", 72, 100, 120, 100)], [picture("two", 72, 100, 120, 100)], [], []), fonts, new Map(), undefined, {
    booklet: true,
    feed: async (refs) => new Map<string, PdfPicture>(refs.map((r) => [r, DRAWING])),
  });
  check("a booklet's sheets ask for theirs too", count(folded, "/Subtype /Image") === 2);
})();

finish();
