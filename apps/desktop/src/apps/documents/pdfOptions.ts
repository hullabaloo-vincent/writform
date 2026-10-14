/**
 * The choices last made when exporting a PDF, remembered on this device (a
 * convenience: the document says nothing about them).
 */

import { cleanPdfOptions, DEFAULT_PDF_OPTIONS, type PdfOptions } from "../../book/render/options";

const KEY = "wf-pdf-export";

export function loadPdfOptions(): PdfOptions {
  try {
    return cleanPdfOptions(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_PDF_OPTIONS };
  }
}

export function savePdfOptions(options: PdfOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch {
    // A convenience only.
  }
}
