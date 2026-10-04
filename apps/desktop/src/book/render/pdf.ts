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
  fillColor(color: number[]): Doc;
  strokeColor(color: number[]): Doc;
  lineWidth(w: number): Doc;
  moveTo(x: number, y: number): Doc;
  lineTo(x: number, y: number): Doc;
  stroke(): Doc;
  save(): Doc;
  restore(): Doc;
  translate(x: number, y: number): Doc;
  image(src: Uint8Array, x: number, y: number, options: { width: number; height: number }): Doc;
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

export async function renderPdf(
  dl: DisplayList,
  /** fontkit font for each DisplayList face. */
  fonts: fontkit.Font[],
  images: Map<string, Uint8Array>,
  onProgress?: (done: number, total: number) => void,
  opts: { booklet?: boolean } = {},
): Promise<Uint8Array> {
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
    for (const it of page.items) {
      if (it.t === "text") {
        const face = dl.faces[it.face];
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
        doc.font(faceName[it.face]).fontSize(it.size).text(it.text, it.x, it.y, textOpts);
      } else if (it.t === "rule") {
        doc.save().lineWidth(it.w).moveTo(it.x1, it.y1).lineTo(it.x2, it.y2).stroke().restore();
      } else {
        const bytes = images.get(it.ref);
        if (bytes) doc.image(bytes, it.x, it.y, { width: it.w, height: it.h });
      }
    }
    if (dx) doc.restore();
  };

  const newSheet = () => {
    doc.addPage({ size: [sheetW, h], margin: 0 });
    const box = [0, 0, sheetW, h];
    doc.page.dictionary.data.TrimBox = box;
    doc.page.dictionary.data.BleedBox = box;
    doc.fillColor(BLACK).strokeColor(BLACK);
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
    let parent: Outline | null = null;
    for (let pi = 0; pi < dl.pages.length; pi += 1) {
      newSheet();
      draw(dl.pages[pi], 0);
      for (const s of sectionsAt.get(pi) ?? []) {
        if (s.level === 0 || !parent) {
          const item = doc.outline.addItem(s.title);
          parent = s.level === 0 ? item : parent;
        } else {
          parent.addItem(s.title);
        }
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
