import { useRef, useState } from "react";

import type { Point } from "./engine/client";
import type { Signing } from "./PdfOverlay";
import { Modal } from "../platform/Modal";

/**
 * A signature to put on a PDF: drawn here with a mouse, a finger or a pen,
 * or a picture of one.
 *
 * This is a signature as a mark on the page (what a pen on paper is). It is
 * not a certificate that vouches for the file.
 */

const PAD_W = 460;
const PAD_H = 170;
/** The longest side a picture is taken at. */
const PICTURE_MOST = 900;

/** A picture file as pixels (four bytes each), no larger than it need be. */
async function pixelsOf(file: File): Promise<Signing["picture"] | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PICTURE_MOST / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    return { pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(), w, h };
  } catch {
    return null;
  }
}

/** Strokes as drawn on the pad, as parts of the box they fill. */
export function fitStrokes(strokes: Point[][]): Signing | null {
  const points = strokes.flat();
  if (points.length < 2) return null;
  const x0 = Math.min(...points.map((p) => p[0]));
  const y0 = Math.min(...points.map((p) => p[1]));
  const w = Math.max(1, Math.max(...points.map((p) => p[0])) - x0);
  const h = Math.max(1, Math.max(...points.map((p) => p[1])) - y0);
  return { strokes: strokes.map((stroke) => stroke.map(([x, y]): Point => [(x - x0) / w, (y - y0) / h])), aspect: Math.min(8, Math.max(0.3, w / h)) };
}

export function SignDialog({ onDone, onCancel }: { onDone: (signature: Signing) => void; onCancel: () => void }) {
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [failed, setFailed] = useState(false);
  const drawing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const at = (e: React.PointerEvent<SVGSVGElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - box.left) / (box.width || PAD_W)) * PAD_W, ((e.clientY - box.top) / (box.height || PAD_H)) * PAD_H];
  };
  const ready = fitStrokes(strokes);

  return (
    <Modal className="wf-pdf-sign" onClose={onCancel}>
      <h3>Your signature</h3>
      <p className="wf-confirm-message">Draw it here, then click the page where it goes. It is put on the page like ink. It is not a certificate.</p>
      <svg
        className="wf-pdf-signpad"
        viewBox={`0 0 ${PAD_W} ${PAD_H}`}
        role="img"
        aria-label="Draw your signature here"
        onPointerDown={(e) => {
          drawing.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const p = at(e);
          setStrokes((all) => [...all, [p]]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = at(e);
          setStrokes((all) => [...all.slice(0, -1), [...(all[all.length - 1] ?? []), p]]);
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      >
        {strokes.map((stroke, k) => (
          <path key={k} d={stroke.map((p, n) => `${n ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")} />
        ))}
      </svg>
      {failed && <p className="wf-connect-error">That picture could not be read.</p>}
      <div className="wf-connect-row wf-confirm-actions">
        <button onClick={onCancel}>Cancel</button>
        <button onClick={() => setStrokes([])} disabled={!strokes.length}>
          Clear
        </button>
        <button onClick={() => fileRef.current?.click()}>Use a picture</button>
        <button className="wf-primary" disabled={!ready} onClick={() => ready && onDone(ready)}>
          Use this signature
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void pixelsOf(file).then((picture) => {
              if (picture) onDone({ picture, aspect: picture.w / picture.h });
              else setFailed(true);
            });
          }}
        />
      </div>
    </Modal>
  );
}
