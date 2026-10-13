import type { Scan } from "../types";

/** A stretch of the document under one heading. */
export interface Chapter {
  name: string;
  /** The block that is its heading, or -1 (the text before the first one). */
  heading: number;
  /** Its blocks: [first, end). */
  first: number;
  end: number;
}

/**
 * The chapters of a document. A manuscript's are its chapter headings (and
 * the unnumbered ones: a prologue). A Document's are the highest level of
 * heading it uses more than once. Text before the first is a chapter of
 * its own. A document with no such headings is one chapter.
 */
export function chaptersOf(scan: Scan, format: string): Chapter[] {
  const { blocks } = scan;
  let starts: (heading: string | null) => boolean;
  if (format === "manuscript") starts = (h) => h === "chapter" || h === "section" || h === "part";
  else {
    let level = "";
    for (const candidate of ["h1", "h2", "h3"]) {
      if (blocks.filter((b) => b.heading === candidate).length >= 2) {
        level = candidate;
        break;
      }
    }
    starts = (h) => level !== "" && h === level;
  }
  const out: Chapter[] = [];
  let numbered = 0;
  let open: Chapter = { name: "Before the first chapter", heading: -1, first: 0, end: 0 };
  blocks.forEach((b, i) => {
    if (!starts(b.heading)) return;
    open.end = i;
    out.push(open);
    if (b.heading === "chapter") numbered += 1;
    const said = b.text.replace(/\s+/g, " ").trim();
    open = { name: said || (b.heading === "chapter" ? `Chapter ${numbered}` : "Untitled"), heading: i, first: i, end: i };
  });
  open.end = blocks.length;
  out.push(open);
  return out;
}
