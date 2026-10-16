/**
 * The typesetter from the main thread's side: one long-lived worker (fonts
 * parsed once, chapters cached between layouts) that the book preview and
 * the print exports share. Font files and images are gathered here, where
 * fetch and canvas are available, and handed over. When a worker can't
 * start, the same session runs on the main thread.
 *
 * Pictures: a layout needs only their sizes, read from each file's first
 * bytes and remembered. A PDF asks for the pictures themselves once it
 * knows how large each is printed, a page's worth at a time, and they are
 * made ready here for that size (pictures.ts says how).
 */

import { modelImages, type DocModel } from "../../doclayout/model";
import { bookFileName } from "../exportBook";
import { loadFaces, resolveFont, scriptFamilies } from "../../fonts/store";
import { isCatalogBookFont } from "../fonts/registry";
import { modelPictureUrls } from "../model/pictures";
import { headingMarkOf } from "../model/presets";
import type { BookModel, Warning } from "../model/types";
import type { PdfOptions, PictureQuality } from "../render/options";
import type { PdfAttachment } from "../render/pdf";
import { smfNames } from "../smf/names";
import type { BuiltFile } from "../ui/ExportBookDialog";
import type { FaceBytes } from "./faces";
import { designFor, ornamentFor, smfFamily } from "./layout";
import { geometryFor } from "../model/trims";
import { canvasPixels, canvasTools } from "./pictureCanvas";
import { makePicture, sniff, type PdfPicture, type PictureInfo, type PictureTools, type PictureWant } from "./pictures";
import { viewKey } from "../../editor/schema/sanitize";
import type { AnyRequest, DocRequest, JobImage, LayoutRequest, PageMap, PictureSource, PressOptions, PrintKind, PrintResult, TypesetSession } from "./run";
import type { DisplayList } from "./types";

/** The families a job draws with: body, headings, and whichever family
 *  has the ornaments. */
export function familiesFor(kind: PrintKind, model: BookModel): string[] {
  if (kind === "submission-pdf") return [smfFamily(model.book.smf.font)];
  const d = designFor(model, "paperback");
  const families = [d.bodyFont, d.headingFont, ornamentFor(d.ornament || "* * *", d).family];
  const mark = headingMarkOf(d, false);
  if (mark.kind === "text") families.push(ornamentFor(mark.text, d).family);
  return [...new Set(families)];
}

/** A book's characters beyond plain ASCII (which scripts its fonts need). */
export function bookExotic(model: BookModel): string {
  const seen = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      for (const ch of value) if (ch.charCodeAt(0) > 0x7f && seen.size < 4000) seen.add(ch);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(model.sections);
  walk(model.book.meta);
  return [...seen].join("");
}

export interface BookFonts {
  /** The model, with any font that couldn't be had replaced by a stand-in. */
  model: BookModel;
  families: string[];
  chains: Record<string, string[]>;
  warnings: Warning[];
}

/**
 * A book designed in fonts from the online catalog: fetch them (the layout
 * can't wait), work out which of their scripts the text needs, and where
 * one can't be had set the book in the nearest of the app's own for now —
 * and say so.
 */
export async function bookFonts(kind: PrintKind, model: BookModel): Promise<BookFonts> {
  const design = { ...model.book.design };
  const chains: Record<string, string[]> = {};
  const warnings: Warning[] = [];
  if (kind !== "submission-pdf") {
    let exotic: string | null = null;
    for (const key of ["bodyFont", "headingFont"] as const) {
      const id = design[key];
      if (!isCatalogBookFont(id)) continue;
      const face = await resolveFont(id);
      design[key] = face.family;
      if (face.substituted) {
        if (!warnings.some((w) => w.message.includes(face.asked))) {
          warnings.push({ kind: "font", message: `${face.asked} couldn’t be fetched (no connection, or the online library is switched off), so the book is set in ${face.drawn} for now.` });
        }
        continue;
      }
      exotic ??= bookExotic(model);
      const more = await scriptFamilies(face.family, exotic);
      if (more.length) chains[face.family] = more;
    }
  }
  // What the heading face lacks (a display face often has one script only)
  // the body face may have: a title in another alphabet is set in that
  // rather than left blank.
  if (Object.keys(chains).length && design.headingFont !== design.bodyFont) {
    chains[design.headingFont] = [...new Set([...(chains[design.headingFont] ?? []), design.bodyFont, ...(chains[design.bodyFont] ?? [])])];
  }
  const same = design.bodyFont === model.book.design.bodyFont && design.headingFont === model.book.design.headingFont;
  const next = same ? model : { ...model, book: { ...model.book, design } };
  return { model: next, families: [...new Set([...familiesFor(kind, next), ...Object.values(chains).flat()])], chains, warnings };
}

// ---------------------------------------------------------------- images

/** The pictures a book's pages draw: those in its text, and its own art. */
const bookImages = (model: BookModel) => modelPictureUrls(model);

/** What is known of a picture from its file (null: it couldn't be had, as
 *  of `at`). The files themselves are not kept. */
const facts = new Map<string, { info: PictureInfo | null; at: number }>();
/** A picture that couldn't be had is asked for again after this long. */
const RETRY_MS = 30_000;

let fetchPicture = async (url: string): Promise<Uint8Array | null> => {
  try {
    const { normalizeAttachmentSrc } = await import("../../lib/backend");
    const res = await fetch(normalizeAttachmentSrc(url));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
};
let tools: PictureTools = canvasTools;

/** For tests: where pictures come from and what draws them. */
export function setPictureSource(fetcher: typeof fetchPicture, drawer: PictureTools = canvasTools): void {
  fetchPicture = fetcher;
  tools = drawer;
  facts.clear();
  ready.clear();
  readyBytes = 0;
}

/** The sizes of a job's pictures, for its layout (a few fetched at a time,
 *  each once), and which couldn't be had. */
async function pictureSizes(urls: string[]): Promise<{ images: JobImage[]; missing: string[] }> {
  const now = Date.now();
  const fresh = [...new Set(urls)].filter((url) => {
    const known = facts.get(url);
    return !known || (!known.info && now - known.at > RETRY_MS);
  });
  let next = 0;
  const worker = async () => {
    while (next < fresh.length) {
      const url = fresh[next];
      next += 1;
      const bytes = await fetchPicture(url);
      facts.set(url, { info: bytes ? sniff(bytes) : null, at: Date.now() });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, fresh.length) }, worker));
  const images: JobImage[] = [];
  const missing: string[] = [];
  for (const url of urls) {
    const info = facts.get(url)?.info;
    if (info) images.push({ url, w: info.w, h: info.h });
    else missing.push(url);
  }
  return { images, missing };
}

/** Pictures made ready lately, the small ones (a photograph is, a page of
 *  plain pixels is not): making the same PDF again, with another choice
 *  ticked, need not make them again. */
const ready = new Map<string, PdfPicture>();
let readyBytes = 0;
const READY_ONE = 2_000_000;
const READY_ALL = 48_000_000;
const sizeOf = (p: PdfPicture) => (p instanceof Uint8Array ? p.length : p.bytes.length + (p.alpha?.length ?? 0) + (p.icc?.length ?? 0) + (p.file?.length ?? 0));

/**
 * A PDF's pictures, made ready as it asks for them. `flatten`: on white,
 * with nothing see-through (a press). `gray`: in greys alone (a press
 * printing in black). Those that can't be had or read are named in
 * `failed`.
 */
function pictureSource(quality: PictureQuality, flatten: boolean, failed: Set<string>, gray = false): PictureSource {
  const maxPixels = canvasPixels();
  const one = async (want: PictureWant): Promise<PdfPicture | null> => {
    const key = `${quality}|${flatten ? 1 : 0}${gray ? "g" : ""}|${quality === "original" ? "" : `${Math.round(want.w)}x${Math.round(want.h)}`}|${viewKey(want.url, want.view)}`;
    const known = ready.get(key);
    if (known) return known;
    const bytes = await fetchPicture(want.url);
    const info = bytes ? sniff(bytes) : null;
    if (!bytes || !info) return null;
    try {
      const made = await makePicture(bytes, info, want, quality, { flatten, maxPixels, gray, view: want.view ?? null }, tools);
      const size = sizeOf(made);
      if (size <= READY_ONE) {
        ready.set(key, made);
        readyBytes += size;
        // (The oldest go first.)
        for (const [old, picture] of ready) {
          if (readyBytes <= READY_ALL) break;
          ready.delete(old);
          readyBytes -= sizeOf(picture);
        }
      }
      return made;
    } catch {
      return null;
    }
  };
  return async (want) => {
    const made = new Map<string, PdfPicture>();
    for (const w of want) {
      const picture = await one(w);
      if (picture) made.set(w.key ?? w.url, picture);
      else failed.add(w.url);
    }
    return made;
  };
}

// ---------------------------------------------------------------- worker

type Reply =
  /** The worker's script loaded (it has no id: it answers no request). */
  | { id?: undefined; type: "ready" }
  | { id: number; type: "progress"; message: string }
  | { id: number; type: "laidout"; dl: DisplayList }
  | { id: number; type: "done"; result: PrintResult }
  | { id: number; type: "pages"; map: PageMap }
  | { id: number; type: "cancelled" }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "fonts"; families: string[] }
  /** A PDF under way wants these pictures, each this large at most. */
  | { id: number; type: "images"; want: PictureWant[] };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  progress: (message: string) => void;
  /** The request, to send again with fonts the worker turns out to lack. */
  type: "layout" | "pdf" | "pages";
  req: AnyRequest;
  channel?: string;
  /** A PDF's pictures, when it asks. */
  pictures?: PictureSource;
}

class WorkerUnavailable extends Error {}

/** Idle workers are let go after this long (they hold fonts and caches). */
const IDLE_MS = 3 * 60_000;

/**
 * How long a new worker has to say it loaded. One that never does — its
 * script threw while loading, which not every webview reports as an error —
 * would otherwise leave every preview, page view and export waiting for
 * ever; past this the main thread does the work.
 */
let startMs = 6000;

/** For tests: how long to wait for a worker to start. */
export function setWorkerPatience(ms: number): void {
  startMs = ms;
}

/** (Exported for tests; the app uses the one from `typesetter()`.) */
export class Typesetter {
  private worker: Worker | null = null;
  private unavailable = false;
  private heard = false;
  /** Families whose files the current worker has been sent. Only a hint:
   *  a worker missing any asks for them. */
  private sent = new Set<string>();
  private pending = new Map<number, Pending>();
  /** Requests under way, from the moment they start gathering fonts: the
   *  worker isn't let go while there are any. */
  private active = 0;
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private starting: ReturnType<typeof setTimeout> | null = null;
  private local: Promise<TypesetSession> | null = null;

  private spawn(): Worker | null {
    if (this.unavailable) return null;
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    } catch {
      this.unavailable = true;
      return null;
    }
    this.worker = worker;
    this.heard = false;
    this.sent.clear();
    // Not a word from it in time: it didn't load. Work on the main thread.
    this.starting = setTimeout(() => {
      this.starting = null;
      if (worker !== this.worker || this.heard) return;
      console.warn("[typesetter] the worker didn't start; typesetting on the main thread");
      this.unavailable = true;
      this.stop(new WorkerUnavailable("the typesetting worker didn't start"));
    }, startMs);
    worker.onmessage = (e: MessageEvent<Reply>) => {
      if (worker !== this.worker) return;
      this.heard = true;
      if (this.starting) clearTimeout(this.starting);
      this.starting = null;
      const msg = e.data;
      if (msg.type === "ready") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === "progress") {
        p.progress(msg.message);
        return;
      }
      if (msg.type === "fonts") {
        void this.refill(worker, msg.id, msg.families);
        return;
      }
      if (msg.type === "images") {
        void this.supply(worker, msg.id, msg.want);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === "laidout") p.resolve(msg.dl);
      else if (msg.type === "done") p.resolve(msg.result);
      else if (msg.type === "pages") p.resolve(msg.map);
      else if (msg.type === "cancelled") p.resolve(null);
      else p.reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (worker !== this.worker) return;
      // Failing before ever answering means module workers can't run here
      // (or the script was blocked): use the main thread from now on.
      const cause = this.heard ? new Error(e.message || "The typesetter stopped unexpectedly.") : new WorkerUnavailable(e.message);
      if (!this.heard) this.unavailable = true;
      this.stop(cause);
    };
    return worker;
  }

  private stop(cause: unknown) {
    this.worker?.terminate();
    this.worker = null;
    this.sent.clear();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.starting) clearTimeout(this.starting);
    this.starting = null;
    for (const p of this.pending.values()) p.reject(cause);
    this.pending.clear();
  }

  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.active || !this.worker) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.active) this.stop(new Error("stopped"));
    }, IDLE_MS);
  }

  private localSession(): Promise<TypesetSession> {
    this.local ??= import("./run").then(({ TypesetSession }) => new TypesetSession());
    return this.local;
  }

  /** Post a request; the files sent with it are the worker's from then on. */
  private post(worker: Worker, id: number, p: Pending, fonts: FaceBytes[], refill = false) {
    worker.postMessage({ id, type: p.type, req: p.req, fonts, channel: p.channel, refill }, fonts.map((f) => f.bytes.buffer));
    for (const f of fonts) this.sent.add(f.family);
  }

  /** The worker lacks files it was thought to have: send them, with the
   *  request again. */
  private async refill(worker: Worker, id: number, families: string[]) {
    for (const f of families) this.sent.delete(f);
    try {
      const fonts = await loadFaces(families);
      const p = this.pending.get(id);
      // Let go meanwhile, which settled the request.
      if (!p || worker !== this.worker) return;
      this.post(worker, id, p, fonts, true);
    } catch (e) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.reject(e);
    }
  }

  /** A PDF under way asked for pictures: make them ready and hand them
   *  over. It is always answered (with fewer, where some can't be had):
   *  the job is waiting. */
  private async supply(worker: Worker, id: number, want: PictureWant[]) {
    let pictures = new Map<string, PdfPicture>();
    try {
      pictures = (await this.pending.get(id)?.pictures?.(want)) ?? pictures;
    } catch {
      // None, then.
    }
    // Let go meanwhile, which settled the request.
    if (!this.pending.has(id) || worker !== this.worker) return;
    try {
      worker.postMessage({ id, type: "images", pictures });
    } catch {
      worker.postMessage({ id, type: "images", pictures: new Map() });
    }
  }

  private async send(
    type: "layout" | "pdf" | "pages",
    req: AnyRequest,
    onProgress: (message: string) => void,
    channel?: string,
    pictures?: PictureSource,
  ): Promise<unknown> {
    this.active += 1;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    try {
      for (let worker = this.spawn(); worker; worker = this.spawn()) {
        const missing = req.families.filter((f) => !this.sent.has(f));
        const fonts = missing.length ? await loadFaces(missing) : [];
        // It stopped while the files loaded: start over with a new one.
        if (worker !== this.worker) continue;
        try {
          return await new Promise((resolve, reject) => {
            const id = this.nextId++;
            const p: Pending = { resolve, reject, progress: onProgress, type, req, channel, pictures };
            this.pending.set(id, p);
            try {
              this.post(worker, id, p, fonts);
            } catch (e) {
              this.pending.delete(id);
              reject(e);
            }
          });
        } catch (e) {
          if (!(e instanceof WorkerUnavailable)) throw e;
        }
      }
      // Main-thread fallback.
      const session = await this.localSession();
      const missing = session.missingFamilies(req.families);
      if (missing.length) session.addFonts(await loadFaces(missing));
      if (type === "pages") return await session.pageMap(req);
      return type === "layout" ? (await session.layout(req, onProgress)).dl : await session.pdf(req, onProgress, pictures);
    } finally {
      this.active -= 1;
      this.armIdle();
    }
  }

  /** Lay the book out (the preview). Null when a newer layout on the same
   *  channel overtook this one. */
  async layout(kind: PrintKind, source: BookModel, onProgress: (message: string) => void = () => {}, channel = "preview") {
    const fonts = await bookFonts(kind, source);
    const { images } = await pictureSizes(bookImages(fonts.model));
    const req: LayoutRequest = {
      kind,
      model: fonts.model,
      families: fonts.families,
      images,
      now: Date.now(),
      ...(Object.keys(fonts.chains).length ? { chains: fonts.chains } : {}),
    };
    const dl = (await this.send("layout", req, onProgress, channel)) as DisplayList | null;
    if (dl && fonts.warnings.length) dl.warnings.push(...fonts.warnings);
    return dl;
  }

  async pdf(kind: PrintKind, source: BookModel, onProgress: (message: string) => void, press?: PressOptions) {
    onProgress("Loading fonts and images…");
    const fonts = await bookFonts(kind, source);
    const { images, missing } = await pictureSizes(bookImages(fonts.model));
    const req: LayoutRequest = {
      kind,
      model: fonts.model,
      families: fonts.families,
      images,
      now: Date.now(),
      ...(Object.keys(fonts.chains).length ? { chains: fonts.chains } : {}),
      ...(kind === "paperback" && (press?.x1a || press?.bleed) ? { press } : {}),
    };
    // A book is for a press: pictures sharp on paper, on white, with
    // nothing see-through left in them (and in greys, for one that prints
    // in black alone).
    const failed = new Set(missing);
    const result = (await this.send("pdf", req, onProgress, undefined, pictureSource("print", true, failed, kind === "paperback" && !!press?.x1a))) as PrintResult;
    if (fonts.warnings.length) result.warnings.push(...fonts.warnings);
    return { result, failed: failed.size };
  }

  /** Lay a document out (its preview). Null when a newer layout on the
   *  same channel overtook this one. */
  async docLayout(doc: DocModel, channel = "doc-preview") {
    const { images } = await pictureSizes(modelImages(doc));
    const req: DocRequest = { kind: "document", doc, families: doc.families, images };
    return (await this.send("layout", req, () => {}, channel)) as DisplayList | null;
  }

  /** Where a document's pages fall (the editor's page view). Null when a
   *  newer request on the same channel overtook this one. */
  async docPages(doc: DocModel, channel = "doc-pages") {
    const { images } = await pictureSizes(modelImages(doc));
    const req: DocRequest = { kind: "document", doc, families: doc.families, images };
    return (await this.send("pages", req, () => {}, channel)) as PageMap | null;
  }

  /** A document as a PDF: straight, or imposed as a booklet. */
  async docPdf(doc: DocModel, booklet: boolean, onProgress: (message: string) => void = () => {}, pdf?: PdfOptions, attach?: PdfAttachment) {
    const { images, missing } = await pictureSizes(modelImages(doc));
    const req: DocRequest = { kind: booklet ? "document-booklet" : "document", doc, families: doc.families, images, ...(pdf ? { pdf } : {}), ...(attach && !booklet ? { attach } : {}) };
    const failed = new Set(missing);
    const result = (await this.send("pdf", req, onProgress, undefined, pictureSource(pdf?.pictures ?? "print", false, failed))) as PrintResult;
    return { result, failed: failed.size };
  }
}

let shared: Typesetter | null = null;

/** The app's one typesetter. */
export function typesetter(): Typesetter {
  shared ??= new Typesetter();
  return shared;
}

/** The margin KDP asks for at the top, the foot and the outside edge of a
 *  page that has bleed (inches). */
const BLEED_MARGIN = 0.375;

export async function typesetToPdf(kind: PrintKind, model: BookModel, onProgress: (message: string) => void, press?: PressOptions): Promise<BuiltFile> {
  const { result, failed } = await typesetter().pdf(kind, model, onProgress, press);
  const warnings = [...result.warnings];
  if (kind === "paperback" && press?.bleed) {
    const g = geometryFor(model.book.print, result.pages);
    if (Math.min(g.top, g.bottom, g.outside) < BLEED_MARGIN) {
      warnings.push({ kind: "page-count", message: `With bleed, KDP asks for at least ${BLEED_MARGIN} in at the top, the bottom and the outside edge. One of this book’s margins is smaller.` });
    }
  }
  if (failed) {
    warnings.push({
      kind: "image",
      message: `${failed} image${failed === 1 ? "" : "s"} couldn’t be loaded and ${failed === 1 ? "was" : "were"} left out.`,
    });
  }
  const trim = `${fmt(result.trim.w)} × ${fmt(result.trim.h)} in`;
  if (kind === "paperback") {
    return {
      bytes: result.bytes,
      fileName: `${bookFileName(model.book)} (paperback interior).pdf`,
      saveKind: "pdf",
      warnings,
      summary: `${result.pages} pages · ${trim} · inside margin ${fmt(result.insideMargin)} in${press?.bleed ? " · with bleed" : ""}${press?.x1a ? " · PDF/X-1a" : ""}`,
    };
  }
  if (kind === "booklet") {
    return {
      bytes: result.bytes,
      fileName: `${bookFileName(model.book)} (booklet).pdf`,
      saveKind: "pdf",
      warnings,
      summary: `${result.pages} pages on ${result.sheets} sheets. Print two-sided, flipping on the short edge, then fold.`,
    };
  }
  return {
    bytes: result.bytes,
    fileName: smfNames(model).fileName.replace(/\.docx$/, ".pdf"),
    saveKind: "pdf",
    warnings,
    summary: `${result.pages} pages · ${trim}`,
  };
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
