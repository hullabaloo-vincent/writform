/**
 * Import a FigJam / Freeform PDF export as an editable board.
 *
 * A PDF has no board semantics — it is text runs, embedded images and vector
 * paths — so this is reconstruction, not conversion: images become image
 * elements, filled rectangle-ish paths become notes (when text sits inside
 * them) or shapes, and text runs are grouped into text elements. Freehand
 * ink, gradients and decorative vectors are knowingly dropped; the user chose
 * editability over pixel fidelity.
 *
 * Grounded against pdf.js 6.2.108's actual operator list (probed on the real
 * exports): the paint verb is FUSED into `constructPath` (arg0 = op, arg2 =
 * [minX, minY, maxX, maxY] in current user space), `setFillRGBColor` carries
 * a CSS hex string, and image objects resolve asynchronously AFTER
 * getOperatorList — they must be awaited via `objs.get(id, callback)`.
 */

import { loadPdfjs, type Pdfjs } from "../../lib/pdfjs";
import type { CreateElementRequest } from "../../bindings/proto/CreateElementRequest";
import { canvasApi } from "./api";
import {
  abandonBoard,
  createDestBoard,
  finishDest,
  guardDest,
  MAX_BOARD_ELEMENTS,
  mediaByteLimit,
  pool,
  saveMediaFor,
  throwIfAborted,
  type ImportDest,
  type ImportProgress,
  type ImportResult,
} from "./boardFile";
import { FRAME_COLORS, STICKY_RGB, TEXT_COLORS } from "./BoardRoom";

const MAX_PAGES = 20;
/** These exports are black text on a white page; imported text keeps that. */
const INK = TEXT_COLORS.find((c) => c.name === "Ink")?.css ?? "#1d1c22";
/** Stop planning new elements past this; the server caps boards at 2000. */
const MAX_ELEMENTS = MAX_BOARD_ELEMENTS - 100;
/** Ignore images smaller than this on either side (masks, specks). */
const MIN_IMAGE_PT = 8;
/** Filled paths in this size window are note/shape candidates. */
const RECT_MIN_W = 90;
const RECT_MIN_H = 50;
const RECT_MAX = 1400;
/** Path complexity cap: a rounded rect is ~40 floats; blobs run to hundreds. */
const RECT_MAX_FLOATS = 160;
const PNG_MAX_BYTES = 2_500_000;
const JPEG_QUALITY = 0.85;
/** An unresolved image object is abandoned after this long. */
const OBJ_TIMEOUT_MS = 20_000;

type Mat = [number, number, number, number, number, number];

/** result = apply `b`, then `a` (PDF `cm` concatenation). */
const matMul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

const matApply = (m: Mat, x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned envelope of a user-space rect pushed through a matrix. */
function boxThrough(m: Mat, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [matApply(m, x0, y0), matApply(m, x1, y0), matApply(m, x0, y1), matApply(m, x1, y1)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/* ------------------------------------------------------------- palettes */

const parseRgb = (raw: string): [number, number, number] | null => {
  const hex = /^#([0-9a-f]{6})$/i.exec(raw.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const nums = raw.match(/\d+/g);
  return nums && nums.length >= 3 ? [Number(nums[0]), Number(nums[1]), Number(nums[2])] : null;
};

function nearestKey(
  rgb: [number, number, number],
  palette: Record<string, [number, number, number]>,
  chromaless: string,
): string {
  // Near-gray fills (white cards, shadows) don't vote — they'd land on an
  // arbitrary hue.
  if (Math.max(...rgb) - Math.min(...rgb) < 18) return chromaless;
  let best = chromaless;
  let bestDist = Infinity;
  for (const [key, [r, g, b]] of Object.entries(palette)) {
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  return best;
}

const stickyPalette = (): Record<string, [number, number, number]> =>
  Object.fromEntries(
    Object.entries(STICKY_RGB).map(([k, v]) => [k, parseRgb(v) ?? [0, 0, 0]]),
  );
const framePalette = (): Record<string, [number, number, number]> =>
  Object.fromEntries(
    Object.entries(FRAME_COLORS).map(([k, v]) => [k, parseRgb(v.border) ?? [0, 0, 0]]),
  );

/* ------------------------------------------------------- image decoding */

interface PdfImageObj {
  bitmap?: ImageBitmap;
  data?: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  kind?: number;
}

/** Image objects stream in after the operator list; wait, bounded. */
function resolveObj(page: { objs: unknown }, objId: string): Promise<PdfImageObj | null> {
  const objs = page.objs as { get: (id: string, cb?: (o: unknown) => void) => unknown };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), OBJ_TIMEOUT_MS);
    try {
      objs.get(objId, (obj: unknown) => {
        clearTimeout(timer);
        resolve((obj as PdfImageObj) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

async function encodeImage(pdfjs: Pdfjs, obj: PdfImageObj): Promise<Blob | null> {
  if (!obj.width || !obj.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = obj.width;
  canvas.height = obj.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (obj.bitmap) {
    ctx.drawImage(obj.bitmap, 0, 0);
  } else if (obj.data) {
    const { width, height } = obj;
    let rgba: Uint8ClampedArray;
    if (obj.kind === pdfjs.ImageKind.RGBA_32BPP) {
      rgba = new Uint8ClampedArray(obj.data);
    } else if (obj.kind === pdfjs.ImageKind.RGB_24BPP) {
      rgba = new Uint8ClampedArray(width * height * 4);
      for (let s = 0, d = 0; s + 2 < obj.data.length; s += 3, d += 4) {
        rgba[d] = obj.data[s];
        rgba[d + 1] = obj.data[s + 1];
        rgba[d + 2] = obj.data[s + 2];
        rgba[d + 3] = 255;
      }
    } else if (obj.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
      rgba = new Uint8ClampedArray(width * height * 4);
      const rowBytes = Math.ceil(width / 8);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const bit = (obj.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const d = (y * width + x) * 4;
          rgba[d] = v;
          rgba[d + 1] = v;
          rgba[d + 2] = v;
          rgba[d + 3] = 255;
        }
      }
    } else {
      return null;
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else {
    return null;
  }

  const png = await toBlob(canvas, "image/png");
  if (png && png.size <= PNG_MAX_BYTES) return png;
  // JPEG drops alpha, which would turn transparency black — flatten on white
  // the way the boards' light surfaces expect.
  const flat = document.createElement("canvas");
  flat.width = obj.width;
  flat.height = obj.height;
  const fctx = flat.getContext("2d");
  if (!fctx) return png;
  fctx.fillStyle = "#ffffff";
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(canvas, 0, 0);
  return (await toBlob(flat, "image/jpeg", JPEG_QUALITY)) ?? png;
}

/* ------------------------------------------------------------ extraction */

interface PlannedImage {
  order: number;
  objId: string;
  box: Box;
  rotate: number;
}

interface PlannedRect {
  order: number;
  box: Box;
  rgb: [number, number, number];
}

interface TextBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  text: string;
  /** Index into the page's rect candidates containing this block, or -1. */
  host: number;
  consumed?: boolean;
}

interface PageContent {
  images: PlannedImage[];
  rects: PlannedRect[];
  blocks: TextBlock[];
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

/** One page's operator walk: images with their placement, filled rect-ish
 *  paths with their color, in paint order. */
function walkOperators(
  pdfjs: Pdfjs,
  fnArray: number[],
  argsArray: unknown[],
  base: Mat,
  pageArea: number,
): { images: PlannedImage[]; rects: PlannedRect[] } {
  const OPS = pdfjs.OPS;
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke]);
  const images: PlannedImage[] = [];
  const rects: PlannedRect[] = [];
  const stack: { ctm: Mat; fill: [number, number, number] }[] = [];
  let ctm: Mat = [...base] as Mat;
  let fill: [number, number, number] = [200, 200, 200];
  let order = 0;

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (fn === OPS.save) {
      stack.push({ ctm: [...ctm] as Mat, fill });
    } else if (fn === OPS.restore) {
      const prev = stack.pop();
      if (prev) {
        ctm = prev.ctm;
        fill = prev.fill;
      }
    } else if (fn === OPS.transform && args && args.length >= 6) {
      ctm = matMul(ctm, args.slice(0, 6).map(Number) as Mat);
    } else if (fn === OPS.setFillRGBColor && args) {
      const parsed = typeof args[0] === "string" ? parseRgb(args[0]) : null;
      if (parsed) fill = parsed;
    } else if (fn === OPS.constructPath && args) {
      // v6 fuses the paint verb in: [paintOp, [Float32Array path], minMax].
      const paintOp = Number(args[0]);
      const inner = (args[1] as ArrayLike<number>[] | undefined)?.[0];
      const minMax = args[2] as ArrayLike<number> | undefined;
      if (!fillOps.has(paintOp) || !minMax || minMax.length !== 4) continue;
      if (inner && inner.length > RECT_MAX_FLOATS) continue;
      // Near-axis-aligned only — a rotated card's envelope lies.
      if (Math.abs(Math.atan2(ctm[1], ctm[0])) > (3 * Math.PI) / 180) continue;
      const box = boxThrough(ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
      if (box.w < RECT_MIN_W || box.h < RECT_MIN_H) continue;
      if (box.w > RECT_MAX || box.h > RECT_MAX) continue;
      if (box.w * box.h > pageArea * 0.65) continue; // page background wash
      rects.push({ order: order++, box, rgb: fill });
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const objId = args?.[0];
      if (typeof objId !== "string") continue;
      // The image fills the unit square under the current matrix.
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      if (w < MIN_IMAGE_PT || h < MIN_IMAGE_PT) continue;
      const center = matApply(ctm, 0.5, 0.5);
      const angle = (Math.atan2(ctm[1], ctm[0]) * 180) / Math.PI;
      images.push({
        order: order++,
        objId,
        box: { x: center.x - w / 2, y: center.y - h / 2, w, h },
        rotate: Math.abs(angle) < 3 ? 0 : Math.round(angle),
      });
    }
  }
  return { images, rects };
}

/**
 * Group a page's text runs into lines, then lines into blocks.
 *
 * Two rules keep a whole wall of cards from fusing into one block (which is
 * exactly what happened on the first real import): runs on the same baseline
 * only join a line across a SMALL horizontal gap — a board page is thousands
 * of points wide, and same-height text in different cards is not one line —
 * and lines only merge into a block when they live inside the SAME card
 * (rect candidate), or both in none.
 */
function groupText(items: PdfTextItem[], pageHeight: number, cards: Box[]): TextBlock[] {
  interface Run {
    x: number;
    top: number;
    baseline: number;
    width: number;
    size: number;
    str: string;
  }
  const runs: Run[] = [];
  for (const item of items) {
    if (!item.str.trim()) continue;
    const t = item.transform;
    const size = Math.hypot(t[2], t[3]) || 12;
    if (size < 4) continue;
    const baseline = pageHeight - t[5];
    runs.push({
      x: t[4],
      top: baseline - size * 0.83,
      baseline,
      width: Math.abs(item.width) || item.str.length * size * 0.5,
      size,
      str: item.str,
    });
  }

  // Lines: same baseline AND horizontally adjacent.
  runs.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  interface Line {
    x0: number;
    x1: number;
    top: number;
    size: number;
    baseline: number;
    text: string;
  }
  const lines: Line[] = [];
  for (const run of runs) {
    const line = lines.find(
      (l) =>
        Math.abs(l.baseline - run.baseline) <= Math.max(2, run.size * 0.45) &&
        run.x - l.x1 <= Math.max(30, run.size * 2.5) &&
        run.x - l.x1 >= -run.size,
    );
    if (!line) {
      lines.push({
        x0: run.x,
        x1: run.x + run.width,
        top: run.top,
        size: run.size,
        baseline: run.baseline,
        text: run.str,
      });
      continue;
    }
    const gap = run.x - line.x1;
    if (line.text && !/\s$/.test(line.text) && gap > Math.max(1.5, run.size * 0.18)) {
      line.text += " ";
    }
    line.text += run.str;
    line.x0 = Math.min(line.x0, run.x);
    line.x1 = Math.max(line.x1, run.x + run.width);
    line.top = Math.min(line.top, run.top);
    line.size = Math.max(line.size, run.size);
  }

  // Which card each line sits in — the smallest rect containing its centre.
  const hostOf = (cx: number, cy: number): number => {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < cards.length; i += 1) {
      const c = cards[i];
      if (cx < c.x || cx > c.x + c.w || cy < c.y || cy > c.y + c.h) continue;
      const area = c.w * c.h;
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    return best;
  };

  // Blocks: each line joins the best open block of the SAME card that it
  // horizontally overlaps and vertically continues. Lines are y-sorted
  // globally, so unrelated regions interleave — matching only the previous
  // line would shred every column on a wide board.
  lines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  interface OpenBlock extends TextBlock {
    bottom: number;
  }
  const blocks: OpenBlock[] = [];
  for (const line of lines) {
    const host = hostOf((line.x0 + line.x1) / 2, line.top + line.size * 0.6);
    let best: OpenBlock | null = null;
    for (const b of blocks) {
      if (b.host !== host) continue;
      if (Math.min(b.x + b.w, line.x1) - Math.max(b.x, line.x0) <= 0) continue;
      const gap = line.top - b.bottom;
      if (gap > Math.max(6, Math.min(b.size, line.size) * 1.7) || gap < -line.size) continue;
      if (!best || b.bottom > best.bottom) best = b;
    }
    if (best) {
      best.text += `\n${line.text}`;
      best.w = Math.max(best.x + best.w, line.x1) - Math.min(best.x, line.x0);
      best.x = Math.min(best.x, line.x0);
      best.bottom = Math.max(best.bottom, line.top + line.size * 1.25);
      best.h = best.bottom - best.y;
      best.size = Math.max(best.size, line.size);
    } else {
      blocks.push({
        x: line.x0,
        y: line.top,
        w: line.x1 - line.x0,
        h: line.size * 1.3,
        bottom: line.top + line.size * 1.25,
        size: line.size,
        text: line.text,
        host,
      });
    }
  }
  return blocks.filter((b) => b.text.trim().length > 0);
}


/* ---------------------------------------------------------------- import */

export async function importPdfAsBoard(
  file: File,
  dest: ImportDest,
  onProgress: (p: ImportProgress) => void,
  signal: AbortSignal,
): Promise<ImportResult> {
  onProgress({ label: "Reading PDF", done: 0, total: 1 });
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);

  let loadingTask: ReturnType<Pdfjs["getDocument"]> | null = null;
  try {
    loadingTask = pdfjs.getDocument({
      data,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
    });
    const doc = await loadingTask.promise.catch((e: unknown) => {
      const name = (e as { name?: string } | null)?.name;
      if (name === "PasswordException") {
        throw {
          code: "pdf_password",
          message: "This PDF is password-protected — remove the password and try again.",
        };
      }
      throw { code: "pdf_invalid", message: "That file doesn't look like a readable PDF." };
    });

    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const truncatedPages = doc.numPages > MAX_PAGES;
    if (pageCount === 0) {
      throw { code: "pdf_empty", message: "That PDF has no pages." };
    }

    // ---- extraction pass: everything in memory before any board exists.
    const pages: PageContent[] = [];
    const blobs = new Map<string, Blob>(); // objId → encoded picture
    let planned = 0;
    let elementsTruncated = false;

    for (let p = 0; p < pageCount; p += 1) {
      throwIfAborted(signal);
      onProgress({ label: `Reading page ${p + 1} of ${pageCount}`, done: p, total: pageCount });
      const page = await doc.getPage(p + 1);
      const viewport = page.getViewport({ scale: 1 });
      const base = viewport.transform.slice(0, 6) as Mat;

      const opList = await page.getOperatorList();
      const { images, rects } = walkOperators(
        pdfjs,
        opList.fnArray,
        opList.argsArray,
        base,
        viewport.width * viewport.height,
      );

      const content = await page.getTextContent();
      const blocks = groupText(
        content.items.filter((it) => "str" in it) as unknown as PdfTextItem[],
        viewport.height,
        rects.map((r) => r.box),
      );

      // Decode this page's unique pictures now — cleanup() clears them.
      const uniqueIds = [...new Set(images.map((img) => img.objId))];
      await pool(uniqueIds, 3, async (objId) => {
        throwIfAborted(signal);
        const obj = await resolveObj(page, objId);
        const blob = obj ? await encodeImage(pdfjs, obj).catch(() => null) : null;
        if (blob) blobs.set(objId, blob);
      });
      page.cleanup();

      // Respect the board's element budget across all pages.
      const keepImages = images.filter((img) => blobs.has(img.objId));
      const room = () => MAX_ELEMENTS - planned;
      const take = <T,>(list: T[]): T[] => {
        const kept = list.slice(0, Math.max(0, room()));
        if (kept.length < list.length) elementsTruncated = true;
        planned += kept.length;
        return kept;
      };
      pages.push({ images: take(keepImages), rects: take(rects), blocks: take(blocks) });
    }

    if (planned === 0) {
      throw {
        code: "pdf_nothing",
        message:
          "Nothing recognizable to import — this PDF has no text, pictures or note-like shapes.",
      };
    }

    // ---- the board exists only now that there is something to put on it.
    throwIfAborted(signal);
    const name = file.name.replace(/\.pdf$/i, "");
    const boardId = await createDestBoard(dest, name);

    try {
      guardDest(dest, boardId);
      await canvasApi.updateBoard(
        boardId,
        JSON.stringify({
          pages: Array.from({ length: pageCount }, (_, i) => ({
            id: i,
            name: `Page ${i + 1}`,
            // The source page: white paper, no dot grid — imported black
            // text and pastel cards read the way they did in the export.
            bg: { color: "#ffffff", grid: false },
          })),
        }),
      );

      // Store each unique picture once; repeated draws reuse the ref.
      const uniqueBlobs = [...blobs.entries()].filter(([, b]) => b.size <= mediaByteLimit(dest));
      const refs = new Map<string, string>();
      let stored = 0;
      await pool(uniqueBlobs, 3, async ([objId, blob]) => {
        throwIfAborted(signal);
        guardDest(dest, boardId);
        onProgress({ label: "Storing pictures", done: stored, total: uniqueBlobs.length });
        refs.set(objId, await saveMediaFor(dest, blob, `${name}-${objId}.png`));
        stored += 1;
      });

      const sticky = stickyPalette();
      const frame = framePalette();
      const counts = { images: 0, notes: 0, frames: 0, shapes: 0, texts: 0 };
      const totalToPlace = pages.reduce(
        (n, page) => n + page.images.length + page.rects.length + page.blocks.length,
        0,
      );
      let placed = 0;
      const create = async (req: CreateElementRequest) => {
        throwIfAborted(signal);
        guardDest(dest, boardId);
        onProgress({ label: "Placing elements", done: placed, total: totalToPlace });
        placed += 1;
        await canvasApi.createElement(boardId, req);
      };

      for (let p = 0; p < pageCount; p += 1) {
        const { images, rects, blocks } = pages[p];

        // Classify each card by what it holds. A card with one text block and
        // no pictures is a note; anything holding pictures, several blocks,
        // or lots of space is a CONTAINER — a frame, which tints the area,
        // keeps its children when dragged, and leaves the card's text as
        // positioned text elements so the layout survives (the real Freeform
        // board lays text beside photos; one joined-up note would flatten
        // that).
        interface CardPlan {
          kind: "sticky" | "frame" | "shape";
          label?: TextBlock;
          inside: TextBlock[];
        }
        const plans = new Map<number, CardPlan>();
        rects.forEach((rect, ri) => {
          const inside = blocks
            .filter((b) => b.host === ri)
            .sort((a, b) => a.y - b.y || a.x - b.x);
          const holdsImages = images.some((img) => {
            const cx = img.box.x + img.box.w / 2;
            const cy = img.box.y + img.box.h / 2;
            return (
              cx >= rect.box.x &&
              cx <= rect.box.x + rect.box.w &&
              cy >= rect.box.y &&
              cy <= rect.box.y + rect.box.h
            );
          });
          const large = rect.box.w > 380 || rect.box.h > 380;
          if (inside.length === 1 && !holdsImages && rect.box.w <= 620 && rect.box.h <= 620) {
            inside[0].consumed = true;
            plans.set(ri, { kind: "sticky", inside });
          } else if (inside.length > 0 || holdsImages || large) {
            const plan: CardPlan = { kind: "frame", inside };
            // A short single top line makes a natural frame label.
            const first = inside[0];
            if (
              first &&
              !first.text.includes("\n") &&
              first.text.length <= 48 &&
              first.y <= rect.box.y + rect.box.h * 0.3
            ) {
              plan.label = first;
              first.consumed = true;
            }
            plans.set(ri, plan);
          } else {
            plans.set(ri, { kind: "shape", inside });
          }
        });

        // Paint order first (backgrounds under photos), text on top.
        const inOrder = [
          ...rects.map((r) => ({ order: r.order, kind: "rect" as const, rect: r })),
          ...images.map((img) => ({ order: img.order, kind: "image" as const, img })),
        ].sort((a, b) => a.order - b.order);

        for (const item of inOrder) {
          if (item.kind === "image") {
            const ref = refs.get(item.img.objId);
            if (!ref) continue;
            const style: Record<string, unknown> = {};
            if (item.img.rotate) style.rotate = item.img.rotate;
            counts.images += 1;
            await create({
              kind: "image",
              page: p,
              x: item.img.box.x,
              y: item.img.box.y,
              w: Math.max(MIN_IMAGE_PT, item.img.box.w),
              h: Math.max(MIN_IMAGE_PT, item.img.box.h),
              text: ref,
              color: "",
              style: Object.keys(style).length ? JSON.stringify(style) : "",
              from_id: null,
              to_id: null,
            });
            continue;
          }
          const ri = rects.indexOf(item.rect);
          const plan = plans.get(ri) ?? { kind: "shape" as const, inside: [] };
          const rect = item.rect;
          if (plan.kind === "sticky") {
            counts.notes += 1;
            const block = plan.inside[0];
            await create({
              kind: "sticky",
              page: p,
              x: rect.box.x,
              y: rect.box.y,
              w: rect.box.w,
              h: rect.box.h,
              text: block.text.slice(0, 4000),
              color: nearestKey(rect.rgb, sticky, "yellow"),
              style: JSON.stringify({ size: Math.round(Math.min(96, Math.max(9, block.size))) }),
              from_id: null,
              to_id: null,
            });
          } else if (plan.kind === "frame") {
            counts.frames += 1;
            await create({
              kind: "frame",
              page: p,
              x: rect.box.x,
              y: rect.box.y,
              w: rect.box.w,
              h: rect.box.h,
              text: plan.label ? plan.label.text.slice(0, 120) : "",
              color: nearestKey(rect.rgb, frame, ""),
              style: "",
              from_id: null,
              to_id: null,
            });
          } else {
            counts.shapes += 1;
            await create({
              kind: "shape",
              page: p,
              x: rect.box.x,
              y: rect.box.y,
              w: rect.box.w,
              h: rect.box.h,
              text: "",
              color: nearestKey(rect.rgb, frame, ""),
              style: JSON.stringify({ shape: "rect", filled: true }),
              from_id: null,
              to_id: null,
            });
          }
        }

        for (const block of blocks) {
          if (block.consumed) continue;
          counts.texts += 1;
          const size = Math.round(Math.min(96, Math.max(9, block.size)));
          const lineCount = block.text.split("\n").length;
          await create({
            kind: "text",
            page: p,
            x: block.x - 8,
            y: block.y - 6,
            // The app renders in its own typeface at line-height 1.4 with
            // padding; PDF glyph metrics run tighter, and a snug box clips.
            w: Math.max(70, Math.round(block.w * 1.2) + 28),
            h: Math.max(36, Math.round(lineCount * size * 1.5) + 22),
            text: block.text.slice(0, 4000),
            color: "",
            style: JSON.stringify({ size, textColor: INK }),
            from_id: null,
            to_id: null,
          });
        }
      }

      await finishDest(dest);

      const parts = [
        counts.images > 0 && `${counts.images} picture${counts.images === 1 ? "" : "s"}`,
        counts.notes > 0 && `${counts.notes} note${counts.notes === 1 ? "" : "s"}`,
        counts.frames > 0 && `${counts.frames} frame${counts.frames === 1 ? "" : "s"}`,
        counts.shapes > 0 && `${counts.shapes} shape${counts.shapes === 1 ? "" : "s"}`,
        counts.texts > 0 && `${counts.texts} text block${counts.texts === 1 ? "" : "s"}`,
      ].filter(Boolean);
      const extras = [
        truncatedPages && `first ${MAX_PAGES} of ${doc.numPages} pages`,
        elementsTruncated && "element limit reached",
      ].filter(Boolean);
      return {
        boardId,
        notice: `Imported ${parts.join(", ")}${extras.length ? ` (${extras.join("; ")})` : ""}`,
      };
    } catch (e) {
      await abandonBoard(boardId);
      throw e;
    }
  } finally {
    // Also stops the worker; a throw here must never mask the real outcome.
    if (loadingTask) await loadingTask.destroy().catch(() => {});
  }
}
