/**
 * File import: convert PDF / DOCX / RTF / .pages / TXT / MD into a new
 * document. Conversion is entirely client-side (heavy libraries load
 * lazily); the result seeds the new document's Yjs doc in bounded updates
 * and a named version records the import.
 */

import { generateJSON, type JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYXmlFragment, updateYFragment } from "@tiptap/y-tiptap";
import { Node as PmNode } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import * as Y from "yjs";

import type { Document } from "../../../bindings/proto/Document";
import { documentsApi } from "../api";
import { b64encode } from "../collab";
import { applyDocMaps, docMapsUpdate, type DocMapsSnapshot } from "../docMaps";
import { useLocalDocs } from "../local";
import { regionPaper } from "../newDocument";
import { chooseDialog } from "../../../platform/confirm";
import { toast } from "../../../platform/toast";
import { FORMAT_LABELS } from "../formats/elements";
import { rtfToText } from "./rtf";

import { mapImages, type DocxMedia } from "../../../docx/read";
import { docContentExtensions } from "../../../editor/schema/content";
import { downlevelJson } from "../../../editor/schema/downlevel";
import { levelOfJson } from "../../../editor/schema/levels";
import { attachmentRef, backend, localDocMediaId, localDocMediaUrl, type CmdError } from "../../../lib/backend";
import { SERVER_PICTURE_BYTES, uploadBlob } from "../../../lib/upload";
import { COVER_SLOTS, encodeArt, parseArt } from "../../../book/cover/art";
import { ART_SLOTS } from "../../../book/model/bookMap";
import { fitUnder } from "../../../book/cover/files";
import { featureLevel } from "../sync/caps";

const EXTENSIONS = docContentExtensions();
/** Kinds of file that carry no page of their own. */
const PAPERLESS = new Set(["txt", "md", "markdown", "rtf"]);
const SEED_BATCH_JSON_BYTES = 48 * 1024;
// Leave headroom under the server's 256 KiB decoded-update ceiling.
const MAX_SEED_UPDATE_BYTES = 240 * 1024;

interface ConvertedFile {
  stem: string;
  content: JSONContent;
  suggestedFormat: string;
  /** Per-document maps to seed (page setup, a book manuscript's details). */
  maps: DocMapsSnapshot;
  /** The file's pictures; the content's image nodes point at them by key
   *  until they're stored somewhere. */
  media: DocxMedia[];
  /** What the import did ("Imported as a Manuscript: …"). */
  summary: string | null;
  /** What didn't come across. */
  warnings: string[];
}

/** The toast after an import: what it became, and what was left behind. */
function importNote(file: Pick<ConvertedFile, "summary" | "warnings">): string | null {
  if (!file.warnings.length) return file.summary;
  return `${file.summary ?? "Imported"} (${file.warnings.join(", ")})`;
}

/** What an import ends with when the person thought better of it: nothing
 *  is made, and nothing need be said. */
export const IMPORT_CANCELLED = "import_cancelled";
export const importCancelled = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === IMPORT_CANCELLED;

/**
 * A PDF made here with its document kept inside: ask whether to open that
 * document or read the pages. The document as a converted file, or null to
 * go on and read the pages (it has none inside, the pages were chosen, or
 * what is inside cannot be used, which `warnings` then says).
 */
async function documentInside(data: ArrayBuffer, stem: string, warnings: string[]): Promise<ConvertedFile | null> {
  let found: Awaited<ReturnType<typeof import("./pdfSource").readPdfSource>>;
  try {
    const { readPdfSource } = await import("./pdfSource");
    found = await readPdfSource(data);
    // Its text has to be a document this app can hold, node for node.
    if (found) PmNode.fromJSON(getSchema(EXTENSIONS), found.copy.content).check();
  } catch (e) {
    const newer = (e as { code?: unknown } | null)?.code === "source_newer";
    warnings.push(newer ? "the document kept inside was made by a newer version of subScribe, so the pages were read" : "the document kept inside could not be read, so the pages were");
    return null;
  }
  if (!found) return null;
  const { copy, changed } = found;
  const picked = await chooseDialog(
    `You can open that document and go on writing it with its styles and pictures. Or you can read the pages of the PDF as text.${changed ? " This PDF was changed after it was made. Its pages may differ from the document inside." : ""}`,
    [
      { id: "open", label: "Open the document" },
      { id: "pages", label: "Read the pages" },
    ],
    { title: "This PDF holds the document it was made from" },
  );
  if (picked === null) throw { code: IMPORT_CANCELLED, message: "Nothing was imported." };
  if (picked === "pages") return null;
  const lost = copy.left ? [`${copy.left} picture${copy.left === 1 ? " was" : "s were"} not kept inside`] : [];
  return {
    stem: copy.title.trim() || stem,
    content: copy.content,
    suggestedFormat: copy.format in FORMAT_LABELS ? copy.format : "none",
    maps: copy.maps,
    media: copy.media,
    summary: "Opened the document kept inside the PDF",
    warnings: lost,
  };
}

/** Client-side conversion shared by server import and import-to-device.
 *  (Exported for tests.) */
export async function convertFile(file: File): Promise<ConvertedFile> {
  const name = file.name;
  const stem = name.replace(/\.[^.]+$/, "") || "Imported document";
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  let content: JSONContent;
  let suggestedFormat = "none";
  let fileMeta: { title?: string; author?: string } = {};
  let fileSettings: Record<string, unknown> = {};
  let fileFonts: Record<string, string> = {};
  let fileStyles: Record<string, string> = {};
  let media: DocxMedia[] = [];
  const warnings: string[] = [];
  switch (ext) {
    case "txt":
      content = paragraphsToDoc(splitPlainText(await file.text()));
      break;
    case "md":
    case "markdown": {
      const { marked } = await import("marked");
      content = htmlToDoc(await marked.parse(await file.text()));
      break;
    }
    case "docx": {
      const { docxToContent } = await import("../../../book/convert/docx");
      const imported = await docxToContent(await file.arrayBuffer());
      content = imported.content;
      fileMeta = imported.meta;
      fileSettings = imported.settings;
      fileFonts = imported.fonts;
      fileStyles = imported.styles;
      media = imported.media;
      warnings.push(...imported.warnings);
      break;
    }
    case "rtf":
      content = paragraphsToDoc(splitPlainText(rtfToText(await file.text())));
      break;
    case "pdf": {
      const data = await file.arrayBuffer();
      const inside = await documentInside(data, stem, warnings);
      if (inside) return inside;
      const { readPdfPages } = await import("./pdfPages");
      const imported = await readPdfPages(data, name);
      content = imported.content;
      suggestedFormat = imported.suggestedFormat;
      fileMeta = imported.meta;
      fileSettings = imported.settings;
      fileFonts = imported.fonts;
      media = imported.media;
      warnings.push(...imported.warnings);
      break;
    }
    case "pages": {
      // A .pages bundle is a zip. Pages stores the actual text as compressed
      // protobuf in Index/*.iwa, which there is no practical way to parse
      // here, so import relies on the PDF preview Pages *optionally* embeds.
      // Modern versions only include it when "Include preview in document"
      // was enabled, so the common case is that there is nothing to read and
      // the message has to say what to do instead.
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const preview =
        zip.file("QuickLook/Preview.pdf") ??
        zip.file("preview.pdf") ??
        zip.file(/preview\.pdf$/i)[0];
      if (!preview) {
        const isModern = zip.file(/^Index\/.*\.iwa$/i).length > 0;
        throw {
          code: "pages_no_preview",
          message: isModern
            ? "Pages stores this document in a format subScribe can't read directly, and this file has no embedded PDF preview. In Pages, choose File → Export To → Word (or PDF) and import that instead."
            : "This .pages file has no embedded preview to import. In Pages, choose File → Export To → Word (or PDF) and import that instead.",
        };
      }
      const { readPdfPages } = await import("./pdfPages");
      const imported = await readPdfPages(await preview.async("arraybuffer"), name);
      content = imported.content;
      suggestedFormat = imported.suggestedFormat;
      fileSettings = imported.settings;
      fileFonts = imported.fonts;
      media = imported.media;
      warnings.push(...imported.warnings);
      break;
    }
    default:
      throw {
        code: "unsupported_import",
        message: `Can't import .${ext} files. Supported: PDF, DOCX, RTF, Pages, TXT, MD.`,
      };
  }

  if (!content.content || content.content.length === 0) {
    content = { type: "doc", content: [{ type: "paragraph" }] };
  }
  // Plain words say nothing of a page: they are set on the paper of where
  // the writer is, as a new document is.
  if (PAPERLESS.has(ext)) fileSettings = { ...fileSettings, pageSize: regionPaper() };

  // A file that's clearly a book comes in as a book manuscript; anything
  // else keeps the page setup it was written with.
  let maps: DocMapsSnapshot = {
    ...(Object.keys(fileSettings).length ? { settings: fileSettings } : {}),
    ...(Object.keys(fileFonts).length ? { fonts: fileFonts } : {}),
    ...(Object.keys(fileStyles).length ? { styles: fileStyles } : {}),
  };
  let summary: string | null = null;
  if (suggestedFormat === "none") {
    const { asManuscript } = await import("../../../book/convert/importAsBook");
    const book = asManuscript(content, { title: fileMeta.title ?? stem, author: fileMeta.author });
    if (book) {
      content = book.content;
      suggestedFormat = "manuscript";
      maps = { book: book.bookPatch };
      summary = `Imported as a Manuscript: ${book.summary}`;
    }
  }

  return { stem, content, suggestedFormat, maps, media, summary, warnings };
}

/** Store a file's pictures as attachments and point the content at them.
 *  One that fails to upload is left out and counted. */
async function uploadMedia(file: ConvertedFile): Promise<JSONContent> {
  if (!file.media.length) return file.content;
  const stored = new Map<string, string>();
  let failed = 0;
  for (const item of file.media) {
    try {
      const meta = await uploadBlob(new Blob([item.bytes as BlobPart], { type: item.type }), item.name);
      stored.set(item.key, attachmentRef(meta.id));
    } catch {
      failed += 1;
    }
  }
  if (failed) file.warnings.push(`${failed} picture${failed === 1 ? "" : "s"} couldn't be uploaded`);
  return mapImages(file.content, (src) => stored.get(src) ?? null);
}

export async function importFile(file: File): Promise<Document> {
  const converted = await convertFile(file);
  const content = await uploadMedia(converted);
  const doc = await createServerDocument(
    converted.stem,
    converted.suggestedFormat,
    content,
    converted.maps,
    `Imported from ${file.name}`,
    {
      // A server that hasn't been updated yet takes the words and the
      // formatting it knows; the rest is left out, and said.
      simplify: true,
      onSimplified: () => converted.warnings.push("some formatting left out (this server needs an update to hold it)"),
    },
  );
  const note = importNote(converted);
  if (note) toast(note, "success");
  return doc;
}

/** Import a file as a document on this device — no server involved.
 *  Resolves to the new local document's id. */
export async function importFileToLocal(file: File): Promise<string> {
  const converted = await convertFile(file);
  // The file's pictures are stored beside the new document, on this device.
  const id = crypto.randomUUID();
  const stored = new Map<string, string>();
  let failed = 0;
  for (const item of converted.media) {
    try {
      const mediaId = crypto.randomUUID();
      await backend.localdocMediaWrite(id, mediaId, item.bytes);
      stored.set(item.key, localDocMediaUrl(id, mediaId));
    } catch {
      failed += 1;
    }
  }
  if (failed) converted.warnings.push(`${failed} picture${failed === 1 ? "" : "s"} couldn't be stored`);
  const content = mapImages(converted.content, (src) => stored.get(src) ?? null);
  await createLocalDocument(converted.stem, converted.suggestedFormat, content, converted.maps, id);
  const note = importNote(converted);
  if (note) toast(note, "success");
  return id;
}

/**
 * A new server document holding `content` and its per-document maps, with
 * a named version recording where it came from. Atomic for the user: if
 * seeding fails, the partial document is deleted for good.
 */
export async function createServerDocument(
  title: string,
  format: string,
  content: JSONContent,
  maps: DocMapsSnapshot,
  versionName: string,
  opts: {
    /** When the server can't hold the content's formatting (it hasn't been
     *  updated), store a copy without it instead of refusing. */
    simplify?: boolean;
    onSimplified?: () => void;
  } = {},
): Promise<Document> {
  // The document starts at the level its content needs — which the server
  // has to be able to store.
  const allowed = await featureLevel();
  if (levelOfJson(content) > allowed) {
    if (!opts.simplify) {
      throw {
        code: "server_too_old",
        message: "This server needs an update before it can hold this document's formatting.",
      } satisfies CmdError;
    }
    content = downlevelJson(content, allowed, getSchema(EXTENSIONS));
    opts.onSimplified?.();
  }
  // A document from this device brings its pictures: they become
  // attachments on the server, and the content points at those.
  content = await uploadDevicePictures(content);
  maps = await uploadDeviceCover(maps);
  // Build before creating the server row so an unexpectedly huge individual
  // block cannot leave an empty document behind.
  const updates = buildImportSeedUpdates(content);
  const mapsUpdate = docMapsUpdate(maps);
  if (mapsUpdate) updates.push(mapsUpdate);
  const level = levelOfJson(content);
  const doc = await documentsApi.create(title.trim().slice(0, 200) || "Untitled", format, level);
  try {
    for (const update of updates) {
      await documentsApi.appendUpdate(doc.id, b64encode(update));
    }
    await documentsApi.snapshot(doc.id, JSON.stringify(content), versionName.slice(0, 120));
    return doc;
  } catch (error) {
    await discardServerDocument(doc.id);
    throw error;
  }
}

/**
 * Upload every picture stored on this device that `content` shows, and
 * return the content pointing at the uploads instead. One that can't be
 * read or uploaded is left out rather than left pointing at this device
 * (where nobody else could see it).
 */
export async function uploadDevicePictures(content: JSONContent): Promise<JSONContent> {
  const sources = new Set<string>();
  const find = (node: JSONContent) => {
    const src = node.type === "image" ? node.attrs?.src : null;
    if (typeof src === "string" && localDocMediaId(src)) sources.add(src);
    node.content?.forEach(find);
  };
  find(content);
  if (sources.size === 0) return content;
  const uploaded = new Map<string, string | null>();
  for (const src of sources) {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
      uploaded.set(src, attachmentRef((await uploadBlob(blob, `picture.${ext}`)).id));
    } catch {
      uploaded.set(src, null);
    }
  }
  const walk = (node: JSONContent): JSONContent | null => {
    if (node.type === "image" && typeof node.attrs?.src === "string" && uploaded.has(node.attrs.src)) {
      const next = uploaded.get(node.attrs.src);
      return next ? { ...node, attrs: { ...node.attrs, src: next } } : null;
    }
    if (!node.content) return node;
    const kids = node.content.map(walk).filter((n): n is JSONContent => n !== null);
    return { ...node, content: kids.length || node.type !== "doc" ? kids : [{ type: "paragraph" }] };
  };
  return walk(content) ?? content;
}

/**
 * The same for a book's own pictures, which its settings name (not its
 * text): the cover's artwork and the pictures of its pages. Artwork
 * heavier than a server keeps is saved again as a JPEG.
 */
export async function uploadDeviceCover(maps: DocMapsSnapshot): Promise<DocMapsSnapshot> {
  const book = maps.book;
  if (!book) return maps;
  let next: Record<string, unknown> | null = null;
  for (const key of [...COVER_SLOTS.map((slot) => `cover.${slot}`), ...ART_SLOTS.map((slot) => `art.${slot}`)]) {
    const art = parseArt(book[key]);
    if (!art || !localDocMediaId(art.src)) continue;
    next ??= { ...book };
    try {
      const res = await fetch(art.src);
      if (!res.ok) throw new Error(String(res.status));
      const { blob } = await fitUnder(await res.blob(), SERVER_PICTURE_BYTES);
      const ext = blob.type === "image/png" ? "png" : "jpg";
      next[key] = encodeArt({ ...art, src: attachmentRef((await uploadBlob(blob, `cover.${ext}`)).id) });
    } catch {
      delete next[key];
    }
  }
  return next ? { ...maps, book: next } : maps;
}

/** Remove a document that never really existed (a failed import or copy):
 *  out of the list and out of Recently Deleted. */
export async function discardServerDocument(id: number): Promise<void> {
  await documentsApi.remove(id).catch(() => {});
  await documentsApi.purge(id).catch(() => {});
}

/** A new on-device document holding `content` and its maps. */
export async function createLocalDocument(
  title: string,
  format: string,
  content: JSONContent,
  maps: DocMapsSnapshot,
  /** An id chosen beforehand (its pictures are already stored under it). */
  withId?: string,
): Promise<string> {
  // One-shot conversion: local docs have no per-update size ceiling.
  const ydoc = new Y.Doc();
  try {
    const schema = getSchema(EXTENSIONS);
    ydoc.transact(() => {
      prosemirrorJSONToYXmlFragment(schema, content, ydoc.get("default", Y.XmlFragment));
    });
    applyDocMaps(ydoc, maps);
    const state_b64 = b64encode(Y.encodeStateAsUpdate(ydoc));
    return await useLocalDocs
      .getState()
      .create(title.trim().slice(0, 200) || "Untitled", format, state_b64, levelOfJson(content), withId);
  } finally {
    ydoc.destroy();
  }
}

/**
 * Convert progressively larger ProseMirror documents into independent Yjs
 * v1 updates. Batching by source JSON size keeps each decoded update safely
 * below the collaboration endpoint's 256 KiB limit (older servers).
 *
 * Linear, not quadratic: the document is parsed ONCE, every batch reuses the
 * same child node objects, and one shared mapping lets y-tiptap's diff
 * recognize already-synced blocks by identity instead of re-comparing them.
 */
export function buildImportSeedUpdates(content: JSONContent): Uint8Array[] {
  const schema = getSchema(EXTENSIONS);
  const full = PmNode.fromJSON(schema, content);
  const children: PmNode[] = [];
  full.forEach((child) => children.push(child));
  const ydoc = new Y.Doc();
  const fragment = ydoc.get("default", Y.XmlFragment);
  const meta = { mapping: new Map(), isOMark: new Map() };
  const encoder = new TextEncoder();
  const updates: Uint8Array[] = [];
  let end = 0;

  while (end < children.length) {
    let nextEnd = end;
    let batchBytes = 0;
    while (nextEnd < children.length) {
      const blockBytes = encoder.encode(JSON.stringify(children[nextEnd].toJSON())).byteLength;
      if (nextEnd > end && batchBytes + blockBytes > SEED_BATCH_JSON_BYTES) break;
      batchBytes += blockBytes;
      nextEnd += 1;
    }

    const partial = full.type.create(full.attrs, children.slice(0, nextEnd));
    const before = Y.encodeStateVector(ydoc);
    ydoc.transact(() => {
      updateYFragment(ydoc, fragment, partial, meta);
    });
    const update = Y.encodeStateAsUpdate(ydoc, before);
    if (update.byteLength > MAX_SEED_UPDATE_BYTES) {
      throw {
        code: "import_element_too_large",
        message:
          "One imported section is too large to synchronize. Split that section in the source file and try again.",
      };
    }
    if (update.byteLength > 0) updates.push(update);
    end = nextEnd;
  }

  ydoc.destroy();
  return updates;
}

function htmlToDoc(html: string): JSONContent {
  return generateJSON(html, EXTENSIONS) as JSONContent;
}

/**
 * Plain text → paragraphs. Text that separates paragraphs with blank lines
 * (and wraps lines inside them) splits on the blank lines; text with one
 * paragraph per line — most manuscripts saved as .txt — splits per line.
 * Blank lines in the second kind are kept as empty paragraphs, so a
 * manuscript's scene-break gaps survive for chapter detection.
 */
function splitPlainText(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  const breaks = (normalized.match(/\n/g) ?? []).length;
  const doubles = (normalized.match(/\n[ \t]*\n/g) ?? []).length;
  if (breaks > 0 && doubles / breaks >= 0.3) {
    return normalized
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\n/g, " ").trim())
      .filter((p) => p.length > 0);
  }
  return normalized.split("\n").map((line) => line.trim());
}

function paragraphsToDoc(paragraphs: string[]): JSONContent {
  return {
    type: "doc",
    content: paragraphs.map((text) =>
      text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" },
    ),
  };
}
