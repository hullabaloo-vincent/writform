/**
 * Drawing a picture for a PDF, where there is a canvas (the page, never the
 * typesetting thread). What is decided about a picture is in pictures.ts.
 * This only reads the file, draws it at the size asked and hands back its
 * pixels or a JPEG of them.
 */

import { CANVAS_PIXELS, orientationMatrix, PHONE_PIXELS, type PictureTools } from "./pictures";

/** The most pixels this device draws at once (a phone has less to spare). */
export function canvasPixels(): number {
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return coarse ? PHONE_PIXELS : CANVAS_PIXELS;
}

export const canvasTools: PictureTools = {
  async draw(bytes, type, w, h, orientation, white) {
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
      // pixels as stored, and the turning is ours.
      const turned = orientation > 4;
      ctx.setTransform(...orientationMatrix(orientation, w, h));
      ctx.drawImage(bitmap, 0, 0, turned ? h : w, turned ? w : h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return {
        pixels: () => ctx.getImageData(0, 0, w, h).data,
        async jpeg(quality, opaque) {
          if (opaque) ctx.putImageData(new ImageData(opaque as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
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
