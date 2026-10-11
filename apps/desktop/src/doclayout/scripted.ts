/**
 * The scripted formats — screenplay, stage play, poetry — as documents the
 * page layout can set. A script's paragraphs say what they ARE (a scene
 * heading, a character's name, a line of verse); this turns each into the
 * indents, capitals and spacing its format gives it, on that format's
 * sheet, so their pages come from the same engine as a Document's: real
 * type, any alphabet, the same preview, print and PDF.
 *
 * Nothing is stored: the result is made for the layout and thrown away.
 * The measurements are the screen's (styles.css, "format styling"), which
 * are the industry's: twelve-point Courier, six lines to the inch, a
 * page a minute.
 */

import type { JSONContent } from "@tiptap/core";

import { DEFAULT_SETTINGS, type DocSettings } from "../apps/documents/docSettings";
import { SINGLE } from "../editor/styles/sheet";

export const isScripted = (format: string): boolean => format === "screenplay" || format === "stageplay" || format === "poetry";

const IN = 72;
/** Courier at twelve points: its line is twelve points, its page 6 in wide. */
const LINE = 12;
const TEXT_W = 6 * IN;

interface Shape {
  /** From the text's left edge, and how wide (absent: to the right edge). */
  left?: number;
  width?: number;
  align?: "center" | "right";
  /** Blank space above and below, points. */
  above?: number;
  below?: number;
  upper?: boolean;
  italic?: boolean;
  bold?: boolean;
  /** Not left at the foot of a page without what follows. */
  keep?: boolean;
}

const SCREENPLAY: Record<string, Shape> = {
  scene_heading: { above: 2 * LINE, below: LINE, upper: true, keep: true },
  action: { below: LINE },
  character: { left: 2.2 * IN, upper: true, keep: true },
  parenthetical: { left: 1.6 * IN, width: 2 * IN, keep: true },
  dialogue: { left: 1 * IN, width: 3.5 * IN, below: LINE },
  transition: { align: "right", above: LINE, below: LINE, upper: true },
};

const STAGEPLAY: Record<string, Shape> = {
  act_heading: { align: "center", above: 2 * LINE, below: LINE, upper: true, keep: true },
  scene_heading: { above: LINE, below: LINE, upper: true, keep: true },
  stage_direction: { italic: true },
  character: { left: 2.2 * IN, above: LINE, upper: true, keep: true },
  dialogue: { left: 1 * IN, width: 3.5 * IN, below: LINE },
};

const DEFAULT_ELEMENT: Record<string, string> = { screenplay: "action", stageplay: "stage_direction", poetry: "line" };

/** Verse: how far a line that runs over is set in. */
const TURNOVER = 24;
const VERSE_SIZE = 12;
const VERSE_LINE = 1.6;

/** The same text with a mark on all of it, or in capitals. */
function restyle(content: JSONContent[] | undefined, shape: Shape): JSONContent[] | undefined {
  if (!content || (!shape.upper && !shape.italic && !shape.bold)) return content;
  return content.map((node) => {
    if (node.type !== "text") return node;
    const marks = [...(node.marks ?? [])];
    for (const type of [shape.italic ? "italic" : "", shape.bold ? "bold" : ""]) {
      if (type && !marks.some((m) => m.type === type)) marks.push({ type });
    }
    return { ...node, ...(shape.upper ? { text: (node.text ?? "").toUpperCase() } : {}), ...(marks.length ? { marks } : {}) };
  });
}

function scriptPara(node: JSONContent, shape: Shape): JSONContent {
  const left = shape.left ?? 0;
  const right = shape.width !== undefined ? Math.max(0, TEXT_W - left - shape.width) : 0;
  return {
    type: "paragraph",
    attrs: {
      // (A script's line is its type's size exactly: six to the inch.)
      lineRule: "exact",
      lineAt: LINE,
      sa: shape.above ?? 0,
      sb: shape.below ?? 0,
      indL: left || null,
      indR: right || null,
      indF: 0,
      align: shape.align ?? null,
      keepNext: shape.keep ? true : null,
      pageBreakBefore: node.attrs?.pageBreakBefore ? true : null,
    },
    ...(node.content ? { content: restyle(node.content, shape) } : {}),
  };
}

function versePara(node: JSONContent, title: boolean): JSONContent {
  const align = node.attrs?.align;
  return {
    type: "paragraph",
    attrs: {
      line: VERSE_LINE / SINGLE,
      sa: title ? VERSE_SIZE * 1.4 : 0,
      sb: title ? VERSE_SIZE * 0.5 : 0,
      // A line too long for the measure turns over, set in.
      indL: title ? null : TURNOVER,
      indF: title ? 0 : -TURNOVER,
      align: align === "center" || align === "right" ? align : null,
      keepNext: title ? true : null,
      pageBreakBefore: node.attrs?.pageBreakBefore ? true : null,
    },
    ...(node.content ? { content: restyle(node.content, title ? { bold: true } : {}) } : {}),
  };
}

const titlePara = (title: string, attrs: Record<string, unknown>): JSONContent => ({
  type: "paragraph",
  attrs,
  content: [{ type: "text", text: title, marks: [{ type: "bold" }] }],
});

export interface Scripted {
  doc: JSONContent;
  settings: DocSettings;
  /** How many blocks at the start were put in here (a title) and aren't
   *  in the editor's own document. */
  virtual: number;
}

/**
 * A scripted document in a Document's terms: its content with every
 * paragraph formatted directly, and the page setup of its format.
 */
export function scriptedAsDocument(doc: JSONContent, format: string, title: string): Scripted {
  const fallback = DEFAULT_ELEMENT[format];
  const elementOf = (node: JSONContent) => (typeof node.attrs?.element === "string" && node.attrs.element ? node.attrs.element : fallback);
  const blocks = doc.content ?? [];

  if (format === "poetry") {
    const content = blocks.map((node) => (node.type === "paragraph" ? versePara(node, elementOf(node) === "stanza_title") : node));
    const name = title.trim();
    return {
      doc: { type: "doc", content: [...(name ? [titlePara(name, { size: 16, sb: 18, indF: 0, keepNext: true })] : []), ...content] },
      virtual: name ? 1 : 0,
      settings: {
        ...DEFAULT_SETTINGS,
        mt: 1,
        mb: 1,
        ml: 1.5,
        mr: 1.5,
        bodySize: VERSE_SIZE,
        paraSpacing: 0,
        firstIndent: 0,
        // The page number, centred at the foot.
        fR: "",
        feL: "",
        fC: "{page}",
      },
    };
  }

  const shapes = format === "stageplay" ? STAGEPLAY : SCREENPLAY;
  const content = blocks.map((node) => (node.type === "paragraph" ? scriptPara(node, shapes[elementOf(node)] ?? shapes[fallback]) : node));
  const name = title.trim();
  // A play opens with its title; a screenplay's is on a title page of its own.
  const head =
    format === "stageplay" && name
      ? [titlePara(name.toUpperCase(), { lineRule: "exact", lineAt: LINE, sa: 0, sb: 2 * LINE, indF: 0, align: "center", keepNext: true })]
      : [];
  return {
    doc: { type: "doc", content: [...head, ...content] },
    virtual: head.length,
    settings: {
      ...DEFAULT_SETTINGS,
      mt: 1,
      mb: 1,
      ml: 1.5,
      mr: 1,
      bodyFont: "mono",
      bodySize: 12,
      bodyLine: 1,
      paraSpacing: 0,
      firstIndent: 0,
      // Numbered at the top right, from the second page.
      fR: "",
      feL: "",
      hR: "{page}.",
      hfFirst: true,
    },
  };
}
