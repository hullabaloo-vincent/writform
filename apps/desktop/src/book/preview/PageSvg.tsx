import { memo } from "react";

import { normalizeAttachmentSrc } from "../../lib/backend";
import { viewMatrix } from "../../editor/schema/sanitize";
import type { DisplayList, DLItem, DLPage, DLText, FaceRef } from "../engine/types";

/**
 * One page of the display list as SVG: the very runs the PDF writer draws,
 * in the same font files (fonts.css), so the preview is what prints. Each
 * word sits at the position the typesetter gave it; text stays selectable,
 * and every line knows its manuscript paragraph (`data-src`).
 */
export const PageSvg = memo(function PageSvg({
  page,
  dl,
  width,
  paper,
}: {
  page: DLPage;
  dl: DisplayList;
  /** CSS pixels. */
  width: number;
  paper: "cream" | "white";
}) {
  const { w, h } = page.size ?? dl.trim;
  return (
    <svg
      className={`wf-bp-page wf-bp-paper-${paper}`}
      viewBox={`0 0 ${w} ${h}`}
      width={width}
      height={(width * h) / w}
      aria-label={page.folio ? `Page ${page.folio}` : `Page ${page.n}`}
    >
      <rect className="wf-bp-sheet" width={w} height={h} />
      {page.items.map((it, i) => item(it, i, dl.faces, page.n))}
    </svg>
  );
});

function item(it: DLItem, key: number, faces: FaceRef[], page: number) {
  if (it.t === "text") return <TextRun key={key} it={it} face={faces[it.face]} />;
  if (it.t === "rule") {
    if (it.wave) {
      // A wave along the line, as the PDF draws it.
      const a = it.wave;
      const half = a * 2;
      let d = `M${it.x1} ${it.y1}`;
      let up = true;
      for (let x = it.x1; x < it.x2 - 1e-6; x += half) {
        const end = Math.min(it.x2, x + half);
        d += ` Q${(x + end) / 2} ${it.y1 + (up ? -a : a) * 2} ${end} ${it.y1}`;
        up = !up;
      }
      return <path key={key} d={d} fill="none" stroke={it.color ?? "currentColor"} strokeWidth={it.w} />;
    }
    return <line key={key} x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={it.color ?? "currentColor"} strokeWidth={it.w} {...(it.dash ? { strokeDasharray: it.dash.join(" ") } : {})} />;
  }
  if (it.t === "rect") return <rect key={key} x={it.x} y={it.y} width={it.w} height={it.h} fill={it.color} />;
  // Links and anchors are for the PDF; the preview only shows the page.
  if (it.t === "link" || it.t === "anchor") return null;
  const picture = (clip?: string) => {
    if (it.crop || it.rot) {
      // Its kept part, turned, as the PDF has it: the whole picture placed
      // and turned inside a box that shows only that part.
      const v = viewMatrix({ ...(it.crop ? { crop: it.crop } : {}), ...(it.rot ? { rot: it.rot } : {}) }, it.w, it.h);
      return (
        <g key={key} {...(clip ? { clipPath: `url(#${clip})` } : {})}>
          <svg x={it.x} y={it.y} width={it.w} height={it.h} viewBox={`0 0 ${it.w} ${it.h}`} overflow="hidden">
            <g transform={`matrix(${v.m.join(" ")})`}>
              <image href={normalizeAttachmentSrc(it.ref)} x={v.x} y={v.y} width={v.fw} height={v.fh} preserveAspectRatio="none" />
            </g>
          </svg>
        </g>
      );
    }
    return (
      <image
        key={key}
        href={normalizeAttachmentSrc(it.ref)}
        x={it.x}
        y={it.y}
        width={it.w}
        height={it.h}
        preserveAspectRatio="xMidYMid meet"
        {...(clip ? { clipPath: `url(#${clip})` } : {})}
      />
    );
  };
  if (!it.round && !it.border) return picture();
  // A picture with rounded corners or a line round it (documents): cut to
  // its shape, the line drawn inside its edge, as the PDF has it.
  const round = it.round ?? 0;
  const shape = (by: number, props: React.SVGProps<SVGRectElement & SVGEllipseElement>) =>
    round >= 50 ? (
      <ellipse cx={it.x + it.w / 2} cy={it.y + it.h / 2} rx={Math.max(0, it.w / 2 - by)} ry={Math.max(0, it.h / 2 - by)} {...props} />
    ) : (
      <rect x={it.x + by} y={it.y + by} width={Math.max(0, it.w - by * 2)} height={Math.max(0, it.h - by * 2)} rx={Math.max(0, (Math.min(it.w, it.h) * round) / 100 - by)} {...props} />
    );
  const id = `wf-pic-${page}-${key}`;
  return (
    <g key={key}>
      {round > 0 && <clipPath id={id}>{shape(0, {})}</clipPath>}
      {picture(round > 0 ? id : undefined)}
      {it.border && shape(it.border.w / 2, { fill: "none", stroke: it.border.color, strokeWidth: it.border.w })}
    </g>
  );
}

/** One run of set text, each word where the typesetter put it. (A book's
 *  cover draws its words with this too.) */
export function TextRun({ it, face }: { it: DLText; face: FaceRef | undefined }) {
  const words = it.text.split(" ");
  // Faces without a bold are drawn bold by stroking — exactly as in the PDF.
  const fakeBold = !!face?.fakeBold;
  const style: React.CSSProperties = {
    fontFamily: face?.cssFamily,
    fontStyle: face?.cssStyle,
    fontWeight: fakeBold ? 400 : face?.cssWeight,
    fontSize: it.size,
    fontKerning: "normal",
    ...(it.feat?.length ? { fontFeatureSettings: it.feat.map((f) => `"${f}" 1`).join(", ") } : {}),
    ...(it.cs ? { letterSpacing: it.cs } : {}),
  };
  const color = it.color ?? "currentColor";
  return (
    <text
      x={it.x}
      y={it.y}
      style={style}
      data-src={it.src}
      {...(it.color ? { fill: it.color } : {})}
      {...(fakeBold ? { stroke: color, strokeWidth: it.size * 0.035 } : {})}
      // A family without an italic is slanted about its baseline, as in the PDF.
      {...(face?.fakeItalic ? { transform: `translate(${0.21 * it.y} 0) skewX(-11.86)` } : {})}
    >
      {words.length === 1 || !it.xs
        ? it.text
        : words.map((word, i) => (
            // A trailing space keeps copied text readable; each word is
            // placed absolutely, so it doesn't move anything.
            <tspan key={i} x={it.xs![i]}>
              {i < words.length - 1 ? `${word} ` : word}
            </tspan>
          ))}
    </text>
  );
}
