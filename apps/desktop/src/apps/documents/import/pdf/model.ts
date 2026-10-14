/**
 * What a PDF is read into on its way to being a document: one model, which
 * each part of the importer reads from or adds to.
 *
 * A PDF is pages of placed strings, lines and pictures. Reading one goes:
 * the page as it was drawn (`PageData`, read.ts), its strings as lines of
 * text (`Line`, lines.ts), the lines in the order they are read (order.ts)
 * without what is repeated on every page (furniture.ts), then what the
 * lines are (`Block`: paragraphs, headings, lists, tables, pictures), and
 * last the document (assemble.ts).
 *
 * Every measure is in points, x to the right and y DOWN from the top left
 * of the page as it is shown.
 */

import type { Box } from "../../../../lib/pdfOps";

export type { Box };

/** A piece of text in one style, on one baseline. */
export interface Run {
  text: string;
  /** Its left end, on its baseline. */
  x: number;
  y: number;
  w: number;
  /** The height of its type. */
  size: number;
  /** Its font's own name (no subset tag), "" when that isn't known. */
  font: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  /** "#rrggbb", null when it isn't a plain colour (or isn't known). */
  color: string | null;
  /** Text nobody sees: the words a scan was recognised as. */
  hidden: boolean;
  /** Where it leads. */
  link?: string;
  /** The marked stretch of the page it was drawn in (`PageData.marks`), -1
   *  for none. */
  mark: number;
  /** Marked as decoration (a running head, a page number). */
  artifact: boolean;
  /** Set above the line it is on (a note's number), or below it. */
  shift?: "up" | "down";
  /** A note's number in the text: the lines of the note it cites. */
  note?: Line[];
}

/** A stretch of a page its writer marked: what it is, and the name the
 *  page's structure knows it by. */
export interface Mark {
  tag: string;
  id: string | null;
}

/** A ruled line, across or down. */
export interface Rule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PagePicture {
  /** The object pdf.js keeps it as (the same picture drawn twice has one). */
  id: string;
  box: Box;
  /** The marked stretch of the page it was drawn in (its number), if any. */
  mc: number | null;
  /** Where it comes in the page's drawing. */
  order: number;
}

export interface PageLink {
  box: Box;
  url: string;
}

/** A page's structure as its writer tagged it (pdf.js's `getStructTree`). */
export interface TreeNode {
  role?: string;
  type?: string;
  id?: string;
  alt?: string;
  lang?: string;
  children?: TreeNode[];
}

export interface PageData {
  /** From 1. */
  n: number;
  w: number;
  h: number;
  runs: Run[];
  marks: Mark[];
  pictures: PagePicture[];
  rules: Rule[];
  /** Filled boxes (a shaded cell, a highlighted line). */
  fills: { box: Box; color: string }[];
  links: PageLink[];
  tree: TreeNode | null;
  /** A page of text, a picture of a page, or nothing. */
  kind: "text" | "scan" | "empty";
  /** Pieces of text set at an angle, which are left out. */
  turned: number;
  /** Drawn shapes that are neither rules nor boxes. */
  drawings: number;
}

/** A line of text: the runs on one baseline that read on from each other. */
export interface Line {
  page: number;
  x0: number;
  x1: number;
  /** Its baseline, and the top and foot of its type. */
  y: number;
  top: number;
  bottom: number;
  /** The size most of it is set in. */
  size: number;
  runs: Run[];
  text: string;
  /** The column it was read in: its edges. */
  left?: number;
  right?: number;
  /** A column or a page begins with it. */
  starts?: boolean;
}

/** Text in one style, as a document holds it. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  color?: string;
  font?: string;
  size?: number;
  link?: string;
  shift?: "up" | "down";
  /** A note cited here: what it says. */
  note?: Span[];
}

export interface ParaBlock {
  kind: "para";
  spans: Span[];
  page: number;
  /** The size most of it is set in, and whether all of it is bold. */
  size: number;
  bold: boolean;
  lines: number;
  align?: "center" | "right";
  /** Its first line starts in from the others. */
  indent?: boolean;
  /** 1 to 6. */
  heading?: number;
  /** A format's element (a screenplay's "character"). */
  element?: string;
  /** In from the column's edge, points. */
  inset?: number;
  /** Where its first line starts from the column's edge, and where the
   *  lines after it do (when it has any). */
  x: number;
  hang?: number;
  quote?: boolean;
}

export interface ListItem {
  blocks: Block[];
}

export interface ListBlock {
  kind: "list";
  page: number;
  ordered: boolean;
  /** What an ordered list counts from, and in: "1" "a" "A" "i" "I". */
  start?: number;
  numbering?: string;
  items: ListItem[];
}

export interface TableCell {
  blocks: Block[];
  colspan: number;
  rowspan: number;
  bg?: string;
}

export interface TableBlock {
  kind: "table";
  page: number;
  /** Column widths, points. */
  cols: number[];
  rows: TableCell[][];
  /** Its first row heads its columns. */
  head: boolean;
  /** Drawn with lines (false: set in space alone). */
  ruled: boolean;
}

export interface ImageBlock {
  kind: "image";
  page: number;
  /** The picture, by the key its bytes are kept under. */
  key: string;
  w: number;
  h: number;
  alt?: string;
  caption?: string;
  align?: "center" | "right";
}

export interface RuleBlock {
  kind: "rule";
  page: number;
}

export interface TocBlock {
  kind: "toc";
  page: number;
}

export type Block = ParaBlock | ListBlock | TableBlock | ImageBlock | RuleBlock | TocBlock;

/** A picture as pdf.js hands one over: drawn already, or as pixels. */
export interface PdfImageObject {
  bitmap?: unknown;
  data?: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** 1: one bit a pixel. 2: red, green, blue. 3: and how solid. */
  kind?: number;
}

export interface EncodedPicture {
  bytes: Uint8Array;
  type: "image/png" | "image/jpeg";
  w: number;
  h: number;
}

/** Make a file of a picture, no larger than `maxPixels` (null: it can't be). */
export type EncodeImage = (image: PdfImageObject, maxPixels: number) => Promise<EncodedPicture | null>;

/** A line of text found in a picture of a page: its place as parts of the
 *  picture, from its top left. */
export interface SeenLine {
  text: string;
  box: Box;
  confidence: number;
}

/** Read the text in a picture of a page (null: it can't be done here). */
export type Recognise = (picture: EncodedPicture, lang: string) => Promise<SeenLine[] | null>;

/** A page as a picture, for reading or for keeping. */
export type RenderPage = (page: unknown, dpi: number) => Promise<EncodedPicture | null>;

/** What only the person importing can say. */
export interface Ask {
  /** The file's password (`again`: the last one was wrong). Null calls the
   *  import off. */
  password?: (again: boolean) => Promise<string | null>;
  /** Pages that are pictures of text: read them, or keep them as pictures.
   *  Null calls the import off. */
  scan?: (pages: number, canRead: boolean) => Promise<"read" | "pictures" | null>;
}

export interface Limits {
  /** The largest file read, bytes. */
  bytes: number;
  pages: number;
  /** Pages whose text is recognised. */
  ocrPages: number;
  /** The most pixels one picture is kept at. */
  picturePixels: number;
  /** The most pictures kept, and the most they may weigh together. */
  pictures: number;
  pictureBytes: number;
}

export const DESKTOP_LIMITS: Limits = { bytes: 64_000_000, pages: 2000, ocrPages: 300, picturePixels: 16_000_000, pictures: 400, pictureBytes: 96_000_000 };
export const PHONE_LIMITS: Limits = { bytes: 32_000_000, pages: 2000, ocrPages: 50, picturePixels: 4_000_000, pictures: 150, pictureBytes: 32_000_000 };

export interface PdfError {
  code: "pdf_invalid" | "pdf_empty" | "pdf_too_large" | "pdf_password" | "import_cancelled";
  message: string;
}

export const cancelled = (): PdfError => ({ code: "import_cancelled", message: "Nothing was imported." });

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}
