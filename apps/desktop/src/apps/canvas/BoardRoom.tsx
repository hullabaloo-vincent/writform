import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  Circle,
  Diamond,
  ExternalLink,
  Frame as FrameIcon,
  HardDrive,
  ChevronDown,
  Crop,
  Shapes,
  Square,
  Triangle,
  FlipHorizontal,
  FlipVertical,
  Maximize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Grid3x3,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpToLine,
  Plus,
  Ban,
  ClipboardPaste,
  Copy,
  CopyPlus,
  CornerDownRight,
  Heart,
  Lock,
  Scissors,
  Squircle,
  Unlock,
  ImagePlus,
  Pencil,
  Search,
  Star,
  Palette,
  Pipette,
  Map as MapIcon,
  Minus,
  Italic,
  PaintBucket,
  Link2,
  List,
  MousePointer2,
  Spline,
  StickyNote,
  Trash2,
  Type,
  Underline,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { CanvasElement } from "../../bindings/proto/CanvasElement";
import type { LinkPreview } from "../../bindings/proto/LinkPreview";
import { isCmdError } from "../../lib/backend";
import { uploadBlob } from "../../lib/upload";
import { confirmDialog } from "../../platform";
import { useSession } from "../../stores/session";
import { useChat } from "../chat/store";
import { CanvasDocCard } from "../documents/CanvasDocCard";
import { canvasApi } from "./api";
import { BoardFind } from "./BoardFind";
import { imageSrc, isLocalBoard, saveLocalImage } from "./local";
import {
  parseSketch,
  SketchPad,
  SketchStrokes,
  type SketchData,
} from "./SketchPad";
import { useCanvas } from "./store";

/** One preview fetch per URL per session; cards share the promise. */
const previewCache = new Map<string, Promise<LinkPreview>>();
function fetchPreview(url: string): Promise<LinkPreview> {
  let p = previewCache.get(url);
  if (!p) {
    p = canvasApi.linkPreview(url);
    // Don't cache a failure: a link pasted with no server should still get its
    // preview once there is one.
    void p.catch(() => previewCache.delete(url));
    previewCache.set(url, p);
  }
  return p;
}

/** Link card: server-fetched title/description/thumbnail, opens externally. */
function LinkCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  useEffect(() => {
    let live = true;
    fetchPreview(url)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  let domain = url;
  try {
    domain = new URL(url).host;
  } catch {
    // keep raw url
  }
  return (
    <div className="wf-el-link-card">
      {preview?.image_url && (
        <img className="wf-el-link-thumb" src={preview.image_url} alt="" draggable={false} />
      )}
      <div className="wf-el-link-body">
        <span className="wf-el-link-title">
          <Link2 size={13} /> {preview?.title ?? domain}
        </span>
        {preview?.description && (
          <span className="wf-el-link-desc">{preview.description}</span>
        )}
        <span className="wf-el-link-domain">{domain}</span>
      </div>
      <a
        className="wf-el-link-open"
        href={url}
        target="_blank"
        rel="noreferrer"
        title="Open link"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ExternalLink size={14} />
      </a>
    </div>
  );
}

/** Note fills are kept as bare channels so each note can choose its own
 *  alpha. They start translucent so overlapping notes read as stacked layers
 *  rather than one hiding the other, at a level that keeps the note's dark
 *  text legible over a dark board or a background image. */
const STICKY_RGB: Record<string, string> = {
  yellow: "232, 212, 120",
  pink: "232, 154, 176",
  blue: "138, 182, 232",
  green: "147, 211, 162",
  purple: "183, 163, 234",
};

const NOTE_ALPHA = 0.75;

const stickyColor = (key: string, alpha = NOTE_ALPHA) =>
  `rgba(${STICKY_RGB[key] ?? STICKY_RGB.yellow}, ${alpha})`;

/** The palette as swatches, at the default alpha. */
const STICKY_COLORS: Record<string, string> = Object.fromEntries(
  Object.keys(STICKY_RGB).map((key) => [key, stickyColor(key)]),
);

/** Soft translucent frame fills (Freeform-style); "" = plain frame. */
const FRAME_COLORS: Record<string, { bg: string; border: string }> = {
  orange: { bg: "rgba(232, 147, 60, 0.28)", border: "rgba(232, 147, 60, 0.75)" },
  purple: { bg: "rgba(150, 117, 190, 0.28)", border: "rgba(150, 117, 190, 0.75)" },
  green: { bg: "rgba(139, 190, 120, 0.28)", border: "rgba(139, 190, 120, 0.75)" },
  yellow: { bg: "rgba(226, 200, 92, 0.28)", border: "rgba(226, 200, 92, 0.75)" },
  pink: { bg: "rgba(224, 140, 178, 0.28)", border: "rgba(224, 140, 178, 0.75)" },
  blue: { bg: "rgba(112, 158, 214, 0.28)", border: "rgba(112, 158, 214, 0.75)" },
};

/** Per-element text styling, stored as JSON in the `style` column. */
interface TextStyle {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  list?: "bullet";
  /** Typeface; undefined = the app's default sans. */
  font?: "serif" | "mono" | "hand";
  /** Text color from the fixed palette; undefined = inherit. */
  textColor?: string;
  /** Image transforms — stored here so they need no schema change. */
  rotate?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** How the image fills its box: contain (default) or cover (crop). */
  fit?: "contain" | "cover";
  /** Per-side crop, as fractions of the source image hidden (0–0.95). */
  crop?: { t: number; r: number; b: number; l: number };
  /** Which outline a `shape` element draws. */
  shape?: "rect" | "ellipse" | "diamond" | "triangle" | "star" | "heart";
  /** Shape elements: fill the outline with the color's translucent tint. */
  filled?: boolean;
  /** Corner radius in px; undefined = whatever the kind's stylesheet says. */
  radius?: number;
  /** Locked: still selectable and stylable, but it won't move or resize. */
  locked?: boolean;
  /** Note fill opacity, 0–1; undefined means the palette's own level. */
  opacity?: number;
}


type ShapeKind = NonNullable<TextStyle["shape"]>;

const SHAPE_OPTIONS: { kind: ShapeKind; title: string; icon: typeof Square }[] = [
  { kind: "rect", title: "Rectangle", icon: Square },
  { kind: "ellipse", title: "Ellipse", icon: Circle },
  { kind: "diamond", title: "Diamond", icon: Diamond },
  { kind: "triangle", title: "Triangle", icon: Triangle },
  { kind: "star", title: "Star", icon: Star },
  { kind: "heart", title: "Heart", icon: Heart },
];

/** Five-pointed star inscribed in the box, so it stretches with the shape. */
function starPoints(w: number, h: number, m: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - m;
  const ry = h / 2 - m;
  return Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const reach = i % 2 === 0 ? 1 : 0.4; // alternate outer point / inner notch
    return `${(cx + Math.cos(angle) * rx * reach).toFixed(2)},${(cy + Math.sin(angle) * ry * reach).toFixed(2)}`;
  }).join(" ");
}

/** Heart drawn in a 0–1 box and mapped onto the element's, stroke inset. */
function heartPath(w: number, h: number, m: number): string {
  const px = (v: number) => (m + v * (w - 2 * m)).toFixed(2);
  const py = (v: number) => (m + v * (h - 2 * m)).toFixed(2);
  const curve = (a: number[], b: number[], end: number[]) =>
    `C ${px(a[0])},${py(a[1])} ${px(b[0])},${py(b[1])} ${px(end[0])},${py(end[1])}`;
  return [
    `M ${px(0.5)},${py(0.95)}`,
    curve([0.15, 0.72], [0.02, 0.48], [0.02, 0.32]),
    curve([0.02, 0.14], [0.18, 0.05], [0.32, 0.05]),
    curve([0.41, 0.05], [0.47, 0.12], [0.5, 0.19]),
    curve([0.53, 0.12], [0.59, 0.05], [0.68, 0.05]),
    curve([0.82, 0.05], [0.98, 0.14], [0.98, 0.32]),
    curve([0.98, 0.48], [0.85, 0.72], [0.5, 0.95]),
    "Z",
  ].join(" ");
}

const FONT_STACKS: Record<NonNullable<TextStyle["font"]>, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  hand: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive",
};
/** Popover entries: value, display name, rendered in its own typeface. */
const FONT_OPTIONS: { value: TextStyle["font"]; label: string }[] = [
  { value: undefined, label: "Simple" },
  { value: "serif", label: "Bookish" },
  { value: "mono", label: "Technical" },
  { value: "hand", label: "Scribbled" },
];

/** Text color swatches; undefined (default) inherits the element's color. */
const TEXT_COLORS: { css: string; name: string }[] = [
  { css: "#eceaf2", name: "Light" },
  { css: "#1d1c22", name: "Ink" },
  { css: "#e05b5b", name: "Red" },
  { css: "#e0a04c", name: "Orange" },
  { css: "#7fbf7a", name: "Green" },
  { css: "#709ed6", name: "Blue" },
  { css: "#b7a3ea", name: "Purple" },
];

function textStyle(raw: string): TextStyle {
  try {
    const parsed = JSON.parse(raw) as TextStyle | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** CSS transform for an image element's stored rotate/flip. */
function imageTransform(st: TextStyle): string | undefined {
  const parts: string[] = [];
  if (st.rotate) parts.push(`rotate(${st.rotate}deg)`);
  if (st.flipX) parts.push("scaleX(-1)");
  if (st.flipY) parts.push("scaleY(-1)");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The image body of an image element. A cropped image renders oversized and
 * offset inside an overflow-hidden wrapper — the box shows a window into the
 * source. The wrapper (not the element div) clips, so the selection handles
 * hanging outside the box stay visible.
 */
function CanvasImage({ el }: { el: CanvasElement }) {
  const st = textStyle(el.style);
  const c = st.crop;
  if (!c) {
    return (
      <div className="wf-el-imgwrap">
        <img
          className="wf-el-img"
          src={imageSrc(el)}
          alt=""
          draggable={false}
          style={{ transform: imageTransform(st), objectFit: st.fit ?? "contain" }}
        />
      </div>
    );
  }
  const w = el.w / Math.max(0.05, 1 - c.l - c.r);
  const h = el.h / Math.max(0.05, 1 - c.t - c.b);
  return (
    <div className="wf-el-imgwrap">
      <img
        className="wf-el-img"
        src={imageSrc(el)}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          left: -w * c.l,
          top: -h * c.t,
          width: w,
          height: h,
          maxWidth: "none",
          objectFit: "fill",
          transform: imageTransform(st),
        }}
      />
    </div>
  );
}

const FONT_SIZES = [12, 14, 16, 20, 24, 32, 40, 48];
const ALIGN_CYCLE: NonNullable<TextStyle["align"]>[] = ["left", "center", "right"];

/**
 * Stacking bands. DOM order is stable (by id) so focus is never lost when
 * someone else's `z` changes; layering comes from these instead. The gaps are
 * far larger than `MAX_ELEMENTS_PER_BOARD`, so per-element `z` can never
 * bleed from one band into the next.
 */
const Z_BAND_FRAME = 0;
const Z_BAND_CONNECTOR = 100_000;
const Z_BAND_BODY = 200_000;
// Peers' pointers sit above every element band so they're never hidden behind
// a note or frame — same stacking context, so a plain CSS z-index would lose
// to the inline band numbers above.
const Z_BAND_CURSOR = 900_000;

/** Grid step for snap-to-grid (world units). */
const GRID = 8;

/** Floors for the resize handle, so an element can't be dragged to nothing. */
const MIN_W = 60;
const MIN_H = 36;

type Tool = "select" | "sticky" | "text" | "frame" | "shape" | "connect";

/**
 * A sketch's strokes, scaled into whatever box the element occupies. The
 * class is `wf-el-sketch-svg`, never `wf-el-sketch` — that name belongs to
 * the element div (`wf-el-${kind}`), and sharing it would put this layer's
 * pointer-events: none on the whole element and make it undraggable.
 */
function SketchBody({ el }: { el: CanvasElement }) {
  const data = parseSketch(el.text);
  if (!data || data.strokes.length === 0) return null;
  const { x, y, w, h } = data.box;
  return (
    <svg
      className="wf-el-sketch-svg"
      viewBox={`${x} ${y} ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      <SketchStrokes strokes={data.strokes} />
    </svg>
  );
}

/** SVG outline of a shape element, stretching with its box. */
function ShapeBody({ el }: { el: CanvasElement }) {
  const st = textStyle(el.style);
  const shape = st.shape ?? "rect";
  // Stroke/fill go through inline STYLE, not SVG attributes: presentation
  // attributes can't resolve var(), which silently becomes stroke:none — an
  // invisible shape. Style inherits to the child node.
  const stroke = FRAME_COLORS[el.color]?.border ?? "var(--wf-shape-stroke)";
  const fill = st.filled ? (FRAME_COLORS[el.color]?.bg ?? "var(--wf-shape-fill)") : "transparent";
  const { w, h } = el;
  const m = 1.5; // stroke inset so the 2px line isn't clipped by the box
  // NOT class "wf-el-shape": the element DIV already carries that name (it
  // is `wf-el-${kind}`), and sharing it put pointer-events:none on the whole
  // element — an unclickable, undraggable shape.
  return (
    <svg
      className="wf-el-shape-svg"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ stroke, fill }}
      aria-hidden
    >
      {shape === "ellipse" ? (
        <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - m} ry={h / 2 - m} />
      ) : shape === "diamond" ? (
        <polygon points={`${w / 2},${m} ${w - m},${h / 2} ${w / 2},${h - m} ${m},${h / 2}`} />
      ) : shape === "triangle" ? (
        <polygon points={`${w / 2},${m} ${w - m},${h - m} ${m},${h - m}`} />
      ) : shape === "star" ? (
        <polygon points={starPoints(w, h, m)} />
      ) : shape === "heart" ? (
        <path d={heartPath(w, h, m)} />
      ) : (
        <rect x={m} y={m} width={w - 2 * m} height={h - 2 * m} rx={10} />
      )}
    </svg>
  );
}

/** Connector styling, stored as JSON in the connector element's `text`. */
type ConnAnchor = "auto" | "top" | "bottom" | "left" | "right";
type ConnCap = "none" | "arrow" | "dot";
type ConnRoute = "straight" | "elbow" | "curve";
interface ConnStyle {
  from_anchor: ConnAnchor;
  to_anchor: ConnAnchor;
  dash: boolean;
  start_cap: ConnCap;
  end_cap: ConnCap;
  /** How the line gets there: direct, right-angled, or a smooth curve. */
  route: ConnRoute;
  width: number;
  /** Key into FRAME_COLORS; "" keeps the board's default line color. */
  color: string;
  /** Words on the line, drawn at its midpoint. */
  label: string;
}

const CONN_DEFAULTS: ConnStyle = {
  from_anchor: "auto",
  to_anchor: "auto",
  dash: false,
  start_cap: "none",
  end_cap: "none",
  route: "straight",
  width: 2,
  color: "",
  label: "",
};

const CONN_ROUTES: { id: ConnRoute; title: string; icon: typeof Spline }[] = [
  { id: "straight", title: "Straight line", icon: Minus },
  { id: "elbow", title: "Right angles", icon: CornerDownRight },
  { id: "curve", title: "Curved", icon: Spline },
];

const CONN_WIDTHS = [1.5, 3, 5];

type Side = "top" | "right" | "bottom" | "left";
const SIDES: Side[] = ["top", "right", "bottom", "left"];

/** Which edge an endpoint sits on — the direction its line should leave in. */
function sideOf(el: CanvasElement, at: { x: number; y: number }, anchor: ConnAnchor): Side {
  if (anchor !== "auto") return anchor;
  const dx = (at.x - (el.x + el.w / 2)) / Math.max(1, el.w / 2);
  const dy = (at.y - (el.y + el.h / 2)) / Math.max(1, el.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

const stub = (p: { x: number; y: number }, side: Side, by: number) => ({
  x: p.x + (side === "left" ? -by : side === "right" ? by : 0),
  y: p.y + (side === "top" ? -by : side === "bottom" ? by : 0),
});

/** Orthogonal route: leave each end along its own side, then turn. */
function elbowPoints(
  p1: { x: number; y: number },
  s1: Side,
  p2: { x: number; y: number },
  s2: Side,
): { x: number; y: number }[] {
  const gap = 24;
  const a = stub(p1, s1, gap);
  const b = stub(p2, s2, gap);
  const h1 = s1 === "left" || s1 === "right";
  const h2 = s2 === "left" || s2 === "right";
  const middle: { x: number; y: number }[] = h1
    ? h2
      ? [
          { x: (a.x + b.x) / 2, y: a.y },
          { x: (a.x + b.x) / 2, y: b.y },
        ]
      : [{ x: b.x, y: a.y }]
    : h2
      ? [{ x: a.x, y: b.y }]
      : [
          { x: a.x, y: (a.y + b.y) / 2 },
          { x: b.x, y: (a.y + b.y) / 2 },
        ];
  const points = [p1, a, ...middle, b, p2];
  // Drop repeats so the corner rounding never divides by a zero-length leg.
  return points.filter(
    (p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5,
  );
}

/** Polyline with rounded corners, the way a drawn elbow looks. */
function roundedPath(points: { x: number; y: number }[], radius = 12): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const before = {
      x: here.x + ((prev.x - here.x) / inLen) * r,
      y: here.y + ((prev.y - here.y) / inLen) * r,
    };
    const after = {
      x: here.x + ((next.x - here.x) / outLen) * r,
      y: here.y + ((next.y - here.y) / outLen) * r,
    };
    d += ` L ${before.x},${before.y} Q ${here.x},${here.y} ${after.x},${after.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x},${last.y}`;
}

interface ConnGeometry {
  d: string;
  startAngle: number;
  endAngle: number;
  labelAt: { x: number; y: number };
}

/** The drawn shape of a connector, plus where its caps point and its label
 *  sits — all three depend on the route, so they're worked out together. */
function connectorGeometry(
  p1: { x: number; y: number },
  s1: Side,
  p2: { x: number; y: number },
  s2: Side,
  route: ConnRoute,
): ConnGeometry {
  const angle = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

  if (route === "elbow") {
    const points = elbowPoints(p1, s1, p2, s2);
    // Midpoint by distance along the polyline, so the label sits on the line
    // rather than at the average of its ends.
    const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
    const total = lengths.reduce((sum, l) => sum + l, 0);
    let walked = 0;
    let labelAt = points[0];
    for (let i = 0; i < lengths.length; i += 1) {
      if (walked + lengths[i] >= total / 2) {
        const t = lengths[i] === 0 ? 0 : (total / 2 - walked) / lengths[i];
        labelAt = {
          x: points[i].x + (points[i + 1].x - points[i].x) * t,
          y: points[i].y + (points[i + 1].y - points[i].y) * t,
        };
        break;
      }
      walked += lengths[i];
    }
    return {
      d: roundedPath(points),
      startAngle: angle(points[0], points[1]),
      endAngle: angle(points[points.length - 2], points[points.length - 1]),
      labelAt,
    };
  }

  if (route === "curve") {
    const reach = Math.max(48, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2);
    const c1 = stub(p1, s1, reach);
    const c2 = stub(p2, s2, reach);
    return {
      d: `M ${p1.x},${p1.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`,
      startAngle: angle(p1, c1),
      endAngle: angle(c2, p2),
      // The cubic's own midpoint, not the chord's.
      labelAt: {
        x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
        y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
      },
    };
  }

  return {
    d: `M ${p1.x},${p1.y} L ${p2.x},${p2.y}`,
    startAngle: angle(p1, p2),
    endAngle: angle(p1, p2),
    labelAt: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
  };
}

function connStyle(text: string): ConnStyle {
  try {
    const parsed = JSON.parse(text) as Partial<ConnStyle>;
    return { ...CONN_DEFAULTS, ...parsed };
  } catch {
    return { ...CONN_DEFAULTS };
  }
}

/** Endpoint of a connector on an element for the chosen anchor side. */
function anchorPoint(el: CanvasElement, a: ConnAnchor): { x: number; y: number } {
  switch (a) {
    case "top":
      return { x: el.x + el.w / 2, y: el.y };
    case "bottom":
      return { x: el.x + el.w / 2, y: el.y + el.h };
    case "left":
      return { x: el.x, y: el.y + el.h / 2 };
    case "right":
      return { x: el.x + el.w, y: el.y + el.h / 2 };
    default:
      return { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  }
}

/** Where the segment from `el`'s center toward `toward` exits `el`'s rect —
 *  used for "auto" anchors so end decorations aren't hidden under elements. */
function clipToRect(el: CanvasElement, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const tx = dx !== 0 ? el.w / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? el.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Cap shapes drawn as ordinary siblings of the connector line. SVG
 *  <marker> refs are deliberately avoided: WKWebView doesn't repaint a
 *  marker-start/end changed in place on an already-painted line, so caps
 *  set during a live session stayed invisible until the board remounted. */
function ConnectorCap({
  kind,
  at,
  angleDeg,
  color,
}: {
  kind: ConnCap;
  at: { x: number; y: number };
  angleDeg: number;
  /** Matches the line; undefined leaves the stylesheet's color in charge. */
  color?: string;
}) {
  if (kind === "arrow") {
    return (
      <path
        className="wf-cap"
        d="M0,0 L-14,7 L-14,-7 Z"
        style={color ? { fill: color } : undefined}
        transform={`translate(${at.x}, ${at.y}) rotate(${angleDeg})`}
      />
    );
  }
  if (kind === "dot") {
    return (
      <circle className="wf-cap" cx={at.x} cy={at.y} r={5} style={color ? { fill: color } : undefined} />
    );
  }
  return null;
}

const CAP_CYCLE: ConnCap[] = ["none", "arrow", "dot"];

interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

interface CanvasHistoryAction {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** Marks a clipboard payload as ours, so pasting elsewhere is still plain text
 *  and pasting here is a real copy rather than a sticky full of JSON. */
const CLIP_PREFIX = "writform/canvas-v1:";

/** What the right-click menu's Paste uses. The clipboard proper can only be
 *  read inside a paste event, and a menu click isn't one. */
let lastCopy: CanvasElement[] = [];

interface BoardMenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a tick, for the settings-style entries. */
  checked?: boolean;
  onClick: () => void;
}

/** `null` entries render as separators. */
interface BoardMenuState {
  x: number;
  y: number;
  items: (BoardMenuItem | null)[];
}

type BgFit = "cover" | "contain" | "stretch" | "tile" | "center";

/** The board's own `style` column: a color, an image, and how it's laid in.
 *  `image` is an attachment id on a group board, or a `local:` reference to a
 *  picture stored on this device. */
interface BoardBackground {
  color?: string;
  image?: number | string;
  fit?: BgFit;
  /** false hides the dot grid; undefined leaves it on. */
  grid?: boolean;
}

const BG_FITS: { id: BgFit; label: string }[] = [
  { id: "cover", label: "Fill" },
  { id: "contain", label: "Fit" },
  { id: "stretch", label: "Stretch" },
  { id: "tile", label: "Tile" },
  { id: "center", label: "Center" },
];

const BG_COLORS: { label: string; value?: string }[] = [
  { label: "Default" },
  { label: "Ink", value: "#12131a" },
  { label: "Slate", value: "#1d1f27" },
  { label: "Moss", value: "#1b2620" },
  { label: "Plum", value: "#231b2a" },
  { label: "Paper", value: "#f6f3ea" },
  { label: "Sand", value: "#e8dcc6" },
  { label: "Sky", value: "#dbe6f2" },
];

/** A board's pages. Elements store the page's ID, never its position, so
 *  deleting one doesn't silently move everything on the pages after it. */
interface BoardPage {
  id: number;
  name: string;
  /** Each page dresses itself; unset falls back to the board-wide value a
   *  board may already carry from before backgrounds were per page. */
  bg?: BoardBackground;
}

/** Everything the board's single `style` column holds. */
interface BoardStyle extends BoardBackground {
  pages?: BoardPage[];
}

function parseBoardStyle(raw: string): BoardStyle {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as BoardStyle;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The background of one page: its own, or the board-wide one it inherits. */
function pageBackground(raw: string, pageId: number): BoardBackground {
  const style = parseBoardStyle(raw);
  const own = style.pages?.find((p) => p.id === pageId)?.bg;
  if (own) return own;
  const { color, image, fit, grid } = style;
  return { color, image, fit, grid };
}

/** Every board has at least one page, whether or not it says so. */
function boardPages(raw: string): BoardPage[] {
  const pages = parseBoardStyle(raw).pages;
  return pages && pages.length > 0 ? pages : [{ id: 0, name: "Page 1" }];
}

/** Only the color is set when there's no image, so the dot grid survives. */
function backgroundStyle(bg: BoardBackground): CSSProperties {
  const style: CSSProperties = {};
  if (bg.color) style.backgroundColor = bg.color;
  // The dots ARE the stylesheet's background-image, so hiding them and
  // setting a picture are the same switch.
  if (bg.grid === false && bg.image === undefined) style.backgroundImage = "none";
  if (bg.image !== undefined) {
    const fit = bg.fit ?? "cover";
    style.backgroundImage = `url("${imageSrc({ text: String(bg.image) })}")`;
    style.backgroundSize =
      fit === "stretch" ? "100% 100%" : fit === "cover" || fit === "contain" ? fit : "auto";
    style.backgroundRepeat = fit === "tile" ? "repeat" : "no-repeat";
    style.backgroundPosition = "center";
  }
  return style;
}

/** Keyboard and clipboard shortcuts belong to whatever is being typed in. */
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  const tag = (el?.tagName ?? "").toLowerCase();
  return tag === "textarea" || tag === "input" || el?.isContentEditable === true;
}

function createRequest(el: CanvasElement, from_id = el.from_id, to_id = el.to_id) {
  return {
    kind: el.kind, x: el.x, y: el.y, w: el.w, h: el.h, text: el.text,
    page: el.page ?? 0, color: el.color, style: el.style, from_id, to_id,
  };
}

/** Move the local copy of an element without touching updated_at, so the
 *  server echo (same values, newer stamp) still applies cleanly. */
function patchLocal(id: number, patch: Partial<CanvasElement>) {
  useCanvas.setState((s) => {
    const el = s.elements[id];
    if (!el) return s;
    return { elements: { ...s.elements, [id]: { ...el, ...patch } } };
  });
}

const isLocked = (el: CanvasElement): boolean => textStyle(el.style).locked === true;

/** Mirrors the per-kind corner radius in styles.css, so the radius handle
 *  starts where the element already looks rounded. Keep the two in step. */
const defaultRadius = (el: CanvasElement): number =>
  el.kind === "sticky" ? 16 : el.kind === "frame" ? 20 : 8;

/** Kinds with a box to round. Shapes draw their own outline in SVG. */
const canRound = (el: CanvasElement): boolean =>
  !["connector", "shape"].includes(el.kind);


function minZ(elements: Record<number, CanvasElement>): number {
  let z = 0;
  for (const el of Object.values(elements)) if (el.z < z) z = el.z;
  return z;
}

function maxZ(elements: Record<number, CanvasElement>): number {
  let z = 0;
  for (const el of Object.values(elements)) if (el.z > z) z = el.z;
  return z;
}

export function BoardRoom() {
  const board = useCanvas((s) => s.board);
  const elements = useCanvas((s) => s.elements);
  const closeBoard = useCanvas((s) => s.closeBoard);
  const hold = useCanvas((s) => s.hold);
  const cursors = useCanvas((s) => s.cursors);
  const me = useSession((s) => s.session?.user);
  const groups = useChat((s) => s.groups);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ tx: 60, ty: 40, scale: 1 });
  const [tool, setTool] = useState<Tool>("select");
  /** Which outline the shape tool places; picked from the toolbar popover. */
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [finding, setFinding] = useState(false);
  /** null = closed; `{ el: null }` = drawing a new one; `{ el }` = editing. */
  const [sketching, setSketching] = useState<{ el: CanvasElement | null } | null>(null);
  const [menu, setMenu] = useState<BoardMenuState | null>(null);
  const [activePage, setActivePage] = useState(0);
  const [renamingPage, setRenamingPage] = useState<number | null>(null);
  const [shapeMenu, setShapeMenu] = useState(false);
  useEffect(() => {
    if (!shapeMenu) return;
    // The toolbar swallows pointerdown, so only outside presses reach here.
    const close = () => setShapeMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [shapeMenu]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState(() => localStorage.getItem("wf-canvas-snap") !== "off");
  const undoStack = useRef<CanvasHistoryAction[]>([]);
  const redoStack = useRef<CanvasHistoryAction[]>([]);
  const liveIds = useRef(new Map<number, number>());
  const historyBusy = useRef(false);
  const [, refreshHistory] = useState(0);

  const viewRef = useRef(view);
  viewRef.current = view;
  // Must live above the `!board` early return: hooks cannot be conditional.
  const lastCursorSent = useRef(0);
  /** Text an edit began with — autosave rewrites `el.text` mid-edit, so this
   *  is what "did anything actually change?" and undo must compare against. */
  const editingOriginal = useRef("");

  // The wheel gesture zooms the board, but React registers `onWheel`
  // passively, so the event also bubbles to `.wf-main` (overflow: auto) and
  // scrolls the app shell — which flashes a scrollbar over the canvas while
  // you work. Claiming it on a non-passive native listener stops that.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const swallow = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", swallow, { passive: false });
    return () => el.removeEventListener("wheel", swallow);
  }, [board?.id]);

  // Touch: two fingers on the canvas pinch-zoom (and pan) the viewport.
  // Tracking lives on window-level CAPTURE listeners: capture runs before
  // React's delegated handlers, so the second finger can flip the touch
  // count and be ignored by the gesture starters below before it would
  // start a competing pan/drag — and window-level, because fingers wander
  // outside the surface mid-gesture.
  const touchPts = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; scale: number; wx: number; wy: number } | null>(null);
  /** The active pan/marquee/drag/resize registers an abort hook here so a
   *  starting pinch can cancel it instead of fighting it over the view. */
  const gestureCancels = useRef(new Set<() => void>());

  useEffect(() => {
    const beginPinch = () => {
      for (const cancel of [...gestureCancels.current]) cancel();
      gestureCancels.current.clear();
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect || touchPts.current.size !== 2) return;
      const [a, b] = [...touchPts.current.values()];
      const v = viewRef.current;
      pinchRef.current = {
        // Floor the baseline: fingers landing almost together would
        // otherwise turn a tiny spread into an enormous scale factor.
        dist: Math.max(24, Math.hypot(b.x - a.x, b.y - a.y)),
        scale: v.scale,
        wx: ((a.x + b.x) / 2 - rect.left - v.tx) / v.scale,
        wy: ((a.y + b.y) / 2 - rect.top - v.ty) / v.scale,
      };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const surface = surfaceRef.current;
      const target = e.target as Element | null;
      if (!surface || !target || !surface.contains(target)) return;
      // Toolbars and the minimap sit inside the surface but are controls,
      // not canvas — fingers there must not count toward a pinch.
      if (
        target.closest(
          ".wf-board-toolbar, .wf-selection-toolbar-wrap, .wf-minimap, .wf-minimap-toggle, .wf-board-viewbar",
        )
      )
        return;
      touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPts.current.size === 2) beginPinch();
      else if (touchPts.current.size > 2) pinchRef.current = null;
    };
    const move = (e: PointerEvent) => {
      const pt = touchPts.current.get(e.pointerId);
      if (!pt) return;
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pinchRef.current;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!p || !rect || touchPts.current.size !== 2) return;
      const [a, b] = [...touchPts.current.values()];
      const scale = Math.min(
        2.5,
        Math.max(0.2, (p.scale * Math.hypot(b.x - a.x, b.y - a.y)) / p.dist),
      );
      const cx = (a.x + b.x) / 2 - rect.left;
      const cy = (a.y + b.y) / 2 - rect.top;
      // Keep the world point that started under the fingers' midpoint under
      // it as it moves — pinch and two-finger pan in one formula.
      setView({ scale, tx: cx - p.wx * scale, ty: cy - p.wy * scale });
    };
    const up = (e: PointerEvent) => {
      if (!touchPts.current.delete(e.pointerId)) return;
      if (touchPts.current.size === 2) beginPinch();
      else if (touchPts.current.size < 2) pinchRef.current = null;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    const pts = touchPts.current;
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      pts.clear();
      pinchRef.current = null;
    };
  }, [board?.id]);

  // Peers do not announce leaving, so drop pointers that have gone quiet.
  useEffect(() => {
    const timer = setInterval(() => useCanvas.getState().pruneCursors(), 2000);
    return () => clearInterval(timer);
  }, []);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  /** Quantize a world coordinate to the grid when snapping is on. */
  const snapv = (v: number) => (snapRef.current ? Math.round(v / GRID) * GRID : v);

  /** World point at the middle of the visible board — where new things land. */
  const centerOfView = () => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: (rect.width / 2 - v.tx) / v.scale, y: (rect.height / 2 - v.ty) / v.scale };
  };

  const fail = (e: unknown) => setError(isCmdError(e) ? e.message : String(e));

  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    liveIds.current.clear();
    setActivePage(0);
    refreshHistory((n) => n + 1);
  }, [board?.id]);

  const resolveId = (logicalId: number) => liveIds.current.get(logicalId) ?? logicalId;
  const pushHistory = (action: CanvasHistoryAction) => {
    if (historyBusy.current) return;
    undoStack.current = [...undoStack.current.slice(-14), action];
    redoStack.current = [];
    refreshHistory((n) => n + 1);
  };
  const undo = async () => {
    if (historyBusy.current) return;
    const action = undoStack.current.pop();
    if (!action) return;
    historyBusy.current = true;
    refreshHistory((n) => n + 1);
    try {
      await action.undo();
      redoStack.current.push(action);
    } catch (e) {
      undoStack.current.push(action);
      fail(e);
    } finally {
      historyBusy.current = false;
      refreshHistory((n) => n + 1);
    }
  };
  const redo = async () => {
    if (historyBusy.current) return;
    const action = redoStack.current.pop();
    if (!action) return;
    historyBusy.current = true;
    refreshHistory((n) => n + 1);
    try {
      await action.redo();
      undoStack.current.push(action);
    } catch (e) {
      redoStack.current.push(action);
      fail(e);
    } finally {
      historyBusy.current = false;
      refreshHistory((n) => n + 1);
    }
  };
  /**
   * Optimistic edit + authoritative confirm.
   *
   * `patchLocal` deliberately leaves `updated_at` alone so the element's own
   * echo still applies. The cost is that the local copy looks OLDER than it
   * is, so any other echo arriving before the server confirms this patch wins
   * the staleness comparison in `applyElement` and silently reverts the edit.
   * With one person on a board there is no other traffic and it never shows;
   * with two it reverts constantly. Holding the element for the duration of
   * the request closes that window, and applying the response makes the local
   * copy authoritative (correct `updated_at`) the moment it lands.
   */
  const commitPatch = async (id: number, patch: Partial<CanvasElement>) => {
    patchLocal(id, patch);
    hold(id, true);
    try {
      const updated = await canvasApi.updateElement(id, patch);
      hold(id, false); // release first: applyElement ignores held elements
      useCanvas.getState().applyElement(updated);
    } catch (e) {
      hold(id, false);
      throw e;
    }
  };
  const applyRemotePatch = async (logicalId: number, patch: Partial<CanvasElement>) => {
    await commitPatch(resolveId(logicalId), patch);
  };
  const recordPatch = (logicalId: number, before: Partial<CanvasElement>, after: Partial<CanvasElement>, label: string) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    pushHistory({
      label,
      undo: () => applyRemotePatch(logicalId, before),
      redo: () => applyRemotePatch(logicalId, after),
    });
  };
  const applyPatchWithHistory = (el: CanvasElement, patch: Partial<CanvasElement>, label: string) => {
    const before: Partial<CanvasElement> = {};
    for (const key of Object.keys(patch) as (keyof CanvasElement)[]) {
      (before as Record<string, unknown>)[key] = el[key];
    }
    void commitPatch(el.id, patch).catch(fail);
    recordPatch(el.id, before, patch, label);
  };
  const recordCreate = (el: CanvasElement, label: string) => {
    const logicalId = el.id;
    liveIds.current.set(logicalId, el.id);
    pushHistory({
      label,
      undo: async () => {
        const id = resolveId(logicalId);
        await canvasApi.deleteElement(id);
        useCanvas.getState().removeElement(id);
      },
      redo: async () => {
        const from = el.from_id === null ? null : resolveId(el.from_id);
        const to = el.to_id === null ? null : resolveId(el.to_id);
        const created = await canvasApi.createElement(el.board_id, createRequest(el, from, to));
        liveIds.current.set(logicalId, created.id);
        useCanvas.getState().applyElement(created);
      },
    });
  };

  /** Connectors go first so no endpoint disappears out from under one. */
  const removeAll = async (snapshots: CanvasElement[]) => {
    const bodyIds = snapshots.filter((el) => el.kind !== "connector").map((el) => resolveId(el.id));
    const connectorIds = snapshots.filter((el) => el.kind === "connector").map((el) => resolveId(el.id));
    for (const id of [...connectorIds, ...bodyIds]) {
      await canvasApi.deleteElement(id).catch(() => {});
      useCanvas.getState().removeElement(id);
    }
  };

  /** Bodies first, then connectors onto their (possibly new) endpoint ids. */
  const recreateAll = async (snapshots: CanvasElement[]) => {
    for (const el of snapshots.filter((item) => item.kind !== "connector")) {
      const created = await canvasApi.createElement(el.board_id, createRequest(el));
      liveIds.current.set(el.id, created.id);
      useCanvas.getState().applyElement(created);
    }
    for (const el of snapshots.filter((item) => item.kind === "connector")) {
      const created = await canvasApi.createElement(el.board_id, createRequest(el, el.from_id === null ? null : resolveId(el.from_id), el.to_id === null ? null : resolveId(el.to_id)));
      liveIds.current.set(el.id, created.id);
      useCanvas.getState().applyElement(created);
    }
  };

  const deleteSelected = (ids: Set<number>) => {
    if (ids.size === 0) return;
    const current = useCanvas.getState().elements;
    const logicalIds = new Set(ids);
    for (const el of Object.values(current)) {
      if ((el.from_id !== null && ids.has(el.from_id)) || (el.to_id !== null && ids.has(el.to_id))) logicalIds.add(el.id);
    }
    const snapshots = [...logicalIds].map((id) => current[id]).filter(Boolean);
    for (const el of snapshots) liveIds.current.set(el.id, el.id);
    const remove = () => removeAll(snapshots);
    const restore = () => recreateAll(snapshots);
    void remove().catch(fail);
    pushHistory({ label: snapshots.length === 1 ? "Delete element" : `Delete ${snapshots.length} elements`, undo: restore, redo: remove });
    setSelected(new Set());
  };

  /**
   * Drop the pasted copy where the eye is: centred in the viewport, or nudged
   * off the original for a duplicate. Connectors are re-pointed at the new
   * copies, so a pasted diagram stays wired the way it was drawn.
   */
  const pasteElements = async (
    payload: CanvasElement[],
    placement: { mode: "center" } | { mode: "offset"; dx: number; dy: number },
  ) => {
    const boardId = useCanvas.getState().board?.id;
    if (boardId === undefined || payload.length === 0) return;
    const bodies = payload.filter((el) => el.kind !== "connector");
    const connectors = payload.filter((el) => el.kind === "connector");
    let dx = 0;
    let dy = 0;
    if (placement.mode === "offset") {
      dx = placement.dx;
      dy = placement.dy;
    } else if (bodies.length > 0) {
      const midX = (Math.min(...bodies.map((el) => el.x)) + Math.max(...bodies.map((el) => el.x + el.w))) / 2;
      const midY = (Math.min(...bodies.map((el) => el.y)) + Math.max(...bodies.map((el) => el.y + el.h))) / 2;
      const center = centerOfView();
      dx = center.x - midX;
      dy = center.y - midY;
    }

    const idMap = new Map<number, number>();
    const created: CanvasElement[] = [];
    for (const el of bodies) {
      const made = await canvasApi.createElement(boardId, {
        ...createRequest(el, null, null),
        x: snapv(el.x + dx),
        y: snapv(el.y + dy),
      });
      idMap.set(el.id, made.id);
      liveIds.current.set(made.id, made.id);
      useCanvas.getState().applyElement(made);
      created.push(made);
    }
    for (const el of connectors) {
      const from = el.from_id === null ? undefined : idMap.get(el.from_id);
      const to = el.to_id === null ? undefined : idMap.get(el.to_id);
      if (from === undefined || to === undefined) continue; // would dangle
      const made = await canvasApi.createElement(boardId, createRequest(el, from, to));
      liveIds.current.set(made.id, made.id);
      useCanvas.getState().applyElement(made);
      created.push(made);
    }
    if (created.length === 0) return;
    setSelected(new Set(created.filter((el) => el.kind !== "connector").map((el) => el.id)));
    pushHistory({
      label: created.length === 1 ? "Paste element" : `Paste ${created.length} elements`,
      undo: () => removeAll(created),
      redo: () => recreateAll(created),
    });
  };

  const copyPayload = (ids: Set<number>): CanvasElement[] => {
    const current = useCanvas.getState().elements;
    const bodies = [...ids]
      .map((id) => current[id])
      .filter((el): el is CanvasElement => Boolean(el) && el.kind !== "connector");
    const bodyIds = new Set(bodies.map((el) => el.id));
    // Connectors come along when both ends do — including ones the marquee
    // never touched, since a link between two copied notes is part of them.
    const connectors = Object.values(current).filter(
      (el) =>
        el.kind === "connector" &&
        el.from_id !== null &&
        el.to_id !== null &&
        bodyIds.has(el.from_id) &&
        bodyIds.has(el.to_id),
    );
    return [...bodies, ...connectors];
  };

  /**
   * Frame a set of elements: centre them and pick the scale that fits, with
   * room to breathe. An empty set means "show me the whole board", which is
   * what F does when nothing is selected.
   */
  const focusOn = (ids: Set<number>) => {
    const source = useCanvas.getState().elements;
    const picked = (ids.size > 0 ? [...ids].map((id) => source[id]) : Object.values(source)).filter(
      (el): el is CanvasElement =>
        Boolean(el) && el.kind !== "connector" && (ids.size > 0 || (el.page ?? 0) === activePage),
    );
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (picked.length === 0 || !rect) return;
    const minX = Math.min(...picked.map((el) => el.x));
    const minY = Math.min(...picked.map((el) => el.y));
    const maxX = Math.max(...picked.map((el) => el.x + el.w));
    const maxY = Math.max(...picked.map((el) => el.y + el.h));
    const pad = 96;
    const scale = Math.min(
      2.5,
      Math.max(
        0.2,
        Math.min(
          (rect.width - pad) / Math.max(1, maxX - minX),
          (rect.height - pad) / Math.max(1, maxY - minY),
        ),
      ),
    );
    setView({
      scale,
      tx: rect.width / 2 - ((minX + maxX) / 2) * scale,
      ty: rect.height / 2 - ((minY + maxY) / 2) * scale,
    });
  };

  // Keyboard history and deletion (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) void redo(); else void undo();
        return;
      }
      if (mod && key === "a") {
        e.preventDefault();
        const all = Object.values(useCanvas.getState().elements).filter(
          (el) => el.kind !== "connector" && (el.page ?? 0) === activePage,
        );
        setSelected(new Set(all.map((el) => el.id)));
        return;
      }
      if (mod && key === "f") {
        e.preventDefault();
        setFinding(true);
        return;
      }
      if (!mod && key === "f") {
        // Frame the selection, or the whole board when nothing is selected.
        e.preventDefault();
        focusOn(selected);
        return;
      }
      if (mod && key === "d") {
        // Duplicate in place, nudged so the copy is visibly its own thing.
        e.preventDefault();
        if (selected.size > 0) {
          void pasteElements(copyPayload(selected), { mode: "offset", dx: 24, dy: 24 }).catch(fail);
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selected.size > 0) deleteSelected(selected);
    };
    // Copy/cut ride the real clipboard events, so the board's copy replaces
    // whatever else was on the clipboard and the newest copy always wins at
    // paste time — no private clipboard shadowing the system one.
    const writeClipboard = (e: ClipboardEvent): boolean => {
      if (isTypingTarget()) return false;
      const payload = copyPayload(selected);
      if (payload.length === 0) return false;
      e.preventDefault();
      lastCopy = payload; // so the right-click menu's Paste matches ⌘V
      e.clipboardData?.setData("text/plain", CLIP_PREFIX + JSON.stringify(payload));
      return true;
    };
    const onCopy = (e: ClipboardEvent) => void writeClipboard(e);
    const onCut = (e: ClipboardEvent) => {
      if (writeClipboard(e)) deleteSelected(selected);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
    };
    // activePage matters: select-all must mean the page in view, not the one
    // that happened to be open when the listener was attached.
  }, [selected, activePage]);

  // A page someone else deleted can't stay selected, or the board would look
  // empty with no way back.
  useEffect(() => {
    const live = boardPages(board?.style ?? "");
    if (!live.some((p) => p.id === activePage)) setActivePage(live[0].id);
  }, [board?.style, activePage]);

  // Any press outside the context menu dismisses it; so does Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Paste onto the board: images become image elements, URLs become link
  // cards, other text becomes a sticky — placed at the viewport center.
  useEffect(() => {
    const create = (
      kind: string,
      text: string,
      w: number,
      h: number,
      color = "",
    ) => {
      const boardId = useCanvas.getState().board?.id;
      if (boardId === undefined) return;
      const { x, y } = centerOfView();
      canvasApi
        .createElement(boardId, {
          kind,
          page: activePage,
          x: snapv(x - w / 2),
          y: snapv(y - h / 2),
          w,
          h,
          text,
          color,
          style: "",
          from_id: null,
          to_id: null,
        })
        .then((el) => {
          useCanvas.getState().applyElement(el);
          setSelected(new Set([el.id]));
          recordCreate(el, `Add ${kind}`);
        })
        .catch(fail);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget()) return; // typing somewhere
      const item = [...(e.clipboardData?.items ?? [])].find((i) =>
        i.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        const boardId = useCanvas.getState().board?.id;
        if (boardId === undefined) return;
        // Place at the picture's own aspect ratio, capped at 480px on the
        // long edge.
        const place = (ref: string) => {
          const img = new window.Image();
          const url = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, 480 / Math.max(img.width, img.height));
            create(
              "image",
              ref,
              Math.max(60, Math.round(img.width * scale)),
              Math.max(60, Math.round(img.height * scale)),
            );
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            create("image", ref, 320, 240);
          };
          img.src = url;
        };
        // A board on this device keeps its pictures beside it; a group board
        // uploads them as attachments so everyone else can see them.
        if (isLocalBoard(boardId)) {
          void saveLocalImage(file).then(place).catch(fail);
        } else {
          void uploadBlob(file, "pasted.png")
            .then((meta) => place(String(meta.id)))
            .catch(fail);
        }
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      e.preventDefault();
      if (text.startsWith(CLIP_PREFIX)) {
        try {
          const payload = JSON.parse(text.slice(CLIP_PREFIX.length)) as CanvasElement[];
          if (Array.isArray(payload)) void pasteElements(payload, { mode: "center" }).catch(fail);
        } catch {
          // mangled on the way through the clipboard — nothing to paste
        }
        return;
      }
      if (/^https?:\/\/\S+$/.test(text)) create("link", text, 280, 96);
      else create("sticky", text.slice(0, 4000), 180, 140, "yellow");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!board) return <div className="wf-sessions-empty">Loading…</div>;
  const local = isLocalBoard(board.id);
  const group = groups.find((g) => g.id === board.group_id);
  const canDelete = local || (me && (board.creator.id === me.id || group?.my_role === "admin"));
  const background = pageBackground(board.style, activePage);

  const writeBoardStyle = async (style: string) => {
    const current = useCanvas.getState().board;
    if (!current) return;
    useCanvas.setState({ board: await canvasApi.updateBoard(current.id, style) });
  };
  /**
   * Insert a finished sketch at the centre of the view, or save an edit back
   * into the element it came from. The drawing's own proportions set the
   * element's starting size, capped so a big doodle doesn't land oversized.
   */
  const saveSketch = (data: SketchData, target: CanvasElement | null) => {
    const text = JSON.stringify(data);
    setSketching(null);
    if (target) {
      applyPatchWithHistory(target, { text }, "Edit sketch");
      return;
    }
    const boardId = useCanvas.getState().board?.id;
    if (boardId === undefined) return;
    const scale = Math.min(1, 420 / Math.max(data.box.w, data.box.h));
    const w = Math.max(MIN_W, Math.round(data.box.w * scale));
    const h = Math.max(MIN_H, Math.round(data.box.h * scale));
    const center = centerOfView();
    canvasApi
      .createElement(boardId, {
        kind: "sketch",
        page: activePage,
        x: snapv(center.x - w / 2),
        y: snapv(center.y - h / 2),
        w,
        h,
        text,
        color: "",
        style: "",
        from_id: null,
        to_id: null,
      })
      .then((el) => {
        useCanvas.getState().applyElement(el);
        setSelected(new Set([el.id]));
        recordCreate(el, "Add sketch");
      })
      .catch(fail);
  };

  /** Patch every element of a selection as one undoable step. */
  const patchEach = (
    ids: Set<number>,
    patchFor: (el: CanvasElement, index: number) => Partial<CanvasElement>,
    label: string,
  ) => {
    const source = useCanvas.getState().elements;
    const after: { id: number; patch: Partial<CanvasElement> }[] = [];
    const before: { id: number; patch: Partial<CanvasElement> }[] = [];
    [...ids]
      .map((id) => source[id])
      .filter(Boolean)
      .forEach((el, index) => {
        const patch = patchFor(el, index);
        const prev: Partial<CanvasElement> = {};
        for (const key of Object.keys(patch) as (keyof CanvasElement)[]) {
          (prev as Record<string, unknown>)[key] = el[key];
        }
        if (JSON.stringify(prev) === JSON.stringify(patch)) return;
        after.push({ id: el.id, patch });
        before.push({ id: el.id, patch: prev });
      });
    if (after.length === 0) return;
    const apply = async (list: typeof after) => {
      for (const item of list) await commitPatch(resolveId(item.id), item.patch);
    };
    void apply(after).catch(fail);
    pushHistory({ label, undo: () => apply(before), redo: () => apply(after) });
  };

  const styleEach = (ids: Set<number>, change: (st: TextStyle) => TextStyle, label: string) =>
    patchEach(ids, (el) => ({ style: JSON.stringify(change(textStyle(el.style))) }), label);

  const reorder = (ids: Set<number>, dir: "front" | "back") => {
    const source = useCanvas.getState().elements;
    const top = maxZ(source);
    const bottom = minZ(source);
    patchEach(
      ids,
      (_el, index) => ({ z: dir === "front" ? top + 1 + index : bottom - 1 - index }),
      dir === "front" ? "Bring to front" : "Send to back",
    );
  };

  /** Copy for the menu: the in-app buffer is what Paste reads, and the system
   *  clipboard is kept in step so ⌘V gives the same thing. */
  const copyToBuffer = (ids: Set<number>) => {
    const payload = copyPayload(ids);
    if (payload.length === 0) return;
    lastCopy = payload;
    void navigator.clipboard
      ?.writeText?.(CLIP_PREFIX + JSON.stringify(payload))
      .catch(() => {});
  };

  const openElementMenu = (e: React.MouseEvent, el: CanvasElement) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking outside the current selection retargets it first.
    const ids = selected.has(el.id) ? new Set(selected) : new Set([el.id]);
    if (!selected.has(el.id)) setSelected(ids);
    const st = textStyle(el.style);
    const locked = st.locked === true;
    const many = ids.size > 1;
    const editable = !many && ["sticky", "text", "frame", "shape", "sketch"].includes(el.kind);
    const items: (BoardMenuItem | null)[] = [
      { label: "Bring to front", icon: <ArrowUpToLine size={14} />, onClick: () => reorder(ids, "front") },
      { label: "Send to back", icon: <ArrowDownToLine size={14} />, onClick: () => reorder(ids, "back") },
      null,
      {
        label: "Cut",
        icon: <Scissors size={14} />,
        onClick: () => {
          copyToBuffer(ids);
          deleteSelected(ids);
        },
      },
      { label: "Copy", icon: <Copy size={14} />, onClick: () => copyToBuffer(ids) },
      {
        label: "Paste",
        icon: <ClipboardPaste size={14} />,
        disabled: lastCopy.length === 0,
        onClick: () => void pasteElements(lastCopy, { mode: "center" }).catch(fail),
      },
      {
        label: "Duplicate",
        icon: <CopyPlus size={14} />,
        onClick: () =>
          void pasteElements(copyPayload(ids), { mode: "offset", dx: 24, dy: 24 }).catch(fail),
      },
      null,
      {
        label: locked ? "Unlock" : "Lock",
        icon: locked ? <Unlock size={14} /> : <Lock size={14} />,
        checked: locked,
        onClick: () =>
          styleEach(
            ids,
            (s) => ({ ...s, locked: locked ? undefined : true }),
            locked ? "Unlock" : "Lock",
          ),
      },
      {
        label: "Round corners",
        icon: <Squircle size={14} />,
        checked: (st.radius ?? 16) > 0,
        onClick: () =>
          styleEach(
            ids,
            (s) => ({ ...s, radius: (s.radius ?? 16) > 0 ? 0 : 16 }),
            "Round corners",
          ),
      },
      editable ? null : undefined,
      editable
        ? {
            label: el.kind === "sketch" ? "Edit sketch" : "Edit text",
            icon: <Pencil size={14} />,
            onClick: () => (el.kind === "sketch" ? setSketching({ el }) : beginEditing(el)),
          }
        : undefined,
      null,
      {
        label: many ? `Delete ${ids.size} elements` : "Delete",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => deleteSelected(ids),
      },
    ].filter((item) => item !== undefined) as (BoardMenuItem | null)[];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  /**
   * Dress the page you're on. The whole style column is rewritten each time,
   * so this MUST start from what's already there — an earlier version built
   * a fresh object from the background alone and took every page but the
   * first down with it.
   */
  const applyBackground = (bg: BoardBackground) => {
    const before = board.style;
    const current = parseBoardStyle(before);
    const next = JSON.stringify({
      ...current,
      pages: boardPages(before).map((p) =>
        p.id === activePage ? { ...p, bg: Object.keys(bg).length > 0 ? bg : undefined } : p,
      ),
    });
    if (next === before) return;
    void writeBoardStyle(next).catch(fail);
    pushHistory({
      label: "Page background",
      undo: () => writeBoardStyle(before),
      redo: () => writeBoardStyle(next),
    });
  };

  /* --- pages --- */

  const pages = boardPages(board.style);
  /** Merge into the board's one style blob so pages and background, which
   *  share the column, can never overwrite each other. */
  const writePages = (next: BoardPage[]) =>
    writeBoardStyle(JSON.stringify({ ...parseBoardStyle(board.style), pages: next }));

  const addPage = () => {
    const id = pages.reduce((top, p) => Math.max(top, p.id), 0) + 1;
    const next = [...pages, { id, name: `Page ${pages.length + 1}` }];
    void writePages(next).then(() => setActivePage(id)).catch(fail);
  };

  const renamePage = (id: number, name: string) => {
    const clean = name.trim().slice(0, 60);
    if (!clean || clean === pages.find((p) => p.id === id)?.name) return;
    void writePages(pages.map((p) => (p.id === id ? { ...p, name: clean } : p))).catch(fail);
  };

  const deletePage = async (id: number) => {
    if (pages.length <= 1) return; // a board is always at least one page
    const doomed = Object.values(useCanvas.getState().elements).filter(
      (el) => (el.page ?? 0) === id,
    );
    const ok = await confirmDialog(
      doomed.length === 0
        ? "Delete this page?"
        : `Delete this page and the ${doomed.length} thing${doomed.length === 1 ? "" : "s"} on it?`,
      { title: "Delete page", confirmLabel: "Delete page", danger: true },
    );
    if (!ok) return;
    for (const el of doomed) liveIds.current.set(el.id, el.id);
    const before = pages;
    const remaining = pages.filter((p) => p.id !== id);
    // Undo has to put the page back as well as its contents, or the restored
    // elements would belong to a page that no longer exists.
    const drop = async () => {
      await removeAll(doomed);
      await writePages(remaining);
    };
    const restore = async () => {
      await writePages(before);
      await recreateAll(doomed);
    };
    void drop()
      .then(() => setActivePage(remaining[0].id))
      .catch(fail);
    pushHistory({ label: "Delete page", undo: restore, redo: drop });
  };

  // Broadcast our pointer to peers, throttled. Fire-and-forget: a dropped
  // frame is corrected by the next move, so failures are ignored.
  const broadcastCursor = (clientX: number, clientY: number) => {
    const boardId = useCanvas.getState().board?.id;
    if (boardId === undefined) return;
    if (pinchRef.current) return; // pinch fingers aren't a pointer position
    const now = Date.now();
    if (now - lastCursorSent.current < 50) return; // ~20/s
    lastCursorSent.current = now;
    const { x, y } = toWorld(clientX, clientY);
    void canvasApi.cursor(boardId, x, y).catch(() => {});
  };

  /** Centre the viewport on a world point (used by the minimap). */
  const jumpTo = (worldX: number, worldY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) => ({
      ...v,
      tx: rect.width / 2 - worldX * v.scale,
      ty: rect.height / 2 - worldY * v.scale,
    }));
  };


  /**
   * The arrow affordances around a selected element: make a fresh element on
   * that side and wire it up in one step. Kinds whose text is data rather
   * than words (a picture, a sketch, a link) spawn a note instead — an empty
   * copy of them would mean nothing.
   */
  const spawnLinked = async (el: CanvasElement, side: Side) => {
    const boardId = useCanvas.getState().board?.id;
    if (boardId === undefined) return;
    const gap = 80;
    const kind = ["sticky", "text", "shape", "frame"].includes(el.kind) ? el.kind : "sticky";
    const sameKind = kind === el.kind;
    const made = await canvasApi.createElement(boardId, {
      kind,
      page: activePage,
      x: snapv(el.x + (side === "left" ? -(el.w + gap) : side === "right" ? el.w + gap : 0)),
      y: snapv(el.y + (side === "top" ? -(el.h + gap) : side === "bottom" ? el.h + gap : 0)),
      w: sameKind ? el.w : 180,
      h: sameKind ? el.h : 140,
      text: "",
      color: sameKind ? el.color : "yellow",
      // Carry the look across, but never the lock — a new element you can't
      // move would be baffling.
      style: sameKind ? JSON.stringify({ ...textStyle(el.style), locked: undefined }) : "",
      from_id: null,
      to_id: null,
    });
    useCanvas.getState().applyElement(made);
    const opposite: Record<Side, Side> = {
      top: "bottom",
      bottom: "top",
      left: "right",
      right: "left",
    };
    const link = await canvasApi.createElement(boardId, {
      kind: "connector",
      page: activePage,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      text: JSON.stringify({
        ...CONN_DEFAULTS,
        from_anchor: side,
        to_anchor: opposite[side],
        end_cap: "arrow",
      }),
      color: "",
      style: "",
      from_id: el.id,
      to_id: made.id,
    });
    useCanvas.getState().applyElement(link);
    for (const item of [made, link]) liveIds.current.set(item.id, item.id);
    setSelected(new Set([made.id]));
    if (kind !== "frame") beginEditing(made);
    pushHistory({
      label: "Add linked element",
      undo: () => removeAll([made, link]),
      redo: () => recreateAll([made, link]),
    });
  };

  /** Find-and-replace writes: one undo step for the whole sweep. */
  const replaceInElements = (edits: { id: number; text: string }[], label: string) => {
    if (edits.length === 0) return;
    const source = useCanvas.getState().elements;
    const before = edits
      .filter((edit) => source[edit.id])
      .map((edit) => ({ id: edit.id, text: source[edit.id].text }));
    const apply = async (list: { id: number; text: string }[]) => {
      for (const item of list) await commitPatch(resolveId(item.id), { text: item.text });
    };
    void apply(edits).catch(fail);
    pushHistory({ label, undo: () => apply(before), redo: () => apply(edits) });
  };

  const toWorld = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale,
    };
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    setView((v) => {
      const scale = Math.min(2.5, Math.max(0.2, v.scale * factor));
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const wx = (px - v.tx) / v.scale;
      const wy = (py - v.ty) / v.scale;
      return { scale, tx: px - wx * scale, ty: py - wy * scale };
    });
  };

  /** The view bar's zoom, anchored at the middle of the board itself — the
   *  window's centre drifts well below it on phones, where the header, page
   *  strip and wrapped tool bar all take height from the board. */
  const zoomFromCenter = (factor: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  const placeElement = (kind: "sticky" | "text" | "frame" | "shape", x: number, y: number) => {
    const defaults =
      kind === "sticky"
        ? { w: 180, h: 140, text: "", color: "yellow" }
        : kind === "text"
          ? { w: 240, h: 48, text: "", color: "" }
          : kind === "shape"
            ? { w: 180, h: 130, text: "", color: "" }
            : { w: 520, h: 360, text: "Frame", color: "" };
    canvasApi
      .createElement(board.id, {
        kind,
        page: activePage,
        x: snapv(x - defaults.w / 2),
        y: snapv(y - defaults.h / 2),
        w: defaults.w,
        h: defaults.h,
        text: defaults.text,
        color: defaults.color,
        style: kind === "shape" ? JSON.stringify({ shape: shapeKind }) : "",
        from_id: null,
        to_id: null,
      })
      .then((el) => {
        useCanvas.getState().applyElement(el);
        setSelected(new Set([el.id]));
        if (kind !== "frame") beginEditing(el);
        recordCreate(el, `Add ${kind}`);
      })
      .catch(fail);
    setTool("select");
  };

  const onSurfaceDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Second finger of a pinch: the touch tracker above owns it (it has
    // already seen this pointerdown — capture phase runs first).
    if (e.pointerType === "touch" && touchPts.current.size >= 2) return;
    if (tool === "sticky" || tool === "text" || tool === "frame" || tool === "shape") {
      const { x, y } = toWorld(e.clientX, e.clientY);
      placeElement(tool, x, y);
      return;
    }
    e.preventDefault();
    if (e.shiftKey) {
      // Marquee select.
      const start = toWorld(e.clientX, e.clientY);
      const rect = { x1: start.x, y1: start.y, x2: start.x, y2: start.y };
      setMarquee(rect);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        const now = toWorld(ev.clientX, ev.clientY);
        rect.x2 = now.x;
        rect.y2 = now.y;
        setMarquee({ ...rect });
      };
      const cancel = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setMarquee(null);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        gestureCancels.current.delete(cancel);
        cancel();
        const [lx, hx] = [Math.min(rect.x1, rect.x2), Math.max(rect.x1, rect.x2)];
        const [ly, hy] = [Math.min(rect.y1, rect.y2), Math.max(rect.y1, rect.y2)];
        const hit = new Set<number>();
        for (const el of Object.values(useCanvas.getState().elements)) {
          if (el.kind === "connector") continue;
          if (el.x < hx && el.x + el.w > lx && el.y < hy && el.y + el.h > ly) hit.add(el.id);
        }
        setSelected(hit);
      };
      gestureCancels.current.add(cancel);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }
    // Pan.
    // A click that closes an open text editor only leaves edit mode — the
    // element stays selected so it can be dragged straight away. Clicking
    // blank canvas again then deselects, so one gesture changes one thing.
    if (editing === null) setSelected(new Set());
    setEditing(null);
    setConnectFrom(null);
    const start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      setView((v) => ({ ...v, tx: start.tx + ev.clientX - start.x, ty: start.ty + ev.clientY - start.y }));
    };
    const cancel = () => {
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        // capture already gone
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      gestureCancels.current.delete(cancel);
      cancel();
    };
    gestureCancels.current.add(cancel);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onElementDown = (e: React.PointerEvent, el: CanvasElement) => {
    if (e.button !== 0) return;
    // Fingers two and up belong to the pinch tracker, not to dragging.
    if (e.pointerType === "touch" && touchPts.current.size >= 2) return;
    e.stopPropagation();
    if (tool === "connect") {
      if (connectFrom === null) {
        setConnectFrom(el.id);
      } else if (connectFrom !== el.id) {
        canvasApi
          .createElement(board.id, {
            kind: "connector",
            page: activePage,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            text: "",
            color: "",
            style: "",
            from_id: connectFrom,
            to_id: el.id,
          })
          .then((c) => {
            useCanvas.getState().applyElement(c);
            recordCreate(c, "Add connector");
          })
          .catch(fail);
        setConnectFrom(null);
        setTool("select");
      }
      return;
    }
    e.preventDefault(); // stops native image drag + text selection
    // Shift-click toggles membership without dragging.
    if (e.shiftKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(el.id)) next.delete(el.id);
        else next.add(el.id);
        return next;
      });
      return;
    }
    // Click on an unselected element selects just it; a selected one keeps
    // the group so the whole selection drags together.
    const dragSet = new Set(selected.has(el.id) ? selected : [el.id]);
    if (!selected.has(el.id)) setSelected(new Set([el.id]));
    if (editing !== null && editing !== el.id) setEditing(null);
    // Locked elements still select — that's how you reach the unlock item —
    // but grabbing one never starts a drag.
    if (isLocked(el)) return;

    const all = useCanvas.getState().elements;
    // A frame carries everything whose center sits inside it.
    for (const id of [...dragSet]) {
      const f = all[id];
      if (!f || f.kind !== "frame") continue;
      for (const other of Object.values(all)) {
        if (other.id === f.id || other.kind === "connector") continue;
        const cx = other.x + other.w / 2;
        const cy = other.y + other.h / 2;
        if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) {
          dragSet.add(other.id);
        }
      }
    }

    // Bring the grabbed element to front once per grab.
    const top = maxZ(all);
    if (el.z < top) {
      patchLocal(el.id, { z: top + 1 });
      canvasApi.updateElement(el.id, { z: top + 1 }).catch(() => {});
    }

    // Drag to move, throttled sync while moving, final patch on release.
    const origins = new Map<number, { x: number; y: number }>();
    for (const id of dragSet) {
      const item = all[id];
      if (!item || isLocked(item)) continue; // a frame can't drag locked children
      origins.set(id, { x: item.x, y: item.y });
      hold(id, true);
    }
    const startWorld = toWorld(e.clientX, e.clientY);
    const last = new Map<number, { x: number; y: number }>(origins);
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const now = toWorld(ev.clientX, ev.clientY);
      const dx = now.x - startWorld.x;
      const dy = now.y - startWorld.y;
      const t = Date.now();
      const send = t - lastSent > 120;
      if (send) lastSent = t;
      for (const [id, origin] of origins) {
        const pos = { x: snapv(origin.x + dx), y: snapv(origin.y + dy) };
        last.set(id, pos);
        patchLocal(id, pos);
        if (send) canvasApi.updateElement(id, pos).catch(() => {});
      }
    };
    const cancel = () => {
      // A pinch is starting: this was a finger planting for it, not a drag.
      // Put everything back where the grab found it (at most a few px and
      // possibly one throttled sync ago) — no history entry.
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      for (const [id, origin] of origins) {
        patchLocal(id, origin);
        canvasApi.updateElement(id, origin).catch(() => {});
        hold(id, false);
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      gestureCancels.current.delete(cancel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      for (const [id, pos] of last) {
        const origin = origins.get(id);
        // The element stays held until the server confirms this final
        // position, then the response makes the local copy authoritative —
        // otherwise a concurrent echo can snap it back to where it was.
        canvasApi
          .updateElement(id, pos)
          .then((updated) => {
            hold(id, false);
            useCanvas.getState().applyElement(updated);
          })
          .catch((e) => {
            hold(id, false);
            fail(e);
          });
        if (origin) recordPatch(id, origin, pos, dragSet.size > 1 ? "Move selection" : "Move element");
      }
    };
    gestureCancels.current.add(cancel);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onResizeDown = (e: React.PointerEvent, el: CanvasElement) => {
    if (e.button !== 0) return;
    if (e.pointerType === "touch" && touchPts.current.size >= 2) return;
    e.stopPropagation();
    hold(el.id, true);
    const startWorld = toWorld(e.clientX, e.clientY);
    const origin = { w: el.w, h: el.h };
    let last = { w: el.w, h: el.h };
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const now = toWorld(ev.clientX, ev.clientY);
      const rawW = origin.w + now.x - startWorld.x;
      const rawH = origin.h + now.y - startWorld.y;
      if (ev.shiftKey) {
        // Hold shift to keep the proportions: whichever axis the pointer
        // pushed further sets one scale, which both axes then take. The grid
        // gives way here — snapping both sides would break the ratio.
        const grow = Math.abs(rawW / origin.w - 1) >= Math.abs(rawH / origin.h - 1);
        const scale = Math.max(
          grow ? rawW / origin.w : rawH / origin.h,
          MIN_W / origin.w,
          MIN_H / origin.h,
        );
        last = { w: Math.round(origin.w * scale), h: Math.round(origin.h * scale) };
      } else {
        last = { w: Math.max(MIN_W, snapv(rawW)), h: Math.max(MIN_H, snapv(rawH)) };
      }
      patchLocal(el.id, last);
      const t = Date.now();
      if (t - lastSent > 120) {
        lastSent = t;
        canvasApi.updateElement(el.id, last).catch(() => {});
      }
    };
    const cancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      patchLocal(el.id, { w: origin.w, h: origin.h });
      canvasApi.updateElement(el.id, { w: origin.w, h: origin.h }).catch(() => {});
      hold(el.id, false);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      gestureCancels.current.delete(cancel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvasApi
        .updateElement(el.id, last)
        .then((updated) => {
          hold(el.id, false);
          useCanvas.getState().applyElement(updated);
        })
        .catch((e) => {
          hold(el.id, false);
          fail(e);
        });
      recordPatch(el.id, origin, last, "Resize element");
    };
    gestureCancels.current.add(cancel);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /**
   * Corner-radius handle. Dragging away from the corner rounds it off and
   * back toward it squares it up, measured from where you grabbed so the
   * handle never jumps out from under the pointer.
   */
  const onRadiusDown = (e: React.PointerEvent, el: CanvasElement) => {
    if (e.button !== 0) return;
    if (e.pointerType === "touch" && touchPts.current.size >= 2) return;
    e.stopPropagation();
    e.preventDefault();
    hold(el.id, true);
    const startWorld = toWorld(e.clientX, e.clientY);
    const before = el.style;
    const origin = textStyle(before).radius ?? defaultRadius(el);
    const max = Math.floor(Math.min(el.w, el.h) / 2);
    let last = before;
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const now = toWorld(ev.clientX, ev.clientY);
      const along = (now.x - startWorld.x + (now.y - startWorld.y)) / 2;
      const radius = Math.round(Math.min(max, Math.max(0, origin + along)));
      last = JSON.stringify({ ...textStyle(before), radius });
      patchLocal(el.id, { style: last });
      const t = Date.now();
      if (t - lastSent > 120) {
        lastSent = t;
        canvasApi.updateElement(el.id, { style: last }).catch(() => {});
      }
    };
    const cancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      patchLocal(el.id, { style: before });
      canvasApi.updateElement(el.id, { style: before }).catch(() => {});
      hold(el.id, false);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      gestureCancels.current.delete(cancel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvasApi
        .updateElement(el.id, { style: last })
        .then((updated) => {
          hold(el.id, false);
          useCanvas.getState().applyElement(updated);
        })
        .catch((err) => {
          hold(el.id, false);
          fail(err);
        });
      recordPatch(el.id, { style: before }, { style: last }, "Corner radius");
    };
    gestureCancels.current.add(cancel);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Edge-handle crop for images: the box edge moves while the visible
   *  content stays put (the source's on-screen scale never changes mid-drag),
   *  so dragging inward cuts and dragging back out restores, until the crop
   *  fraction reaches zero and the box simply stops growing. */
  const onCropDown = (e: React.PointerEvent, el: CanvasElement, side: "t" | "r" | "b" | "l") => {
    if (e.button !== 0) return;
    if (e.pointerType === "touch" && touchPts.current.size >= 2) return;
    e.stopPropagation();
    e.preventDefault();
    hold(el.id, true);
    const startWorld = toWorld(e.clientX, e.clientY);
    const st0 = textStyle(el.style);
    const crop0 = st0.crop ?? { t: 0, r: 0, b: 0, l: 0 };
    // On-screen size of the FULL source at drag start — held constant.
    const srcW = el.w / Math.max(0.05, 1 - crop0.l - crop0.r);
    const srcH = el.h / Math.max(0.05, 1 - crop0.t - crop0.b);
    const origin: Partial<CanvasElement> = {
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      style: el.style,
    };
    let last: Partial<CanvasElement> | null = null;
    let lastSent = 0;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const now = toWorld(ev.clientX, ev.clientY);
      const dx = now.x - startWorld.x;
      const dy = now.y - startWorld.y;
      const next = { ...crop0 };
      let { x, y, w, h } = el;
      if (side === "r") {
        next.r = Math.min(Math.max(0, crop0.r - dx / srcW), 0.95 - crop0.l);
        w = Math.max(1, Math.round(srcW * (1 - crop0.l - next.r)));
      } else if (side === "l") {
        next.l = Math.min(Math.max(0, crop0.l + dx / srcW), 0.95 - crop0.r);
        w = Math.max(1, Math.round(srcW * (1 - next.l - crop0.r)));
        x = Math.round(el.x + srcW * (next.l - crop0.l));
      } else if (side === "b") {
        next.b = Math.min(Math.max(0, crop0.b - dy / srcH), 0.95 - crop0.t);
        h = Math.max(1, Math.round(srcH * (1 - crop0.t - next.b)));
      } else {
        next.t = Math.min(Math.max(0, crop0.t + dy / srcH), 0.95 - crop0.b);
        h = Math.max(1, Math.round(srcH * (1 - next.t - crop0.b)));
        y = Math.round(el.y + srcH * (next.t - crop0.t));
      }
      const cropped = next.t > 0 || next.r > 0 || next.b > 0 || next.l > 0;
      last = {
        x,
        y,
        w,
        h,
        style: JSON.stringify({ ...st0, crop: cropped ? next : undefined }),
      };
      patchLocal(el.id, last);
      const t = Date.now();
      if (t - lastSent > 120) {
        lastSent = t;
        canvasApi.updateElement(el.id, last).catch(() => {});
      }
    };
    const cancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      patchLocal(el.id, origin);
      canvasApi.updateElement(el.id, origin).catch(() => {});
      hold(el.id, false);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      gestureCancels.current.delete(cancel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!last) {
        hold(el.id, false);
        return;
      }
      const final = last;
      canvasApi
        .updateElement(el.id, final)
        .then((updated) => {
          hold(el.id, false);
          useCanvas.getState().applyElement(updated);
        })
        .catch((err) => {
          hold(el.id, false);
          fail(err);
        });
      recordPatch(el.id, origin, final, "Crop image");
    };
    gestureCancels.current.add(cancel);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Snap the element box back to the image's natural aspect ratio, keeping
   *  the current width. Rotation is applied to the content, not the box, so
   *  a quarter-turn swaps the ratio. */
  const fitImageToContent = (el: CanvasElement) => {
    const img = new window.Image();
    img.onload = () => {
      if (!img.width || !img.height) return;
      const st = textStyle(el.style);
      const quarterTurned = Math.abs(((st.rotate ?? 0) / 90) % 2) === 1;
      const ratio = quarterTurned ? img.width / img.height : img.height / img.width;
      const h = Math.max(60, Math.round(el.w * ratio));
      const patch: Partial<CanvasElement> = { h };
      // Matching the source's aspect only makes sense for the whole source.
      if (st.crop) patch.style = JSON.stringify({ ...st, crop: undefined });
      applyPatchWithHistory(el, patch, "Fit image");
    };
    img.onerror = () => setError("Couldn't load the image to fit its size.");
    img.src = imageSrc(el);
  };

  const beginEditing = (el: CanvasElement) => {
    editingOriginal.current = el.text;
    setEditing(el.id);
  };

  /** Persist while typing so an interrupted edit can never lose work. No
   *  history entry — the whole edit becomes one undo step on commit. */
  const autosaveText = (el: CanvasElement, text: string) => {
    if (text === el.text) return;
    void commitPatch(el.id, { text }).catch(() => {});
  };

  const commitText = (el: CanvasElement, text: string) => {
    setEditing(null);
    const original = editingOriginal.current;
    if (text === original) return;
    void commitPatch(el.id, { text }).catch(fail);
    recordPatch(el.id, { text: original }, { text }, "Edit text");
  };

  // Only the page in view: everything downstream (frames, bodies, links,
  // the minimap, select-all) reads from this one list.
  const all = Object.values(elements).filter((el) => (el.page ?? 0) === activePage);
  // Render order is by id — deliberately NOT by `z`. Stacking is expressed
  // with z-index instead (see Z_BAND_*), because sorting the DOM by `z` made
  // React *move* nodes whenever anyone's `z` changed, and every click
  // rewrites `z` and broadcasts it. Moving a node blurs whatever is focused
  // inside it, so another person clicking anything killed your open text
  // editor mid-edit and silently dropped what you typed.
  const byId = (a: CanvasElement, b: CanvasElement) => a.id - b.id;
  const frames = all.filter((el) => el.kind === "frame").sort(byId);
  const bodies = all
    .filter((el) =>
      ["sticky", "text", "image", "link", "document", "shape", "sketch"].includes(el.kind),
    )
    .sort(byId);
  const connectors = all.filter((el) => el.kind === "connector");
    // Single-selection element (color swatches, connector styling, resize).
  /**
   * Where to float the contextual toolbar: centred over the selection's top
   * edge, in SCREEN space (the stage is transformed, so world coords are
   * converted through the current viewport). Flips below when it would sit
   * off the top of the board.
   */
  const selectionBox = (() => {
    if (selected.size === 0) return null;
    const picked = [...selected].map((id) => elements[id]).filter(Boolean);
    if (picked.length === 0) return null;
    // Connectors have no meaningful box; anchor to their endpoints instead.
    const boxes = picked.map((el) => {
      if (el.kind !== "connector") return el;
      const from = el.from_id !== null ? elements[el.from_id] : undefined;
      const to = el.to_id !== null ? elements[el.to_id] : undefined;
      if (!from || !to) return el;
      const x = Math.min(from.x, to.x);
      const y = Math.min(from.y, to.y);
      return {
        x,
        y,
        w: Math.max(from.x + from.w, to.x + to.w) - x,
        h: Math.max(from.y + from.h, to.y + to.h) - y,
      };
    });
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const centreX = (minX + maxX) / 2;
    const screenX = centreX * view.scale + view.tx;
    const screenY = minY * view.scale + view.ty;
    const GAP = 12;
    const below = screenY < 64; // not enough headroom above the selection
    return {
      left: screenX,
      top: below ? screenY + (Math.max(...boxes.map((b) => b.y + b.h)) - minY) * view.scale + GAP : screenY - GAP,
      below,
    };
  })();

  const soleId = selected.size === 1 ? [...selected][0] : null;
  const selectedEl = soleId !== null ? elements[soleId] : undefined;

  return (
    <div className="wf-board-wrap">
      <header className="wf-session-room-header wf-board-header">
        <button onClick={closeBoard}>←</button>
        <h2>{board.name}</h2>
        <span className="wf-session-meta">
          {local ? (
            <span className="wf-doc-local-chip" title="Stored on this device only">
              <HardDrive size={13} /> on this device
            </span>
          ) : (
            <>
              {group?.name} · by {board.creator.display_name ?? board.creator.username}
            </>
          )}
        </span>
        <span className="wf-statusbar-spacer" />
        <button
          title="Find and replace (⌘/Ctrl+F)"
          className={finding ? "active" : ""}
          onClick={() => setFinding((f) => !f)}
        >
          <Search size={16} />
        </button>
        <BackgroundMenu
          background={background}
          local={local}
          onChange={applyBackground}
          onError={fail}
        />
        {canDelete && (
          <button
            className="wf-danger"
            onClick={() =>
              void confirmDialog(
                local
                  ? "Delete this board from this device? It exists nowhere else."
                  : "Delete this board for everyone? This cannot be undone.",
                { title: "Delete board", confirmLabel: "Delete board", danger: true },
              ).then((ok) => {
                if (!ok) return;
                canvasApi.deleteBoard(board.id).then(closeBoard).catch(fail);
              })
            }
          >
            Delete board
          </button>
        )}
      </header>
      {error && (
        <p className="wf-connect-error wf-board-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {finding && (
        <BoardFind
          elements={all}
          onGo={(id) => {
            setSelected(new Set([id]));
            const el = useCanvas.getState().elements[id];
            // Centre it but keep the zoom: F is for framing, find is for
            // walking through matches without the view leaping about.
            if (el) jumpTo(el.x + el.w / 2, el.y + el.h / 2);
          }}
          onReplace={replaceInElements}
          onClose={() => setFinding(false)}
        />
      )}

      {/* Always shown: the strip is how a second page gets made. */}
      <div className="wf-board-pages">
          {pages.map((p) => (
            <button
              key={p.id}
              className={`wf-board-page ${p.id === activePage ? "active" : ""}`}
              onClick={() => setActivePage(p.id)}
              onDoubleClick={() => setRenamingPage(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    {
                      label: "Rename page",
                      icon: <Pencil size={14} />,
                      onClick: () => setRenamingPage(p.id),
                    },
                    {
                      label: "Delete page",
                      icon: <Trash2 size={14} />,
                      danger: true,
                      disabled: pages.length <= 1,
                      onClick: () => void deletePage(p.id),
                    },
                  ],
                });
              }}
            >
              {renamingPage === p.id ? (
                <input
                  autoFocus
                  defaultValue={p.name}
                  maxLength={60}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    renamePage(p.id, e.target.value);
                    setRenamingPage(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenamingPage(null);
                  }}
                />
              ) : (
                p.name
              )}
            </button>
          ))}
        <button className="wf-board-page-add" title="Add a page" onClick={addPage}>
          <Plus size={14} />
        </button>
      </div>

      <div
        ref={surfaceRef}
        className={`wf-board wf-board-tool-${tool}`}
        style={backgroundStyle(background)}
        onPointerDown={onSurfaceDown}
        onContextMenu={(e) => {
          // Right-clicking the board itself: the actions that need no element.
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              {
                label: "Paste",
                icon: <ClipboardPaste size={14} />,
                disabled: lastCopy.length === 0,
                onClick: () => void pasteElements(lastCopy, { mode: "center" }).catch(fail),
              },
              {
                label: "Select all",
                icon: <MousePointer2 size={14} />,
                onClick: () =>
                  setSelected(
                    new Set(
                      Object.values(useCanvas.getState().elements)
                        .filter((item) => item.kind !== "connector")
                        .map((item) => item.id),
                    ),
                  ),
              },
              {
                label: "Fit to screen",
                icon: <Maximize2 size={14} />,
                onClick: () => focusOn(new Set()),
              },
            ],
          });
        }}
        onPointerMove={(e) => broadcastCursor(e.clientX, e.clientY)}
        onWheel={(e) => zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.08 : 1 / 1.08)}
      >
        <div
          className="wf-board-stage"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
        >
          {frames.map((el) => (
            <div
              key={el.id}
              className={`wf-el wf-el-frame ${selected.has(el.id) ? "selected" : ""} ${connectFrom === el.id ? "connect-from" : ""} ${isLocked(el) ? "locked" : ""}`}
              style={{
                left: el.x,
                top: el.y,
                width: el.w,
                height: el.h,
                zIndex: Z_BAND_FRAME + el.z,
                background: FRAME_COLORS[el.color]?.bg,
                borderColor: FRAME_COLORS[el.color]?.border,
                borderRadius: textStyle(el.style).radius,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onContextMenu={(e) => openElementMenu(e, el)}
              onDoubleClick={() => beginEditing(el)}
            >
              <ElementText
                el={el}
                editing={editing === el.id}
                onCommit={(text) => commitText(el, text)}
                onDraft={(text) => autosaveText(el, text)}
                className="wf-el-frame-label"
              />
              {selected.has(el.id) && selected.size === 1 && !isLocked(el) && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
              {selected.has(el.id) && selected.size === 1 && !isLocked(el) && canRound(el) && (
                <span
                  className="wf-el-radius"
                  title="Drag to round the corners"
                  onPointerDown={(e) => onRadiusDown(e, el)}
                />
              )}
              {selected.has(el.id) && selected.size === 1 && !isLocked(el) && (
                <>
                  {SIDES.map((side) => (
                    <button
                      key={side}
                      className={`wf-el-spawn ${side}`}
                      title="Add a linked element this way"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void spawnLinked(el, side).catch(fail);
                      }}
                    >
                      <ArrowRight size={12} />
                    </button>
                  ))}
                </>
              )}
            </div>
          ))}

          <svg className="wf-board-links" style={{ zIndex: Z_BAND_CONNECTOR }}>
            {connectors.map((c) => {
              const from = c.from_id !== null ? elements[c.from_id] : undefined;
              const to = c.to_id !== null ? elements[c.to_id] : undefined;
              if (!from || !to) return null;
              const cs = connStyle(c.text);
              const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
              const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
              // Auto anchors attach at the element edge (center-to-center
              // endpoints would bury the arrowheads under the elements).
              const p1 =
                cs.from_anchor === "auto"
                  ? clipToRect(from, toCenter)
                  : anchorPoint(from, cs.from_anchor);
              const p2 =
                cs.to_anchor === "auto"
                  ? clipToRect(to, fromCenter)
                  : anchorPoint(to, cs.to_anchor);
              const geo = connectorGeometry(
                p1,
                sideOf(from, p1, cs.from_anchor),
                p2,
                sideOf(to, p2, cs.to_anchor),
                cs.route,
              );
              const capped = Math.hypot(p2.x - p1.x, p2.y - p1.y) >= 1;
              const isSelected = selected.has(c.id);
              // Stroke goes through inline style, never a presentation
              // attribute: `.wf-link`'s CSS would win over the attribute. When
              // selected, leave it off so the accent color shows through.
              const stroke = isSelected ? undefined : FRAME_COLORS[cs.color]?.border;
              return (
                <g key={c.id}>
                  <path
                    className="wf-link-hit"
                    d={geo.d}
                    fill="none"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelected(new Set([c.id]));
                    }}
                    onContextMenu={(e) => openElementMenu(e, c)}
                  />
                  <path
                    className={`wf-link ${isSelected ? "selected" : ""}`}
                    d={geo.d}
                    fill="none"
                    style={{ stroke, strokeWidth: cs.width }}
                    strokeDasharray={cs.dash ? "7 5" : undefined}
                  />
                  {capped && (
                    <ConnectorCap
                      kind={cs.start_cap}
                      at={p1}
                      angleDeg={geo.startAngle + 180}
                      color={stroke}
                    />
                  )}
                  {capped && (
                    <ConnectorCap
                      kind={cs.end_cap}
                      at={p2}
                      angleDeg={geo.endAngle}
                      color={stroke}
                    />
                  )}
                  {cs.label && (
                    <foreignObject
                      x={geo.labelAt.x - 90}
                      y={geo.labelAt.y - 16}
                      width={180}
                      height={32}
                      className="wf-link-label-wrap"
                    >
                      <div className="wf-link-label-box">
                        <span className="wf-link-label">{cs.label}</span>
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}
          </svg>

          {bodies.map((el) => (
            <div
              key={el.id}
              className={`wf-el wf-el-${el.kind} ${selected.has(el.id) ? "selected" : ""} ${connectFrom === el.id ? "connect-from" : ""} ${isLocked(el) ? "locked" : ""}`}
              style={{
                left: el.x,
                top: el.y,
                width: el.w,
                height: el.h,
                zIndex: Z_BAND_BODY + el.z,
                background:
                  el.kind === "sticky"
                    ? stickyColor(el.color, textStyle(el.style).opacity ?? NOTE_ALPHA)
                    : undefined,
                borderRadius: textStyle(el.style).radius,
              }}
              onPointerDown={(e) => onElementDown(e, el)}
              onContextMenu={(e) => openElementMenu(e, el)}
              onDoubleClick={() => {
                if (el.kind === "sketch") setSketching({ el });
                else if (el.kind !== "image" && el.kind !== "link" && el.kind !== "document") {
                  beginEditing(el);
                }
              }}
            >
              {el.kind === "image" ? (
                <CanvasImage el={el} />
              ) : el.kind === "link" ? (
                <LinkCard url={el.text} />
              ) : el.kind === "document" ? (
                <CanvasDocCard payload={el.text} />
              ) : el.kind === "sketch" ? (
                <SketchBody el={el} />
              ) : el.kind === "shape" ? (
                <>
                  <ShapeBody el={el} />
                  <ElementText
                    el={el}
                    editing={editing === el.id}
                    onCommit={(text) => commitText(el, text)}
                    onDraft={(text) => autosaveText(el, text)}
                    className="wf-el-shape-text"
                  />
                </>
              ) : (
                <ElementText
                  el={el}
                  editing={editing === el.id}
                  onCommit={(text) => commitText(el, text)}
                  onDraft={(text) => autosaveText(el, text)}
                  className={el.kind === "sticky" ? "wf-el-sticky-text" : "wf-el-text-text"}
                />
              )}
              {selected.has(el.id) && selected.size === 1 && !isLocked(el) && (
                <span className="wf-el-resize" onPointerDown={(e) => onResizeDown(e, el)} />
              )}
              {selected.has(el.id) && selected.size === 1 && !isLocked(el) && canRound(el) && (
                <span
                  className="wf-el-radius"
                  title="Drag to round the corners"
                  onPointerDown={(e) => onRadiusDown(e, el)}
                />
              )}
              {selected.has(el.id) && selected.size === 1 && !isLocked(el) && (
                <>
                  {SIDES.map((side) => (
                    <button
                      key={side}
                      className={`wf-el-spawn ${side}`}
                      title="Add a linked element this way"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        void spawnLinked(el, side).catch(fail);
                      }}
                    >
                      <ArrowRight size={12} />
                    </button>
                  ))}
                </>
              )}
              {/* Images: mid-edge handles crop (the corner still scales). */}
              {selected.has(el.id) && selected.size === 1 && el.kind === "image" && (
                <>
                  <span className="wf-el-crop n" onPointerDown={(e) => onCropDown(e, el, "t")} />
                  <span className="wf-el-crop e" onPointerDown={(e) => onCropDown(e, el, "r")} />
                  <span className="wf-el-crop s" onPointerDown={(e) => onCropDown(e, el, "b")} />
                  <span className="wf-el-crop w" onPointerDown={(e) => onCropDown(e, el, "l")} />
                </>
              )}
            </div>
          ))}

          {marquee && (
            <div
              className="wf-marquee"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
              }}
            />
          )}

          {/* Peers' pointers live in world space so they track the board as
              you pan and zoom; the counter-scale keeps them a constant size. */}
          {Object.values(cursors).map((c) => (
            <div
              key={c.user.id}
              className="wf-cursor"
              style={{
                left: c.x,
                top: c.y,
                zIndex: Z_BAND_CURSOR,
                transform: `scale(${1 / view.scale})`,
                color: c.user.accent_color ?? cursorColor(c.user.username),
              }}
            >
              <MousePointer2 size={16} className="wf-cursor-arrow" />
              {/* Background is set here rather than via `currentColor` in CSS:
                  the label also sets its own text colour, which would make
                  `currentColor` resolve to that instead of the cursor's. */}
              <span
                className="wf-cursor-label"
                style={{
                  background: c.user.accent_color ?? cursorColor(c.user.username),
                  color: contrastText(c.user.accent_color ?? cursorColor(c.user.username)),
                }}
              >
                {c.user.display_name ?? c.user.username}
              </span>
            </div>
          ))}
        </div>

        {selectionBox && (
          <div
            className={`wf-selection-toolbar-wrap ${selectionBox.below ? "below" : ""}`}
            style={{
              left: Math.max(8, Math.min(selectionBox.left, window.innerWidth - 228)),
              top: selectionBox.top,
            }}
            // Keep the board from panning, and keep focus where it is so
            // formatting an element mid-edit doesn't close its text editor —
            // except on the toolbar's own fields, which need the focus this
            // would deny them (a text box you can't click into, a select that
            // won't open).
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              if (!(e.target as HTMLElement).closest("input, select, textarea")) {
                e.preventDefault();
              }
            }}
          >
            <div className="wf-selection-toolbar">
            {selectedEl && selectedEl.kind === "connector" && (
              <ConnectorControls
                connector={selectedEl}
                onChange={(cs) => {
                  const text = JSON.stringify(cs);
                  applyPatchWithHistory(selectedEl, { text }, "Style connector");
                }}
              />
            )}
            {selectedEl && selectedEl.kind === "sticky" && (
              <ColorMenu
                title="Note color"
                current={selectedEl.color || "yellow"}
                colors={Object.entries(STICKY_COLORS).map(([key, css]) => ({ key, css }))}
                onPick={(key) =>
                  applyPatchWithHistory(selectedEl, { color: key }, "Change sticky color")
                }
                footer={
                  <OpacitySlider
                    value={Math.round((textStyle(selectedEl.style).opacity ?? NOTE_ALPHA) * 100)}
                    onPreview={(percent) =>
                      patchLocal(selectedEl.id, {
                        style: JSON.stringify({
                          ...textStyle(selectedEl.style),
                          opacity: percent / 100,
                        }),
                      })
                    }
                    onCommit={(from, to) => {
                      if (from === to) return;
                      // Both ends are built explicitly: by now the element's
                      // own style holds the previewed value, so it can't
                      // stand in for "before".
                      const styleAt = (percent: number) =>
                        JSON.stringify({
                          ...textStyle(selectedEl.style),
                          opacity: percent / 100,
                        });
                      void commitPatch(selectedEl.id, { style: styleAt(to) }).catch(fail);
                      recordPatch(
                        selectedEl.id,
                        { style: styleAt(from) },
                        { style: styleAt(to) },
                        "Note opacity",
                      );
                    }}
                  />
                }
              />
            )}
            {selectedEl && selectedEl.kind === "sketch" && (
              <button
                className="wf-icon"
                title="Edit sketch"
                onClick={() => setSketching({ el: selectedEl })}
              >
                <Pencil size={15} />
              </button>
            )}
            {selectedEl && selectedEl.kind === "image" && (
              <ImageControls
                element={selectedEl}
                onChange={(st) =>
                  applyPatchWithHistory(selectedEl, { style: JSON.stringify(st) }, "Transform image")
                }
                onFitBox={() => fitImageToContent(selectedEl)}
              />
            )}
            {selectedEl && (selectedEl.kind === "frame" || selectedEl.kind === "shape") && (
              <>
                {selectedEl.kind === "shape" && (
                  <button
                    className={`wf-icon ${textStyle(selectedEl.style).filled ? "active" : ""}`}
                    title={
                      textStyle(selectedEl.style).filled
                        ? "Filled (click for outline only)"
                        : "Outline (click to fill)"
                    }
                    onClick={() => {
                      const s = textStyle(selectedEl.style);
                      applyPatchWithHistory(
                        selectedEl,
                        { style: JSON.stringify({ ...s, filled: !s.filled || undefined }) },
                        "Toggle shape fill",
                      );
                    }}
                  >
                    <PaintBucket size={15} />
                  </button>
                )}
                <ColorMenu
                  title={selectedEl.kind === "frame" ? "Frame color" : "Shape color"}
                  current={selectedEl.color}
                  colors={[
                    { key: "", css: "" },
                    ...Object.entries(FRAME_COLORS).map(([key, css]) => ({
                      key,
                      css: css.border,
                    })),
                  ]}
                  onPick={(key) => applyPatchWithHistory(selectedEl, { color: key }, "Change color")}
                />
              </>
            )}
            {selectedEl &&
              (selectedEl.kind === "sticky" ||
                selectedEl.kind === "text" ||
                selectedEl.kind === "shape") && (
              <TextStyleControls
                element={selectedEl}
                onChange={(st) => {
                  const style = JSON.stringify(st);
                  applyPatchWithHistory(selectedEl, { style }, "Format text");
                }}
              />
            )}
            </div>

            {/* Its own panel beside the toolbar, centred against it however
                many rows the controls take. */}
            {selected.size > 0 && (
              <button
                className="wf-selection-delete"
                title={selected.size > 1 ? `Delete ${selected.size} elements` : "Delete element"}
                onClick={() => deleteSelected(selected)}
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
        )}

        {/* The page in view, so the map matches what's on screen. */}
        <Minimap
          elements={Object.fromEntries(all.map((el) => [el.id, el]))}
          view={view}
          surfaceRef={surfaceRef}
          onJump={jumpTo}
        />

        <div className="wf-board-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <ToolButton tool="select" active={tool} set={setTool} title="Select / pan">
            <MousePointer2 size={17} />
          </ToolButton>
          <ToolButton tool="sticky" active={tool} set={setTool} title="Sticky note (click to place)">
            <StickyNote size={17} />
          </ToolButton>
          <ToolButton tool="text" active={tool} set={setTool} title="Text (click to place)">
            <Type size={17} />
          </ToolButton>
          <ToolButton tool="frame" active={tool} set={setTool} title="Frame (click to place)">
            <FrameIcon size={17} />
          </ToolButton>
          <span className="wf-board-menuwrap">
            <button
              className={tool === "shape" ? "active" : ""}
              title="Shape (pick one, then click to place)"
              onClick={() => setShapeMenu((v) => !v)}
            >
              <Shapes size={17} />
            </button>
            {shapeMenu && (
              <span className="wf-board-menu wf-board-menu-shapes">
                {SHAPE_OPTIONS.map((s) => (
                  <button
                    key={s.kind}
                    className={tool === "shape" && shapeKind === s.kind ? "active" : ""}
                    title={s.title}
                    onClick={() => {
                      setShapeKind(s.kind);
                      setTool("shape");
                      setShapeMenu(false);
                    }}
                  >
                    <s.icon size={16} />
                  </button>
                ))}
              </span>
            )}
          </span>
          <button title="Add sketch" onClick={() => setSketching({ el: null })}>
            <Pencil size={17} />
          </button>
          <ToolButton
            tool="connect"
            active={tool}
            set={(t) => {
              setConnectFrom(null);
              setTool(t);
            }}
            title="Connector (click two elements)"
          >
            <Spline size={17} />
          </ToolButton>
          <span className="wf-board-toolbar-sep" />
          <button title={`Undo${undoStack.current.length ? `: ${undoStack.current[undoStack.current.length - 1].label}` : ""}`} disabled={undoStack.current.length === 0 || historyBusy.current} onClick={() => void undo()}>
            <Undo2 size={17} />
          </button>
          <button title={`Redo${redoStack.current.length ? `: ${redoStack.current[redoStack.current.length - 1].label}` : ""}`} disabled={redoStack.current.length === 0 || historyBusy.current} onClick={() => void redo()}>
            <Redo2 size={17} />
          </button>
          <span className="wf-board-history-count" title="Canvas history keeps the last 15 actions">{undoStack.current.length}/15</span>
        </div>

        {/* View controls live in the corner, away from the tools: they act on
            the board itself rather than on what you're drawing. */}
        <div className="wf-board-viewbar" onPointerDown={(e) => e.stopPropagation()}>
          <button title="Zoom out" onClick={() => zoomFromCenter(1 / 1.2)}>
            <ZoomOut size={16} />
          </button>
          <button
            className="wf-board-zoom"
            title="Reset zoom to 100%"
            // Through zoomAt, so it settles around the middle of the view
            // instead of yanking whatever you were looking at off-screen.
            onClick={() => zoomFromCenter(1 / viewRef.current.scale)}
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button title="Zoom in" onClick={() => zoomFromCenter(1.2)}>
            <ZoomIn size={16} />
          </button>
          <span className="wf-board-toolbar-sep" />
          <button
            title={snap ? "Snap to grid: on" : "Snap to grid: off"}
            className={snap ? "active" : ""}
            onClick={() => {
              const next = !snap;
              setSnap(next);
              localStorage.setItem("wf-canvas-snap", next ? "on" : "off");
            }}
          >
            <Grid3x3 size={16} />
          </button>
        </div>
        {tool === "connect" && (
          <div className="wf-board-hint">
            {connectFrom === null
              ? "Connector: click the first element"
              : "Now click the element to connect to"}
          </div>
        )}
      </div>
      {menu && (
        <div
          className="wf-context-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - (menu.items.length * 34 + 24))),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.items.map((item, i) =>
            item === null ? (
              <span key={i} className="wf-context-sep" />
            ) : (
              <button
                key={i}
                className={item.danger ? "wf-danger" : ""}
                disabled={item.disabled}
                onClick={() => {
                  setMenu(null);
                  item.onClick();
                }}
              >
                <span className="wf-context-check">{item.checked && <Check size={13} />}</span>
                <span className="wf-context-icon">{item.icon}</span>
                <span className="wf-context-label">{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}

      {sketching && (
        <SketchPad
          initial={sketching.el ? parseSketch(sketching.el.text) : null}
          onCancel={() => setSketching(null)}
          onDone={(data) => saveSketch(data, sketching.el)}
        />
      )}
    </div>
  );
}

function ToolButton({
  tool,
  active,
  set,
  title,
  children,
}: {
  tool: Tool;
  active: Tool;
  set: (t: Tool) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button className={active === tool ? "active" : ""} title={title} onClick={() => set(tool)}>
      {children}
    </button>
  );
}

/** CSS derived from an element's TextStyle for both display and editing. */
function textStyleCss(st: TextStyle): React.CSSProperties {
  return {
    fontSize: st.size,
    fontWeight: st.bold ? 700 : undefined,
    fontStyle: st.italic ? "italic" : undefined,
    textDecoration: st.underline ? "underline" : undefined,
    textAlign: st.align,
    fontFamily: st.font ? FONT_STACKS[st.font] : undefined,
    color: st.textColor,
  };
}

function ElementText({
  el,
  editing,
  onCommit,
  onDraft,
  className,
}: {
  el: CanvasElement;
  editing: boolean;
  onCommit: (text: string) => void;
  /** Called on a pause in typing, so work survives an interrupted edit. */
  onDraft?: (text: string) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(el.text);
  useEffect(() => {
    if (editing) setDraft(el.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Autosave after a short pause; the blur commit still records the undo step.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!editing || !onDraft) return;
    const timer = setTimeout(() => onDraft(draftRef.current), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing]);

  // Editing can also end from outside (clicking the canvas closes it), and
  // that path may not fire `blur` — flush whatever was typed since the last
  // autosave tick so nothing is lost.
  useEffect(() => {
    if (!editing || !onDraft) return;
    return () => onDraft(draftRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const st = textStyle(el.style);
  const css = textStyleCss(st);

  if (!editing) {
    if (!el.text) {
      return (
        <div className={className} style={css}>
          <span className="wf-el-placeholder">double-click to write</span>
        </div>
      );
    }
    if (st.list === "bullet") {
      return (
        <ul className={`${className} wf-el-bullets`} style={css}>
          {el.text.split("\n").map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      );
    }
    return (
      <div className={className} style={css}>
        {el.text}
      </div>
    );
  }
  return (
    <textarea
      className={`${className} wf-el-edit`}
      style={css}
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        // Commits rather than reverts — the draft has been autosaving,
        // so discarding here would only roll back the last few seconds.
        if (e.key === "Escape") onCommit(draft);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onCommit(draft);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** B/I/U, font size, alignment, bullet controls for sticky/text elements. */
function TextStyleControls({
  element,
  onChange,
}: {
  element: CanvasElement;
  onChange: (st: TextStyle) => void;
}) {
  const st = textStyle(element.style);
  const size = st.size ?? 14;
  const align = st.align ?? "left";
  const [menu, setMenu] = useState<null | "font" | "color">(null);
  useEffect(() => {
    if (!menu) return;
    // The selection toolbar stops pointerdown propagation, so only presses
    // OUTSIDE it reach the window — exactly when the menu should close.
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const stepSize = (dir: 1 | -1) => {
    const idx = FONT_SIZES.findIndex((s) => s >= size);
    const at = idx === -1 ? FONT_SIZES.length - 1 : idx;
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, at + dir))];
    onChange({ ...st, size: next });
  };
  const AlignIcon = align === "center" ? AlignCenter : align === "right" ? AlignRight : AlignLeft;
  return (
    <>
      <button
        title="Bold"
        className={st.bold ? "active" : ""}
        onClick={() => onChange({ ...st, bold: !st.bold || undefined })}
      >
        <Bold size={15} />
      </button>
      <button
        title="Italic"
        className={st.italic ? "active" : ""}
        onClick={() => onChange({ ...st, italic: !st.italic || undefined })}
      >
        <Italic size={15} />
      </button>
      <button
        title="Underline"
        className={st.underline ? "active" : ""}
        onClick={() => onChange({ ...st, underline: !st.underline || undefined })}
      >
        <Underline size={15} />
      </button>
      <button title="Smaller text" onClick={() => stepSize(-1)}>
        −
      </button>
      <span className="wf-board-fontsize" title="Font size">
        {size}
      </span>
      <button title="Larger text" onClick={() => stepSize(1)}>
        +
      </button>
      <button
        title={`Align: ${align} (click to change)`}
        onClick={() => {
          const next = ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(align) + 1) % ALIGN_CYCLE.length];
          onChange({ ...st, align: next === "left" ? undefined : next });
        }}
      >
        <AlignIcon size={15} />
      </button>
      <button
        title="Bullet list"
        className={st.list === "bullet" ? "active" : ""}
        onClick={() => onChange({ ...st, list: st.list === "bullet" ? undefined : "bullet" })}
      >
        <List size={15} />
      </button>
      <span className="wf-board-menuwrap">
        <button
          className="wf-board-font"
          title="Font"
          onClick={() => setMenu(menu === "font" ? null : "font")}
        >
          <span style={{ fontFamily: st.font ? FONT_STACKS[st.font] : undefined }}>Aa</span>
          <ChevronDown size={12} />
        </button>
        {menu === "font" && (
          <span className="wf-board-menu wf-board-menu-fonts">
            {FONT_OPTIONS.map((f) => (
              <button
                key={f.label}
                className={st.font === f.value ? "active" : ""}
                style={{ fontFamily: f.value ? FONT_STACKS[f.value] : undefined }}
                onClick={() => {
                  onChange({ ...st, font: f.value });
                  setMenu(null);
                }}
              >
                <Check size={13} className={st.font === f.value ? "" : "wf-invisible"} />
                {f.label}
              </button>
            ))}
          </span>
        )}
      </span>
      <span className="wf-board-menuwrap">
        <button
          className="wf-board-font"
          title="Text color"
          onClick={() => setMenu(menu === "color" ? null : "color")}
        >
          {/* The classic "A over a color bar" glyph — a bare dot read as
              "empty", not as a color control. Default shows a mini rainbow. */}
          <span className="wf-board-colorbtn">
            A
            <span
              className="wf-board-colorbar"
              style={st.textColor ? { background: st.textColor } : undefined}
            />
          </span>
          <ChevronDown size={12} />
        </button>
        {menu === "color" && (
          <span className="wf-board-menu wf-board-menu-colors">
            <button
              className={`wf-board-swatch wf-board-swatch-none ${st.textColor === undefined ? "active" : ""}`}
              title="Default"
              onClick={() => {
                onChange({ ...st, textColor: undefined });
                setMenu(null);
              }}
            />
            {TEXT_COLORS.map((c) => (
              <button
                key={c.css}
                className={`wf-board-swatch ${st.textColor === c.css ? "active" : ""}`}
                style={{ background: c.css }}
                title={c.name}
                onClick={() => {
                  onChange({ ...st, textColor: c.css });
                  setMenu(null);
                }}
              />
            ))}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Board background: a color, or an image and how it lies on the surface.
 * Writes the whole background back as one JSON blob, so "no color and no
 * image" collapses to an empty string and the board returns to its default.
 */
function BackgroundMenu({
  background,
  local,
  onChange,
  onError,
}: {
  background: BoardBackground;
  local: boolean;
  onChange: (bg: BoardBackground) => void;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const write = (next: BoardBackground) => {
    const cleaned: BoardBackground = {};
    if (next.color) cleaned.color = next.color;
    if (next.image !== undefined) {
      cleaned.image = next.image;
      cleaned.fit = next.fit ?? "cover";
    }
    if (next.grid === false) cleaned.grid = false;
    onChange(cleaned);
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      // Same split as a pasted picture: stored beside the board on this
      // device, or uploaded as an attachment everyone in the group can see.
      const image = local ? await saveLocalImage(file) : (await uploadBlob(file, file.name)).id;
      write({ ...background, image });
    } catch (e) {
      onError(e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <span className="wf-board-menuwrap" onPointerDown={(e) => e.stopPropagation()}>
      <button
        title="Board background"
        className={open ? "active" : ""}
        onClick={() => setOpen((o) => !o)}
      >
        <Palette size={16} />
      </button>
      {open && (
        <div className="wf-board-menu wf-board-bg-menu">
          <span className="wf-board-bg-note">This page</span>
          <div className="wf-board-bg-colors">
            {BG_COLORS.map((c) => (
              <button
                key={c.label}
                title={c.label}
                className={`wf-board-bg-swatch ${(background.color ?? "") === (c.value ?? "") ? "active" : ""}`}
                style={c.value ? { background: c.value } : undefined}
                onClick={() => write({ ...background, color: c.value })}
              >
                {!c.value && <Ban size={13} />}
              </button>
            ))}
            <label className="wf-board-bg-swatch wf-board-bg-custom" title="Custom color">
              <Pipette size={13} />
              <input
                type="color"
                value={background.color ?? "#1d1f27"}
                onChange={(e) => write({ ...background, color: e.target.value })}
              />
            </label>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          <div className="wf-board-bg-row">
            <button onClick={() => fileRef.current?.click()} disabled={uploading}>
              <ImagePlus size={14} />{" "}
              {uploading
                ? "Uploading…"
                : background.image !== undefined
                  ? "Replace image"
                  : "Add image"}
            </button>
            {background.image !== undefined && (
              <button className="wf-danger" onClick={() => write({ color: background.color })}>
                Remove
              </button>
            )}
          </div>
          {background.image !== undefined && (
            <div className="wf-board-bg-fits">
              {BG_FITS.map((f) => (
                <button
                  key={f.id}
                  className={(background.fit ?? "cover") === f.id ? "active" : ""}
                  onClick={() => write({ ...background, fit: f.id })}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <label className="wf-board-bg-toggle">
            <input
              type="checkbox"
              checked={background.grid !== false}
              onChange={(e) => write({ ...background, grid: e.target.checked ? undefined : false })}
            />
            Dot grid
          </label>
        </div>
      )}
    </span>
  );
}

/**
 * One swatch that opens the palette, rather than the whole palette sitting in
 * the toolbar — the same shape as the text-color control next to it.
 */
function ColorMenu({
  colors,
  current,
  title,
  onPick,
  footer,
}: {
  colors: { key: string; css: string }[];
  current: string;
  title: string;
  onPick: (key: string) => void;
  /** Extra control under the swatches — opacity, for a note's fill. */
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const active = colors.find((c) => c.key === current) ?? colors[0];
  // An entry with no css is the "no fill / default" one, drawn as a slashed
  // ring rather than a color.
  const swatch = (css: string) => `wf-board-swatch ${css ? "" : "wf-board-swatch-none"}`;
  return (
    <span className="wf-board-menuwrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className={open ? "active" : ""} title={title} onClick={() => setOpen((o) => !o)}>
        <span
          className={`${swatch(active?.css ?? "")} wf-board-swatch-current`}
          style={active?.css ? { background: active.css } : undefined}
        />
        <ChevronDown size={12} />
      </button>
      {open && (
        <span className={`wf-board-menu wf-board-menu-colors ${footer ? "has-foot" : ""}`}>
          <span className="wf-board-menu-swatches">
            {colors.map((c) => (
              <button
                key={c.key}
                className={`${swatch(c.css)} ${c.key === current ? "active" : ""}`}
                style={c.css ? { background: c.css } : undefined}
                title={c.key || "None"}
                onClick={() => {
                  onPick(c.key);
                  setOpen(false);
                }}
              />
            ))}
          </span>
          {footer}
        </span>
      )}
    </span>
  );
}

/** A dropdown of choices, shaped like the color menu next to it. */
function PickerMenu({
  title,
  trigger,
  children,
}: {
  title: string;
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <span className="wf-board-menuwrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className={open ? "active" : ""} title={title} onClick={() => setOpen((o) => !o)}>
        {trigger}
        <ChevronDown size={12} />
      </button>
      {open && (
        <span className="wf-board-menu wf-board-menu-list">{children(() => setOpen(false))}</span>
      )}
    </span>
  );
}

/** An arrow at the start of a line points back the way it came. */
const capLabel = (kind: ConnCap, end: "start" | "end") =>
  kind === "arrow" ? (end === "start" ? "\u25C0" : "\u25B6") : kind === "dot" ? "\u25CF" : "\u2014";

/**
 * Connector controls, in two rows: how the line looks on top, and what
 * happens at each end below — laid out left cap, line, right cap, so the row
 * reads the way the connector is drawn.
 */
function ConnectorControls({
  connector,
  onChange,
}: {
  connector: CanvasElement;
  onChange: (cs: ConnStyle) => void;
}) {
  const cs = connStyle(connector.text);
  const anchors: ConnAnchor[] = ["auto", "top", "right", "bottom", "left"];
  const cycleCap = (v: ConnCap) => CAP_CYCLE[(CAP_CYCLE.indexOf(v) + 1) % CAP_CYCLE.length];
  const route = CONN_ROUTES.find((r) => r.id === cs.route) ?? CONN_ROUTES[0];
  const weightName = (w: number) => (w <= 1.5 ? "Thin" : w <= 3 ? "Medium" : "Thick");
  return (
    <>
      <PickerMenu title="Line style" trigger={<route.icon size={15} />}>
        {(close) =>
          CONN_ROUTES.map((r) => (
            <button
              key={r.id}
              className={cs.route === r.id ? "active" : ""}
              onClick={() => {
                onChange({ ...cs, route: r.id });
                close();
              }}
            >
              <r.icon size={15} /> {r.title}
            </button>
          ))
        }
      </PickerMenu>
      <PickerMenu
        title="Line weight"
        trigger={<span className="wf-conn-weight" style={{ height: Math.max(2, cs.width) }} />}
      >
        {(close) =>
          CONN_WIDTHS.map((w) => (
            <button
              key={w}
              className={cs.width === w ? "active" : ""}
              onClick={() => {
                onChange({ ...cs, width: w });
                close();
              }}
            >
              <span className="wf-conn-weight" style={{ height: w }} /> {weightName(w)}
            </button>
          ))
        }
      </PickerMenu>
      <button
        title={cs.dash ? "Dashed (click for solid)" : "Solid (click for dashed)"}
        className={cs.dash ? "active" : ""}
        onClick={() => onChange({ ...cs, dash: !cs.dash })}
      >
        {cs.dash ? "\u2505" : "\u2014"}
      </button>
      <ColorMenu
        title="Line color"
        current={cs.color}
        colors={[
          { key: "", css: "" },
          ...Object.entries(FRAME_COLORS).map(([key, css]) => ({ key, css: css.border })),
        ]}
        onPick={(key) => onChange({ ...cs, color: key })}
      />
      <ConnectorLabel value={cs.label} onCommit={(label) => onChange({ ...cs, label })} />

      {/* Everything about the two ends, on its own row and in the order the
          line runs: start cap, the line, end cap. */}
      <span className="wf-toolbar-break" />
      <button
        title={`Start decoration: ${cs.start_cap} (click to change)`}
        className="wf-conn-cap"
        onClick={() => onChange({ ...cs, start_cap: cycleCap(cs.start_cap) })}
      >
        {capLabel(cs.start_cap, "start")}
      </button>
      <select
        title="Start attaches to this side"
        value={cs.from_anchor}
        onChange={(e) => onChange({ ...cs, from_anchor: e.target.value as ConnAnchor })}
      >
        {anchors.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <span className="wf-conn-run">—</span>
      <select
        title="End attaches to this side"
        value={cs.to_anchor}
        onChange={(e) => onChange({ ...cs, to_anchor: e.target.value as ConnAnchor })}
      >
        {anchors.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <button
        title={`End decoration: ${cs.end_cap} (click to change)`}
        className="wf-conn-cap"
        onClick={() => onChange({ ...cs, end_cap: cycleCap(cs.end_cap) })}
      >
        {capLabel(cs.end_cap, "end")}
      </button>
    </>
  );
}

/**
 * Note opacity. Dragging repaints locally so it's live under the cursor;
 * only the release reaches the server and the undo stack, so a drag is one
 * step rather than one per pixel.
 */
function OpacitySlider({
  value,
  onPreview,
  onCommit,
}: {
  value: number;
  onPreview: (percent: number) => void;
  onCommit: (from: number, to: number) => void;
}) {
  const [live, setLive] = useState(value);
  const start = useRef(value);
  useEffect(() => setLive(value), [value]);
  const commit = () => onCommit(start.current, live);
  return (
    <label className="wf-board-opacity-row">
      <span>Opacity</span>
      <input
        className="wf-board-opacity"
      type="range"
      min={20}
      max={100}
      step={5}
      title={`Note opacity: ${live}%`}
      value={live}
      onFocus={() => (start.current = live)}
      onPointerDown={() => (start.current = live)}
      onChange={(e) => {
        const next = Number(e.target.value);
        setLive(next);
        onPreview(next);
      }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="wf-board-opacity-value">{live}%</span>
    </label>
  );
}

/** Words on a connector. Committed on blur or Enter so a typed label is one
 *  undo step rather than one per keystroke. */
function ConnectorLabel({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (label: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="wf-conn-label-input"
      placeholder="Label…"
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Stable per-user cursor colour when they have no accent set. */
const CURSOR_COLORS = ["#c96f4a", "#5a9e6f", "#5d8fc9", "#a878c9", "#c9a44a", "#c96f9a", "#4aa8a0"];
function cursorColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length];
}

/**
 * Readable text colour for an arbitrary background. Accent colours are
 * user-chosen and can be pale, so a fixed white label would be unreadable.
 */
function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#101014" : "#fff";
}

/** Bounding box of everything on the board, in world coordinates. */
function contentBounds(elements: Record<number, CanvasElement>) {
  const items = Object.values(elements).filter((el) => el.kind !== "connector");
  if (items.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of items) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  return { minX, minY, maxX, maxY };
}

const MINIMAP_W = 180;
const MINIMAP_H = 120;

/**
 * Overview of the board with the current viewport drawn on it. Click or drag
 * to recentre. Hidden on an empty board, where it would show nothing useful.
 */
function Minimap({
  elements,
  view,
  surfaceRef,
  onJump,
}: {
  elements: Record<number, CanvasElement>;
  view: Viewport;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  onJump: (worldX: number, worldY: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem("wf-canvas-minimap");
    if (saved !== null) return saved === "off";
    // No expressed preference: phones start with the map tucked away — at
    // that size it covers a real share of the board.
    return window.matchMedia("(max-width: 767px)").matches;
  });
  const bounds = contentBounds(elements);
  if (!bounds) return null;

  const rect = surfaceRef.current?.getBoundingClientRect();
  // Include the visible viewport in the extent so the indicator stays inside
  // the minimap even when you pan away from the content.
  const viewW = (rect?.width ?? 800) / view.scale;
  const viewH = (rect?.height ?? 600) / view.scale;
  const viewX = -view.tx / view.scale;
  const viewY = -view.ty / view.scale;
  const minX = Math.min(bounds.minX, viewX);
  const minY = Math.min(bounds.minY, viewY);
  const maxX = Math.max(bounds.maxX, viewX + viewW);
  const maxY = Math.max(bounds.maxY, viewY + viewH);
  const pad = 40;
  const worldW = maxX - minX + pad * 2;
  const worldH = maxY - minY + pad * 2;
  const scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH);
  const toMini = (x: number, y: number) => ({
    left: (x - minX + pad) * scale,
    top: (y - minY + pad) * scale,
  });

  const jumpFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const worldX = (e.clientX - box.left) / scale + minX - pad;
    const worldY = (e.clientY - box.top) / scale + minY - pad;
    onJump(worldX, worldY);
  };

  if (collapsed) {
    return (
      <button
        className="wf-minimap-toggle wf-icon"
        title="Show minimap"
        // Without this the board's pan handler takes pointer capture and the
        // click never lands on the button (the expanded minimap stops it on
        // its wrapper for the same reason).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          setCollapsed(false);
          localStorage.setItem("wf-canvas-minimap", "on");
        }}
      >
        <MapIcon size={15} />
      </button>
    );
  }

  return (
    <div className="wf-minimap" onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="wf-minimap-surface"
        style={{ width: MINIMAP_W, height: MINIMAP_H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          jumpFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) jumpFromEvent(e);
        }}
      >
        {Object.values(elements)
          .filter((el) => el.kind !== "connector")
          .map((el) => {
            const pos = toMini(el.x, el.y);
            return (
              <span
                key={el.id}
                className={`wf-minimap-el ${el.kind === "frame" ? "frame" : ""}`}
                style={{
                  ...pos,
                  width: Math.max(2, el.w * scale),
                  height: Math.max(2, el.h * scale),
                  background:
                    el.kind === "sticky"
                      ? (STICKY_COLORS[el.color] ?? STICKY_COLORS.yellow)
                      : undefined,
                }}
              />
            );
          })}
        <span
          className="wf-minimap-view"
          style={{
            ...toMini(viewX, viewY),
            width: Math.max(6, viewW * scale),
            height: Math.max(6, viewH * scale),
          }}
        />
      </div>
      <button
        className="wf-minimap-hide wf-icon"
        title="Hide minimap"
        onClick={() => {
          setCollapsed(true);
          localStorage.setItem("wf-canvas-minimap", "off");
        }}
      >
        <ChevronDown size={13} />
      </button>
    </div>
  );
}


/** Rotate / flip / fit controls shown while an image element is selected. */
function ImageControls({
  element,
  onChange,
  onFitBox,
}: {
  element: CanvasElement;
  onChange: (st: TextStyle) => void;
  onFitBox: () => void;
}) {
  const st = textStyle(element.style);
  const rotate = st.rotate ?? 0;
  // Keep rotation in [0, 360) so the label stays readable after many turns.
  const turn = (delta: number) => onChange({ ...st, rotate: (((rotate + delta) % 360) + 360) % 360 });
  return (
    <>
      <button className="wf-icon" title="Rotate left" onClick={() => turn(-90)}>
        <RotateCcw size={15} />
      </button>
      <button className="wf-icon" title="Rotate right" onClick={() => turn(90)}>
        <RotateCw size={15} />
      </button>
      <span className="wf-board-fontsize" title="Rotation">
        {rotate}°
      </span>
      <button
        className={`wf-icon ${st.flipX ? "active" : ""}`}
        title="Flip horizontally"
        onClick={() => onChange({ ...st, flipX: !st.flipX || undefined })}
      >
        <FlipHorizontal size={15} />
      </button>
      <button
        className={`wf-icon ${st.flipY ? "active" : ""}`}
        title="Flip vertically"
        onClick={() => onChange({ ...st, flipY: !st.flipY || undefined })}
      >
        <FlipVertical size={15} />
      </button>
      <button
        className={`wf-icon ${st.fit === "cover" ? "active" : ""}`}
        title={st.fit === "cover" ? "Filling the box (click to fit inside)" : "Fitting inside the box (click to fill)"}
        // Fit modes describe the WHOLE source in the box, so entering one
        // discards any edge crop rather than compounding with it.
        onClick={() => onChange({ ...st, fit: st.fit === "cover" ? undefined : "cover", crop: undefined })}
      >
        <Crop size={15} />
      </button>
      <button className="wf-icon" title="Match the image's aspect ratio" onClick={onFitBox}>
        <Maximize2 size={15} />
      </button>
      {(rotate !== 0 || st.flipX || st.flipY || st.fit || st.crop) && (
        <button
          className="wf-icon"
          title="Reset transform"
          onClick={() =>
            onChange({
              ...st,
              rotate: undefined,
              flipX: undefined,
              flipY: undefined,
              fit: undefined,
              crop: undefined,
            })
          }
        >
          <RefreshCw size={15} />
        </button>
      )}
    </>
  );
}
