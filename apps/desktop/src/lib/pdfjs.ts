/**
 * Shared pdf.js loader. One place owns the legacy build (it carries
 * Promise.withResolvers and friends for the macOS desktop webview), the
 * worker wiring, and the ReadableStream async-iterator polyfill older
 * WKWebViews need. Everything that reads a PDF loads through here; pdf.js
 * stays lazily bundled.
 *
 * The worker goes through the app's build (`?worker`), not in as a file
 * (`?url`): pdf.js's own files hold syntax Safari 15 cannot read, and only
 * what the build has been over is lowered to what it can (vite.config.ts).
 * A webview that still cannot run pdf.js gets one plain error from here,
 * for every caller to show.
 */

export type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * Older WKWebViews expose ReadableStream#getReader without making streams
 * async-iterable. PDF.js uses `for await` in getTextContent, so add the
 * standards-compatible iterator before loading PDF.js.
 */
function ensureReadableStreamAsyncIterator(): void {
  const Stream = globalThis.ReadableStream;
  if (!Stream) return;
  const streamPrototype = Stream.prototype as unknown as Record<symbol, unknown>;
  if (typeof streamPrototype[Symbol.asyncIterator] === "function") return;

  Object.defineProperty(Stream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* <T>(this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/** What a caller shows when this webview cannot run the PDF reader. */
export const PDF_UNAVAILABLE = {
  code: "pdf_unavailable",
  message: "PDFs cannot be read on this version of the system. It needs iOS 16.4 or Safari 16.4 or later.",
} as const;

export const isPdfUnavailable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === PDF_UNAVAILABLE.code;

let loaded: Promise<Pdfjs> | null = null;

/** For tests, where the build's own worker cannot run: the reader to use
 *  from then on (pdf.js loaded by the test itself). */
export function setPdfjs(pdfjs: Pdfjs): void {
  loaded = Promise.resolve(pdfjs);
}

export function loadPdfjs(): Promise<Pdfjs> {
  loaded ??= (async () => {
    try {
      ensureReadableStreamAsyncIterator();
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { default: PdfWorker } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker");
      // One worker for every PDF opened (pdf.js shares a port it is given
      // and never ends it).
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
      return pdfjs;
    } catch (error) {
      console.warn("[pdf] the reader did not load", error);
      throw PDF_UNAVAILABLE;
    }
  })();
  // A failure is not kept: the next try starts again.
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
}
