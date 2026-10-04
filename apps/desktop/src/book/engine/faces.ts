/**
 * The typefaces a layout uses, parsed once with fontkit: measurement (with
 * kerning and ligatures, per word — exactly how the PDF writer lays text),
 * style fallbacks (a family without bold is drawn bold by stroking), and
 * missing-glyph detection for preflight.
 */

import * as fontkit from "fontkit";

import { bookFont } from "../fonts/registry";
import type { FaceRef, StyleKey } from "./types";

export interface FaceBytes {
  family: string;
  style: StyleKey;
  bytes: Uint8Array;
}

const FALLBACK: Record<StyleKey, StyleKey[]> = {
  regular: ["regular"],
  italic: ["italic", "regular"],
  bold: ["bold", "regular"],
  boldItalic: ["boldItalic", "bold", "italic", "regular"],
};

interface Shaped {
  /** Advance in font units. */
  units: number;
  glyphs: number;
  /** Characters the face has no glyph for. */
  missing?: string[];
  /** Per glyph: the string offset it starts at, and its advance (units).
   *  Only kept when a word's parts were asked for. */
  starts?: number[];
  advances?: number[];
}

interface FontInfo {
  font: fontkit.Font;
  upm: number;
  features: Set<string>;
}

/**
 * fontkit re-selects the script and rebuilds its feature table on every
 * layout() call that doesn't name a language (most of the cost of shaping
 * a word). A book is one script, so remembering the last selection per
 * processor is equivalent — and makes both the layout and PDFKit, which
 * shapes with the same font objects, several times faster. If fontkit's
 * internals ever change shape, this quietly does nothing.
 */
function rememberScript(font: fontkit.Font) {
  try {
    const engine = (font as unknown as { _layoutEngine?: { engine?: Record<string, unknown> } })._layoutEngine?.engine;
    for (const key of ["GSUBProcessor", "GPOSProcessor"]) {
      const proc = engine?.[key] as
        | { selectScript?: (script?: string, language?: string, direction?: string) => string; scriptTag?: string; wfRemembers?: boolean }
        | null
        | undefined;
      if (!proc || typeof proc.selectScript !== "function" || proc.wfRemembers) continue;
      const original = proc.selectScript.bind(proc);
      let last: string | null = null;
      proc.selectScript = (script, language, direction) => {
        const args = `${script}|${language}|${direction}`;
        if (args === last && proc.scriptTag !== undefined) return proc.scriptTag;
        last = args;
        return original(script, language, direction);
      };
      proc.wfRemembers = true;
    }
  } catch {
    // No speed-up; shaping is still correct.
  }
}

export class FaceSet {
  readonly faces: FaceRef[] = [];
  private readonly fonts: FontInfo[] = [];
  private readonly parsed = new Map<string, FontInfo>();
  private readonly index = new Map<string, number>();
  private readonly shaped = new Map<string, Shaped>();
  readonly missing = new Map<string, Set<string>>();

  constructor(files: FaceBytes[]) {
    for (const f of files) {
      const font = fontkit.create(f.bytes as never) as unknown as fontkit.Font;
      // The first layout builds the engine; then its script choice sticks.
      font.layout("a");
      rememberScript(font);
      this.parsed.set(`${f.family}:${f.style}`, { font, upm: font.unitsPerEm, features: new Set(font.availableFeatures) });
    }
  }

  /** The face for a family + style (index into `faces`), with fallbacks. */
  face(family: string, style: StyleKey): number {
    const key = `${family}:${style}`;
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;
    let info: FontInfo | undefined;
    let used: StyleKey = style;
    for (const candidate of FALLBACK[style]) {
      info = this.parsed.get(`${family}:${candidate}`);
      if (info) {
        used = candidate;
        break;
      }
    }
    if (!info) {
      // The family isn't loaded at all: the first loaded face stands in.
      const first = this.parsed.values().next().value;
      if (!first) throw new Error("No fonts loaded");
      info = first;
      used = "regular";
    }
    const wantsBold = style === "bold" || style === "boldItalic";
    const isBold = used === "bold" || used === "boldItalic";
    const italic = style === "italic" || style === "boldItalic";
    const ref: FaceRef = {
      family,
      style,
      fakeBold: wantsBold && !isBold,
      cssFamily: bookFont(family).css,
      cssStyle: italic ? "italic" : "normal",
      cssWeight: wantsBold ? 700 : 400,
    };
    const i = this.faces.length;
    this.faces.push(ref);
    this.fonts.push(info);
    this.index.set(key, i);
    return i;
  }

  font(face: number): fontkit.Font {
    return this.fonts[face].font;
  }

  hasFeature(face: number, feature: string): boolean {
    return this.fonts[face].features.has(feature);
  }

  /** Start a new layout: missing glyphs are reported per run (shapes are
   *  cached across runs, so they carry their own record). */
  resetMissing() {
    this.missing.clear();
  }

  private noteMissing(face: number, chars: string[]) {
    const family = this.faces[face].family;
    const set = this.missing.get(family) ?? new Set<string>();
    for (const ch of chars) set.add(ch);
    this.missing.set(family, set);
  }

  private shape(face: number, text: string, features: string[] | undefined, parts: boolean): Shaped {
    const key = `${face}|${features?.join(",") ?? ""}|${text}`;
    const hit = this.shaped.get(key);
    if (hit && (!parts || hit.starts)) {
      if (hit.missing) this.noteMissing(face, hit.missing);
      return hit;
    }
    const run = this.fonts[face].font.layout(text, features);
    const shaped: Shaped = { units: run.advanceWidth, glyphs: run.glyphs.length };
    let offset = 0;
    const starts: number[] = [];
    const advances: number[] = [];
    run.glyphs.forEach((g, i) => {
      if (g.id === 0) {
        shaped.missing ??= [];
        for (const cp of g.codePoints) shaped.missing.push(String.fromCodePoint(cp));
      }
      if (parts) {
        starts.push(offset);
        advances.push(run.positions[i].xAdvance);
        for (const cp of g.codePoints) offset += cp > 0xffff ? 2 : 1;
      }
    });
    // Glyph clusters that don't account for the text exactly (decomposed
    // characters) can't be split reliably.
    if (parts && offset === text.length) {
      shaped.starts = starts;
      shaped.advances = advances;
    }
    if (shaped.missing) this.noteMissing(face, shaped.missing);
    this.shaped.set(key, shaped);
    return shaped;
  }

  /** Width of `text` at `size` pt, shaped as one run (kerning, ligatures,
   *  `features`) — the PDF writer shapes each word the same way. `cs` is
   *  letter spacing, added after every glyph (PDF's Tc). */
  measure(face: number, size: number, text: string, features?: string[], cs = 0): number {
    if (!text) return 0;
    const s = this.shape(face, text, features, false);
    return (s.units * size) / this.fonts[face].upm + cs * s.glyphs;
  }

  /**
   * Widths of the pieces of `text` between `cuts` (string offsets), from
   * shaping the whole text once: each glyph counts toward the piece its
   * first character is in (a ligature across a cut goes to the first
   * piece; kerning across it is approximate). Good for choosing breaks —
   * lines are re-measured exactly once they're set.
   */
  measureParts(face: number, size: number, text: string, cuts: number[], features?: string[], cs = 0): number[] {
    const s = this.shape(face, text, features, true);
    if (!s.starts || !s.advances) {
      const bounds = [0, ...cuts, text.length];
      return bounds.slice(1).map((end, i) => this.measure(face, size, text.slice(bounds[i], end), features, cs));
    }
    const scale = size / this.fonts[face].upm;
    const out = new Array<number>(cuts.length + 1).fill(0);
    let piece = 0;
    for (let g = 0; g < s.starts.length; g += 1) {
      while (piece < cuts.length && s.starts[g] >= cuts[piece]) piece += 1;
      out[piece] += s.advances[g] * scale + cs;
    }
    return out;
  }

  /** Whether every character of `text` has a glyph in this face. */
  covers(face: number, text: string): boolean {
    const font = this.fonts[face].font;
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      if (!font.hasGlyphForCodePoint(ch.codePointAt(0)!)) return false;
    }
    return true;
  }

  /** Whether a family's files were loaded (fallbacks stand in otherwise). */
  has(family: string): boolean {
    for (const key of this.parsed.keys()) if (key.startsWith(`${family}:`)) return true;
    return false;
  }

  /** Cap height as a fraction of the em. */
  capHeight(face: number): number {
    const { font, upm } = this.fonts[face];
    return (font.capHeight || font.ascent * 0.7) / upm;
  }

  ascent(face: number): number {
    const { font, upm } = this.fonts[face];
    return font.ascent / upm;
  }

  /** Size factor for small capitals drawn as reduced capitals (faces without
   *  real ones): a little taller than the x-height, as real small caps are. */
  smallCapScale(face: number): number {
    const { font } = this.fonts[face];
    const cap = font.capHeight || font.ascent * 0.7;
    const x = font.xHeight || cap * 0.66;
    return Math.min(0.82, Math.max(0.68, (x * 1.12) / cap));
  }
}
