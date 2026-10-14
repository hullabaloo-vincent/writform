/**
 * What a person chooses when a document is made into a PDF. Plain data,
 * carried from the dialog to the writer (which may be on another thread).
 */

/** How pictures go in. Screen: small enough to send. Print: sharp on
 *  paper. Original: as they are in the document, whatever their size. */
export type PictureQuality = "screen" | "print" | "original";

export interface PdfOptions {
  pictures: PictureQuality;
  /** Tags for screen readers and for text that reflows. */
  tagged: boolean;
  /** A copy made to last (PDF/A). */
  archive: boolean;
  /** The document itself kept inside the file, to open it again here. */
  source: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = { pictures: "print", tagged: true, archive: false, source: false };

const QUALITIES: PictureQuality[] = ["screen", "print", "original"];

/** Options from anywhere (a device's memory, another thread), made whole. */
export function cleanPdfOptions(raw: unknown): PdfOptions {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PDF_OPTIONS;
  return {
    pictures: QUALITIES.includes(o.pictures as PictureQuality) ? (o.pictures as PictureQuality) : d.pictures,
    tagged: typeof o.tagged === "boolean" ? o.tagged : d.tagged,
    archive: typeof o.archive === "boolean" ? o.archive : d.archive,
    source: typeof o.source === "boolean" ? o.source : d.source,
  };
}
