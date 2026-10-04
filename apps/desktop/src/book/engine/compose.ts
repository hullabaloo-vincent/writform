/**
 * Setting a paragraph: styled runs → words → boxes, glue and penalties →
 * optimal line breaks → lines of positioned text (display-list items).
 *
 * Handles first-line indents, drop caps (the first lines narrowed around
 * the initial), small-caps lead-ins (real small caps when the font has
 * them, reduced capitals when it doesn't), hyphenation by patterns, soft
 * hyphens, explicit hyphens and dashes, hard line breaks, and justified,
 * ragged, centered and balanced settings.
 *
 * Measurement matches the PDF writer exactly: each word is shaped on its
 * own (kerning and ligatures inside the word), and a space is the face's
 * own space plus the line's justification — PDFKit draws precisely that.
 */

import { bookFont } from "../fonts/registry";
import type { Run } from "../model/types";
import type { FaceSet } from "./faces";
import type { Hyphenator } from "./hyphenate";
import { breakLines, FIL, INF_PENALTY, Items, lineStarts } from "./linebreak";
import type { DLItem, DLRule, DLText, StyleKey } from "./types";

export type Caps = "none" | "small" | "all" | "upper";

export interface TextStyle {
  family: string;
  size: number;
  italic?: boolean;
  bold?: boolean;
  /** small = lowercase as small capitals; all = every letter small;
   *  upper = uppercase. */
  caps?: Caps;
  /** Letter spacing, em. */
  tracking?: number;
  /** OpenType features always on (old-style figures…). */
  features?: string[];
  /** Italic is drawn as underlined roman (the manuscript convention). */
  underlineItalic?: boolean;
}

export type Align = "justify" | "left" | "center" | "right";

export interface DropCap {
  lines: number;
  family: string;
  /** The body's line spacing (the cap spans `lines` of it). */
  leading: number;
}

export interface ParaInput {
  runs: Run[];
  style: TextStyle;
  width: number;
  align: Align;
  /** First-line indent, pt. */
  indent?: number;
  /** Indent of every line after the first (verse turnovers), pt. */
  hang?: number;
  hyphenate?: boolean;
  /** The block is italic: emphasis inside it flips to roman. */
  italicBlock?: boolean;
  dropCap?: DropCap | null;
  leadIn?: "none" | "first-line" | "first-words";
  /** Even out the lines (titles): the narrowest measure that keeps the
   *  same number of lines. */
  balance?: boolean;
  /** Manuscript block (click-to-source). */
  src?: number;
}

export interface SetLine {
  /** x from the paragraph's left edge; y from the line's baseline. */
  items: DLItem[];
  /** Width the line's text occupies (from its first glyph). */
  width: number;
}

export interface SetPara {
  lines: SetLine[];
  overfull: number;
  /** The first lines that must stay on one page (a drop cap's height). */
  keepFirst: number;
  /** The same paragraph one line looser (+1) or tighter (−1), when that's
   *  possible within tolerance; null otherwise. */
  rebreak(looseness: number): SetPara | null;
}

interface Glyphs {
  text: string;
  face: number;
  size: number;
  feat?: string[];
  /** Letter spacing, pt. */
  cs: number;
  underline: boolean;
  w: number;
}

interface Piece {
  text: string;
  style: TextStyle;
}

interface Word {
  pieces: Piece[];
  lead: boolean;
}

type Token = { k: "word"; w: Word } | { k: "space" } | { k: "br" };

interface WordBreak {
  penalty: number;
  flagged: boolean;
  auto: boolean;
  /** A hyphen is added when the line breaks here. */
  hyphen: boolean;
}

interface Prepared {
  input: ParaInput;
  items: Items;
  /** Box payloads: the glyph runs of one syllable and its word index. */
  syl: { glyphs: Glyphs[]; word: number }[];
  /** Line widths for breaking (by line; last repeats). */
  widths: number[];
  /** Left offset of each line (drop cap, hang). */
  offsets: number[];
  /** Width each line is aligned within. */
  avail: number[];
  dropItems: DLItem[];
  dropLines: number;
  /** Lead-in words requested. */
  lead: number;
}

// Breaking spaces only: no-break, figure and narrow no-break spaces stay
// inside their word.
const SPACES = /([ \t\r\n\u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+)/;
const ONLY_SPACES = /^[ \t\r\n\u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+$/;
const INVISIBLE = /[\u200b\u2060\ufeff]/g;
const SOFT_HYPHEN = "\u00ad";
const LETTER = /\p{L}/u;

const featKey = (f?: string[]) => (f && f.length ? f.join(",") : "");

function sameRun(a: { face: number; size: number; feat?: string[]; cs?: number }, b: Glyphs, aUnderline: boolean) {
  return a.face === b.face && a.size === b.size && featKey(a.feat) === featKey(b.feat) && (a.cs ?? 0) === b.cs && aUnderline === b.underline;
}

export class Composer {
  constructor(
    private readonly faces: FaceSet,
    private readonly hyphenator: Hyphenator | null,
    private readonly lang: string,
  ) {}

  /** When a style draws its text as-is in one run (no case change, no
   *  reduced capitals), the run's parameters; null otherwise. */
  private plain(style: TextStyle, lead: boolean): Omit<Glyphs, "text" | "w"> | null {
    const caps: Caps = lead && (!style.caps || style.caps === "none") ? "small" : (style.caps ?? "none");
    const underline = !!(style.underlineItalic && style.italic);
    const italic = !!style.italic && !style.underlineItalic;
    const face = this.faces.face(style.family, style.bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular");
    const base = style.features?.length ? style.features : undefined;
    let feat = base;
    if (caps === "small") {
      if (this.faces.hasFeature(face, "smcp")) feat = [...(base ?? []), "smcp"];
      else if (!bookFont(style.family).caseless) return null;
    } else if (caps !== "none") {
      return null;
    }
    return { face, size: style.size, feat, cs: (style.tracking ?? 0) * style.size, underline };
  }

  /** Shape one piece of text in a style: one glyph run, or several when
   *  small capitals are drawn as reduced capitals. */
  shape(text: string, style: TextStyle, lead = false): Glyphs[] {
    const underline = !!(style.underlineItalic && style.italic);
    const italic = !!style.italic && !style.underlineItalic;
    const key: StyleKey = style.bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular";
    const face = this.faces.face(style.family, key);
    const size = style.size;
    const tracking = style.tracking ?? 0;
    const base = style.features?.length ? style.features : undefined;
    const caps: Caps = lead && (!style.caps || style.caps === "none") ? "small" : (style.caps ?? "none");
    const out: Glyphs[] = [];
    const add = (t: string, sz: number, feat?: string[]) => {
      if (!t) return;
      const cs = tracking * sz;
      out.push({ text: t, face, size: sz, feat, cs, underline, w: this.faces.measure(face, sz, t, feat, cs) });
    };
    const info = bookFont(style.family);
    const real = this.faces.hasFeature(face, "smcp");
    switch (caps) {
      case "upper":
        add(text.toLocaleUpperCase(this.lang), size, base);
        break;
      case "small":
        if (real) add(text, size, [...(base ?? []), "smcp"]);
        else if (info.caseless) add(text, size, base);
        else {
          const scale = this.faces.smallCapScale(face);
          for (const m of text.matchAll(/(\p{Ll}+)|([^\p{Ll}]+)/gu)) {
            if (m[1]) add(m[1].toLocaleUpperCase(this.lang), size * scale, base);
            else add(m[2], size, base);
          }
        }
        break;
      case "all":
        if (real && this.faces.hasFeature(face, "c2sc")) add(text, size, [...(base ?? []), "c2sc", "smcp"]);
        else if (info.caseless) add(text.toLocaleLowerCase(this.lang), size, base);
        else add(text.toLocaleUpperCase(this.lang), size * this.faces.smallCapScale(face), base);
        break;
      default:
        add(text, size, base);
    }
    return out;
  }

  /**
   * One line of display text (a label, running head, folio): items from
   * x = 0 on the baseline, and the width they take.
   */
  setLine(text: string, style: TextStyle, src?: number): { items: DLText[]; width: number } {
    const words = text.split(SPACES).filter((w) => w && !ONLY_SPACES.test(w));
    const items: DLText[] = [];
    let x = 0;
    let cur: DLText | null = null;
    words.forEach((word, wi) => {
      const glyphs = this.shape(word, style);
      glyphs.forEach((g, gi) => {
        if (cur && gi === 0 && wi > 0 && sameRun(cur, g, false)) {
          cur.text += ` ${g.text}`;
          cur.xs!.push(x);
        } else {
          cur = textItem(g, x, src);
          items.push(cur);
        }
        x += g.w;
      });
      if (wi < words.length - 1) {
        const last = glyphs[glyphs.length - 1];
        x += last ? this.faces.measure(last.face, last.size, " ") + last.cs : 0;
      }
    });
    return { items, width: x };
  }

  setParagraph(input: ParaInput): SetPara {
    if (input.leadIn === "first-line") {
      // Small capitals change the first line's width, which changes how
      // many words fit: iterate until the small caps fill exactly line one.
      let lead = 0;
      let best: { para: SetPara; first: number; lead: number } | null = null;
      for (let iter = 0; iter < 5; iter += 1) {
        const prepared = this.prepare(input, lead);
        const { para, firstLineWords } = this.set(prepared, 0);
        const candidate = { para, first: firstLineWords, lead };
        if (firstLineWords === lead && lead > 0) return para;
        // Prefer runs where every small-capped word is on line one.
        if (!best || (lead > 0 && candidate.first > candidate.lead && (best.lead === 0 || best.first < best.lead))) {
          best = candidate;
        }
        if (firstLineWords === lead) break;
        lead = firstLineWords;
      }
      return best!.para;
    }
    return this.set(this.prepare(input, input.leadIn === "first-words" ? 3 : 0), 0).para;
  }

  private tokenize(input: ParaInput): Token[] {
    const tokens: Token[] = [];
    const base = input.style;
    const last = () => tokens[tokens.length - 1];
    for (const run of input.runs) {
      if (run.text === "\n") {
        while (last()?.k === "space") tokens.pop();
        tokens.push({ k: "br" });
        continue;
      }
      const italic = input.italicBlock ? !run.italic : !!run.italic || !!base.italic;
      const style: TextStyle = { ...base, italic, bold: !!run.bold || !!base.bold };
      for (const part of run.text.replace(INVISIBLE, "").split(SPACES)) {
        if (!part) continue;
        if (ONLY_SPACES.test(part)) {
          const prev = last();
          if (prev && prev.k === "word") tokens.push({ k: "space" });
          continue;
        }
        const prev = last();
        if (prev?.k === "word") prev.w.pieces.push({ text: part, style });
        else tokens.push({ k: "word", w: { pieces: [{ text: part, style }], lead: false } });
      }
    }
    while (last()?.k === "space" || last()?.k === "br") tokens.pop();
    return tokens;
  }

  private prepare(input: ParaInput, leadWords: number): Prepared {
    const tokens = this.tokenize(input);
    const style = input.style;
    const bodyFace = this.faces.face(style.family, "regular");

    // ---- drop cap: the initial comes out of the text and is drawn large
    // beside the first lines, which are narrowed to make room.
    const dropItems: DLItem[] = [];
    let dropW = 0;
    let dropLines = 0;
    const dc = input.dropCap;
    const first = tokens[0];
    if (dc && dc.lines >= 2 && first?.k === "word") {
      const piece = first.w.pieces[0];
      const m = /^([“"‘'([«„]*)(\p{L}|\p{N})/u.exec(piece.text);
      if (m) {
        piece.text = piece.text.slice(m[0].length);
        if (!piece.text) first.w.pieces.shift();
        const capFace = this.faces.face(dc.family, "regular");
        const bodyCap = this.faces.capHeight(bodyFace) * style.size;
        const size = ((dc.lines - 1) * dc.leading + bodyCap) / this.faces.capHeight(capFace);
        let x = 0;
        if (m[1]) {
          const q = this.shape(m[1], { ...style, italic: false, bold: false })[0];
          dropItems.push(textItem(q, 0, input.src));
          x = q.w + style.size * 0.04;
        }
        const capW = this.faces.measure(capFace, size, m[2]);
        dropItems.push({
          t: "text",
          x,
          y: (dc.lines - 1) * dc.leading,
          face: capFace,
          size,
          text: m[2],
          xs: [x],
          ...(input.src !== undefined ? { src: input.src } : {}),
        });
        dropW = x + capW + style.size * 0.18;
        if (!first.w.pieces.length) {
          // A one-letter first word ("A dark night"): keep a word space.
          tokens.shift();
          if (tokens[0]?.k === "space") tokens.shift();
          dropW += this.faces.measure(bodyFace, style.size, " ");
        }
        dropLines = dc.lines;
      }
    }

    // ---- lead-in: the first words in small capitals
    let marked = 0;
    for (const t of tokens) {
      if (t.k === "br" || marked >= leadWords) break;
      if (t.k === "word") {
        t.w.lead = true;
        marked += 1;
      }
    }

    // ---- items
    const justify = input.align === "justify";
    const items = new Items();
    const syl: Prepared["syl"] = [];
    const space0 = this.faces.measure(bodyFace, style.size, " ");
    const rag = style.size * 2.5;
    const indent = dropLines ? 0 : (input.indent ?? 0);
    if (indent > 0) items.box(indent, -1);

    let wordNo = 0;
    let lastGlyphs: Glyphs | null = null;
    for (const t of tokens) {
      if (t.k === "word") {
        const { pieces, syllables, breaks } = this.syllables(t.w, !!input.hyphenate && !t.w.lead);
        // Shape each style piece once and split its width at the syllable
        // cuts (lines are measured exactly again once they're set).
        const split = pieces.map((p, pi) => {
          if (syllables.length < 2) return null;
          const run = this.plain(p.style, t.w.lead);
          if (!run) return null;
          const cuts: number[] = [];
          for (const parts of syllables) for (const part of parts) if (part.piece === pi && part.start > 0) cuts.push(part.start);
          return { run, cuts, widths: this.faces.measureParts(run.face, run.size, p.text, cuts, run.feat, run.cs) };
        });
        syllables.forEach((parts, si) => {
          const glyphs: Glyphs[] = [];
          for (const part of parts) {
            const p = pieces[part.piece];
            const text = p.text.slice(part.start, part.end);
            const s = split[part.piece];
            if (s) glyphs.push({ ...s.run, text, w: s.widths[part.start === 0 ? 0 : s.cuts.indexOf(part.start) + 1] });
            else glyphs.push(...this.shape(text, p.style, t.w.lead));
          }
          if (si > 0) {
            const br = breaks[si - 1];
            const prev = syl[syl.length - 1].glyphs;
            const g = prev[prev.length - 1];
            const hyphenW = br.hyphen && g ? this.faces.measure(g.face, g.size, "-", g.feat, g.cs) : 0;
            items.penalty(hyphenW, br.penalty, br.flagged, br.auto);
          }
          syl.push({ glyphs, word: wordNo });
          items.box(
            glyphs.reduce((n, g) => n + g.w, 0),
            syl.length - 1,
          );
          if (glyphs.length) lastGlyphs = glyphs[glyphs.length - 1];
        });
        wordNo += 1;
      } else if (t.k === "space") {
        const g = lastGlyphs as Glyphs | null;
        const sp = g ? this.faces.measure(g.face, g.size, " ") + g.cs : space0;
        if (justify) {
          items.glue(sp, space0 / 2, space0 / 3);
        } else {
          items.glue(0, rag, 0);
          items.penalty(0, 0);
          items.glue(sp, -rag, 0);
        }
      } else {
        items.glue(0, FIL, 0);
        items.penalty(0, -INF_PENALTY);
      }
    }
    items.glue(0, FIL, 0);
    items.penalty(0, -INF_PENALTY);

    const hang = input.hang ?? 0;
    const n = Math.max(dropLines, 1) + 1;
    const widths: number[] = [];
    const offsets: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const off = (i < dropLines ? dropW : 0) + (i > 0 ? hang : 0);
      offsets.push(off);
      widths.push(Math.max(style.size * 2, input.width - off));
    }
    return { input, items, syl, widths, offsets, avail: widths.slice(), dropItems, dropLines, lead: leadWords };
  }

  /** A word's style pieces (soft hyphens removed), its syllables as parts
   *  of those pieces, and the breaks between syllables. */
  private syllables(
    word: Word,
    hyphenate: boolean,
  ): { pieces: Piece[]; syllables: { piece: number; start: number; end: number }[][]; breaks: WordBreak[] } {
    // Soft hyphens mark allowed breaks; they never print.
    const at = new Map<number, WordBreak>();
    const pieces: Piece[] = [];
    let text = "";
    for (const p of word.pieces) {
      const parts = p.text.split(SOFT_HYPHEN);
      parts.forEach((part, i) => {
        if (i > 0 && text) at.set(text.length, { penalty: 50, flagged: true, auto: false, hyphen: true });
        if (part) {
          pieces.push({ text: part, style: p.style });
          text += part;
        }
      });
    }
    const whole = () => [pieces.map((p, piece) => ({ piece, start: 0, end: p.text.length }))];
    if ([...text].length !== text.length) {
      // Astral characters: no breaks inside such words (rare in prose).
      return { pieces, syllables: whole(), breaks: [] };
    }
    // Explicit hyphens and dashes.
    for (let i = 1; i < text.length - 1; i += 1) {
      const ch = text[i];
      if ((ch === "-" || ch === "\u2010") && LETTER.test(text[i - 1]) && LETTER.test(text[i + 1])) {
        at.set(i + 1, { penalty: 50, flagged: true, auto: false, hyphen: false });
      } else if (ch === "—" || ch === "–") {
        at.set(i + 1, { penalty: 50, flagged: false, auto: false, hyphen: false });
      } else if (ch === "/" && LETTER.test(text[i - 1]) && LETTER.test(text[i + 1])) {
        at.set(i + 1, { penalty: 100, flagged: false, auto: false, hyphen: false });
      }
    }
    // Pattern hyphenation inside each segment between explicit breaks;
    // a capitalized word (a name, a sentence start) breaks only at a
    // higher price.
    if (hyphenate && this.hyphenator) {
      const cuts = [0, ...[...at.keys()].sort((a, b) => a - b), text.length];
      for (let c = 0; c < cuts.length - 1; c += 1) {
        const segment = text.slice(cuts[c], cuts[c + 1]);
        const syll = this.hyphenator(segment);
        const penalty = /^[^\p{L}]*\p{Lu}/u.test(segment) ? 150 : 50;
        let off = cuts[c];
        for (let s = 0; s < syll.length - 1; s += 1) {
          off += syll[s].length;
          if (!at.has(off)) at.set(off, { penalty, flagged: true, auto: true, hyphen: true });
        }
      }
    }
    const offsets = [...at.keys()].filter((o) => o > 0 && o < text.length).sort((a, b) => a - b);
    if (!offsets.length) return { pieces, syllables: whole(), breaks: [] };

    // Cut the pieces at the offsets: each syllable is a list of piece parts.
    const syllables: { piece: number; start: number; end: number }[][] = [[]];
    const breaks: WordBreak[] = [];
    let base = 0;
    let next = 0;
    pieces.forEach((p, piece) => {
      let start = 0;
      while (start < p.text.length) {
        const cut = next < offsets.length ? offsets[next] - base : Infinity;
        if (cut <= start) {
          // A break at the start of this piece (its boundary with the last).
          if (syllables[syllables.length - 1].length) {
            syllables.push([]);
            breaks.push(at.get(offsets[next])!);
          }
          next += 1;
          continue;
        }
        const end = Math.min(p.text.length, cut);
        syllables[syllables.length - 1].push({ piece, start, end });
        start = end;
        if (end === cut && end < p.text.length) {
          syllables.push([]);
          breaks.push(at.get(offsets[next])!);
          next += 1;
        }
      }
      base += p.text.length;
    });
    return { pieces, syllables, breaks };
  }

  private set(p: Prepared, looseness: number): { para: SetPara; firstLineWords: number } {
    const input = p.input;
    let widths = p.widths;
    // A looser or tighter setting (to fill a page) is only worth having
    // when its spacing stays comfortable.
    const result0 = breakLines(
      p.items,
      looseness
        ? { widths, looseness, emergencyStretch: 0, tolerance: 100, finalTolerance: 100 }
        : { widths, emergencyStretch: input.style.size * 1.5 },
    );
    let result = result0;
    if (input.balance && result.breaks.length > 1 && !looseness) {
      // The narrowest measure with the same number of lines.
      let lo = input.width / (result.breaks.length + 1);
      let hi = input.width;
      for (let i = 0; i < 12; i += 1) {
        const mid = (lo + hi) / 2;
        const trial = breakLines(p.items, { widths: [mid], emergencyStretch: input.style.size });
        if (trial.breaks.length <= result0.breaks.length && trial.overfull === 0) hi = mid;
        else lo = mid;
      }
      widths = [hi];
      result = breakLines(p.items, { widths, emergencyStretch: input.style.size });
    }
    const lines = this.build(p, result.breaks);

    // Words wholly on line one (for the lead-in iteration).
    let firstLineWords: number;
    {
      const b = result.breaks[0];
      let lastWord = -1;
      for (let i = 0; i < b; i += 1) {
        if (p.items.isBox(i) && p.items.data[i] >= 0) lastWord = p.syl[p.items.data[i]].word;
      }
      const hyphenated = p.items.isPenalty(b) && p.items.cost[b] > -INF_PENALTY && p.items.isBox(b + 1) && p.items.data[b + 1] >= 0 && p.syl[p.items.data[b + 1]].word === lastWord;
      firstLineWords = lastWord + (hyphenated ? 0 : 1);
    }

    const para: SetPara = {
      lines,
      overfull: result.overfull,
      keepFirst: p.dropLines,
      rebreak: (loose: number) => {
        if (looseness || input.balance || (p.lead && input.leadIn === "first-line")) return null;
        const alt = this.set(p, loose).para;
        if (alt.overfull || Math.sign(alt.lines.length - lines.length) !== Math.sign(loose)) return null;
        return alt;
      },
    };
    return { para, firstLineWords };
  }

  private build(p: Prepared, breaks: number[]): SetLine[] {
    const { items, syl, input } = p;
    const starts = lineStarts(items, breaks);
    const lines: SetLine[] = [];
    const at = <T>(arr: T[], i: number) => arr[Math.min(i, arr.length - 1)];

    breaks.forEach((b, li) => {
      // Collect words (glyph runs) between the line's start and its break.
      const words: Glyphs[][] = [];
      let cur: Glyphs[] = [];
      let gap = false;
      let indentW = 0;
      for (let i = starts[li]; i < b; i += 1) {
        if (items.isBox(i)) {
          const d = items.data[i];
          if (d < 0) {
            indentW += items.width[i];
            continue;
          }
          if (gap && cur.length) {
            words.push(cur);
            cur = [];
          }
          gap = false;
          for (const g of syl[d].glyphs) {
            const prev = cur[cur.length - 1];
            if (prev && sameRun(prev, g, prev.underline)) cur[cur.length - 1] = { ...prev, text: prev.text + g.text };
            else cur.push({ ...g });
          }
        } else if (items.isGlue(i)) {
          gap = true;
        }
      }
      // A hyphenation break adds its hyphen.
      if (items.isPenalty(b) && items.width[b] > 0 && cur.length) {
        const g = cur[cur.length - 1];
        cur[cur.length - 1] = { ...g, text: `${g.text}-` };
      }
      if (cur.length) words.push(cur);

      // Measure the words as they'll be drawn (whole, not by syllable).
      let natural = indentW;
      const gaps: number[] = [];
      for (let wi = 0; wi < words.length; wi += 1) {
        for (const g of words[wi]) {
          g.w = this.faces.measure(g.face, g.size, g.text, g.feat, g.cs);
          natural += g.w;
        }
        if (wi < words.length - 1) {
          const last = words[wi][words[wi].length - 1];
          const sp = this.faces.measure(last.face, last.size, " ") + last.cs;
          gaps.push(sp);
          natural += sp;
        }
      }

      const avail = at(p.avail, li);
      const forced = items.isPenalty(b) && items.cost[b] <= -INF_PENALTY;
      let adj = 0;
      if (input.align === "justify" && gaps.length) {
        if (!forced) adj = (avail - natural) / gaps.length;
        else if (natural > avail) adj = (avail - natural) / gaps.length;
      }
      let x = at(p.offsets, li) + indentW;
      const slack = Math.max(0, avail - natural);
      if (input.align === "center") x += slack / 2;
      else if (input.align === "right") x += slack;

      const out: DLItem[] = [];
      const rules: DLRule[] = [];
      let text: DLText | null = null;
      let textUnderline = false;
      let ulStart: number | null = null;
      words.forEach((word, wi) => {
        word.forEach((g, gi) => {
          if (text && gi === 0 && wi > 0 && sameRun(text, g, textUnderline)) {
            text.text += ` ${g.text}`;
            text.xs!.push(x);
          } else {
            text = textItem(g, x, input.src);
            if (adj) text.ws = adj;
            textUnderline = g.underline;
            out.push(text);
          }
          if (g.underline && ulStart === null) ulStart = x;
          if (!g.underline && ulStart !== null) {
            rules.push(underlineRule(ulStart, x, g.size));
            ulStart = null;
          }
          x += g.w;
        });
        if (wi < words.length - 1) {
          const nextUnderlined = words[wi + 1][0]?.underline;
          if (ulStart !== null && !nextUnderlined) {
            rules.push(underlineRule(ulStart, x, word[word.length - 1].size));
            ulStart = null;
          }
          x += gaps[wi] + adj;
        }
      });
      if (ulStart !== null) rules.push(underlineRule(ulStart, x, input.style.size));
      if (li === 0 && p.dropItems.length) out.unshift(...p.dropItems.map((d) => ({ ...d })));
      lines.push({ items: [...out, ...rules], width: x });
    });
    return lines;
  }
}

function textItem(g: Glyphs, x: number, src?: number): DLText {
  const t: DLText = { t: "text", x, y: 0, face: g.face, size: g.size, text: g.text, xs: [x] };
  if (g.feat?.length) t.feat = g.feat;
  if (g.cs) t.cs = g.cs;
  if (src !== undefined) t.src = src;
  return t;
}

function underlineRule(x1: number, x2: number, size: number): DLRule {
  const y = size * 0.13;
  return { t: "rule", x1, y1: y, x2, y2: y, w: Math.max(0.4, size * 0.05) };
}

/** Move items by (dx, dy) — in place, returning them. */
export function shift<T extends DLItem>(items: T[], dx: number, dy: number): T[] {
  for (const it of items) {
    if (it.t === "text") {
      it.x += dx;
      it.y += dy;
      if (it.xs) it.xs = it.xs.map((v) => v + dx);
    } else if (it.t === "rule") {
      it.x1 += dx;
      it.x2 += dx;
      it.y1 += dy;
      it.y2 += dy;
    } else {
      it.x += dx;
      it.y += dy;
    }
  }
  return items;
}
