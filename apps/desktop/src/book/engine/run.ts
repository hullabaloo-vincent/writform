/**
 * Typesetting jobs — the same code in the worker and, when a worker can't
 * start, on the main thread: parse the fonts, load the language's
 * hyphenation patterns, lay the book out, and write the PDF.
 *
 * A session lives as long as its worker: fonts are parsed once, shaped
 * words stay cached, and laid-out sections are reused while unchanged, so
 * the live preview re-sets only the chapter being edited.
 *
 * KDP's minimum inside margin depends on the page count, and the page
 * count on the margin: lay out with an estimate, then again with the
 * margin the real count needs (at most three passes; the margin only ever
 * grows, so it settles).
 */

import { layoutDoc, ParaCache } from "../../doclayout/layout";
import type { DocModel } from "../../doclayout/model";
import { trimSize } from "../model/bookMap";
import { estimatePages, geometryFor, kdpMinInside } from "../model/trims";
import type { BookModel, Warning } from "../model/types";
import type { PdfOptions } from "../render/options";
import { renderPdf, type PdfAttachment } from "../render/pdf";
import { FaceSet, type FaceBytes } from "./faces";
import { loadHyphenator, type Hyphenator } from "./hyphenate";
import { designFor, layoutBook, SectionCache, smfGeometry } from "./layout";
import { pictureKey, viewOfItem, type PdfPicture, type PictureWant } from "./pictures";
import { BLEED_PT, type DisplayList, type PageStart } from "./types";

export type PrintKind = "paperback" | "submission-pdf" | "booklet";

export interface JobImage {
  url: string;
  /** The picture itself, a JPEG or a PNG. Usually absent: a layout needs
   *  only the size, and a PDF asks for its pictures once it knows how large
   *  each is printed (see `PictureSource`). */
  bytes?: Uint8Array;
  /** Pixel size, as shown. */
  w: number;
  h: number;
}

/** Where a PDF's pictures come from: given which, and the largest each is
 *  printed, they come back ready for the file (those that can be had). */
export type PictureSource = (want: PictureWant[]) => Promise<Map<string, PdfPicture>>;

export interface LayoutRequest {
  kind: PrintKind;
  model: BookModel;
  /** Font families the job draws with (their files must be in the session). */
  families: string[];
  images: JobImage[];
  /** Copyright year default (ms since epoch). */
  now: number;
  /** A catalog family's other scripts, when the book needs them. */
  chains?: Record<string, string[]>;
  /** A paperback's interior, as a press asks for it. */
  press?: PressOptions;
}

/** What a press may ask of a book's interior. */
export interface PressOptions {
  /** PDF/X-1a:2001: black ink and greys only. */
  x1a?: boolean;
  /** Each sheet larger than its page by the bleed (an eighth of an inch
   *  at the top, the foot and the outside edge). */
  bleed?: boolean;
}

export { BLEED_PT } from "./types";

/** A document (as opposed to a book): its own model and layout. */
export interface DocRequest {
  kind: "document" | "document-booklet";
  doc: DocModel;
  families: string[];
  images: JobImage[];
  /** What was chosen for the PDF (absent: the usual). */
  pdf?: PdfOptions;
  /** A file to carry inside the PDF (the document it was made from). */
  attach?: PdfAttachment;
}

/** A document's pages without their contents: how many, where each begins
 *  in the editor's text, how tall each one's text area is (pt). What the
 *  editor's page view needs, and a fraction of a display list to send. */
export interface PageMap {
  pages: number;
  starts: (PageStart | null)[];
  bodyH: number[];
  /** Footnotes numbered again on each page: every note's label as set. */
  notes?: string[];
}

export type AnyRequest = LayoutRequest | DocRequest;

const isDoc = (req: AnyRequest): req is DocRequest => "doc" in req;

export interface PrintResult {
  bytes: Uint8Array;
  pages: number;
  /** Physical sheets (booklets). */
  sheets?: number;
  warnings: Warning[];
  /** Inches. */
  trim: { w: number; h: number };
  insideMargin: number;
}

/** A one-shot job carrying its own fonts (tests, simple callers). */
export interface PrintJob {
  kind: PrintKind;
  model: BookModel;
  fonts: FaceBytes[];
  images: JobImage[];
  now: number;
}

export class TypesetSession {
  private readonly files = new Map<string, FaceBytes[]>();
  private readonly sets = new Map<string, { faces: FaceSet; cache: SectionCache }>();
  private readonly docSets = new Map<string, { faces: FaceSet; cache: ParaCache }>();
  private readonly hyphenators = new Map<string, Promise<Hyphenator | null>>();

  addFonts(fonts: FaceBytes[]) {
    const byFamily = new Map<string, FaceBytes[]>();
    for (const f of fonts) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
    for (const [family, list] of byFamily) if (!this.files.has(family)) this.files.set(family, list);
  }

  /** Families whose files the session doesn't have yet. */
  missingFamilies(families: string[]): string[] {
    return [...new Set(families)].filter((f) => !this.files.has(f));
  }

  private facesFor(families: string[]) {
    const wanted = [...new Set(families)].sort();
    const key = wanted.join(",");
    let entry = this.sets.get(key);
    if (!entry) {
      const bytes = wanted.flatMap((f) => this.files.get(f) ?? []);
      if (!bytes.length) throw new Error("The book’s fonts didn’t load.");
      entry = { faces: new FaceSet(bytes), cache: new SectionCache() };
      this.sets.set(key, entry);
    }
    return entry;
  }

  /** A document's faces: the same files, but a family without an italic is
   *  slanted rather than left upright. */
  private docFacesFor(families: string[]) {
    const wanted = [...new Set(families)].sort();
    const key = wanted.join(",");
    let entry = this.docSets.get(key);
    if (!entry) {
      const bytes = wanted.flatMap((f) => this.files.get(f) ?? []);
      if (!bytes.length) throw new Error("The document’s fonts didn’t load.");
      entry = { faces: new FaceSet(bytes, true), cache: new ParaCache() };
      this.docSets.set(key, entry);
    }
    return entry;
  }

  private async layoutDocument(req: DocRequest): Promise<{ dl: DisplayList; faces: FaceSet }> {
    const { faces, cache } = this.docFacesFor(req.families);
    faces.resetMissing();
    const hyphenator = req.doc.settings.hyphenate ? await this.hyphenator(req.doc.meta.lang || "en-US") : null;
    const images = new Map(req.images.map((i) => [i.url, { w: i.w, h: i.h }]));
    try {
      return { dl: layoutDoc({ model: req.doc, faces, hyphenator, images, cache }), faces };
    } finally {
      cache.sweep();
    }
  }

  /** Where a document's pages fall (the same layout as its preview and
   *  PDF; its paragraphs are shared with those between runs). */
  async pageMap(req: AnyRequest): Promise<PageMap> {
    if (!isDoc(req)) throw new Error("Only a document has a page map.");
    const { dl } = await this.layoutDocument(req);
    return { pages: dl.pages.length, starts: dl.starts ?? [], bodyH: dl.bodyH ?? [], ...(dl.noteLabels ? { notes: dl.noteLabels } : {}) };
  }

  private hyphenator(lang: string): Promise<Hyphenator | null> {
    let h = this.hyphenators.get(lang);
    if (!h) {
      h = loadHyphenator(lang);
      this.hyphenators.set(lang, h);
    }
    return h;
  }

  async layout(req: AnyRequest, progress: (message: string) => void = () => {}): Promise<{ dl: DisplayList; faces: FaceSet }> {
    if (isDoc(req)) return this.layoutDocument(req);
    const { faces, cache } = this.facesFor(req.families);
    faces.resetMissing();
    const target = req.kind === "submission-pdf" ? "smf" : "paperback";
    const model = req.model;
    const design = designFor(model, target);
    const hyphenator = design.hyphenate ? await this.hyphenator(model.book.meta.language || "en-US") : null;
    const images = new Map(req.images.map((i) => [i.url, { w: i.w, h: i.h }]));
    const now = new Date(req.now);
    try {
      if (target === "smf") {
        progress("Setting the manuscript…");
        const dl = layoutBook({ model, target, faces, hyphenator, geometry: smfGeometry(model.book.smf.paper), images, now, cache, chains: req.chains });
        return { dl, faces };
      }
      const print = model.book.print;
      const chapters = model.sections.filter((s) => s.kind === "chapter").length;
      let pages = estimatePages(model.words, chapters, print, design);
      let dl: DisplayList | null = null;
      for (let pass = 0; pass < 3; pass += 1) {
        progress(pass === 0 ? "Setting the text…" : "Adjusting the gutter for the page count…");
        const geometry = geometryFor(print, pages);
        dl = layoutBook({ model, target, faces, hyphenator, geometry, images, now, cache, chains: req.chains });
        const needed = geometryFor(print, dl.pages.length).inside;
        pages = dl.pages.length;
        if (Math.abs(needed - geometry.inside) < 1e-9) break;
      }
      const result = dl!;
      if (print.margins === "custom" && print.mi < kdpMinInside(result.pages.length)) {
        result.warnings.push({
          kind: "page-count",
          message: `At ${result.pages.length} pages KDP needs an inside margin of at least ${kdpMinInside(result.pages.length)} in, so it was widened to fit.`,
        });
      }
      return { dl: result, faces };
    } finally {
      cache.sweep();
    }
  }

  async pdf(req: AnyRequest, progress: (message: string) => void = () => {}, pictures?: PictureSource): Promise<PrintResult> {
    const { dl, faces } = await this.layout(req, progress);
    const booklet = req.kind === "booklet" || req.kind === "document-booklet";
    progress(`Writing ${dl.pages.length} pages…`);
    const images = new Map<string, PdfPicture>();
    for (const i of req.images) if (i.bytes) images.set(i.url, i.bytes);
    // The largest each picture is printed: how many of its pixels are worth
    // keeping is a matter of that, and known only now. (A picture shown
    // cropped or turned is a picture of its own: only that part is made.)
    const placed = new Map<string, PictureWant>();
    for (const page of dl.pages) {
      for (const it of page.items) {
        if (it.t !== "image") continue;
        const key = pictureKey(it);
        const was = placed.get(key);
        const view = viewOfItem(it);
        placed.set(key, { url: it.ref, w: Math.max(was?.w ?? 0, it.w), h: Math.max(was?.h ?? 0, it.h), ...(view ? { view, key } : {}) });
      }
    }
    const feed = pictures ? (refs: string[]) => pictures(refs.map((key) => placed.get(key) ?? { url: key, w: 0, h: 0 })) : undefined;
    const fonts = dl.faces.map((_, i) => faces.font(i));
    const bytes = await renderPdf(
      dl,
      fonts,
      images,
      (done, total) => progress(`Writing page ${done} of ${total}…`),
      // A document keeps its colours and its links; a book is black ink for
      // a press, and a booklet's imposed pages have nowhere for a link to go.
      // (And its structure, when it was asked for and worked out.)
      isDoc(req)
        ? {
            booklet,
            color: "rgb",
            links: !booklet,
            tagged: !booklet && !!dl.struct && req.pdf?.tagged !== false,
            feed,
            ...(req.attach && !booklet ? { attach: req.attach } : {}),
            // (An archive copy that carries a file is the part of the
            // standard that lets it.)
            ...(req.pdf?.archive && !booklet ? { archive: req.attach ? ("3b" as const) : ("2b" as const) } : {}),
          }
        : { booklet, feed, ...(req.kind === "paperback" && req.press?.x1a ? { x1a: true } : {}), ...(req.kind === "paperback" && req.press?.bleed ? { bleed: BLEED_PT } : {}) },
    );
    const trim =
      isDoc(req) || req.kind === "submission-pdf" ? { w: dl.trim.w / 72, h: dl.trim.h / 72 } : trimSize(req.model.book.print);
    return {
      bytes,
      pages: dl.pages.length,
      ...(booklet ? { sheets: Math.ceil(dl.pages.length / 4) } : {}),
      warnings: dl.warnings,
      trim,
      insideMargin: dl.insideMargin,
    };
  }
}

/** Lay out a one-shot job (tests). */
export async function layoutJob(job: PrintJob, progress: (message: string) => void = () => {}) {
  const session = new TypesetSession();
  session.addFonts(job.fonts);
  return session.layout({ ...job, families: [...new Set(job.fonts.map((f) => f.family))] }, progress);
}

/** Run a one-shot job to a PDF (tests). */
export async function runPrintJob(job: PrintJob, progress: (message: string) => void = () => {}): Promise<PrintResult> {
  const session = new TypesetSession();
  session.addFonts(job.fonts);
  return session.pdf({ ...job, families: [...new Set(job.fonts.map((f) => f.family))] }, progress);
}
