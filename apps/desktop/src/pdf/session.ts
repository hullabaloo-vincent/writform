/**
 * One PDF open for reading and changing.
 *
 * Two things hold it. The engine (engine/) is where it is changed: it
 * knows the file's objects, makes each change, and can take it back. pdf.js
 * is where it is looked at: it draws pages and finds their words. After a
 * change the engine hands over the file as it now stands and pdf.js opens
 * that, so what is shown is always what would be saved.
 *
 * No React here. The view subscribes, and a harness drives it directly.
 */

import { loadPdfjs, type Pdfjs } from "../lib/pdfjs";
import { newEngine, type Engine, type EngineCall, type EngineCalls, type EngineChange, type EngineFail, type EngineInfo, type EngineRead, type EngineReads } from "./engine/client";

type LoadingTask = ReturnType<Pdfjs["getDocument"]>;
export type PdfProxy = Awaited<LoadingTask["promise"]>;
export type PdfPageProxy = Awaited<ReturnType<PdfProxy["getPage"]>>;

/** The most a PDF may weigh to be opened here. */
export const EDIT_BYTES = 64_000_000;
export const EDIT_BYTES_PHONE = 25_000_000;

const onPhone = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/** Where pdf.js finds what it needs for files that bring less with them
 *  (character maps, the standard fonts, decoders): public/pdfjs. */
function dataUrls(): Record<string, unknown> {
  if (typeof document === "undefined" || !document.baseURI) return {};
  try {
    const at = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;
    return { cMapUrl: at("cmaps"), cMapPacked: true, standardFontDataUrl: at("standard_fonts"), wasmUrl: at("wasm"), iccUrl: at("iccs") };
  } catch {
    return {};
  }
}

export class PdfSession {
  info: EngineInfo;
  /** The file as it stands (what pdf.js shows). */
  bytes: Uint8Array;
  pdf: PdfProxy;
  /** Goes up with every change, and names what was drawn of which. */
  revision = 0;
  /** What the last change touched (null: everything is new). */
  lastChange: EngineChange | null = null;
  busy = false;
  /** Goes up whenever anything a view shows may have changed. */
  ticks = 0;
  private listeners = new Set<() => void>();
  private closed = false;

  private constructor(
    readonly name: string,
    private engine: Engine,
    readonly pdfjs: Pdfjs,
    private password: string | undefined,
    info: EngineInfo,
    bytes: Uint8Array,
    pdf: PdfProxy,
  ) {
    this.info = info;
    this.bytes = bytes;
    this.pdf = pdf;
  }

  /** Open a PDF. Throws an `EngineFail`: `NeedsPassword` and `WrongPassword`
   *  are for asking and trying again. */
  static async open(name: string, bytes: Uint8Array, password?: string): Promise<PdfSession> {
    if (bytes.length > (onPhone() ? EDIT_BYTES_PHONE : EDIT_BYTES)) {
      throw { code: "Invalid", message: `This PDF is too large to edit here. The most is ${Math.round((onPhone() ? EDIT_BYTES_PHONE : EDIT_BYTES) / 1_000_000)} MB.` } satisfies EngineFail;
    }
    const pdfjs = await loadPdfjs();
    const engine = newEngine();
    try {
      const info = await engine.open(bytes, password);
      const pdf = await PdfSession.show(pdfjs, bytes, password);
      return new PdfSession(name, engine, pdfjs, password, info, bytes, pdf);
    } catch (e) {
      engine.close();
      throw e;
    }
  }

  private static async show(pdfjs: Pdfjs, bytes: Uint8Array, password: string | undefined): Promise<PdfProxy> {
    // (pdf.js keeps the bytes it is given: these are a copy.)
    return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password ? { password } : {}), ...dataUrls() }).promise;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private tell(): void {
    this.ticks += 1;
    for (const listener of [...this.listeners]) listener();
  }

  get pageCount(): number {
    return this.info.pages.length;
  }

  /** Make a change. What is shown follows it. One at a time: a change asked
   *  for while another is being made is not made. */
  async change<K extends EngineCall>(method: K, ...args: EngineCalls[K]): Promise<EngineChange | null> {
    if (this.busy || this.closed) return null;
    this.busy = true;
    this.tell();
    try {
      const change = await this.engine.call(method, ...args);
      await this.follow(change);
      return change;
    } catch (e) {
      // After the engine failed it was started again with the file as it
      // last stood: what is shown is still that file.
      if ((e as EngineFail | null)?.code === "Crashed") this.info = await this.engine.info().catch(() => this.info);
      throw e;
    } finally {
      this.busy = false;
      this.tell();
    }
  }

  private async follow(change: EngineChange): Promise<void> {
    const bytes = await this.engine.bytes(false);
    const info = await this.engine.info();
    const pdf = await PdfSession.show(this.pdfjs, bytes, this.password);
    const old = this.pdf;
    this.bytes = bytes;
    this.info = info;
    this.pdf = pdf;
    this.lastChange = change;
    this.revision += 1;
    void old.loadingTask.destroy().catch(() => {});
  }

  /** Read something of the document as it stands (its marks, its form, a
   *  page's text). */
  read<K extends EngineRead>(what: K, ...args: EngineReads[K]["args"]): Promise<EngineReads[K]["value"]> {
    return this.engine.read(what, ...args);
  }

  undo(): Promise<EngineChange | null> {
    return this.change("undo");
  }

  redo(): Promise<EngineChange | null> {
    return this.change("redo");
  }

  /** The document as a file to keep: written afresh, with nothing left
   *  inside of what was taken out. */
  copy(): Promise<Uint8Array> {
    return this.engine.bytes(true);
  }

  /** Some pages as a PDF of their own. */
  extract(pages: number[]): Promise<Uint8Array> {
    return this.engine.extract(pages);
  }

  /** What is open was saved somewhere: it is no longer changed. */
  async markSaved(): Promise<void> {
    await this.engine.saved(this.bytes);
    this.info = await this.engine.info();
    this.tell();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.engine.close();
    void this.pdf.loadingTask.destroy().catch(() => {});
  }
}
