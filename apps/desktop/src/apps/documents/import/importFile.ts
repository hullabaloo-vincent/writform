/**
 * File import: convert PDF / DOCX / RTF / .pages / TXT / MD into a new
 * document. Conversion is entirely client-side (heavy libraries load
 * lazily); the result seeds the new document's Yjs doc in bounded updates
 * and a named version records the import.
 */

import { generateJSON, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYXmlFragment, updateYFragment } from "@tiptap/y-tiptap";
import { Node as PmNode } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import * as Y from "yjs";

import type { Document } from "../../../bindings/proto/Document";
import { documentsApi } from "../api";
import { b64encode } from "../collab";
import { DocElement } from "../formats/DocElement";
import { applyDocMaps, docMapsUpdate, type DocMapsSnapshot } from "../docMaps";
import { useLocalDocs } from "../local";
import { toast } from "../../../platform/toast";
import { pdfToDocument, type ImportedPdfParagraph } from "./pdf";
import { rtfToText } from "./rtf";

import { WfImage } from "../../../editor/RichEditor";
import { TextFormat } from "../../../editor/TextFormat";

const EXTENSIONS = [StarterKit, WfImage, DocElement, TextFormat];
const SEED_BATCH_JSON_BYTES = 48 * 1024;
// Leave headroom under the server's 256 KiB decoded-update ceiling.
const MAX_SEED_UPDATE_BYTES = 240 * 1024;

interface ConvertedFile {
  stem: string;
  content: JSONContent;
  suggestedFormat: string;
  /** Per-document maps to seed (a book manuscript's details). */
  maps: DocMapsSnapshot;
  /** What the import did, for the toast ("Imported as a Manuscript: …"). */
  note: string | null;
}

/** Client-side conversion shared by server import and import-to-device. */
async function convertFile(file: File): Promise<ConvertedFile> {
  const name = file.name;
  const stem = name.replace(/\.[^.]+$/, "") || "Imported document";
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  let content: JSONContent;
  let suggestedFormat = "none";
  let fileMeta: { title?: string; author?: string } = {};
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
      // Mammoth's document model, not its HTML: keeps alignment, page
      // breaks and blank lines (what chapter detection keys on).
      const { docxToContent } = await import("../../../book/convert/docx");
      const imported = await docxToContent(await file.arrayBuffer());
      content = imported.content;
      fileMeta = imported.meta;
      warnings.push(...imported.warnings);
      break;
    }
    case "rtf":
      content = paragraphsToDoc(splitPlainText(rtfToText(await file.text())));
      break;
    case "pdf": {
      const imported = await pdfToDocument(await file.arrayBuffer());
      content = importedParagraphsToDoc(imported.paragraphs);
      suggestedFormat = imported.suggestedFormat;
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
      const imported = await pdfToDocument(await preview.async("arraybuffer"));
      content = importedParagraphsToDoc(imported.paragraphs);
      suggestedFormat = imported.suggestedFormat;
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

  // A file that's clearly a book comes in as a book manuscript.
  let maps: DocMapsSnapshot = {};
  let note: string | null = null;
  if (suggestedFormat === "none") {
    const { asManuscript } = await import("../../../book/convert/importAsBook");
    const book = asManuscript(content, { title: fileMeta.title ?? stem, author: fileMeta.author });
    if (book) {
      content = book.content;
      suggestedFormat = "manuscript";
      maps = { book: book.bookPatch };
      note = `Imported as a Manuscript: ${book.summary}`;
    }
  }
  if (warnings.length) note = `${note ?? "Imported"} (${warnings.join(", ")})`;

  return { stem, content, suggestedFormat, maps, note };
}

export async function importFile(file: File): Promise<Document> {
  const { stem, content, suggestedFormat, maps, note } = await convertFile(file);
  const doc = await createServerDocument(stem, suggestedFormat, content, maps, `Imported from ${file.name}`);
  if (note) toast(note, "success");
  return doc;
}

/** Import a file as a document on this device — no server involved.
 *  Resolves to the new local document's id. */
export async function importFileToLocal(file: File): Promise<string> {
  const { stem, content, suggestedFormat, maps, note } = await convertFile(file);
  const id = await createLocalDocument(stem, suggestedFormat, content, maps);
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
): Promise<Document> {
  // Build before creating the server row so an unexpectedly huge individual
  // block cannot leave an empty document behind.
  const updates = buildImportSeedUpdates(content);
  const mapsUpdate = docMapsUpdate(maps);
  if (mapsUpdate) updates.push(mapsUpdate);
  const doc = await documentsApi.create(title.trim().slice(0, 200) || "Untitled", format);
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
    return await useLocalDocs.getState().create(title.trim().slice(0, 200) || "Untitled", format, state_b64);
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

function importedParagraphsToDoc(paragraphs: ImportedPdfParagraph[]): JSONContent {
  return {
    type: "doc",
    content: paragraphs.map((p) => {
      // Styled runs (bold/italic are StarterKit marks; alignment is a
      // TextFormat attribute) when the importer recovered them; the plain
      // text path still serves the screenplay importer.
      const inline: JSONContent[] = (
        p.runs?.length
          ? p.runs.map((r) => {
              const marks = [
                ...(r.bold ? [{ type: "bold" }] : []),
                ...(r.italic ? [{ type: "italic" }] : []),
              ];
              return {
                type: "text",
                text: r.text,
                ...(marks.length ? { marks } : {}),
              } satisfies JSONContent;
            })
          : p.text
            ? [{ type: "text", text: p.text }]
            : []
      ).filter((n) => (n.text ?? "").length > 0);

      if (p.kind === "heading") {
        return {
          type: "heading",
          attrs: { level: p.level ?? 1, ...(p.align ? { align: p.align } : {}) },
          content: inline.length ? inline : undefined,
        } satisfies JSONContent;
      }
      const attrs: Record<string, unknown> = {};
      if (p.element) attrs.element = p.element;
      if (p.align) attrs.align = p.align;
      return {
        type: "paragraph",
        attrs: Object.keys(attrs).length ? attrs : undefined,
        content: inline.length ? inline : undefined,
      } satisfies JSONContent;
    }),
  };
}
