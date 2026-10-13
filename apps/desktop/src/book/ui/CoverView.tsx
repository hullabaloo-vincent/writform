import { useEffect, useId, useMemo, useState, type ReactNode, type Ref } from "react";

import { showFamilies } from "../../fonts/store";
import { normalizeAttachmentSrc } from "../../lib/backend";
import type { BookCover } from "../cover/art";
import { BLEED, SAFE, type Box, type CoverGeometry } from "../cover/geometry";
import type { CoverFaces, CoverScene } from "../cover/scene";
import { TextRun } from "../preview/PageSvg";

const PT = 72;

/** Which part of the sheet is looked at. The spine is shown lying on its
 *  side, so that what is written down it can be read (and worked on). */
export type CoverViewOf = "all" | "front" | "back" | "spine";

/**
 * A cover's scene for these words and pictures: the engine's composer and
 * the fonts are fetched when a cover is first looked at, and again when its
 * words name a font they haven't had. Until they are here the scene has the
 * paper and the pictures, and no words.
 */
export function useCoverScene(cover: BookCover, g: CoverGeometry): { scene: CoverScene | null; standIns: string[] } {
  const [mod, setMod] = useState<typeof import("../cover/scene") | null>(null);
  const [faces, setFaces] = useState<CoverFaces | null>(null);
  useEffect(() => {
    let live = true;
    void import("../cover/scene").then((m) => live && setMod(m));
    return () => {
      live = false;
    };
  }, []);
  const key = mod ? mod.facesKey(cover.texts) : "";
  useEffect(() => {
    if (!mod) return;
    let live = true;
    void mod
      .coverFaces(cover.texts)
      .then(async (found) => {
        // (So the page can draw in them: the library's are fetched files.)
        await showFamilies(found.families).catch(() => {});
        if (live) setFaces(found);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` says all of the words that matters here
  }, [mod, key]);
  const scene = useMemo(() => (mod ? mod.buildScene(cover, g, faces) : null), [mod, cover, g, faces]);
  return { scene, standIns: faces?.missing ?? [] };
}

/** The window onto the sheet for a view: what part of it shows (in the
 *  view's own frame) and how the sheet is turned into that frame. */
export function viewFrame(g: CoverGeometry, view: CoverViewOf, guides: boolean): { box: Box; turn: string } {
  const edge = guides ? 0 : BLEED;
  if (view === "spine") {
    // The spine's own frame: along it left to right, a little of the covers
    // on either side to see what it sits between.
    const beside = Math.max(0.2, Math.min(0.5, g.spine));
    return {
      box: { x: (edge - BLEED) * PT, y: -beside * PT, w: (g.h - edge * 2) * PT, h: (g.spine + beside * 2) * PT },
      turn: `rotate(-90) translate(${-(g.spineBox.x + g.spine) * PT} ${-BLEED * PT})`,
    };
  }
  if (view === "front" || view === "back") {
    const panel = view === "front" ? g.front : g.back;
    const x = view === "front" ? panel.x : panel.x + edge;
    return { box: { x: x * PT, y: edge * PT, w: (panel.w - edge) * PT, h: (g.h - edge * 2) * PT }, turn: "" };
  }
  return { box: { x: edge * PT, y: edge * PT, w: (g.w - edge * 2) * PT, h: (g.h - edge * 2) * PT }, turn: "" };
}

/** The printer's guides, over the sheet: what is trimmed off, the margin
 *  to keep clear, the spine, the barcode. */
function Guides({ g }: { g: CoverGeometry }) {
  const W = g.w * PT;
  const H = g.h * PT;
  const b = BLEED * PT;
  const safe = SAFE * PT;
  const trimW = g.trim.w * PT;
  const trimH = g.trim.h * PT;
  const spineX = g.spineBox.x * PT;
  const spineW = g.spine * PT;
  return (
    <g className="wf-cover-guides" pointerEvents="none">
      <path className="trimmed" fillRule="evenodd" d={`M0 0H${W}V${H}H0Z M${b} ${b}V${H - b}H${W - b}V${b}Z`} />
      <rect className="safe" x={b + safe} y={b + safe} width={trimW - safe * 2} height={trimH - safe * 2} />
      <rect className="safe" x={g.front.x * PT + safe} y={b + safe} width={trimW - safe * 2} height={trimH - safe * 2} />
      <line className="fold" x1={spineX} y1={0} x2={spineX} y2={H} />
      <line className="fold" x1={spineX + spineW} y1={0} x2={spineX + spineW} y2={H} />
      <rect className="barcode" x={g.barcode.x * PT} y={g.barcode.y * PT} width={g.barcode.w * PT} height={g.barcode.h * PT} />
      <text className="barcode-word" x={(g.barcode.x + g.barcode.w / 2) * PT} y={(g.barcode.y + g.barcode.h / 2) * PT + 3} textAnchor="middle">
        Barcode
      </text>
    </g>
  );
}

/**
 * The cover, drawn: its scene as SVG (the very runs of text the PDF gets,
 * in the same fonts), looked at whole or one part at a time. With `guides`,
 * the whole sheet with the printer's marks on it. Without, the cover as it
 * comes back from the printer.
 *
 * `children` are drawn over it in the sheet's own points (the editor's
 * outlines and handles); `sheetRef` is that frame, for turning a pointer's
 * place on screen into a place on the sheet.
 */
export function CoverSvg({
  g,
  scene,
  view = "all",
  guides,
  className,
  svgRef,
  sheetRef,
  children,
  ...rest
}: {
  g: CoverGeometry;
  scene: CoverScene | null;
  view?: CoverViewOf;
  guides: boolean;
  className?: string;
  svgRef?: Ref<SVGSVGElement>;
  sheetRef?: Ref<SVGGElement>;
  children?: ReactNode;
} & Omit<React.SVGProps<SVGSVGElement>, "ref" | "viewBox" | "children">) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const frame = viewFrame(g, view, guides);
  const W = g.w * PT;
  const H = g.h * PT;
  return (
    <svg
      ref={svgRef}
      className={`wf-cover-svg${className ? ` ${className}` : ""}`}
      viewBox={`${frame.box.x} ${frame.box.y} ${frame.box.w} ${frame.box.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="The paperback cover laid flat: back, spine and front"
      {...rest}
    >
      <g ref={sheetRef} transform={frame.turn || undefined}>
        <rect className="wf-cover-paper" x={0} y={0} width={W} height={H} />
        {scene?.papers.map((paper, i) => (paper.color === "#ffffff" ? null : <rect key={i} x={paper.clip.x} y={paper.clip.y} width={paper.clip.w} height={paper.clip.h} fill={paper.color} />))}
        {scene?.pictures.map((picture) => (
          <g key={picture.slot}>
            <clipPath id={`${id}-${picture.slot}`}>
              <rect x={picture.clip.x} y={picture.clip.y} width={picture.clip.w} height={picture.clip.h} />
            </clipPath>
            <image
              href={normalizeAttachmentSrc(picture.src)}
              x={picture.at.x}
              y={picture.at.y}
              width={picture.at.w}
              height={picture.at.h}
              preserveAspectRatio="none"
              clipPath={`url(#${id}-${picture.slot})`}
            />
          </g>
        ))}
        {scene?.texts.map((text) => (
          <g key={text.id} data-text={text.id} transform={`translate(${text.origin.x} ${text.origin.y})${text.turn ? ` rotate(${text.turn})` : ""}`}>
            {/* (The whole of its box is the words' to be pressed on, not only the ink of the letters.) */}
            <rect x={text.box.x} y={text.box.y} width={text.box.w} height={text.box.h} fill="none" pointerEvents="all" />
            {text.band && <rect x={text.band.x} y={text.band.y} width={text.band.w} height={text.band.h} fill={text.band.color} />}
            {text.items.map((it, i) => (
              <TextRun key={i} it={it} face={scene.faces[it.face]} />
            ))}
          </g>
        ))}
        {guides && <Guides g={g} />}
        {children}
      </g>
    </svg>
  );
}
