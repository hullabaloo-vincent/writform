/**
 * The typesetter from the main thread's side: one long-lived worker (fonts
 * parsed once, chapters cached between layouts) that the book preview and
 * the print exports share. Font files and images are gathered here, where
 * fetch and canvas are available, and handed over. When a worker can't
 * start, the same session runs on the main thread.
 */

import { bookFileName, collectImages } from "../exportBook";
import { loadFontFiles } from "../fonts/files";
import type { BookModel } from "../model/types";
import { smfNames } from "../smf/names";
import type { BuiltFile } from "../ui/ExportBookDialog";
import type { FaceBytes } from "./faces";
import { designFor, ornamentFor, smfFamily } from "./layout";
import type { JobImage, LayoutRequest, PrintKind, PrintResult, TypesetSession } from "./run";
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

// ---------------------------------------------------------------- images

const prepared = new Map<string, JobImage | null>();

/** The manuscript's images, scaled to at most ~300 pixels per inch of the
 *  widest they can print and flattened onto white (print PDFs shouldn't
 *  carry transparency). Cached by URL for the session. */
async function prepareImages(model: BookModel): Promise<{ images: JobImage[]; failed: number }> {
  const urls = [...new Set(model.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "image" ? [b.url] : []))))];
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
  | { id: number; type: "progress"; message: string }
  | { id: number; type: "laidout"; dl: DisplayList }
  | { id: number; type: "done"; result: PrintResult }
  | { id: number; type: "cancelled" }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "fonts"; families: string[] };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  progress: (message: string) => void;
  /** The request, to send again with fonts the worker turns out to lack. */
  type: "layout" | "pdf";
  req: LayoutRequest;
  channel?: string;
}

class WorkerUnavailable extends Error {}

/** Idle workers are let go after this long (they hold fonts and caches). */
const IDLE_MS = 3 * 60_000;

class Typesetter {
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
    worker.onmessage = (e: MessageEvent<Reply>) => {
      if (worker !== this.worker) return;
      this.heard = true;
      const msg = e.data;
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
      const fonts = await loadFontFiles(families);
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
    type: "layout" | "pdf",
    req: LayoutRequest,
    onProgress: (message: string) => void,
    channel?: string,
  ): Promise<unknown> {
    this.active += 1;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    try {
      for (let worker = this.spawn(); worker; worker = this.spawn()) {
        const missing = req.families.filter((f) => !this.sent.has(f));
        const fonts = missing.length ? await loadFontFiles(missing) : [];
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
      if (missing.length) session.addFonts(await loadFontFiles(missing));
      return type === "layout" ? (await session.layout(req, onProgress)).dl : await session.pdf(req, onProgress);
    } finally {
      this.active -= 1;
      this.armIdle();
    }
  }

  /** Lay the book out (the preview). Null when a newer layout on the same
   *  channel overtook this one. */
  async layout(kind: PrintKind, model: BookModel, onProgress: (message: string) => void = () => {}, channel = "preview") {
    const { images } = await prepareImages(model);
    const req: LayoutRequest = {
      kind,
      model,
      families: familiesFor(kind, model),
      images: images.map(({ url, w, h }) => ({ url, w, h })),
      now: Date.now(),
    };
    return (await this.send("layout", req, onProgress, channel)) as DisplayList | null;
  }

  async pdf(kind: PrintKind, model: BookModel, onProgress: (message: string) => void) {
    onProgress("Loading fonts and images…");
    const { images, failed } = await prepareImages(model);
    const req: LayoutRequest = { kind, model, families: familiesFor(kind, model), images, now: Date.now() };
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
