/**
 * The engine's output: a display list — every page as positioned text runs,
 * rules and images, in points from the page's top-left corner. The PDF
 * writer and the on-screen preview both draw exactly this, so what you see
 * is what prints. Serializable (crosses the worker boundary).
 */

import type { Warning } from "../model/types";

export type StyleKey = "regular" | "italic" | "bold" | "boldItalic";

export interface FaceRef {
  /** Font registry id ("garamond"). */
  family: string;
  style: StyleKey;
  /** Drawn bold by stroking (the family has no bold face). */
  fakeBold: boolean;
  /** The CSS font-family / style the preview uses for this face. */
  cssFamily: string;
  cssStyle: "normal" | "italic";
  cssWeight: 400 | 700;
}

export interface DLText {
  t: "text";
  x: number;
  /** Baseline, from the top of the page. */
  y: number;
  /** Index into DisplayList.faces. */
  face: number;
  size: number;
  /** Words separated by single spaces. */
  text: string;
  /** Extra space added to every space (justification), pt. */
  ws?: number;
  /** Start x of each word (for the preview). */
  xs?: number[];
  /** OpenType features (small caps, old-style figures). */
  feat?: string[];
  /** Letter spacing, pt. */
  cs?: number;
  /** Manuscript block this line came from (click-to-source). */
  src?: number;
}

export interface DLRule {
  t: "rule";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
}

export interface DLImage {
  t: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  ref: string;
}

export type DLItem = DLText | DLRule | DLImage;

export type PageRole =
  | "half-title"
  | "also-by"
  | "title"
  | "copyright"
  | "dedication"
  | "epigraph"
  | "toc"
  | "opener"
  | "part"
  | "body"
  | "blank"
  | "back";

export interface DLPage {
  /** Physical page number (1-based). */
  n: number;
  /** The printed page number ("iv", "12"), or null when none is shown. */
  folio: string | null;
  side: "recto" | "verso";
  role: PageRole;
  /** Index into DisplayList.sections, or -1 for generated pages. */
  section: number;
  items: DLItem[];
}

export interface DLSection {
  id: string;
  title: string;
  /** Index of its first page. */
  firstPage: number;
  folio: string;
  level: number;
}

export interface DisplayList {
  trim: { w: number; h: number };
  faces: FaceRef[];
  pages: DLPage[];
  sections: DLSection[];
  meta: { title: string; author: string; subject: string; lang: string };
  warnings: Warning[];
  /** Inside margin used (inches), for the inspector. */
  insideMargin: number;
}
