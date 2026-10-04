/**
 * The book model: a manuscript read as a BOOK — sections (front matter,
 * parts, chapters, back matter) of semantic blocks — independent of any
 * output. The print engine, the EPUB writer and the submission manuscript
 * all render from this one model. Pure data: serializable, worker-safe.
 */

import type { Book } from "./bookMap";

export interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
  /** Links survive for the ebook only. */
  href?: string;
}

export type Align = "left" | "center" | "right" | "justify";

/** `src` = the top-level block index in the manuscript (click-to-source,
 *  preflight "show me"). */
export interface ParaBlock {
  kind: "para";
  runs: Run[];
  align: Align;
  /** First-line indent (false for a chapter's first paragraph, after a
   *  scene break, for "Body — No Indent", centered lines…). */
  indent: boolean;
  /** The first paragraph of the section's text (drop cap / lead-in). */
  opener: boolean;
  src: number;
}

export interface SceneBlock {
  kind: "scene";
  src: number;
}

export interface SubheadingBlock {
  kind: "subheading";
  runs: Run[];
  src: number;
}

export interface QuoteBlock {
  kind: "blockquote";
  paras: { runs: Run[]; align: Align }[];
  src: number;
}

export interface VerseBlock {
  kind: "verse";
  /** One stanza: its lines. */
  lines: Run[][];
  src: number;
}

export interface EpigraphBlock {
  kind: "epigraph";
  paras: Run[][];
  attribution: Run[] | null;
  src: number;
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: Run[][];
  src: number;
}

export interface ImageBlock {
  kind: "image";
  url: string;
  alt: string;
  src: number;
}

export interface PageBreakBlock {
  kind: "pageBreak";
  src: number;
}

export type Block =
  | ParaBlock
  | SceneBlock
  | SubheadingBlock
  | QuoteBlock
  | VerseBlock
  | EpigraphBlock
  | ListBlock
  | ImageBlock
  | PageBreakBlock;

export type SectionKind = "chapter" | "part" | "section" | "untitled";

export interface Section {
  id: string;
  kind: SectionKind;
  matter: "front" | "body" | "back";
  /** Chapter or part number (null for unnumbered sections). */
  number: number | null;
  /** The printed label, e.g. "Chapter Three" ("" when the design has none). */
  label: string;
  /** The chapter's title (typed number peeled off; subtitle promoted). */
  title: string;
  subtitle: string;
  /** An epigraph right under the heading belongs to the opener. */
  epigraph: EpigraphBlock | null;
  blocks: Block[];
  /** The heading's block index (-1 for untitled opening text). */
  src: number;
  words: number;
}

export interface Warning {
  kind:
    | "number-mismatch"
    | "empty-section"
    | "blank-lines"
    | "isbn"
    | "missing-glyphs"
    | "overfull"
    | "image"
    | "page-count"
    | "contact";
  message: string;
  /** The manuscript block to show, when there is one. */
  src?: number;
}

export interface BookModel {
  book: Book;
  sections: Section[];
  warnings: Warning[];
  words: number;
}
