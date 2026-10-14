/**
 * A PDF made here may hold the document it was made from (sourceCopy.ts).
 * This looks for it, and says whether the PDF has been changed since: a
 * file that somebody marked up or saved from another program still holds
 * the document as it was, which may no longer be what its pages show.
 */

import { DOC_SCHEMA_LEVEL } from "../../../editor/schema/levels";
import { loadPdfjs } from "../../../lib/pdfjs";
import { SOURCE_NAME, unpackSource, type SourceCopy } from "../sourceCopy";

export interface PdfSource {
  copy: SourceCopy;
  /** Changed after it was made here. */
  changed: boolean;
}

/** An attached file as pdf.js lists it. (An older pdf.js gave its bytes
 *  with it. Now they are asked for by the name it is listed under.) */
interface Attachment {
  filename?: string;
  content?: Uint8Array;
}

/**
 * The document kept inside a PDF. Null where there is none (or the PDF
 * cannot be opened at all, which is for whoever reads its pages to say).
 * Throws a `SourceError` for a copy that is there and cannot be used.
 */
export async function readPdfSource(data: ArrayBuffer): Promise<PdfSource | null> {
  const pdfjs = await loadPdfjs();
  // (pdf.js keeps the bytes it is given: these are a copy.)
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  try {
    let pdf: Awaited<typeof task.promise>;
    try {
      pdf = await task.promise;
    } catch {
      return null;
    }
    const all = (await pdf.getAttachments().catch(() => null)) as Map<string, Attachment> | Record<string, Attachment> | null;
    if (!all) return null;
    const entries: [string, Attachment][] = all instanceof Map ? [...all.entries()] : Object.entries(all);
    const entry = entries.find(([, a]) => a.filename === SOURCE_NAME);
    if (!entry) return null;
    let bytes = entry[1].content ?? null;
    if (!bytes) {
      const got = (await pdf.getAttachmentContent(entry[0]).catch(() => null)) as Uint8Array | { content?: Uint8Array } | null;
      bytes = got instanceof Uint8Array ? got : (got?.content ?? null);
    }
    if (!bytes) return null;
    const copy = unpackSource(bytes, DOC_SCHEMA_LEVEL);

    const info = ((await pdf.getMetadata().catch(() => null))?.info ?? {}) as Record<string, unknown>;
    // Made here, a PDF is written once, at one moment, by this app.
    const raw = new Uint8Array(data);
    let ends = 0;
    for (let i = raw.length - 5; i >= 0 && ends < 2; i -= 1) {
      if (raw[i] === 0x25 && raw[i + 1] === 0x25 && raw[i + 2] === 0x45 && raw[i + 3] === 0x4f && raw[i + 4] === 0x46) ends += 1;
    }
    const changed = ends > 1 || info.Producer !== "subScribe" || info.ModDate !== info.CreationDate;
    return { copy, changed };
  } finally {
    await task.destroy().catch(() => {});
  }
}
