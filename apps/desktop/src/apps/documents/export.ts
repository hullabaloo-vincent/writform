import type { JSONContent } from "@tiptap/core";

import type { PdfOptions } from "../../book/render/options";
import type { DocxImage, DocxWritten } from "../../docx/write";
import type { StyleOverrides } from "../../editor/styles/sheet";
import type { SaveResult } from "../../lib/backend";
import { saveExport } from "../../lib/saveFile";
import { toast } from "../../platform/toast";
import { authorName } from "../../stores/localProfile";
import { useSession } from "../../stores/session";
import type { DocMapsSnapshot } from "./docMaps";
import { DEFAULT_SETTINGS, type DocSettings } from "./docSettings";
import { finalJson } from "../../editor/review/final";
import { isScripted, scriptedAsDocument } from "../../doclayout/scripted";

function safeName(title: string): string {
  return (title.trim() || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}

/** Who wrote it, for the file's properties and `{author}` fields: the
 *  server's name for you while connected, else the one this device knows. */
function currentAuthor(): string | undefined {
  return authorName(useSession.getState().session?.user);
}

/** Build and save one export. Saving goes through the shared save path —
 *  an `<a download>` click is silently cancelled by the desktop/iOS webview. */
export async function exportDocument(
  source: JSONContent,
  title: string,
  format: string,
  /** `docx` carries suggested changes as Word's tracked changes;
   *  `docx-clean` is the text with them accepted. A PDF never shows them. */
  kind: "pdf" | "docx" | "docx-clean" | "booklet",
  settings?: DocSettings,
  /** What the document has changed about its styles. */
  styles?: StyleOverrides,
): Promise<SaveResult> {
  if (kind === "docx" || kind === "docx-clean") {
    const clean = kind === "docx-clean";
    const built = await buildDocx(clean ? finalJson(source) : source, title, format, settings, styles);
    const result = await saveExport(`${safeName(title)}${clean ? " (clean)" : ""}.docx`, "docx", built.bytes);
    if (result.status === "saved" && built.missingImages) {
      const n = built.missingImages;
      toast(`${n} picture${n === 1 ? "" : "s"} couldn't be loaded and ${n === 1 ? "was" : "were"} left out.`, "info");
    }
    return result;
  }
  const booklet = kind === "booklet";
  const name = booklet ? `${safeName(title)} (booklet).pdf` : `${safeName(title)}.pdf`;
  const { buildDocPdf } = await import("../../doclayout/exportDoc");
  const built = await buildDocPdf(pagesSource(source, title, format, settings, styles), { booklet });
  const result = await saveExport(name, "pdf", built.bytes);
  if (result.status === "saved") noteOnce(built.notes);
  return result;
}

/**
 * What the page layout sets for a document of any format: a Document as it
 * is, with its own page setup and styles; a screenplay, a stage play or a
 * poem turned into that format's page (see doclayout/scripted.ts).
 */
export function pagesSource(
  doc: JSONContent,
  title: string,
  format: string,
  settings: DocSettings | undefined,
  styles?: StyleOverrides,
): { doc: JSONContent; title: string; author?: string; settings: DocSettings; styles?: StyleOverrides } {
  const author = currentAuthor();
  if (isScripted(format)) return { ...scriptedAsDocument(finalJson(doc), format, title), title, author };
  return { doc, title, author, settings: settings ?? DEFAULT_SETTINGS, ...(format === "none" ? { styles } : {}) };
}

/**
 * The document as a PDF for the Export dialog, made the way chosen there.
 * Where it was asked for, the document itself goes inside (sourceCopy.ts):
 * the text as it is in the editor (not as a script's pages set it), its own
 * settings, and its pictures.
 */
export async function buildExportPdf(
  source: JSONContent,
  title: string,
  format: string,
  settings: DocSettings | undefined,
  styles: StyleOverrides | undefined,
  /** The document's own maps, read when they are wanted. */
  maps: () => DocMapsSnapshot,
  options: PdfOptions,
  onProgress: (message: string) => void,
): Promise<{ bytes: Uint8Array; pages: number; notes: string[] }> {
  const { buildDocPdf } = await import("../../doclayout/exportDoc");
  const notes: string[] = [];
  let attach: { name: string; type: string; description: string; bytes: Uint8Array } | undefined;
  if (options.source) {
    onProgress("Putting the document inside…");
    const [{ packSource, SOURCE_DESCRIPTION, SOURCE_NAME, SOURCE_TYPE }, { collectImages }] = await Promise.all([import("./sourceCopy"), import("../../book/exportBook")]);
    const packed = await packSource({ title, format, content: finalJson(source), maps: maps() }, async (src) => (await collectImages([src])).images.get(src)?.bytes ?? null);
    attach = { name: SOURCE_NAME, type: SOURCE_TYPE, description: SOURCE_DESCRIPTION, bytes: packed.bytes };
    if (packed.left) {
      notes.push(`${packed.left === 1 ? "A picture" : `${packed.left} pictures`} couldn’t be read and ${packed.left === 1 ? "is" : "are"} not in the copy kept inside.`);
    }
  }
  const built = await buildDocPdf(pagesSource(source, title, format, settings, styles), { pdf: options, onProgress, ...(attach ? { attach } : {}) });
  return { bytes: built.bytes, pages: built.pages, notes: [...built.notes, ...notes] };
}

/** The document as a PDF for the Print dialog. */
export async function buildPrintable(
  source: JSONContent,
  title: string,
  format: string,
  settings: DocSettings | undefined,
  booklet: boolean,
  styles?: StyleOverrides,
): Promise<{ bytes: Uint8Array; pages?: number; sheets?: number; notes: string[] }> {
  const { buildDocPdf } = await import("../../doclayout/exportDoc");
  return buildDocPdf(pagesSource(source, title, format, settings, styles), { booklet });
}

const noted = new Set<string>();

/** Say what an export had to do differently — once each per session, so a
 *  note that applies to every export (a stand-in font) doesn't nag. */
export function noteOnce(notes: string[]): void {
  for (const note of notes) {
    if (noted.has(note)) continue;
    noted.add(note);
    toast(note, "info", { durationMs: 8000 });
  }
}

/** A Word document from the content, with its pictures fetched and embedded. */
export async function buildDocx(
  doc: JSONContent,
  title: string,
  format: string,
  settings?: DocSettings,
  styles?: StyleOverrides,
): Promise<DocxWritten> {
  const { writeDocx, imageSources } = await import("../../docx/write");
  // Catalog fonts are written under their real family names.
  await import("../../fonts/catalog").then((m) => m.loadCatalog()).catch(() => null);
  const images = new Map<string, DocxImage>();
  const sources = imageSources(doc);
  if (sources.length) {
    const { collectImages } = await import("../../book/exportBook");
    const { imageSize } = await import("../../lib/imageSize");
    const fetched = await collectImages(sources);
    for (const [src, image] of fetched.images) {
      const size = imageSize(image.bytes);
      images.set(src, { ...image, ...(size ?? {}) });
    }
  }
  // A table of contents shows each heading's page: the pages this app's own
  // layout puts them on (Word works them out afresh when asked to update).
  let tocPages: string[] | undefined;
  if (format === "none" && settings && (doc.content ?? []).some((n) => n.type === "toc")) {
    try {
      const { layoutDocPreview } = await import("../../doclayout/exportDoc");
      const dl = await layoutDocPreview({ doc, title, author: currentAuthor(), settings, styles });
      tocPages = dl?.sections.map((section) => section.folio);
    } catch {
      // Without them the entries are still listed; Word fills in the pages.
    }
  }
  return writeDocx(doc, { title, author: currentAuthor(), format, settings, images, styles, ...(tocPages ? { tocPages } : {}) });
}
