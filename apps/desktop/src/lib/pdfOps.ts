/**
 * A walk over one PDF page's drawing instructions, as pdf.js lists them.
 *
 * pdf.js gives a page's text as strings with places, and nothing of how
 * they were drawn: not their colour, not whether they were drawn at all
 * (a scan's recognised words are text nobody sees), not the lines and the
 * pictures around them. Those are in the page's operator list. This follows
 * it, keeping the drawing state a PDF keeps, and says what was put where.
 *
 * Everything it reports is in the page as it is looked at: points, x to
 * the right, y DOWN from the top left corner, the page already turned the
 * way it is shown (`base` is the viewport's transform).
 *
 * Grounded against pdf.js 6.2.108: a path arrives whole with how it was
 * painted (`constructPath`: [paint, [data], [minX, minY, maxX, maxY]]), a
 * fill colour is a "#rrggbb" string whatever colour space it was written
 * in, and `setTextMatrix` carries one array of six.
 */

import type { Pdfjs } from "./pdfjs";

export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `b` first, then `a` (how a PDF's `cm` joins on). */
export const matMul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

export const matApply = (m: Mat, x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

/** How much a matrix enlarges a length (the mean of its two directions). */
export const matScale = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The upright box round a rectangle put through a matrix. */
export function boxThrough(m: Mat, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [matApply(m, x0, y0), matApply(m, x1, y0), matApply(m, x0, y1), matApply(m, x1, y1)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** A colour as pdf.js writes one, as "#rrggbb" (null: not a plain colour). */
export function plainColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(raw.trim());
  return hex ? `#${hex[1].toLowerCase()}` : null;
}

/** A string as it was drawn. */
export interface ShownText {
  /** Where it starts, on its baseline. */
  x: number;
  y: number;
  /** The height of its type. */
  size: number;
  text: string;
  /** What it was filled with (null: a pattern or a shading). */
  fill: string | null;
  /** How its outlines were painted: 0 filled, 1 stroked, 2 both, 3 not at
   *  all (and 4 to 7, the same while adding to the clip). */
  mode: number;
  /** The pen that stroked it, as a part of its height. */
  pen: number;
  /** The font, by the name pdf.js knows it under. */
  font: string;
}

/** A picture, where it was put. */
export interface PlacedImage {
  /** The object pdf.js keeps it as. */
  id: string;
  box: Box;
  /** How far it is turned, degrees. */
  angle: number;
  /** A stencil (one colour through a mask) and not a picture of anything. */
  mask: boolean;
  /** The marked stretch it was drawn in (its number on the page), if any. */
  mc: number | null;
  order: number;
}

/** A path that was painted. */
export interface PaintedPath {
  box: Box;
  filled: boolean;
  stroked: boolean;
  fill: string | null;
  stroke: string | null;
  /** The stroking pen's width. */
  pen: number;
  /** Straight lines only. */
  straight: boolean;
  /** How many places it goes through. */
  points: number;
  order: number;
}

export interface PageMarks {
  shown: ShownText[];
  images: PlacedImage[];
  paths: PaintedPath[];
}

interface FontFacts {
  fontMatrix?: ArrayLike<number>;
  vertical?: boolean;
}

interface Glyph {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

interface State {
  ctm: Mat;
  fill: string | null;
  stroke: string | null;
  pen: number;
  font: string;
  size: number;
  dir: number;
  charSpace: number;
  wordSpace: number;
  hScale: number;
  leading: number;
  rise: number;
  mode: number;
  /** The text matrix, and where the pen is in it. */
  tm: Mat;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
}

const six = (args: unknown[] | null): Mat | null => {
  if (!args) return null;
  const from = args.length >= 6 ? args : (args[0] as ArrayLike<number> | undefined);
  if (!from || from.length < 6) return null;
  const m = Array.from({ length: 6 }, (_, i) => Number((from as ArrayLike<unknown>)[i])) as Mat;
  return m.every(Number.isFinite) ? m : null;
};

/**
 * Follow a page's operator list. `fonts` answers for a font by the name the
 * list uses (how wide its glyph units are): the page's `commonObjs`.
 */
export function walkPage(
  pdfjs: Pdfjs,
  list: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  base: Mat,
  fonts: (name: string) => FontFacts | null = () => null,
): PageMarks {
  const OPS = pdfjs.OPS as Record<string, number>;
  const shown: ShownText[] = [];
  const images: PlacedImage[] = [];
  const paths: PaintedPath[] = [];
  const stack: State[] = [];
  let s: State = {
    ctm: [...base] as Mat,
    fill: "#000000",
    stroke: "#000000",
    pen: 1,
    font: "",
    size: 0,
    dir: 1,
    charSpace: 0,
    wordSpace: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    mode: 0,
    tm: [...IDENTITY] as Mat,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
  };
  let order = 0;
  /** Inside an annotation's own drawing, which is not the page's. */
  let annotation = 0;
  /** The marked stretches that are open, innermost last. */
  const marked: (number | null)[] = [];

  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

  const moveText = (x: number, y: number) => {
    s.lineX += x;
    s.lineY += y;
    s.x = s.lineX;
    s.y = s.lineY;
  };

  const show = (glyphs: unknown) => {
    if (!Array.isArray(glyphs) || !s.size) return;
    const facts = fonts(s.font);
    const unit = Number(facts?.fontMatrix?.[0]) || 0.001;
    const vertical = !!facts?.vertical;
    const at = matMul(s.ctm, s.tm);
    const start = matApply(at, s.x, s.y + s.rise);
    let text = "";
    let advance = 0;
    for (const g of glyphs as (Glyph | number)[]) {
      if (typeof g === "number") {
        advance += ((vertical ? 1 : -1) * g * s.size) / 1000;
        continue;
      }
      if (!g || typeof g !== "object") continue;
      text += g.unicode ?? "";
      const spacing = (g.isSpace ? s.wordSpace : 0) + s.charSpace;
      const width = (Number(g.width) || 0) * s.size * unit;
      advance += vertical ? width - spacing * s.dir : width + spacing * s.dir;
    }
    if (text) {
      const height = s.size * Math.hypot(at[2], at[3]);
      shown.push({ x: start.x, y: start.y, size: height, text, fill: s.fill, mode: s.mode, pen: height > 0 ? (s.pen * matScale(s.ctm)) / height : 0, font: s.font });
    }
    if (vertical) s.y -= advance;
    else s.x += advance * s.hScale;
  };

  const n = list.fnArray.length;
  for (let i = 0; i < n; i += 1) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[] | null;

    if (fn === OPS.beginAnnotation) {
      annotation += 1;
      continue;
    }
    if (fn === OPS.endAnnotation) {
      annotation = Math.max(0, annotation - 1);
      continue;
    }
    if (annotation) continue;

    if (fn === OPS.beginMarkedContent || fn === OPS.beginMarkedContentProps) {
      const id = args?.[1];
      marked.push(typeof id === "number" ? id : null);
      continue;
    }
    if (fn === OPS.endMarkedContent) {
      marked.pop();
      continue;
    }

    if (fn === OPS.save) {
      stack.push({ ...s, ctm: [...s.ctm] as Mat, tm: [...s.tm] as Mat });
    } else if (fn === OPS.restore) {
      const prev = stack.pop();
      if (prev) s = prev;
    } else if (fn === OPS.transform) {
      const m = six(args);
      if (m) s.ctm = matMul(s.ctm, m);
    } else if (fn === OPS.paintFormXObjectBegin) {
      // A form is drawn in a state of its own, placed by its matrix.
      stack.push({ ...s, ctm: [...s.ctm] as Mat, tm: [...s.tm] as Mat });
      const m = six(args && Array.isArray(args[0]) ? (args[0] as unknown[]) : args?.[0] ? [args[0]] : null);
      if (m) s.ctm = matMul(s.ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) {
      const prev = stack.pop();
      if (prev) s = prev;
    } else if (fn === OPS.setFillRGBColor) {
      s.fill = plainColor(args?.[0]);
    } else if (fn === OPS.setStrokeRGBColor) {
      s.stroke = plainColor(args?.[0]);
    } else if (fn === OPS.setFillColorN || fn === OPS.shadingFill) {
      s.fill = null;
    } else if (fn === OPS.setStrokeColorN) {
      s.stroke = null;
    } else if (fn === OPS.setLineWidth) {
      s.pen = Math.abs(Number(args?.[0]) || 0);
    } else if (fn === OPS.setGState) {
      for (const pair of (args?.[0] as [string, unknown][] | undefined) ?? []) {
        if (!Array.isArray(pair)) continue;
        if (pair[0] === "LW") s.pen = Math.abs(Number(pair[1]) || 0);
        else if (pair[0] === "Font" && Array.isArray(pair[1])) {
          s.font = String(pair[1][0] ?? "");
          const size = Number(pair[1][1]) || 0;
          s.size = Math.abs(size);
          s.dir = size < 0 ? -1 : 1;
        }
      }
    } else if (fn === OPS.beginText) {
      s.tm = [...IDENTITY] as Mat;
      s.x = s.y = s.lineX = s.lineY = 0;
    } else if (fn === OPS.setTextMatrix) {
      const m = six(args);
      if (m) {
        s.tm = m;
        s.x = s.y = s.lineX = s.lineY = 0;
      }
    } else if (fn === OPS.moveText) {
      moveText(Number(args?.[0]) || 0, Number(args?.[1]) || 0);
    } else if (fn === OPS.setLeadingMoveText) {
      s.leading = Number(args?.[1]) || 0;
      moveText(Number(args?.[0]) || 0, Number(args?.[1]) || 0);
    } else if (fn === OPS.setLeading) {
      s.leading = -(Number(args?.[0]) || 0);
    } else if (fn === OPS.nextLine) {
      moveText(0, s.leading);
    } else if (fn === OPS.setFont) {
      s.font = String(args?.[0] ?? "");
      const size = Number(args?.[1]) || 0;
      s.size = Math.abs(size);
      s.dir = size < 0 ? -1 : 1;
    } else if (fn === OPS.setCharSpacing) {
      s.charSpace = Number(args?.[0]) || 0;
    } else if (fn === OPS.setWordSpacing) {
      s.wordSpace = Number(args?.[0]) || 0;
    } else if (fn === OPS.setHScale) {
      s.hScale = (Number(args?.[0]) || 100) / 100;
    } else if (fn === OPS.setTextRise) {
      s.rise = Number(args?.[0]) || 0;
    } else if (fn === OPS.setTextRenderingMode) {
      s.mode = Number(args?.[0]) || 0;
    } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      show(args?.[0]);
    } else if (fn === OPS.nextLineShowText) {
      moveText(0, s.leading);
      show(args?.[0]);
    } else if (fn === OPS.nextLineSetSpacingShowText) {
      s.wordSpace = Number(args?.[0]) || 0;
      s.charSpace = Number(args?.[1]) || 0;
      moveText(0, s.leading);
      show(args?.[2]);
    } else if (fn === OPS.constructPath && args) {
      const paint = Number(args[0]);
      const filled = fills.has(paint);
      const stroked = strokes.has(paint);
      const minMax = args[2] as ArrayLike<number> | null | undefined;
      if ((!filled && !stroked) || !minMax || minMax.length !== 4) continue;
      const data = (args[1] as ArrayLike<number>[] | undefined)?.[0];
      let straight = true;
      let points = 0;
      if (data) {
        for (let k = 0; k < data.length; ) {
          const op = data[k];
          if (op === 0 || op === 1) k += 3;
          else if (op === 2) {
            straight = false;
            k += 7;
          } else if (op === 3) {
            straight = false;
            k += 5;
          } else k += 1;
          if (op !== 4) points += 1;
        }
      }
      paths.push({
        box: boxThrough(s.ctm, minMax[0], minMax[1], minMax[2], minMax[3]),
        filled,
        stroked,
        fill: s.fill,
        stroke: s.stroke,
        pen: s.pen * matScale(s.ctm),
        straight,
        points,
        order: order++,
      });
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObject) {
      const first = args?.[0];
      // (A stencil's object is named inside what it is given.)
      const id = typeof first === "string" ? first : typeof (first as { data?: unknown } | null)?.data === "string" ? String((first as { data: string }).data) : "";
      if (!id) continue;
      // A picture fills the unit square under the matrix of the moment.
      const w = Math.hypot(s.ctm[0], s.ctm[1]);
      const h = Math.hypot(s.ctm[2], s.ctm[3]);
      const box = boxThrough(s.ctm, 0, 0, 1, 1);
      const turn = (Math.atan2(s.ctm[1], s.ctm[0]) * 180) / Math.PI;
      images.push({ id, box: Math.abs(turn) < 3 || Math.abs(Math.abs(turn) - 180) < 3 ? box : { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h }, angle: Math.abs(turn) < 3 ? 0 : Math.round(turn), mask: fn === OPS.paintImageMaskXObject, mc: [...marked].reverse().find((m) => m !== null) ?? null, order: order++ });
    }
  }
  return { shown, images, paths };
}
