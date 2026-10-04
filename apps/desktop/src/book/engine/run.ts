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

import { trimSize } from "../model/bookMap";
import { estimatePages, geometryFor, kdpMinInside } from "../model/trims";
import type { BookModel, Warning } from "../model/types";
import { renderPdf } from "../render/pdf";
import { FaceSet, type FaceBytes } from "./faces";
import { loadHyphenator, type Hyphenator } from "./hyphenate";
import { designFor, layoutBook, SectionCache, smfGeometry } from "./layout";
import type { DisplayList } from "./types";

export type PrintKind = "paperback" | "submission-pdf" | "booklet";

export interface JobImage {
  url: string;
  /** JPEG (or PNG) bytes, already scaled for print (absent for layout-only
   *  jobs, which need just the size). */
  bytes?: Uint8Array;
  /** Pixel size. */
  w: number;
  h: number;
}

export interface LayoutRequest {
  kind: PrintKind;
  model: BookModel;
  /** Font families the job draws with (their files must be in the session). */
  families: string[];
  images: JobImage[];
  /** Copyright year default (ms since epoch). */
  now: number;
}

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

  private hyphenator(lang: string): Promise<Hyphenator | null> {
    let h = this.hyphenators.get(lang);
    if (!h) {
      h = loadHyphenator(lang);
      this.hyphenators.set(lang, h);
    }
    return h;
  }

  async layout(req: LayoutRequest, progress: (message: string) => void = () => {}): Promise<{ dl: DisplayList; faces: FaceSet }> {
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
        const dl = layoutBook({ model, target, faces, hyphenator, geometry: smfGeometry(model.book.smf.paper), images, now, cache });
        return { dl, faces };
      }
      const print = model.book.print;
      const chapters = model.sections.filter((s) => s.kind === "chapter").length;
      let pages = estimatePages(model.words, chapters, print, design);
      let dl: DisplayList | null = null;
      for (let pass = 0; pass < 3; pass += 1) {
        progress(pass === 0 ? "Setting the text…" : "Adjusting the gutter for the page count…");
        const geometry = geometryFor(print, pages);
        dl = layoutBook({ model, target, faces, hyphenator, geometry, images, now, cache });
        const needed = geometryFor(print, dl.pages.length).inside;
        pages = dl.pages.length;
        if (Math.abs(needed - geometry.inside) < 1e-9) break;
      }
      const result = dl!;
      if (print.margins === "custom" && print.mi < kdpMinInside(result.pages.length)) {
        result.warnings.push({
          kind: "page-count",
          message: `At ${result.pages.length} pages KDP needs an inside margin of at least ${kdpMinInside(result.pages.length)} in; it was widened to fit.`,
        });
      }
      return { dl: result, faces };
    } finally {
      cache.sweep();
    }
  }

  async pdf(req: LayoutRequest, progress: (message: string) => void = () => {}): Promise<PrintResult> {
    const { dl, faces } = await this.layout(req, progress);
    const booklet = req.kind === "booklet";
    progress(`Writing ${dl.pages.length} pages…`);
    const images = new Map<string, Uint8Array>();
    for (const i of req.images) if (i.bytes) images.set(i.url, i.bytes);
    const fonts = dl.faces.map((_, i) => faces.font(i));
    const bytes = await renderPdf(dl, fonts, images, (done, total) => progress(`Writing page ${done} of ${total}…`), { booklet });
    const trim = req.kind === "submission-pdf" ? { w: dl.trim.w / 72, h: dl.trim.h / 72 } : trimSize(req.model.book.print);
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
