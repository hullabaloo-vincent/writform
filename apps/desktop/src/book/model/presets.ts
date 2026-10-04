/**
 * Book design presets: complete starting points. A book's design is a preset
 * plus whatever the writer overrode (stored as individual `design.*` keys),
 * so picking a different preset keeps nothing stale and every option stays
 * adjustable.
 */

import type { NumberStyle } from "./chapters";

export interface BookDesign {
  preset: string;
  /** Font registry ids (fonts/registry.ts). */
  bodyFont: string;
  /** Points. */
  bodySize: number;
  /** Line spacing in points (the baseline grid). */
  leading: number;
  headingFont: string;
  chapterNumber: NumberStyle;
  chapterLabel: string;
  labelCase: "upper" | "title" | "smallcaps";
  chapterTitle: "show" | "hide";
  titleCase: "as-typed" | "upper" | "smallcaps";
  titleItalic: boolean;
  headingAlign: "center" | "left";
  /** Fraction of the text block a chapter opener drops before its heading. */
  sink: number;
  /** Ornament under chapter headings ("" = none). */
  headingOrnament: string;
  /** Drop cap height in lines (0 = none). */
  dropCap: number;
  leadIn: "none" | "first-line" | "first-words";
  /** First-line indent in ems. */
  indent: number;
  sceneBreak: "ornament" | "blank";
  ornament: string;
  blockquote: "indent" | "indent-italic" | "smaller";
  justify: boolean;
  hyphenate: boolean;
  runningHeads: "author-title" | "title-chapter" | "none";
  headStyle: "smallcaps" | "italic";
  folio: "top-outside" | "bottom-center" | "bottom-outside";
  folioOnOpeners: boolean;
  figures: "default" | "oldstyle" | "lining";
  quotes: "auto" | "curly" | "straight";
  restartNumbersInParts: boolean;
}

const BASE: BookDesign = {
  preset: "classic",
  bodyFont: "garamond",
  bodySize: 11,
  leading: 14.5,
  headingFont: "garamond",
  chapterNumber: "word",
  chapterLabel: "Chapter",
  labelCase: "smallcaps",
  chapterTitle: "show",
  titleCase: "as-typed",
  titleItalic: true,
  headingAlign: "center",
  sink: 0.28,
  headingOrnament: "",
  dropCap: 3,
  leadIn: "first-line",
  indent: 1.2,
  sceneBreak: "ornament",
  ornament: "⁂",
  blockquote: "indent",
  justify: true,
  hyphenate: true,
  runningHeads: "author-title",
  headStyle: "smallcaps",
  folio: "top-outside",
  folioOnOpeners: false,
  figures: "default",
  quotes: "auto",
  restartNumbersInParts: false,
};

export interface PresetInfo {
  id: string;
  label: string;
  description: string;
  design: BookDesign;
}

export const PRESETS: PresetInfo[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Garamond, small-caps chapter labels, a drop cap and a small-caps first line.",
    design: BASE,
  },
  {
    id: "literary",
    label: "Literary",
    description: "Libertinus, large chapter numerals, a quiet small-caps lead-in, blank-line scene breaks.",
    design: {
      ...BASE,
      preset: "literary",
      bodyFont: "libertinus",
      headingFont: "libertinus",
      bodySize: 11,
      leading: 14.5,
      chapterNumber: "numeral",
      chapterLabel: "",
      titleCase: "smallcaps",
      titleItalic: false,
      dropCap: 0,
      leadIn: "first-words",
      sceneBreak: "blank",
      runningHeads: "title-chapter",
      headStyle: "italic",
      folio: "bottom-center",
      sink: 0.33,
    },
  },
  {
    id: "fantasy",
    label: "Fantasy",
    description: "Cinzel headings over Garamond text, a fleuron under each chapter title.",
    design: {
      ...BASE,
      preset: "fantasy",
      headingFont: "cinzel",
      chapterNumber: "word",
      labelCase: "upper",
      titleCase: "upper",
      titleItalic: false,
      headingOrnament: "❦",
      ornament: "❦",
      dropCap: 3,
    },
  },
  {
    id: "romance",
    label: "Romance",
    description: "Playfair Display italic titles over Libre Baskerville, an airy page.",
    design: {
      ...BASE,
      preset: "romance",
      bodyFont: "baskerville",
      headingFont: "playfair",
      bodySize: 10.5,
      leading: 15,
      chapterNumber: "numeral",
      chapterLabel: "",
      titleItalic: true,
      dropCap: 0,
      leadIn: "first-words",
      ornament: "* * *",
      folio: "bottom-center",
    },
  },
  {
    id: "modern",
    label: "Modern",
    description: "Literata, flush-left numerals, uppercase titles, no ornaments.",
    design: {
      ...BASE,
      preset: "modern",
      bodyFont: "literata",
      headingFont: "literata",
      bodySize: 10.5,
      leading: 14.5,
      chapterNumber: "numeral",
      chapterLabel: "",
      labelCase: "upper",
      titleCase: "upper",
      titleItalic: false,
      headingAlign: "left",
      dropCap: 0,
      leadIn: "none",
      sceneBreak: "ornament",
      ornament: "* * *",
      headStyle: "smallcaps",
      folio: "bottom-outside",
    },
  },
];

/** The submission manuscript's fixed design (hidden from the picker). */
export const SMF_DESIGN: BookDesign = {
  ...BASE,
  preset: "smf",
  bodyFont: "courier-prime",
  headingFont: "courier-prime",
  bodySize: 12,
  leading: 24,
  chapterNumber: "word",
  chapterLabel: "Chapter",
  labelCase: "title",
  titleCase: "as-typed",
  titleItalic: false,
  sink: 0.33,
  dropCap: 0,
  leadIn: "none",
  indent: 3.6, // 0.5in at 12pt Courier (10 pitch)
  sceneBreak: "ornament",
  ornament: "#",
  justify: false,
  hyphenate: false,
  runningHeads: "none",
};

export function presetDesign(id: string): BookDesign {
  return PRESETS.find((p) => p.id === id)?.design ?? BASE;
}
