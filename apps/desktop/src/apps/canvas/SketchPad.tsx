import { Eraser, PenLine, Trash2, Undo2 } from "lucide-react";
import { useRef, useState } from "react";

import { Modal } from "../../platform";

/**
 * Freehand sketches. Strokes are stored as points in the pad's own coordinate
 * space — vector, not a bitmap — which keeps them crisp at any board zoom,
 * small enough to live in the element's `text`, editable after the fact, and
 * free of any server attachment, so sketches work on a board that's offline.
 */
const PAD_W = 900;
const PAD_H = 620;

/** Points closer together than this add nothing a viewer can see. */
const MIN_STEP = 2;

export interface SketchStroke {
  /** Ink color. */
  c: string;
  /** Stroke width, in pad units. */
  s: number;
  /** Flat [x0, y0, x1, y1, …] — half the JSON of an array of objects. */
  p: number[];
}

export interface SketchBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SketchData {
  v: 1;
  /** The drawn region, so an element frames the drawing and not the pad. */
  box: SketchBox;
  strokes: SketchStroke[];
}

const INKS = ["#f2f2f7", "#1c1c22", "#e8934a", "#e0729a", "#6fb0e8", "#79c98d", "#e2c85c"];
const SIZES = [2, 4, 9, 18];

/** Preview dot for a nib button — capped so the widest nib still sits inside
 *  its button with room around it rather than spilling over the edge. */
const nibDot = (width: number) => Math.min(18, width + 3);

/** How close the eraser has to pass to a stroke to take it, in pad units. */
const ERASER_REACH = 10;

/** Strokes are erased whole: the eraser rubs out marks, not pixels, which is
 *  what vector strokes can actually do and what feels predictable. */
function strokeUnderPoint(stroke: SketchStroke, x: number, y: number): boolean {
  const reach = stroke.s / 2 + ERASER_REACH;
  for (let i = 0; i + 1 < stroke.p.length; i += 2) {
    if (Math.hypot(stroke.p[i] - x, stroke.p[i + 1] - y) <= reach) return true;
  }
  return false;
}

export function parseSketch(raw: string): SketchData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SketchData;
    if (!parsed || !Array.isArray(parsed.strokes)) return null;
    return { v: 1, box: parsed.box ?? sketchBounds(parsed.strokes), strokes: parsed.strokes };
  } catch {
    return null;
  }
}

/** Tight box around the ink, including how far the stroke width spills. */
export function sketchBounds(strokes: SketchStroke[]): SketchBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const spill = stroke.s / 2 + 2;
    for (let i = 0; i + 1 < stroke.p.length; i += 2) {
      minX = Math.min(minX, stroke.p[i] - spill);
      maxX = Math.max(maxX, stroke.p[i] + spill);
      minY = Math.min(minY, stroke.p[i + 1] - spill);
      maxY = Math.max(maxY, stroke.p[i + 1] + spill);
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: PAD_W, h: PAD_H };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/** The ink itself, shared by the pad and the board element. */
export function SketchStrokes({ strokes }: { strokes: SketchStroke[] }) {
  return (
    <>
      {strokes.map((stroke, i) => (
        <polyline
          key={i}
          points={stroke.p.join(" ")}
          fill="none"
          stroke={stroke.c}
          strokeWidth={stroke.s}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </>
  );
}

export function SketchPad({
  initial,
  onCancel,
  onDone,
}: {
  /** Existing strokes when editing; null starts a blank pad. */
  initial: SketchData | null;
  onCancel: () => void;
  onDone: (data: SketchData) => void;
}) {
  const [strokes, setStrokes] = useState<SketchStroke[]>(initial?.strokes ?? []);
  const last = initial?.strokes[(initial?.strokes.length ?? 0) - 1];
  const [color, setColor] = useState(last?.c ?? INKS[0]);
  const [size, setSize] = useState(last?.s ?? 4);
  const [live, setLive] = useState<SketchStroke | null>(null);
  const [mode, setMode] = useState<"draw" | "erase">("draw");
  const surfaceRef = useRef<SVGSVGElement>(null);
  const drawing = useRef<{ id: number; points: number[] } | null>(null);
  const erasing = useRef<number | null>(null);

  /**
   * Screen point → pad coordinates through the SVG's own matrix. Scaling by
   * the element's bounding box instead gets this wrong whenever the viewBox
   * is letterboxed inside it (which `preserveAspectRatio` does as soon as the
   * element's proportions differ), and the ink lands beside the pointer
   * rather than under it.
   */
  const toPad = (clientX: number, clientY: number) => {
    const ctm = surfaceRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return {
      x: Math.round(Math.min(PAD_W, Math.max(0, point.x))),
      y: Math.round(Math.min(PAD_H, Math.max(0, point.y))),
    };
  };

  const eraseAt = (x: number, y: number) =>
    setStrokes((all) => {
      const kept = all.filter((stroke) => !strokeUnderPoint(stroke, x, y));
      // Same array when the eraser touched nothing, so dragging it across
      // empty space doesn't re-render on every pointer move.
      return kept.length === all.length ? all : kept;
    });

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    surfaceRef.current?.setPointerCapture(e.pointerId);
    const p = toPad(e.clientX, e.clientY);
    if (mode === "erase") {
      erasing.current = e.pointerId;
      eraseAt(p.x, p.y);
      return;
    }
    drawing.current = { id: e.pointerId, points: [p.x, p.y] };
    setLive({ c: color, s: size, p: [p.x, p.y] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (erasing.current === e.pointerId) {
      const p = toPad(e.clientX, e.clientY);
      eraseAt(p.x, p.y);
      return;
    }
    const stroke = drawing.current;
    if (!stroke || stroke.id !== e.pointerId) return;
    const p = toPad(e.clientX, e.clientY);
    const lastX = stroke.points[stroke.points.length - 2];
    const lastY = stroke.points[stroke.points.length - 1];
    if (Math.hypot(p.x - lastX, p.y - lastY) < MIN_STEP) return;
    stroke.points.push(p.x, p.y);
    setLive({ c: color, s: size, p: [...stroke.points] });
  };

  const onUp = (e: React.PointerEvent) => {
    if (erasing.current === e.pointerId) {
      erasing.current = null;
      return;
    }
    const stroke = drawing.current;
    if (!stroke || stroke.id !== e.pointerId) return;
    drawing.current = null;
    setLive(null);
    // A tap is a dot: repeat the point so the round cap has something to draw.
    const points = stroke.points.length === 2 ? [...stroke.points, ...stroke.points] : stroke.points;
    setStrokes((all) => [...all, { c: color, s: size, p: points }]);
  };

  const done = () => {
    const kept = strokes.filter((stroke) => stroke.p.length >= 4);
    onDone({ v: 1, box: sketchBounds(kept), strokes: kept });
  };

  return (
    <Modal onClose={onCancel} className="wf-sketch-modal">
      <header className="wf-doc-panel-header">
        <h3>{initial ? "Edit sketch" : "Add sketch"}</h3>
        <span className="wf-statusbar-spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button className="wf-primary" disabled={strokes.length === 0} onClick={done}>
          {initial ? "Save sketch" : "Insert sketch"}
        </button>
      </header>

      <div className="wf-sketch-tools">
        <button
          className={`wf-icon ${mode === "draw" ? "active" : ""}`}
          title="Draw"
          onClick={() => setMode("draw")}
        >
          <PenLine size={15} />
        </button>
        <button
          className={`wf-icon ${mode === "erase" ? "active" : ""}`}
          title="Erase strokes"
          onClick={() => setMode("erase")}
        >
          <Eraser size={15} />
        </button>
        <span className="wf-toolbar-sep" />
        {INKS.map((ink) => (
          <button
            key={ink}
            title="Ink color"
            className={`wf-sketch-ink ${color === ink ? "active" : ""}`}
            style={{ background: ink }}
            onClick={() => setColor(ink)}
          />
        ))}
        <span className="wf-toolbar-sep" />
        {SIZES.map((width) => (
          <button
            key={width}
            title={`${width}px nib`}
            className={`wf-sketch-nib ${size === width ? "active" : ""}`}
            onClick={() => setSize(width)}
          >
            <span style={{ width: nibDot(width), height: nibDot(width), background: color }} />
          </button>
        ))}
        <span className="wf-statusbar-spacer" />
        <button
          title="Undo last stroke"
          disabled={strokes.length === 0}
          onClick={() => setStrokes((all) => all.slice(0, -1))}
        >
          <Undo2 size={15} />
        </button>
        <button
          title="Clear the whole sketch"
          disabled={strokes.length === 0}
          onClick={() => setStrokes([])}
        >
          <Trash2 size={15} />
        </button>
      </div>

      <svg
        ref={surfaceRef}
        className={`wf-sketch-surface ${mode === "erase" ? "erasing" : ""}`}
        viewBox={`0 0 ${PAD_W} ${PAD_H}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <SketchStrokes strokes={strokes} />
        {live && <SketchStrokes strokes={[live]} />}
      </svg>

      {strokes.length === 0 && !live && (
        <p className="wf-sketch-hint">
          Draw with a mouse, trackpad, finger or stylus. Strokes stay editable — reopen this
          sketch any time to add to it.
        </p>
      )}
    </Modal>
  );
}
