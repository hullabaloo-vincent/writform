/**
 * A screenplay read from its pages.
 *
 * A screenplay's elements sit at fixed places across the page: scene
 * headings and action at the margin, a character's name near the middle,
 * what is said in a narrower column under it. Those places, and the words
 * a scene heading or a transition is written in, say what each line is.
 */

import type { Line, ParaBlock } from "./model";
import { seam } from "./paras";

const SCENE_HEADING = /^(?:INT\.|EXT\.|INT\.?\/EXT\.?|I\/E\.|EST\.)(?:\s|$)/i;
const TRANSITION = /^(?:FADE (?:IN|OUT)|CUT TO BLACK)|(?:TO:|FADE OUT\.?|DISSOLVE TO:|MATCH CUT TO:)$/i;

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

function isCue(line: Line, pageWidth: number): boolean {
  const position = line.x0 / pageWidth;
  return position >= 0.34 && position <= 0.68 && line.text.length <= 48 && isAllCaps(line.text) && !SCENE_HEADING.test(line.text) && !TRANSITION.test(line.text);
}

/** Whether these pages are a screenplay's. */
export function looksLikeScreenplay(lines: Line[], widthOf: (page: number) => number): boolean {
  const scenes = lines.filter((line) => SCENE_HEADING.test(line.text)).length;
  if (scenes >= 2) return true;
  const cues = lines.filter((line) => isCue(line, widthOf(line.page))).length;
  const transitions = lines.filter((line) => TRANSITION.test(line.text)).length;
  return scenes >= 1 && cues >= 3 && transitions >= 1;
}

function elementOf(line: Line, pageWidth: number, previous: string | undefined): string {
  const position = line.x0 / pageWidth;
  if (SCENE_HEADING.test(line.text)) return "scene_heading";
  if (TRANSITION.test(line.text) && position > 0.45) return "transition";
  if (/^\(.+\)$/.test(line.text) && position > 0.28) return "parenthetical";
  if (isCue(line, pageWidth)) return "character";
  if (position >= 0.25 && position <= 0.62 && (previous === "character" || previous === "parenthetical" || previous === "dialogue")) return "dialogue";
  return "action";
}

/** The lines of a screenplay (down each page) as its elements. */
export function screenplayBlocks(lines: Line[], widthOf: (page: number) => number): ParaBlock[] {
  const out: ParaBlock[] = [];
  let text = "";
  let element: string | undefined;
  let first: Line | null = null;
  let prev: Line | null = null;
  let count = 0;
  const flush = () => {
    if (text && first) out.push({ kind: "para", spans: [{ text }], page: first.page, size: first.size, bold: false, lines: count, x: 0, element });
    text = "";
    element = undefined;
    first = null;
    count = 0;
  };
  for (const line of lines) {
    const kind = elementOf(line, widthOf(line.page), element);
    const gap = prev && prev.page === line.page ? line.y - prev.y : Infinity;
    const wraps = kind === "action" || kind === "dialogue";
    const same = element === kind && text.length > 0 && wraps && prev?.page === line.page && gap <= Math.max(prev.size, line.size) * 1.55;
    if (!same) flush();
    if (!text) {
      text = line.text;
      element = kind;
      first = line;
    } else {
      const { cut, glue } = seam(text, line.text, new Set());
      text = (cut ? text.slice(0, -1) : text) + glue + line.text;
    }
    count += 1;
    prev = line;
  }
  flush();
  return out;
}
