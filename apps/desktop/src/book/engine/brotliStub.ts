/**
 * Stands in for the `brotli` decompressor fontkit imports: it's only used
 * for WOFF2 files, and the bundled fonts are TTF/OTF. Keeps ~750 KB of
 * dictionary out of the typesetting bundle.
 */
export default function brotliDecompress(): never {
  throw new Error("WOFF2 fonts aren’t supported");
}
