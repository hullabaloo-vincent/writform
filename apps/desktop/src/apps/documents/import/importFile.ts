/**
 * File import: convert PDF / DOCX / RTF / .pages / TXT / MD into a new
 * document. Conversion is entirely client-side (heavy libraries load
 * lazily); the result seeds the new document's Yjs doc in bounded updates
 * and a named version records the import.
 */

import { generateJSON, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { getSchema } from "@tiptap/core";
import * as Y from "yjs";

import type { Document } from "../../../bindings/proto/Document";
import { documentsApi } from "../api";
import { b64encode } from "../collab";
import { DocElement } from "../formats/DocElement";
import { useLocalDocs } from "../local";
import { pdfToDocument, type ImportedPdfParagraph } from "./pdf";
import { rtfToText } from "./rtf";

const EXTENSIONS = [StarterKit, Image.configure({ allowBase64: false }), DocElement];
const SEED_BATCH_JSON_BYTES = 48 * 1024;
// Leave headroom under the server's 256 KiB decoded-update ceiling.
const MAX_SEED_UPDATE_BYTES = 240 * 1024;

interface ConvertedFile {
  stem: string;
  content: JSONContent;
  suggestedFormat: string;
}

/** Client-side conversion shared by server import and import-to-device. */
async function convertFile(file: File): Promise<ConvertedFile> {
  const name = file.name;
  const stem = name.replace(/\.[^.]+$/, "") || "Imported document";
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  let content: JSONContent;
  let suggestedFormat = "none";
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
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
      content = htmlToDoc(result.value);
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
            ? "Pages stores this document in a format WritForm can't read directly, and this file has no embedded PDF preview. In Pages, choose File → Export To → Word (or PDF) and import that instead."
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

  return { stem, content, suggestedFormat };
}

export async function importFile(file: File): Promise<Document> {
  const { stem, content, suggestedFormat } = await convertFile(file);

  // Build before creating the server row so an unexpectedly huge individual
  // block cannot leave an empty document behind.
  const updates = buildImportSeedUpdates(content);
  const doc = await documentsApi.create(stem.slice(0, 200), suggestedFormat);
  try {
    for (const update of updates) {
      await documentsApi.appendUpdate(doc.id, b64encode(update));
    }
    await documentsApi.snapshot(
      doc.id,
      JSON.stringify(content),
      `Imported from ${file.name}`.slice(0, 120),
    );
    return doc;
  } catch (error) {
    // Import is atomic from the user's perspective. A partially seeded
    // document is not useful and would otherwise clutter the list.
    await documentsApi.remove(doc.id).catch(() => {});
    throw error;
  }
}

/** Import a file as a document on this device — no server involved.
 *  Resolves to the new local document's id. */
export async function importFileToLocal(file: File): Promise<string> {
  const { stem, content, suggestedFormat } = await convertFile(file);
  // One-shot conversion: local docs have no per-update size ceiling.
  const ydoc = new Y.Doc();
  const schema = getSchema(EXTENSIONS);
  ydoc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema, content, ydoc.get("default", Y.XmlFragment));
  });
  const state_b64 = b64encode(Y.encodeStateAsUpdate(ydoc));
  return useLocalDocs.getState().create(stem.slice(0, 200), suggestedFormat, state_b64);
}

/**
 * Convert progressively larger ProseMirror documents into independent Yjs
 * v1 updates. Batching by source JSON size keeps each decoded update safely
 * below the collaboration endpoint's 256 KiB limit.
 */
export function buildImportSeedUpdates(content: JSONContent): Uint8Array[] {
  const blocks = content.content ?? [];
  const ydoc = new Y.Doc();
  const fragment = ydoc.get("default", Y.XmlFragment);
  const schema = getSchema(EXTENSIONS);
  const updates: Uint8Array[] = [];
  let end = 0;

  while (end < blocks.length) {
    let nextEnd = end;
    let batchBytes = 0;
    while (nextEnd < blocks.length) {
      const blockBytes = new TextEncoder().encode(JSON.stringify(blocks[nextEnd])).byteLength;
      if (nextEnd > end && batchBytes + blockBytes > SEED_BATCH_JSON_BYTES) break;
      batchBytes += blockBytes;
      nextEnd += 1;
    }

    const before = Y.encodeStateVector(ydoc);
    ydoc.transact(() => {
      prosemirrorJSONToYXmlFragment(
        schema,
        { ...content, content: blocks.slice(0, nextEnd) },
        fragment,
      );
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

  return updates;
}

function htmlToDoc(html: string): JSONContent {
  return generateJSON(html, EXTENSIONS) as JSONContent;
}

/** Blank-line-separated plain text → paragraphs. */
function splitPlainText(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 0);
}

function paragraphsToDoc(paragraphs: string[]): JSONContent {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

function importedParagraphsToDoc(paragraphs: ImportedPdfParagraph[]): JSONContent {
  return {
    type: "doc",
    content: paragraphs.map(({ text, element }) => ({
      type: "paragraph",
      attrs: element ? { element } : undefined,
      content: text ? [{ type: "text", text }] : undefined,
    })),
  };
}
