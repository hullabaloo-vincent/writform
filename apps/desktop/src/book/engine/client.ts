/**
 * The typesetter from the main thread's side: one long-lived worker (fonts
 * parsed once, chapters cached between layouts) that the book preview and
 * the print exports share. Font files and images are gathered here, where
 * fetch and canvas are available, and handed over. When a worker can't
 * start, the same session runs on the main thread.
 */

import { modelImages, type DocModel } from "../../doclayout/model";
import { bookFileName, collectImages } from "../exportBook";
import { loadFaces, resolveFont, scriptFamilies } from "../../fonts/store";
import { isCatalogBookFont } from "../fonts/registry";
import type { BookModel, Warning } from "../model/types";
import { smfNames } from "../smf/names";
import type { BuiltFile } from "../ui/ExportBookDialog";
import type { FaceBytes } from "./faces";
import { designFor, ornamentFor, smfFamily } from "./layout";
import type { AnyRequest, DocRequest, JobImage, LayoutRequest, PageMap, PrintKind, PrintResult, TypesetSession } from "./run";
import type { DisplayList } from "./types";

/** The families a job draws with: body, headings, and whichever family
 *  has the ornaments. */
export function familiesFor(kind: PrintKind, model: BookModel): string[] {
  if (kind === "submission-pdf") return [smfFamily(model.book.smf.font)];
  const d = designFor(model, "paperback");
  const families = [d.bodyFont, d.headingFont, ornamentFor(d.ornament || "* * *", d).family];
  if (d.headingOrnament) families.push(ornamentFor(d.headingOrnament, d).family);
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

const prepared = new Map<string, JobImage | null>();

const bookImages = (model: BookModel) => [
  ...new Set(model.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "image" ? [b.url] : [])))),
];

/** Images for print, scaled to at most ~300 pixels per inch of the widest
 *  they can print and flattened onto white (print PDFs shouldn't carry
 *  transparency). Cached by URL for the session. */
async function prepareImages(urls: string[]): Promise<{ images: JobImage[]; failed: number }> {
  const fresh = urls.filter((u) => !prepared.has(u));
  if (fresh.length) {
    const { images: fetched } = await collectImages(fresh);
    const maxPx = 1800;
    for (const url of fresh) {
      const img = fetched.get(url);
      if (!img) {
        prepared.set(url, null);
        continue;
      }
      try {
        const bitmap = await createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.type }));
        const scale = Math.min(1, maxPx / bitmap.width);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        if (!blob) throw new Error("encode failed");
        prepared.set(url, { url, bytes: new Uint8Array(await blob.arrayBuffer()), w, h });
      } catch {
        prepared.set(url, null);
      }
    }
  }
  const images: JobImage[] = [];
  let failed = 0;
  for (const url of urls) {
    const img = prepared.get(url);
    if (img) images.push(img);
    else failed += 1;
  }
  return { images, failed };
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
  | { id: number; type: "fonts"; families: string[] };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  progress: (message: string) => void;
  /** The request, to send again with fonts the worker turns out to lack. */
  type: "layout" | "pdf" | "pages";
  req: AnyRequest;
  channel?: string;
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

  private async send(
    type: "layout" | "pdf" | "pages",
    req: AnyRequest,
    onProgress: (message: string) => void,
    channel?: string,
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
            const p: Pending = { resolve, reject, progress: onProgress, type, req, channel };
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
      return type === "layout" ? (await session.layout(req, onProgress)).dl : await session.pdf(req, onProgress);
    } finally {
      this.active -= 1;
      this.armIdle();
    }
  }

  /** Lay the book out (the preview). Null when a newer layout on the same
   *  channel overtook this one. */
  async layout(kind: PrintKind, source: BookModel, onProgress: (message: string) => void = () => {}, channel = "preview") {
    const fonts = await bookFonts(kind, source);
    const { images } = await prepareImages(bookImages(fonts.model));
    const req: LayoutRequest = {
      kind,
      model: fonts.model,
      families: fonts.families,
      images: images.map(({ url, w, h }) => ({ url, w, h })),
      now: Date.now(),
      ...(Object.keys(fonts.chains).length ? { chains: fonts.chains } : {}),
    };
    const dl = (await this.send("layout", req, onProgress, channel)) as DisplayList | null;
    if (dl && fonts.warnings.length) dl.warnings.push(...fonts.warnings);
    return dl;
  }

  async pdf(kind: PrintKind, source: BookModel, onProgress: (message: string) => void) {
    onProgress("Loading fonts and images…");
    const fonts = await bookFonts(kind, source);
    const { images, failed } = await prepareImages(bookImages(fonts.model));
    const req: LayoutRequest = {
      kind,
      model: fonts.model,
      families: fonts.families,
      images,
      now: Date.now(),
      ...(Object.keys(fonts.chains).length ? { chains: fonts.chains } : {}),
    };
    const result = (await this.send("pdf", req, onProgress)) as PrintResult;
    if (fonts.warnings.length) result.warnings.push(...fonts.warnings);
    return { result, failed };
  }

  /** Lay a document out (its preview). Null when a newer layout on the
   *  same channel overtook this one. */
  async docLayout(doc: DocModel, channel = "doc-preview") {
    const { images } = await prepareImages(modelImages(doc));
    const req: DocRequest = {
      kind: "document",
      doc,
      families: doc.families,
      images: images.map(({ url, w, h }) => ({ url, w, h })),
    };
    return (await this.send("layout", req, () => {}, channel)) as DisplayList | null;
  }

  /** Where a document's pages fall (the editor's page view). Null when a
   *  newer request on the same channel overtook this one. */
  async docPages(doc: DocModel, channel = "doc-pages") {
    const { images } = await prepareImages(modelImages(doc));
    const req: DocRequest = {
      kind: "document",
      doc,
      families: doc.families,
      images: images.map(({ url, w, h }) => ({ url, w, h })),
    };
    return (await this.send("pages", req, () => {}, channel)) as PageMap | null;
  }

  /** A document as a PDF: straight, or imposed as a booklet. */
  async docPdf(doc: DocModel, booklet: boolean, onProgress: (message: string) => void = () => {}) {
    const { images, failed } = await prepareImages(modelImages(doc));
    const req: DocRequest = { kind: booklet ? "document-booklet" : "document", doc, families: doc.families, images };
    const result = (await this.send("pdf", req, onProgress)) as PrintResult;
    return { result, failed };
  }
}

let shared: Typesetter | null = null;

/** The app's one typesetter. */
export function typesetter(): Typesetter {
  shared ??= new Typesetter();
  return shared;
}

export async function typesetToPdf(kind: PrintKind, model: BookModel, onProgress: (message: string) => void): Promise<BuiltFile> {
  const { result, failed } = await typesetter().pdf(kind, model, onProgress);
  const warnings = [...result.warnings];
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
      fileName: `${bookFileName(model.book)} – paperback interior.pdf`,
      saveKind: "pdf",
      warnings,
      summary: `${result.pages} pages · ${trim} · inside margin ${fmt(result.insideMargin)} in`,
    };
  }
  if (kind === "booklet") {
    return {
      bytes: result.bytes,
      fileName: `${bookFileName(model.book)} – booklet.pdf`,
      saveKind: "pdf",
      warnings,
      summary: `${result.pages} pages on ${result.sheets} sheets — print two-sided, flipping on the short edge, then fold`,
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
