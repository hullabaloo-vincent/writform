/**
 * What a PDF import needs a canvas for: a picture pdf.js hands over as
 * pixels made a file again, and a page drawn as a picture (a scan that is
 * not one picture, to have its text read). On the page only: the importer
 * itself is given these and never asks for a window.
 */

import { looksDrawn } from "../../../book/engine/pictures";
import type { EncodeImage, EncodedPicture, RenderPage } from "./pdf";

/** The largest a canvas is made here (WebKit refuses much beyond it). */
const CANVAS_MOST = 16_000_000;
/** A lossless file is kept up to this weight. Past it, a photograph's kind. */
const PNG_MOST = 3_000_000;
const JPEG_QUALITY = 0.9;

const blobOf = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** Pixels as pdf.js keeps them, four bytes to each. */
function rgbaOf(data: Uint8Array | Uint8ClampedArray, w: number, h: number, kind: number | undefined): Uint8ClampedArray | null {
  if (kind === 3 && data.length >= w * h * 4) return new Uint8ClampedArray(data.buffer, data.byteOffset, w * h * 4);
  const out = new Uint8ClampedArray(w * h * 4);
  if (kind === 2 && data.length >= w * h * 3) {
    for (let s = 0, d = 0; d < out.length; s += 3, d += 4) {
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = 255;
    }
    return out;
  }
  if (kind === 1) {
    const row = Math.ceil(w / 8);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const v = (data[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const d = (y * w + x) * 4;
        out[d] = out[d + 1] = out[d + 2] = v;
        out[d + 3] = 255;
      }
    }
    return out;
  }
  return null;
}

/** A canvas as a file: lossless for a drawing or anything see-through, a
 *  photograph's kind for a photograph (on white, which it has no way to
 *  be see-through over). */
async function fileOf(canvas: HTMLCanvasElement): Promise<EncodedPicture | null> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const pixels = ctx.getImageData(0, 0, w, h).data;
  let clear = false;
  for (let k = 3; k < pixels.length; k += 4) {
    if (pixels[k] < 255) {
      clear = true;
      break;
    }
  }
  const drawn = clear || looksDrawn(pixels, w, h);
  const png = drawn ? await blobOf(canvas, "image/png") : null;
  if (png && (clear || png.size <= PNG_MOST)) return { bytes: new Uint8Array(await png.arrayBuffer()), type: "image/png", w, h };
  const flat = document.createElement("canvas");
  flat.width = w;
  flat.height = h;
  const fctx = flat.getContext("2d");
  if (!fctx) return null;
  fctx.fillStyle = "#ffffff";
  fctx.fillRect(0, 0, w, h);
  fctx.drawImage(canvas, 0, 0);
  const jpeg = await blobOf(flat, "image/jpeg", JPEG_QUALITY);
  const best = jpeg && png ? (jpeg.size < png.size ? jpeg : png) : (jpeg ?? png);
  flat.width = flat.height = 0;
  return best ? { bytes: new Uint8Array(await best.arrayBuffer()), type: best.type === "image/png" ? "image/png" : "image/jpeg", w, h } : null;
}

export const encodePdfImage: EncodeImage = async (image, maxPixels) => {
  const { width, height } = image;
  if (!width || !height || width * height > CANVAS_MOST * 4) return null;
  const scale = Math.min(1, Math.sqrt(Math.min(maxPixels, CANVAS_MOST) / (width * height)));
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  let source: CanvasImageSource;
  let made: ImageBitmap | null = null;
  if (image.bitmap) source = image.bitmap as ImageBitmap;
  else if (image.data) {
    const rgba = rgbaOf(image.data, width, height, image.kind);
    if (!rgba) return null;
    made = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height));
    source = made;
  } else return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  made?.close();
  try {
    return await fileOf(canvas);
  } finally {
    canvas.width = canvas.height = 0;
  }
};

/** A page drawn at `dpi`, as a picture (for reading its text). */
export const renderPdfPage: RenderPage = async (page, dpi) => {
  const pdf = page as { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas?: HTMLCanvasElement }): { promise: Promise<void> } };
  let scale = dpi / 72;
  const size = pdf.getViewport({ scale: 1 });
  if (size.width * size.height * scale * scale > CANVAS_MOST) scale = Math.sqrt(CANVAS_MOST / (size.width * size.height));
  const viewport = pdf.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await pdf.render({ canvasContext: ctx, viewport, canvas }).promise;
    const jpeg = await blobOf(canvas, "image/jpeg", JPEG_QUALITY);
    return jpeg ? { bytes: new Uint8Array(await jpeg.arrayBuffer()), type: "image/jpeg", w: canvas.width, h: canvas.height } : null;
  } finally {
    canvas.width = canvas.height = 0;
  }
};
