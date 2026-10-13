/**
 * A cover as a SCENE: everything on the sheet, placed, in points from its
 * top left. One layout, three painters: the screen (SVG), the printer's PDF
 * and the ebook's cover picture all draw this very list, so what is seen is
 * what prints.
 *
 * Its words are set by the book's own typesetting engine, measured with the
 * very font files they are printed from (the browser is not asked how wide
 * a line is: it would answer a little differently, and lines would break
 * elsewhere on paper).
 *
 * Loaded when a cover is first looked at (it brings the engine's composer
 * and the font reader with it).
 */

import { loadFaces, resolveFont, scriptFamilies } from "../../fonts/store";
import { Composer, shift, type TextStyle } from "../engine/compose";
import { FaceSet } from "../engine/faces";
import type { DLItem, DLText, FaceRef } from "../engine/types";
import { printPieces, type BookCover, type CoverSlot } from "./art";
import { COVER_PANELS, DEFAULT_COVER_FONT, type CoverPanel, type CoverText } from "./design";
import { fill, panelTrim, slotBox, textRun, type Box, type CoverGeometry } from "./geometry";

const PT = 72;

/** A box on the sheet, points. */
export type Pt = Box;

export interface ScenePaper {
  clip: Pt;
  color: string;
}

export interface ScenePicture {
  slot: CoverSlot;
  src: string;
  /** The part of the sheet it may show in, and where it is drawn (it
   *  overhangs that part: the rest is cut off). */
  clip: Pt;
  at: Pt;
}

export interface SceneText {
  id: string;
  panel: CoverPanel;
  /** Where its own frame starts on the sheet, and how far it is turned (the
   *  spine's words read from the top down: a quarter turn). */
  origin: { x: number; y: number };
  turn: 0 | 90;
  /** In its own frame: the box its lines are set in, the band of colour
   *  behind them, and the runs of text (each on its baseline). */
  box: Pt;
  band: (Pt & { color: string }) | null;
  items: DLText[];
  /** The box as it lies on the sheet (to outline it, to point at it). */
  bounds: Pt;
}

export interface CoverScene {
  w: number;
  h: number;
  papers: ScenePaper[];
  pictures: ScenePicture[];
  texts: SceneText[];
  /** The faces the runs name (by index), as the screen draws them. */
  faces: FaceRef[];
}

/** The font files a cover's words are set in, read and ready. */
export interface CoverFaces {
  set: FaceSet;
  composer: Composer;
  /** The layout family a font is drawn in (itself, or what stands in). */
  family(font: string): string;
  families: string[];
  /** Fonts that couldn't be fetched (their words are in a stand-in). */
  missing: string[];
}

const exoticOf = (text: string): string => [...new Set([...text].filter((ch) => ch.charCodeAt(0) > 0x7f))].sort().join("");

/** What a cover's words need of fonts: said once, to know when it changes. */
export function facesKey(texts: readonly CoverText[]): string {
  const said = new Map<string, string>();
  for (const t of texts) said.set(t.font, (said.get(t.font) ?? "") + (t.caps ? t.text.toUpperCase() : t.text));
  return JSON.stringify([...said].map(([font, text]) => [font, exoticOf(text)]).sort());
}

const kept = new Map<string, Promise<CoverFaces>>();

/** The faces for these words (fetched once for each set of fonts). */
export function coverFaces(texts: readonly CoverText[]): Promise<CoverFaces> {
  const key = facesKey(texts);
  let job = kept.get(key);
  if (!job) {
    job = readFaces(JSON.parse(key) as [string, string][]);
    kept.set(key, job);
    // (A few sets back are worth keeping; a failure is asked for again.)
    job.catch(() => kept.delete(key));
    if (kept.size > 6) kept.delete(kept.keys().next().value!);
  }
  return job;
}

async function readFaces(fonts: [string, string][]): Promise<CoverFaces> {
  const drawn = new Map<string, string>();
  const chains: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const [font, exotic] of fonts.length ? fonts : ([[DEFAULT_COVER_FONT, ""]] as [string, string][])) {
    const face = await resolveFont(font);
    drawn.set(font, face.family);
    if (face.substituted) missing.push(face.asked);
    // (A family from the library comes split by script.)
    const more = exotic ? await scriptFamilies(face.family, exotic) : [];
    if (more.length) chains[face.family] = more;
  }
  const families = [...new Set([...drawn.values(), ...Object.values(chains).flat()])];
  const set = new FaceSet(await loadFaces(families));
  const composer = new Composer(set, null, "en");
  composer.chains = chains;
  return { set, composer, family: (font) => drawn.get(font) ?? drawn.values().next().value ?? DEFAULT_COVER_FONT, families, missing };
}

const pt = (b: Box): Pt => ({ x: b.x * PT, y: b.y * PT, w: b.w * PT, h: b.h * PT });

/** One piece of text, set. */
function setText(t: CoverText, g: CoverGeometry, f: CoverFaces): SceneText {
  const trim = panelTrim(g, t.panel);
  const spine = t.panel === "spine";
  // Its frame: the panel as trimmed. The spine's is turned a quarter, so
  // that "across" runs down the spine and the lines read from the top.
  const run = textRun(g, t.panel);
  const deep = (spine ? trim.w : trim.h) * PT;
  const origin = spine ? { x: (trim.x + trim.w) * PT, y: trim.y * PT } : { x: trim.x * PT, y: trim.y * PT };
  const family = f.family(t.font);
  const style: TextStyle = { family, size: t.size, bold: t.bold, italic: t.italic, caps: t.caps ? "upper" : "none", tracking: t.tracking / 1000, color: t.color };
  const width = Math.max(4, t.w * run);
  const face = f.set.face(family, t.bold ? (t.italic ? "boldItalic" : "bold") : t.italic ? "italic" : "regular");
  const rise = f.set.ascent(face) * t.size;
  const fall = f.set.descent(face) * t.size;
  const line = t.size * t.leading;

  // Every line the writer made is a paragraph of its own (an empty one, a
  // line left blank); each is broken where the box is too narrow for it.
  const lines: (DLItem[] | null)[] = [];
  for (const said of t.text.split("\n")) {
    if (said.trim() === "") {
      lines.push(null);
      continue;
    }
    const para = f.composer.setParagraph({ runs: [{ text: said }], style, width, align: t.align, firstFit: true, hyphenate: false });
    for (const set of para.lines) lines.push(set.items);
  }
  const height = Math.max(1, lines.length) * line;
  const left = t.x * run;
  // On the spine the lines sit in its middle (a single line by the height of
  // its capitals, which is what the eye centres).
  const top = spine ? (lines.length === 1 ? deep / 2 + (f.set.capHeight(face) * t.size) / 2 - ((line - rise - fall) / 2 + rise) : (deep - height) / 2) : t.y * deep;
  const first = top + (line - rise - fall) / 2 + rise;
  const items: DLText[] = [];
  lines.forEach((set, i) => {
    if (!set) return;
    for (const it of shift(set, left, first + i * line)) if (it.t === "text") items.push(it);
  });
  const box: Pt = { x: left, y: top, w: width, h: height };
  const pad = t.size * 0.3;
  const band = t.back ? { x: left - pad, y: top - pad * 0.6, w: width + pad * 2, h: height + pad * 1.2, color: t.back } : null;
  const bounds: Pt = spine ? { x: origin.x - box.y - box.h, y: origin.y + box.x, w: box.h, h: box.w } : { x: origin.x + box.x, y: origin.y + box.y, w: box.w, h: box.h };
  return { id: t.id, panel: t.panel, origin, turn: spine ? 90 : 0, box, band, items, bounds };
}

/**
 * The cover, placed. Without `faces` (they are still being fetched) it has
 * its paper and its pictures, and no words yet.
 */
export function buildScene(cover: BookCover, g: CoverGeometry, faces: CoverFaces | null): CoverScene {
  return {
    w: g.w * PT,
    h: g.h * PT,
    papers: COVER_PANELS.map((panel) => ({ clip: pt(slotBox(g, panel)), color: cover.looks[panel].color })),
    pictures: printPieces(cover).map((slot) => {
      const clip = slotBox(g, slot);
      return { slot, src: cover[slot]!.src, clip: pt(clip), at: pt(fill(cover[slot]!, clip, cover.looks[slot])) };
    }),
    texts: faces ? cover.texts.map((t) => setText(t, g, faces)) : [],
    faces: faces ? faces.set.faces : [],
  };
}

/** Whether the front of the cover is more than its picture as it came: has
 *  words on it, a colour, a picture moved or enlarged, or is part of a
 *  whole cover. (An ebook's cover is then drawn, not just handed over.) */
export function frontIsMade(cover: BookCover): boolean {
  if (cover.texts.some((t) => t.panel === "front" && t.text.trim() !== "")) return true;
  if (cover.wrap) return true;
  const look = cover.looks.front;
  if (!cover.front) return look.color !== "#ffffff";
  return look.zoom !== 1 || look.fx !== 0.5 || look.fy !== 0.5;
}
