/**
 * Drawing a picture for a PDF, where there is a canvas (the page, never the
 * typesetting thread). What is decided about a picture is in pictures.ts.
 * This only reads the file, draws it at the size asked and hands back its
 * pixels or a JPEG of them.
 */

import { shownSize, type PictureView } from "../../editor/schema/sanitize";
import { CANVAS_PIXELS, PHONE_PIXELS, sayUpright, sniff, viewDrawMatrix, type PictureTools } from "./pictures";

/** The most pixels this device draws at once (a phone has less to spare). */
export function canvasPixels(): number {
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return coarse ? PHONE_PIXELS : CANVAS_PIXELS;
}

export const canvasTools: PictureTools = {
  async draw(bytes, type, w, h, orientation, white, view) {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: `image/${type}` }));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      if (white) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // The file was told it is upright (pictures.ts), so these are its
      // pixels as stored, and the turning is ours (and the crop and quarter
      // turn the document asks for: what falls outside is never drawn).
      const { m, dw, dh } = viewDrawMatrix(orientation, w, h, view);
      ctx.setTransform(...m);
      ctx.drawImage(bitmap, 0, 0, dw, dh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return {
        pixels: () => ctx.getImageData(0, 0, w, h).data,
        async jpeg(quality, opaque) {
          if (opaque) ctx.putImageData(new ImageData(opaque as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
          if (!blob) throw new Error("encode failed");
          return new Uint8Array(await blob.arrayBuffer());
        },
        async png() {
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("encode failed");
          return new Uint8Array(await blob.arrayBuffer());
        },
        free() {
          // (A canvas keeps its memory until it is sized to nothing.)
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    } finally {
      bitmap.close();
    }
  },
};

/**
 * A picture file made of only the part of a picture shown, turned (for an
 * ebook, which holds files): a JPEG from a JPEG, else a PNG. At most
 * `maxPixels`. Null when the file can't be read.
 */
export async function viewedFile(bytes: Uint8Array, view: PictureView, maxPixels = canvasPixels()): Promise<{ bytes: Uint8Array; type: string } | null> {
  const info = sniff(bytes);
  if (!info) return null;
  const shown = shownSize(info.w, info.h, view);
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, shown.w * shown.h)));
  const w = Math.max(1, Math.floor(shown.w * scale));
  const h = Math.max(1, Math.floor(shown.h * scale));
  const photo = info.type === "jpeg";
  const surface = await canvasTools.draw(sayUpright(bytes, info), info.type, w, h, info.orientation, photo, view);
  try {
    if (photo) return { bytes: await surface.jpeg(0.92), type: "image/jpeg" };
    return surface.png ? { bytes: await surface.png(), type: "image/png" } : null;
  } finally {
    surface.free();
  }
}
