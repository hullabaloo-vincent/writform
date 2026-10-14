/**
 * A Document as pages: the PDF (straight, or imposed as a booklet) that
 * Export saves and Print sends to the printer, and the display list the
 * preview draws — all from the same layout, so they agree.
 */

import type { JSONContent } from "@tiptap/core";

import { bodyLook, type DocSettings } from "../apps/documents/docSettings";
import { typesetter } from "../book/engine/client";
import type { PageMap } from "../book/engine/run";
import type { DisplayList } from "../book/engine/types";
import type { PdfOptions } from "../book/render/options";
import type { PdfAttachment } from "../book/render/pdf";
import { finalJson } from "../editor/review/final";
import { resolveStyles, styleFonts, type StyleOverrides } from "../editor/styles/sheet";
import { resolveDocFonts, showFamilies } from "../fonts/store";
import { buildDocModel, type DocModel } from "./model";

export interface DocPdf {
  bytes: Uint8Array;
  pages: number;
  /** Physical sheets (booklets). */
  sheets?: number;
  /** Things worth telling the writer: stand-in fonts, missing pictures. */
  notes: string[];
}

export interface DocSource {
  doc: JSONContent;
  title: string;
  author?: string;
  settings: DocSettings;
  /** What the document has changed about its styles. */
  styles?: StyleOverrides;
  /** Lay it out as it stands in the editor — suggested changes not taken
   *  as accepted — so places in the layout are places in the editor. */
  raw?: boolean;
  /** Blocks at the start that were put in for print (see scripted.ts). */
  virtual?: number;
  /** The language, when the settings laid out are not the document's own
   *  (a script on its format's sheet). */
  lang?: string;
  /** Work out the document's structure too (a tagged PDF). */
  struct?: boolean;
}

/** The document as the layout sees it — once every font it names has been
 *  found (or stood in for) on this device. */
export async function docModel(source: DocSource): Promise<DocModel> {
  const named = styleFonts(resolveStyles(bodyLook(source.settings), source.styles));
  // Pages show the text as it would stand: suggested changes accepted.
  const doc = source.raw ? source.doc : finalJson(source.doc);
  const fonts = await resolveDocFonts(doc, source.settings.bodyFont, named);
  return buildDocModel(doc, {
    ...(source.struct ? { struct: true } : {}),
    title: source.title,
    author: source.author,
    settings: source.settings,
    fonts,
    styles: source.styles,
    ...(source.virtual ? { virtual: source.virtual } : {}),
    ...(source.lang ? { lang: source.lang } : {}),
  });
}

/** Where the document's pages fall, for the editor's page view. Null when
 *  a newer request on the same channel overtook this one. `timing.model`
 *  is given how long the part done on the page took, ms (the rest is the
 *  engine's, on its own thread). */
export async function docPageMap(source: DocSource, channel?: string, timing?: { model: number }): Promise<PageMap | null> {
  const began = performance.now();
  const model = await docModel({ ...source, raw: true });
  if (timing) timing.model = performance.now() - began;
  return typesetter().docPages(model, channel);
}

export async function buildDocPdf(
  source: DocSource,
  opts: { booklet?: boolean; onProgress?: (message: string) => void; pdf?: PdfOptions; /** A file to carry inside. */ attach?: PdfAttachment } = {},
): Promise<DocPdf> {
  // Tags are for a file that will be read: asked for, and not a booklet's
  // imposed sheets (nor what is only sent to a printer).
  const model = await docModel({ ...source, struct: !!opts.pdf?.tagged && !opts.booklet });
  const { result, failed } = await typesetter().docPdf(model, !!opts.booklet, opts.onProgress, opts.pdf, opts.attach);
  const notes = result.warnings.map((w) => w.message);
  // A picture nobody has described is a blank to someone who cannot see it.
  const undescribed = (model.struct ?? []).filter((node) => node.role === "Figure" && !node.alt).length;
  if (undescribed) {
    notes.push(
      `${undescribed === 1 ? "A picture has" : `${undescribed} pictures have`} no description for someone who cannot see ${undescribed === 1 ? "it" : "them"}. Select a picture and add one under Picture ▸ Description.`,
    );
  }
  if (failed) {
    notes.push(`${failed} picture${failed === 1 ? "" : "s"} couldn’t be loaded and ${failed === 1 ? "was" : "were"} left out.`);
  }
  return { bytes: result.bytes, pages: result.pages, ...(result.sheets ? { sheets: result.sheets } : {}), notes };
}

/** Lay the document out for the preview. Null when a newer layout on the
 *  same channel overtook this one. */
export async function layoutDocPreview(source: DocSource, channel?: string): Promise<DisplayList | null> {
  const dl = await typesetter().docLayout(await docModel(source), channel);
  // The preview draws each run in the face the layout measured: those from
  // the catalog have to be on the page first.
  if (dl) await showFamilies(dl.faces.map((f) => f.family));
  return dl;
}
