/**
 * Word (.docx) import: the app's own reader (src/docx/read), which keeps
 * headings, nested lists, tables, notes, pictures, page setup, tracked
 * changes and what a manuscript's chapter detection keys on — alignment,
 * page breaks and blank lines.
 */

import type { JSONContent } from "@tiptap/core";

import type { DocxMedia } from "../../docx/read";

export interface DocxImport {
  content: JSONContent;
  meta: { title?: string; author?: string };
  /** A patch for the document's settings map (page setup, body text). */
  settings: Record<string, unknown>;
  /** Entries for the document's font table. */
  fonts: Record<string, string>;
  /** Entries for the document's style table. */
  styles: Record<string, string>;
  /** Pictures the content's image nodes point at (`docx-media:N`). */
  media: DocxMedia[];
  /** What didn't come across, for the import toast. */
  warnings: string[];
}

export async function docxToContent(buffer: ArrayBuffer): Promise<DocxImport> {
  try {
    const { readDocx } = await import("../../docx/read");
    return await readDocx(buffer);
  } catch (error) {
    // Not a Word file at all says so itself; anything else is a file this
    // reader couldn't make sense of — said plainly rather than as a stack.
    if ((error as { code?: string } | null)?.code === "docx_unreadable") {
      throw { code: "docx_unreadable", message: (error as Error).message };
    }
    console.warn("docx: couldn't read the file", error);
    throw { code: "docx_unreadable", message: "This Word document couldn’t be read. Opening it in Word and saving it again as .docx often helps." };
  }
}
