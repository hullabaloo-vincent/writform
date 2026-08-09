/**
 * Shared pdf.js loader. One place owns the legacy build (it carries
 * Promise.withResolvers and friends for the macOS desktop webview), the
 * Vite `?url` worker wiring, and the ReadableStream async-iterator polyfill
 * older WKWebViews need. Both the documents importer and the canvas board
 * importer load through here; pdf.js stays lazily bundled.
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

let loaded: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  loaded ??= (async () => {
    ensureReadableStreamAsyncIterator();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return loaded;
}
