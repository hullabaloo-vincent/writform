/**
 * Reading a PDF's pages, in the app: the reader itself (import/pdf) with
 * what only the app can give it. pdf.js, the dialog that asks (a password,
 * what to do with a scan) and shows how far a long import is, a canvas to
 * make files of pictures, the fonts this device has, its limits, and the
 * system's own text recogniser where there is one.
 */

import { loadCatalog } from "../../../fonts/catalog";
import { fontIdForPdfName, pdfFontFamily } from "../../../fonts/pdfName";
import { systemFonts } from "../../../fonts/store";
import { backend } from "../../../lib/backend";
import { loadPdfjs } from "../../../lib/pdfjs";
import { DESKTOP_LIMITS, PHONE_LIMITS, readPdf, type PdfRead, type Recognise } from "./pdf";
import { encodePdfImage, renderPdfPage } from "./pdfCanvas";
import { beginPdfImport } from "./PdfImportDialog";

const onPhone = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export async function readPdfPages(data: ArrayBuffer, name: string): Promise<PdfRead> {
  const ui = beginPdfImport(name);
  try {
    const [pdfjs, installed, catalog, reads] = await Promise.all([
      loadPdfjs(),
      systemFonts().catch(() => new Map<string, { family: string }>()),
      loadCatalog().catch(() => null),
      backend.ocrStatus().catch(() => false),
    ]);
    const lookup = { installed, catalog: catalog?.byName };
    const recognise: Recognise = async (picture, lang) => {
      const { lines } = await backend.ocrPage(picture.bytes, lang);
      return lines.map((line) => ({ text: line.text, box: { x: line.x, y: line.y, w: line.w, h: line.h }, confidence: line.confidence }));
    };
    return await readPdf(data, {
      pdfjs,
      limits: onPhone() ? PHONE_LIMITS : DESKTOP_LIMITS,
      ask: ui.ask,
      progress: ui.progress,
      signal: ui.signal,
      encodeImage: encodePdfImage,
      renderPage: renderPdfPage,
      ...(reads ? { recognise } : {}),
      lang: typeof navigator !== "undefined" ? navigator.language : "en-US",
      scanDpi: onPhone() ? 200 : 300,
      fontId: (font) => fontIdForPdfName(font, lookup),
      fontFamily: pdfFontFamily,
    });
  } finally {
    ui.end();
  }
}
