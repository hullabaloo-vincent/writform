/**
 * A paperback cover as a PDF, two ways.
 *
 * THE COVER: one page the size of the whole sheet (back, spine, front and
 * the bleed round them), drawn from the cover's scene (scene.ts): the
 * paper's colours, each picture in its part of the sheet, and the words on
 * top as real text in their own fonts (embedded, as in the book's pages).
 * The pictures go in as they are: a JPEG is not compressed again. The page
 * says where the printer trims (its TrimBox) and how far the artwork
 * bleeds past that (its BleedBox, the whole page).
 *
 * THE TEMPLATE: the same sheet with nothing on it but its guides, to work
 * over in whatever the artwork is made in: what is trimmed off, the margin
 * to keep clear, where the spine folds, where the barcode goes, and every
 * measurement in words.
 *
 * Built on the page (one sheet is quick), loaded only when asked for.
 */

import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";

import { BLEED, SAFE, sizeWords, SPINE_SAFE, SPINE_TEXT_PAGES, type Box, type CoverGeometry } from "./geometry";
import type { CoverScene } from "./scene";

/** Shape for the bits of PDFKit used here (its bundled types lag the code). */
interface Doc {
  registerFont(name: string, src: unknown): Doc;
  addPage(options: { size: [number, number]; margin: number }): Doc;
  font(name: string): Doc;
  fontSize(size: number): Doc;
  text(text: string, x: number, y: number, options: Record<string, unknown>): Doc;
  widthOfString(text: string): number;
  fillColor(color: string): Doc;
  strokeColor(color: string): Doc;
  rect(x: number, y: number, w: number, h: number): Doc;
  fill(color: string): Doc;
  clip(): Doc;
  lineWidth(w: number): Doc;
  dash(length: number, options: { space: number }): Doc;
  undash(): Doc;
  moveTo(x: number, y: number): Doc;
  lineTo(x: number, y: number): Doc;
  stroke(): Doc;
  save(): Doc;
  restore(): Doc;
  translate(x: number, y: number): Doc;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): Doc;
  rotate(angle: number, options: { origin: [number, number] }): Doc;
  image(src: Uint8Array, x: number, y: number, options: { width: number; height: number }): Doc;
  on(event: "data", cb: (chunk: Uint8Array) => void): Doc;
  on(event: "end" | "error", cb: (err?: unknown) => void): Doc;
  end(): void;
  page: { dictionary: { data: Record<string, unknown> } };
}

const PT = 72;

function open(g: CoverGeometry, title: string, author: string, subject: string): { doc: Doc; done: () => Promise<Uint8Array> } {
  const size: [number, number] = [g.w * PT, g.h * PT];
  const doc = new PDFDocument({
    autoFirstPage: false,
    // No default font: PDFKit would otherwise load Helvetica's metrics.
    font: null,
    size,
    margin: 0,
    pdfVersion: "1.4",
    displayTitle: true,
    info: { Title: title, Author: author, Subject: subject, Creator: "subScribe", Producer: "subScribe" },
  } as unknown as PDFKit.PDFDocumentOptions) as unknown as Doc;
  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err) => reject(err));
  });
  doc.addPage({ size, margin: 0 });
  const bleed = BLEED * PT;
  doc.page.dictionary.data.BleedBox = [0, 0, size[0], size[1]];
  doc.page.dictionary.data.TrimBox = [bleed, bleed, size[0] - bleed, size[1] - bleed];
  return {
    doc,
    done: async () => {
      doc.end();
      await finished;
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return out;
    },
  };
}

/** The slant of a synthetic italic (about 12°), as a shear. */
const OBLIQUE = 0.21;

/**
 * The cover for the printer. `pictures` are the files of the scene's
 * pictures, by where each is kept (one that is missing is left as paper);
 * `fontOf` is the font file each of the scene's faces was measured with.
 */
export async function coverPdf(
  g: CoverGeometry,
  scene: CoverScene,
  pictures: Map<string, Uint8Array>,
  fontOf: (face: number) => fontkit.Font,
  meta: { title: string; author: string },
): Promise<Uint8Array> {
  const { doc, done } = open(g, meta.title, meta.author, "Paperback cover");
  doc.rect(0, 0, scene.w, scene.h).fill("#ffffff");
  for (const paper of scene.papers) {
    if (paper.color !== "#ffffff") doc.rect(paper.clip.x, paper.clip.y, paper.clip.w, paper.clip.h).fill(paper.color);
  }
  for (const picture of scene.pictures) {
    const bytes = pictures.get(picture.src);
    if (!bytes) continue;
    doc.save();
    doc.rect(picture.clip.x, picture.clip.y, picture.clip.w, picture.clip.h).clip();
    doc.image(bytes, picture.at.x, picture.at.y, { width: picture.at.w, height: picture.at.h });
    doc.restore();
  }

  // One registered font per font file (style fallbacks share a file).
  const names = new Map<fontkit.Font, string>();
  const nameOf = (face: number) => {
    const font = fontOf(face);
    let name = names.get(font);
    if (!name) {
      name = `F${names.size + 1}`;
      names.set(font, name);
      doc.registerFont(name, font);
    }
    return name;
  };
  for (const text of scene.texts) {
    doc.save();
    doc.translate(text.origin.x, text.origin.y);
    if (text.turn) doc.rotate(text.turn, { origin: [0, 0] });
    if (text.band) doc.rect(text.band.x, text.band.y, text.band.w, text.band.h).fill(text.band.color);
    for (const it of text.items) {
      const face = scene.faces[it.face];
      const color = it.color ?? "#000000";
      doc.fillColor(color).strokeColor(color);
      // (As the book's pages are written: see render/pdf.ts.)
      const opts: Record<string, unknown> = { lineBreak: false, baseline: "alphabetic", textWidth: 0, wordCount: 1 };
      if (it.feat?.length) opts.features = it.feat;
      if (it.cs) opts.characterSpacing = it.cs;
      if (it.text.includes(" ")) opts.wordSpacing = it.ws || 1e-6;
      if (face?.fakeBold) {
        opts.fill = true;
        opts.stroke = true;
        doc.lineWidth(it.size * 0.035);
      }
      if (face?.fakeItalic) doc.save().transform(1, 0, -OBLIQUE, 1, OBLIQUE * it.y, 0);
      doc.font(nameOf(it.face)).fontSize(it.size).text(it.text, it.x, it.y, opts);
      if (face?.fakeItalic) doc.restore();
    }
    doc.restore();
  }
  return done();
}

const TRIMMED = "#f3b3b3";
const MARGIN = "#fbe1e1";
const LINE = "#1d1d22";
const FOLD = "#1f5fbf";
const BARCODE_FILL = "#fff0a3";
const WORDS = "#33333a";

/** The template: the sheet and its guides. `font` is the file of the face
 *  its words are set in. */
export async function coverTemplatePdf(g: CoverGeometry, meta: { title: string }, font: Uint8Array): Promise<Uint8Array> {
  const { doc, done } = open(g, `${meta.title} (cover template)`, "", "Paperback cover template");
  doc.registerFont("words", fontkit.create(font as never));
  const W = g.w * PT;
  const H = g.h * PT;
  const band = (b: Box, color: string) => {
    if (b.w > 0 && b.h > 0) doc.rect(b.x * PT, b.y * PT, b.w * PT, b.h * PT).fill(color);
  };
  /** A frame of `by` inside a box (its four sides, not its middle). */
  const frame = (b: Box, by: number, color: string) => {
    band({ x: b.x, y: b.y, w: b.w, h: by }, color);
    band({ x: b.x, y: b.y + b.h - by, w: b.w, h: by }, color);
    band({ x: b.x, y: b.y + by, w: by, h: b.h - by * 2 }, color);
    band({ x: b.x + b.w - by, y: b.y + by, w: by, h: b.h - by * 2 }, color);
  };

  doc.rect(0, 0, W, H).fill("#ffffff");

  // The covers as trimmed, and the spine between them.
  const backTrim: Box = { x: BLEED, y: BLEED, w: g.trim.w, h: g.trim.h };
  const frontTrim: Box = { x: g.front.x, y: BLEED, w: g.trim.w, h: g.trim.h };
  const spineTrim: Box = { x: g.spineBox.x, y: BLEED, w: g.spine, h: g.trim.h };

  // The margin to keep clear on each cover; on the spine, its two edges (or
  // all of it, when it is too narrow for words).
  frame(backTrim, SAFE, MARGIN);
  frame(frontTrim, SAFE, MARGIN);
  if (g.spineText && g.spine > SPINE_SAFE * 2) {
    band({ ...spineTrim, w: SPINE_SAFE }, MARGIN);
    band({ ...spineTrim, x: spineTrim.x + g.spine - SPINE_SAFE, w: SPINE_SAFE }, MARGIN);
  } else {
    band(spineTrim, MARGIN);
  }
  // What the printer trims off.
  frame({ x: 0, y: 0, w: g.w, h: g.h }, BLEED, TRIMMED);

  // The barcode, on the back by the spine.
  band(g.barcode, BARCODE_FILL);
  doc.lineWidth(0.5).strokeColor(LINE);
  doc.rect(g.barcode.x * PT, g.barcode.y * PT, g.barcode.w * PT, g.barcode.h * PT).stroke();

  // Where it is trimmed, and where it folds.
  doc.lineWidth(0.6).strokeColor(LINE);
  doc.rect(BLEED * PT, BLEED * PT, (g.w - BLEED * 2) * PT, g.trim.h * PT).stroke();
  doc.lineWidth(0.6).strokeColor(FOLD).dash(4, { space: 3 });
  for (const x of [g.spineBox.x, g.spineBox.x + g.spine]) {
    doc.moveTo(x * PT, 0).lineTo(x * PT, H).stroke();
  }
  doc.undash();

  // Words. (`y` is the top of the line.)
  const say = (text: string, x: number, y: number, size: number, opts: { centre?: number; color?: string } = {}) => {
    doc.font("words").fontSize(size).fillColor(opts.color ?? WORDS);
    const left = opts.centre === undefined ? x : x + (opts.centre - doc.widthOfString(text)) / 2;
    doc.text(text, left, y, { lineBreak: false });
  };
  const size = sizeWords(g);
  const trimWords = `${g.trim.w} × ${g.trim.h} in`;
  const mid = (g.h * PT) / 2;
  say("Back cover", backTrim.x * PT, mid - 22, 20, { centre: backTrim.w * PT });
  say(trimWords, backTrim.x * PT, mid + 4, 10, { centre: backTrim.w * PT });
  say("Front cover", frontTrim.x * PT, mid - 22, 20, { centre: frontTrim.w * PT });
  say(trimWords, frontTrim.x * PT, mid + 4, 10, { centre: frontTrim.w * PT });
  say("Barcode", g.barcode.x * PT, (g.barcode.y + g.barcode.h / 2) * PT - 11, 10, { centre: g.barcode.w * PT });
  say("2 × 1.2 in", g.barcode.x * PT, (g.barcode.y + g.barcode.h / 2) * PT + 2, 8, { centre: g.barcode.w * PT });

  // Down the spine, read from the top (as it lies with the front cover up).
  const spinePt = g.spine * PT;
  if (spinePt >= 7) {
    const label = `Spine ${size.spine}`;
    const type = Math.min(11, Math.max(5, spinePt * 0.5));
    doc.save();
    doc.rotate(90, { origin: [(g.spineBox.x + g.spine / 2) * PT, mid] });
    doc.font("words").fontSize(type).fillColor(WORDS);
    doc.text(label, (g.spineBox.x + g.spine / 2) * PT - doc.widthOfString(label) / 2, mid - type * 0.6, { lineBreak: false });
    doc.restore();
  }

  // What it all means, at the head of the back cover.
  const left = (backTrim.x + SAFE + 0.15) * PT;
  let y = (backTrim.y + SAFE + 0.15) * PT;
  const line = (text: string, type = 8.5, color = WORDS) => {
    say(text, left, y, type, { color });
    y += type * 1.5;
  };
  line(meta.title || "Untitled", 12);
  line("Paperback cover template");
  y += 4;
  line(`Trim size ${trimWords}. ${g.pages} pages on ${g.paper} paper.`);
  line(`The whole sheet: ${size.inches}.`);
  line(`That is ${size.mm}, or ${size.pixels} at 300 to the inch.`);
  line(`Spine: ${size.spine} wide, between the blue lines.`);
  y += 4;
  line("Red edge: trimmed off. Carry the background into it and keep words out.");
  line("Pale band: the margin. Nothing that matters should be in it.");
  line("Yellow box: where the printer puts the barcode.");
  if (!g.spineText) line(`Fewer than ${SPINE_TEXT_PAGES} pages: the spine is too narrow for words.`);
  y += 4;
  line("Take these guides out before you save the artwork.");

  return done();
}
