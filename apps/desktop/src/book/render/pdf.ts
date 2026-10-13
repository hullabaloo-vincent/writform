/**
 * The print PDF: the display list drawn with PDFKit as a low-level writer.
 *
 * - Fonts are embedded as subsets, registered from the very fontkit objects
 *   the layout measured with, so every width agrees with the layout.
 * - Text is pure black (CMYK 0/0/0/100), as printers want for body text.
 * - Every page carries a TrimBox and BleedBox (no bleed: both equal the
 *   page), document metadata, and an outline of the chapters.
 * - No annotations, links or form fields (KDP and IngramSpark reject them).
 *
 * Documents (as opposed to books) ask for `color: "rgb"` and `links`: text
 * and rules in their own colours, highlights and shading, clickable links,
 * pages of differing sizes. A book's display list uses none of that, and its
 * PDF comes out byte for byte as before.
 *
 * As a booklet, pages are imposed two to a sheet for saddle stitching: the
 * count padded to a multiple of four, sides in the classic order [N,1],
 * [2,N−1], [N−2,3]… Print two-sided, flipping on the short edge, then fold.
 */

import type * as fontkit from "fontkit";
import PDFDocument from "pdfkit";

import type { DisplayList } from "../engine/types";

const BLACK: [number, number, number, number] = [0, 0, 0, 100];

/** Shape for the bits of PDFKit we use (its bundled types lag the code). */
interface Doc {
  registerFont(name: string, src: unknown): Doc;
  addPage(options: { size: [number, number]; margin: number }): Doc;
  font(name: string): Doc;
  fontSize(size: number): Doc;
  text(text: string, x: number, y: number, options: Record<string, unknown>): Doc;
  fillColor(color: number[] | string): Doc;
  strokeColor(color: number[] | string): Doc;
  rect(x: number, y: number, w: number, h: number): Doc;
  fill(color: string): Doc;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): Doc;
  link(x: number, y: number, w: number, h: number, url: string): Doc;
  goTo(x: number, y: number, w: number, h: number, name: string): Doc;
  addNamedDestination(name: string, fit: "XYZ", left: number | null, top: number | null, zoom: number | null): Doc;
  lineWidth(w: number): Doc;
  moveTo(x: number, y: number): Doc;
  lineTo(x: number, y: number): Doc;
  stroke(): Doc;
  save(): Doc;
  restore(): Doc;
  translate(x: number, y: number): Doc;
  image(src: Uint8Array, x: number, y: number, options: { width: number; height: number }): Doc;
  roundedRect(x: number, y: number, w: number, h: number, r: number): Doc;
  ellipse(x: number, y: number, rx: number, ry: number): Doc;
  clip(): Doc;
  on(event: "data", cb: (chunk: Uint8Array) => void): Doc;
  on(event: "end" | "error", cb: (err?: unknown) => void): Doc;
  end(): void;
  page: { dictionary: { data: Record<string, unknown> } };
  outline: Outline;
}

interface Outline {
  addItem(title: string, options?: { expanded?: boolean }): Outline;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The slant of a synthetic italic (about 12°), as a shear. */
const OBLIQUE = 0.21;

export interface RenderOptions {
  booklet?: boolean;
  /** "k": pure black ink, CMYK (books — the default). "rgb": screen
   *  colours, and the items' own colours (documents). */
  color?: "k" | "rgb";
  /** Write links as annotations (never for print-on-demand books). */
  links?: boolean;
}

export async function renderPdf(
  dl: DisplayList,
  /** fontkit font for each DisplayList face. */
  fonts: fontkit.Font[],
  images: Map<string, Uint8Array>,
  onProgress?: (done: number, total: number) => void,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  const ink: number[] | string = opts.color === "rgb" ? "#000000" : BLACK;
  const { w, h } = dl.trim;
  const sheetW = opts.booklet ? w * 2 : w;
  const doc = new PDFDocument({
    autoFirstPage: false,
    // No default font: PDFKit would otherwise load Helvetica's metrics.
    font: null,
    size: [sheetW, h],
    margin: 0,
    pdfVersion: "1.4",
    lang: dl.meta.lang,
    displayTitle: true,
    info: {
      Title: dl.meta.title,
      Author: dl.meta.author,
      Subject: dl.meta.subject,
      Creator: "subScribe",
      Producer: "subScribe",
    },
  } as unknown as PDFKit.PDFDocumentOptions) as unknown as Doc;

  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err) => reject(err));
  });

  // One registered font per font file (style fallbacks share a file).
  const names = new Map<fontkit.Font, string>();
  const faceName = dl.faces.map((_, i) => {
    const font = fonts[i];
    let name = names.get(font);
    if (!name) {
      name = `F${names.size + 1}`;
      names.set(font, name);
      doc.registerFont(name, font);
    }
    return name;
  });

  const draw = (page: DisplayList["pages"][number], dx: number) => {
    if (dx) doc.save().translate(dx, 0);
    // The fill colour in force; only changed when a run asks for another.
    let fill: string | null = null;
    for (const it of page.items) {
      if (it.t === "text") {
        const face = dl.faces[it.face];
        const color = it.color ?? null;
        if (color !== fill) {
          doc.fillColor(color ?? ink).strokeColor(color ?? ink);
          fill = color;
        }
        const textOpts: Record<string, unknown> = {
          lineBreak: false,
          baseline: "alphabetic",
          // Skip PDFKit's own measuring (only used for links/underlines).
          textWidth: 0,
          wordCount: 1,
        };
        if (it.feat?.length) textOpts.features = it.feat;
        if (it.cs) textOpts.characterSpacing = it.cs;
        // With word spacing set, PDFKit shapes word by word — exactly how
        // the layout measured — so it's always on for multi-word runs.
        if (it.text.includes(" ")) textOpts.wordSpacing = it.ws || 1e-6;
        if (face?.fakeBold) {
          textOpts.fill = true;
          textOpts.stroke = true;
          doc.lineWidth(it.size * 0.035);
        }
        if (face?.fakeItalic) {
          // Shear about the baseline, so the run keeps its place.
          doc.save().transform(1, 0, -OBLIQUE, 1, OBLIQUE * it.y, 0);
        }
        doc.font(faceName[it.face]).fontSize(it.size).text(it.text, it.x, it.y, textOpts);
        if (face?.fakeItalic) doc.restore();
      } else if (it.t === "rule") {
        doc.save().lineWidth(it.w);
        if (it.color) doc.strokeColor(it.color);
        doc.moveTo(it.x1, it.y1).lineTo(it.x2, it.y2).stroke().restore();
      } else if (it.t === "rect") {
        doc.save().rect(it.x, it.y, it.w, it.h).fill(it.color).restore();
      } else if (it.t === "link") {
        if (!opts.links) continue;
        if (it.url) doc.link(it.x, it.y, it.w, it.h, it.url);
        else if (it.to) doc.goTo(it.x, it.y, it.w, it.h, it.to);
      } else if (it.t === "anchor") {
        if (opts.links) doc.addNamedDestination(it.name, "XYZ", null, it.y, null);
      } else {
        const bytes = images.get(it.ref);
        // A picture's shape: its rectangle, or with corners rounded (all
        // the way: an oval), `by` inside its edge.
        const shape = (by: number) => {
          const w = Math.max(0, it.w - by * 2);
          const h = Math.max(0, it.h - by * 2);
          const round = it.round ?? 0;
          if (round >= 50) return doc.ellipse(it.x + it.w / 2, it.y + it.h / 2, w / 2, h / 2);
          return round > 0 ? doc.roundedRect(it.x + by, it.y + by, w, h, Math.max(0, (Math.min(it.w, it.h) * round) / 100 - by)) : doc.rect(it.x + by, it.y + by, w, h);
        };
        if (bytes && it.round) {
          doc.save();
          shape(0).clip();
          doc.image(bytes, it.x, it.y, { width: it.w, height: it.h });
          doc.restore();
        } else if (bytes) doc.image(bytes, it.x, it.y, { width: it.w, height: it.h });
        if (it.border) {
          doc.save().lineWidth(it.border.w).strokeColor(it.border.color);
          shape(it.border.w / 2).stroke();
          doc.restore();
        }
      }
    }
    if (fill !== null) doc.fillColor(ink).strokeColor(ink);
    if (dx) doc.restore();
  };

  /** A new sheet: the document's size, or a page's own. */
  const newSheet = (size?: { w: number; h: number }) => {
    const sw = size?.w ?? sheetW;
    const sh = size?.h ?? h;
    doc.addPage({ size: [sw, sh], margin: 0 });
    const box = [0, 0, sw, sh];
    doc.page.dictionary.data.TrimBox = box;
    doc.page.dictionary.data.BleedBox = box;
    doc.fillColor(ink).strokeColor(ink);
  };

  if (opts.booklet) {
    const n = Math.max(4, Math.ceil(dl.pages.length / 4) * 4);
    for (let side = 0; side < n / 2; side += 1) {
      const outer = n - 1 - side;
      const [left, right] = side % 2 === 0 ? [outer, side] : [side, outer];
      newSheet();
      if (dl.pages[left]) draw(dl.pages[left], 0);
      if (dl.pages[right]) draw(dl.pages[right], w);
      if (side % 8 === 7) {
        onProgress?.(Math.min(dl.pages.length, (side + 1) * 2), dl.pages.length);
        await tick();
      }
    }
  } else {
    const sectionsAt = new Map<number, typeof dl.sections>();
    for (const s of dl.sections) {
      const list = sectionsAt.get(s.firstPage) ?? [];
      list.push(s);
      sectionsAt.set(s.firstPage, list);
    }
    // The outline nests by level: each entry goes under the nearest earlier
    // entry of a lower level (a chapter under its part, a subsection under
    // its section).
    const open: { level: number; item: Outline }[] = [];
    for (let pi = 0; pi < dl.pages.length; pi += 1) {
      newSheet(dl.pages[pi].size);
      draw(dl.pages[pi], 0);
      for (const s of sectionsAt.get(pi) ?? []) {
        while (open.length && open[open.length - 1].level >= s.level) open.pop();
        const parent = open.length ? open[open.length - 1].item : doc.outline;
        open.push({ level: s.level, item: parent.addItem(s.title) });
      }
      if (pi % 16 === 15) {
        onProgress?.(pi + 1, dl.pages.length);
        await tick();
      }
    }
  }
  doc.end();
  await finished;

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
