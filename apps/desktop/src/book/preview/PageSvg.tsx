import { memo } from "react";

import { normalizeAttachmentSrc } from "../../lib/backend";
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
      {page.items.map((it, i) => item(it, i, dl.faces))}
    </svg>
  );
});

function item(it: DLItem, key: number, faces: FaceRef[]) {
  if (it.t === "text") return <TextRun key={key} it={it} face={faces[it.face]} />;
  if (it.t === "rule") {
    return <line key={key} x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={it.color ?? "currentColor"} strokeWidth={it.w} />;
  }
  if (it.t === "rect") return <rect key={key} x={it.x} y={it.y} width={it.w} height={it.h} fill={it.color} />;
  // Links and anchors are for the PDF; the preview only shows the page.
  if (it.t === "link" || it.t === "anchor") return null;
  return (
    <image
      key={key}
      href={normalizeAttachmentSrc(it.ref)}
      x={it.x}
      y={it.y}
      width={it.w}
      height={it.h}
      preserveAspectRatio="xMidYMid meet"
    />
  );
}

function TextRun({ it, face }: { it: DLText; face: FaceRef | undefined }) {
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
