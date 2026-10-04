/**
 * The book exports, from the manuscript as it is now: the submission
 * manuscript (Word), the ebook (EPUB) and the print-ready PDF. Each builds
 * the same book model, so they always agree on structure and numbering.
 */

import type { JSONContent } from "@tiptap/core";

import { saveExport } from "../lib/saveFile";
import { toast } from "../platform/toast";
import type { Book } from "./model/bookMap";
import { buildModel } from "./model/buildModel";

/** Standard Manuscript Format, as a Word document. */
export async function exportSubmissionDocx(doc: JSONContent, format: string, book: Book) {
  const model = buildModel(doc, format, book);
  const { buildManuscriptDocx, smfNames } = await import("./smf/docx");
  const bytes = await buildManuscriptDocx(model);
  const result = await saveExport(smfNames(model).fileName, "docx", bytes);
  if (result.status === "saved" && !book.contact.legalName && !book.contact.email) {
    toast("Tip: add your contact details in Book ▸ Submission manuscript for the title page.", "info", {
      durationMs: 7000,
    });
  }
  return result;
}

/** Fetch the manuscript's images (server attachments) for an export;
 *  failures are reported, not fatal. */
export async function collectImages(
  urls: string[],
): Promise<{ images: Map<string, { bytes: Uint8Array; type: string }>; failed: number }> {
  const { normalizeAttachmentSrc } = await import("../lib/backend");
  const images = new Map<string, { bytes: Uint8Array; type: string }>();
  let failed = 0;
  for (const url of new Set(urls)) {
    try {
      const res = await fetch(normalizeAttachmentSrc(url));
      if (!res.ok) throw new Error(String(res.status));
      const type = (res.headers.get("content-type") ?? "").split(";")[0] || "image/jpeg";
      if (!/^image\/(jpeg|png|gif)$/.test(type)) throw new Error(type);
      images.set(url, { bytes: new Uint8Array(await res.arrayBuffer()), type });
    } catch {
      failed += 1;
    }
  }
  return { images, failed };
}

export function bookFileName(book: Book, suffix = ""): string {
  const base = (book.meta.title || "Book").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${base}${suffix}`;
}

/** Print outputs (paperback interior, booklet, submission PDF) — built by
 *  the typesetting engine. */
export async function buildPrintFile(
  kind: "paperback" | "submission-pdf" | "booklet",
  model: import("./model/types").BookModel,
  onProgress: (message: string) => void,
): Promise<import("./ui/ExportBookDialog").BuiltFile> {
  const { typesetToPdf } = await import("./engine/client");
  return typesetToPdf(kind, model, onProgress);
}
