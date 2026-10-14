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
import { nextTab, type TabLeader, type TabStop, type UnderlineKind } from "../../editor/schema/sanitize";
import { breakFirstFit, breakFirstFitTabs, breakLines, FIL, INF_PENALTY, Items, lineStarts } from "./linebreak";
import type { DLItem, DLLink, DLRect, DLRule, DLText, StyleKey } from "./types";

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
  /** Documents: a real underline, a line through, a colour, a link. */
  underline?: boolean;
  strike?: boolean;
  /** `#rrggbb`. */
  color?: string;
  link?: string;
  /** A highlighter colour behind the text, `#rrggbb`. */
  highlight?: string;
  /** Raised (or, negative, lowered) from the baseline, pt. */
  rise?: number;
  /** Documents: an underline other than a single line, its own colour, and
   *  a line through drawn twice. */
  ul?: UnderlineKind;
  ulColor?: string;
  strike2?: boolean;
  /** Capitals keep the letters' count (documents: where the page view
   *  counts its way through the text). */
  sameLength?: boolean;
}

/** A book's run, plus what a document's run may also carry. */
export interface RichRun extends Run {
  underline?: boolean;
  strike?: boolean;
  /** A typeface and size of the run's own (inline code). */
  family?: string;
  size?: number;
  color?: string;
  /** A web address the run links to (drawn as a link, unlike `href`,
   *  which a book keeps for its ebook only). */
  link?: string;
  highlight?: string;
  /** Superscript (positive) or subscript (negative) shift, pt. */
  rise?: number;
  /** Capitals as formatting (documents): every letter, or the small ones
   *  as small capitals. The letters keep their count (ß is drawn ẞ). */
  caps?: "upper" | "small";
  /** Letter spacing, em. */
  tracking?: number;
  ul?: UnderlineKind;
  ulColor?: string;
  strike2?: boolean;
}

export type Align = "justify" | "left" | "center" | "right";

export interface DropCap {
  lines: number;
  family: string;
  /** The body's line spacing (the cap spans `lines` of it). */
  leading: number;
}

export interface ParaInput {
  runs: RichRun[];
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
  /** Break first-fit, as a word processor does (documents), instead of
   *  weighing the whole paragraph. */
  firstFit?: boolean;
  /** Tab stops (documents): a tab goes to the next of them. Without them
   *  a tab is a space between words, as it has always been in a book. */
  tabs?: TabSpec;
}

/** Where a paragraph's tabs go (see `nextTab`). Stops are measured from
 *  the margin (a table cell's left edge), points. */
export interface TabSpec {
  stops: TabStop[];
  /** Points between the stops past the paragraph's own. */
  every: number;
  /** Where the paragraph's left edge is from the margin. */
  origin: number;
  /** A hanging indent's place from the margin (a stop too), or null. */
  hang: number | null;
  /** The decimal mark, for decimal stops. */
  decimal: string;
}

/** A tab's box carries `TAB_DATA - k` (k: which tab of the paragraph). */
const TAB_DATA = -2;

export interface SetLine {
  /** x from the paragraph's left edge; y from the line's baseline. */
  items: DLItem[];
  /** Width the line's text occupies (from its first glyph). */
  width: number;
  /** How many of the paragraph's characters it holds — spaces, soft
   *  hyphens and a hyphen added at its end aside. (Counting through the
   *  lines says where in the text each one starts.) */
  chars: number;
}

export interface SetPara {
  lines: SetLine[];
  overfull: number;
  /** The first lines that must stay on one page (a drop cap's height). */
  keepFirst: number;
  /** Characters taken out of the lines altogether (a drop cap's initial). */
  skipped: number;
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
  strike?: boolean;
  color?: string;
  link?: string;
  highlight?: string;
  rise?: number;
  ul?: UnderlineKind;
  ulc?: string;
  strike2?: boolean;
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

type Token = { k: "word"; w: Word } | { k: "space" } | { k: "br" } | { k: "tab" };

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
  /** Characters the drop cap took. */
  skipped: number;
  /** Each tab's text up to the next tab: its width, and its width up to
   *  the decimal mark (the whole width when it has none). */
  tabs: { seg: number; before: number }[];
}

// Breaking spaces only: no-break, figure and narrow no-break spaces stay
// inside their word.
const SPACES = /([ \t\r\n\u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+)/;
const ONLY_SPACES = /^[ \t\r\n\u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+$/;
const INVISIBLE = /[\u200b\u2060\ufeff]/g;
const SOFT_HYPHEN = "\u00ad";
const LETTER = /\p{L}/u;
const NO_BREAK_HYPHEN = String.fromCharCode(0x2011);

const featKey = (f?: string[]) => (f && f.length ? f.join(",") : "");

function sameRun(a: { face: number; size: number; feat?: string[]; cs?: number; color?: string }, b: Glyphs, aUnderline: boolean) {
  return (
    a.face === b.face &&
    a.size === b.size &&
    featKey(a.feat) === featKey(b.feat) &&
    (a.cs ?? 0) === b.cs &&
    aUnderline === b.underline &&
    a.color === b.color
  );
}

/** Line-through, link, highlight and shift: what two neighbouring runs
 *  must share to be one. */
const sameDeco = (a: Glyphs, b: Glyphs) =>
  !!a.strike === !!b.strike && a.link === b.link && a.highlight === b.highlight && (a.rise ?? 0) === (b.rise ?? 0) && a.ul === b.ul && a.ulc === b.ulc && !!a.strike2 === !!b.strike2;

/** A style's decorations, as the fields a glyph run carries. */
function deco(style: TextStyle): { strike?: boolean; color?: string; link?: string; highlight?: string; rise?: number; ul?: UnderlineKind; ulc?: string; strike2?: boolean } {
  if (!style.strike && !style.color && !style.link && !style.highlight && !style.rise && !style.ul && !style.ulColor) return {};
  return {
    ...(style.strike ? { strike: true } : {}),
    ...(style.strike && style.strike2 ? { strike2: true } : {}),
    ...(style.ul ? { ul: style.ul } : {}),
    ...(style.ulColor ? { ulc: style.ulColor } : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(style.link ? { link: style.link } : {}),
    ...(style.highlight ? { highlight: style.highlight } : {}),
    ...(style.rise ? { rise: style.rise } : {}),
  };
}

export class Composer {
  /**
   * For a family, the further families tried — in order — for characters
   * it lacks: a catalog family comes split by script, Latin in one file
   * and Cyrillic in another, and a book set in it needs both.
   */
  chains: Record<string, string[]> = {};

  constructor(
    private readonly faces: FaceSet,
    private readonly hyphenator: Hyphenator | null,
    private readonly lang: string,
  ) {}

  /** A piece of a word as the pieces each family draws (one, almost
   *  always: its own). */
  private cover(text: string, style: TextStyle): Piece[] {
    const chain = this.chains[style.family];
    if (!chain?.length || this.faces.covers(this.faces.face(style.family, "regular"), text)) return [{ text, style }];
    const options = [style.family, ...chain.filter((f) => this.faces.has(f))];
    const out: Piece[] = [];
    for (const ch of text) {
      const family = options.find((f) => this.faces.covers(this.faces.face(f, "regular"), ch)) ?? style.family;
      const last = out[out.length - 1];
      if (last && last.style.family === family) last.text += ch;
      else out.push({ text: ch, style: family === style.family ? style : { ...style, family } });
    }
    return out;
  }

  /** When a style draws its text as-is in one run (no case change, no
   *  reduced capitals), the run's parameters; null otherwise. */
  private plain(style: TextStyle, lead: boolean): Omit<Glyphs, "text" | "w"> | null {
    const caps: Caps = lead && (!style.caps || style.caps === "none") ? "small" : (style.caps ?? "none");
    const underline = !!(style.underlineItalic && style.italic) || !!style.underline;
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
    return { face, size: style.size, feat, cs: (style.tracking ?? 0) * style.size, underline, ...deco(style) };
  }

  /** Shape one piece of text in a style: one glyph run, or several when
   *  small capitals are drawn as reduced capitals. */
  shape(text: string, style: TextStyle, lead = false): Glyphs[] {
    const underline = !!(style.underlineItalic && style.italic) || !!style.underline;
    const extra = deco(style);
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
      // A hyphen the line may not break at is kept in its word (see
      // `syllables`). Many faces have no glyph of that name: there it is
      // drawn as the face's own hyphen, not as a box or in another font.
      if (t.includes(NO_BREAK_HYPHEN) && !this.faces.covers(face, NO_BREAK_HYPHEN)) t = t.split(NO_BREAK_HYPHEN).join("-");
      const cs = tracking * sz;
      out.push({ text: t, face, size: sz, feat, cs, underline, ...extra, w: this.faces.measure(face, sz, t, feat, cs) });
    };
    const info = bookFont(style.family);
    const real = this.faces.hasFeature(face, "smcp");
    switch (caps) {
      case "upper":
        add(style.sameLength ? upperSameLength(text, this.lang) : text.toLocaleUpperCase(this.lang), size, base);
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
        if (cur && gi === 0 && wi > 0 && sameRun(cur, g, false) && cur.y === -(g.rise ?? 0)) {
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
      if (run.family) style.family = run.family;
      if (run.size) style.size = run.size;
      if (run.underline) style.underline = true;
      if (run.strike) style.strike = true;
      if (run.color) style.color = run.color;
      if (run.link) style.link = run.link;
      if (run.highlight) style.highlight = run.highlight;
      if (run.rise) style.rise = run.rise;
      if (run.caps) {
        style.caps = run.caps;
        style.sameLength = true;
      }
      if (run.tracking) style.tracking = run.tracking;
      if (run.ul) style.ul = run.ul;
      if (run.ulColor) style.ulColor = run.ulColor;
      if (run.strike2) style.strike2 = true;
      // (With tab stops a tab is its own token. Without, a space.)
      const chunks = input.tabs ? run.text.split("\t") : [run.text];
      chunks.forEach((chunk, ci) => {
        if (ci > 0) tokens.push({ k: "tab" });
        for (const part of chunk.replace(INVISIBLE, "").split(SPACES)) {
          if (!part) continue;
          if (ONLY_SPACES.test(part)) {
            const prev = last();
            if (prev && prev.k === "word") tokens.push({ k: "space" });
            continue;
          }
          const prev = last();
          const pieces = this.cover(part, style);
          if (prev?.k === "word") prev.w.pieces.push(...pieces);
          else tokens.push({ k: "word", w: { pieces, lead: false } });
        }
      });
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
    let skipped = 0;
    const dc = input.dropCap;
    const first = tokens[0];
    if (dc && dc.lines >= 2 && first?.k === "word") {
      const piece = first.w.pieces[0];
      const m = /^([“"‘'([«„]*)(\p{L}|\p{N})/u.exec(piece.text);
      if (m) {
        piece.text = piece.text.slice(m[0].length);
        skipped = m[0].length;
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
    let tabNo = 0;
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
      } else if (t.k === "tab") {
        // As wide as where it falls says (see `tabStep`).
        items.box(0, TAB_DATA - tabNo);
        tabNo += 1;
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
    return { input, items, syl, widths, offsets, avail: widths.slice(), dropItems, dropLines, lead: leadWords, skipped, tabs: tabNo ? this.tabSegments(items, syl, input.tabs?.decimal ?? ".") : [] };
  }

  /** Each tab's text up to the next tab (or the line's end): how wide it
   *  is, and how wide before its decimal mark. */
  private tabSegments(items: Items, syl: Prepared["syl"], mark: string): Prepared["tabs"] {
    const out: Prepared["tabs"] = [];
    for (let j = 0; j < items.length; j += 1) {
      if (!items.isBox(j) || items.data[j] > TAB_DATA) continue;
      let seg = 0;
      let before = -1;
      for (let m = j + 1; m < items.length; m += 1) {
        if (items.isBox(m)) {
          const d = items.data[m];
          if (d <= TAB_DATA) break;
          if (d < 0) continue;
          if (before < 0) {
            let acc = 0;
            for (const g of syl[d].glyphs) {
              const at = g.text.indexOf(mark);
              if (at >= 0) {
                before = seg + acc + this.faces.measure(g.face, g.size, g.text.slice(0, at), g.feat, g.cs);
                break;
              }
              acc += g.w;
            }
          }
          seg += items.width[m];
        } else if (items.isGlue(m)) seg += items.width[m];
        else if (items.cost[m] <= -INF_PENALTY) break;
      }
      out.push({ seg, before: before >= 0 ? before : seg });
    }
    return out;
  }

  /** How wide tab `k` is when it starts `x` from the paragraph's left
   *  edge, and the leader of the stop it goes to. */
  private tabStep(p: Prepared, k: number, x: number): { w: number; leader: TabLeader | null } {
    const spec = p.input.tabs;
    const min = p.input.style.size * 0.25;
    if (!spec) return { w: min, leader: null };
    const from = spec.origin + x;
    const stop = nextTab(spec.stops, spec.every, from, spec.hang, min);
    const info = p.tabs[k] ?? { seg: 0, before: 0 };
    const target = stop.pt - (stop.kind === "r" ? info.seg : stop.kind === "c" ? info.seg / 2 : stop.kind === "d" ? info.before : 0);
    return { w: Math.max(min, target - from), leader: stop.leader };
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
    const result0 = input.firstFit
      ? p.tabs.length
        ? breakFirstFitTabs(p.items, widths, p.offsets, (j, x) => (p.items.data[j] <= TAB_DATA ? this.tabStep(p, TAB_DATA - p.items.data[j], x).w : null))
        : breakFirstFit(p.items, widths)
      : breakLines(
          p.items,
          looseness
            ? { widths, looseness, emergencyStretch: 0, tolerance: 100, finalTolerance: 100 }
            : { widths, emergencyStretch: input.style.size * 1.5 },
        );
    let result = result0;
    if (input.balance && result.breaks.length > 1 && !looseness && !input.firstFit) {
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
      skipped: p.skipped,
      rebreak: (loose: number) => {
        if (looseness || input.balance || input.firstFit || (p.lead && input.leadIn === "first-line")) return null;
        const alt = this.set(p, loose).para;
        if (alt.overfull || Math.sign(alt.lines.length - lines.length) !== Math.sign(loose)) return null;
        return alt;
      },
    };
    return { para, firstLineWords };
  }

  private build(p: Prepared, breaks: number[]): SetLine[] {
    if (p.tabs.length) return this.buildTabbed(p, breaks);
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
      let chars = 0;
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
            chars += g.text.length;
            const prev = cur[cur.length - 1];
            if (prev && sameRun(prev, g, prev.underline) && sameDeco(prev, g)) cur[cur.length - 1] = { ...prev, text: prev.text + g.text };
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
      let ulColor: string | undefined;
      let ulKind: UnderlineKind | undefined;
      // Runs with a line through them or a link, where they were set.
      const placed: { g: Glyphs; x1: number; x2: number }[] = [];
      words.forEach((word, wi) => {
        word.forEach((g, gi) => {
          if (text && gi === 0 && wi > 0 && sameRun(text, g, textUnderline) && text.y === -(g.rise ?? 0)) {
            text.text += ` ${g.text}`;
            text.xs!.push(x);
          } else {
            text = textItem(g, x, input.src);
            if (adj) text.ws = adj;
            textUnderline = g.underline;
            out.push(text);
          }
          if (g.underline && ulStart !== null && (g.ul !== ulKind || (g.ulc ?? g.color) !== ulColor)) {
            rules.push(...underlineRule(ulStart, x, g.size, ulColor, ulKind));
            ulStart = null;
          }
          if (g.underline && ulStart === null) {
            ulStart = x;
            ulColor = g.ulc ?? g.color;
            ulKind = g.ul;
          }
          if (!g.underline && ulStart !== null) {
            rules.push(...underlineRule(ulStart, x, g.size, ulColor, ulKind));
            ulStart = null;
          }
          if (g.strike || g.link || g.highlight) placed.push({ g, x1: x, x2: x + g.w });
          else if (placed.length) placed.push({ g, x1: x, x2: x });
          x += g.w;
        });
        if (wi < words.length - 1) {
          const nextUnderlined = words[wi + 1][0]?.underline;
          if (ulStart !== null && !nextUnderlined) {
            rules.push(...underlineRule(ulStart, x, word[word.length - 1].size, ulColor, ulKind));
            ulStart = null;
          }
          x += gaps[wi] + adj;
        }
      });
      if (ulStart !== null) rules.push(...underlineRule(ulStart, x, input.style.size, ulColor, ulKind));
      // Neighbours sharing a line-through (or one link) share it across the
      // space between them.
      const extras: DLItem[] = [];
      for (let i = 0; i < placed.length; ) {
        const first = placed[i];
        let j = i;
        while (j + 1 < placed.length && !!placed[j + 1].g.strike === !!first.g.strike && !!placed[j + 1].g.strike2 === !!first.g.strike2 && first.g.strike) j += 1;
        if (first.g.strike) extras.push(...strikeRule(first.x1, placed[j].x2, first.g.size, first.g.color, !!first.g.strike2));
        i = j + 1;
      }
      for (let i = 0; i < placed.length; ) {
        const first = placed[i];
        let j = i;
        while (j + 1 < placed.length && placed[j + 1].g.link === first.g.link && first.g.link) j += 1;
        if (first.g.link) {
          const size = Math.max(...placed.slice(i, j + 1).map((e) => e.g.size));
          const link: DLLink = { t: "link", x: first.x1, y: -size * 0.85, w: placed[j].x2 - first.x1, h: size * 1.15, url: first.g.link };
          extras.push(link);
        }
        i = j + 1;
      }
      // Highlighter goes down before the ink: one bar under each stretch of
      // neighbours sharing a colour, as tall as their type.
      const bars: DLItem[] = [];
      for (let i = 0; i < placed.length; ) {
        const first = placed[i];
        let j = i;
        while (j + 1 < placed.length && placed[j + 1].g.highlight === first.g.highlight && first.g.highlight) j += 1;
        if (first.g.highlight) {
          let top = 0;
          let bottom = 0;
          for (const e of placed.slice(i, j + 1)) {
            top = Math.max(top, this.faces.ascent(e.g.face) * e.g.size + (e.g.rise ?? 0));
            bottom = Math.max(bottom, this.faces.descent(e.g.face) * e.g.size - (e.g.rise ?? 0));
          }
          const bar: DLRect = { t: "rect", x: first.x1, y: -top, w: placed[j].x2 - first.x1, h: top + bottom, color: first.g.highlight };
          bars.push(bar);
        }
        i = j + 1;
      }
      if (li === 0 && p.dropItems.length) out.unshift(...p.dropItems.map((d) => ({ ...d })));
      lines.push({ items: bars.length || extras.length ? [...bars, ...out, ...rules, ...extras] : [...out, ...rules], width: x, chars });
    });
    return lines;
  }

  /**
   * The lines of a paragraph with tabs in it: as `build`, but a tab takes
   * the text after it to its stop (with the stop's leader drawn in the
   * gap). Such a line is set from the left: a tab means the writer placed
   * the words.
   */
  private buildTabbed(p: Prepared, breaks: number[]): SetLine[] {
    const { items, syl, input } = p;
    const starts = lineStarts(items, breaks);
    const lines: SetLine[] = [];
    const at = <T>(arr: T[], i: number) => arr[Math.min(i, arr.length - 1)];
    type Sep = { space: boolean; tabs: number[] };

    breaks.forEach((b, li) => {
      const words: Glyphs[][] = [];
      const seps: Sep[] = [];
      let cur: Glyphs[] = [];
      let sep: Sep = { space: false, tabs: [] };
      let indentW = 0;
      let chars = 0;
      for (let i = starts[li]; i < b; i += 1) {
        if (items.isBox(i)) {
          const d = items.data[i];
          if (d <= TAB_DATA) {
            if (cur.length) {
              words.push(cur);
              cur = [];
            }
            sep.tabs.push(TAB_DATA - d);
            continue;
          }
          if (d < 0) {
            indentW += items.width[i];
            continue;
          }
          if (cur.length && (sep.space || sep.tabs.length)) {
            words.push(cur);
            cur = [];
          }
          if (!cur.length) {
            seps.push(sep);
            sep = { space: false, tabs: [] };
          }
          for (const g of syl[d].glyphs) {
            chars += g.text.length;
            const prev = cur[cur.length - 1];
            if (prev && sameRun(prev, g, prev.underline) && sameDeco(prev, g)) cur[cur.length - 1] = { ...prev, text: prev.text + g.text };
            else cur.push({ ...g });
          }
        } else if (items.isGlue(i) && (cur.length || sep.tabs.length)) {
          sep.space = true;
        }
      }
      if (items.isPenalty(b) && items.width[b] > 0 && cur.length) {
        const g = cur[cur.length - 1];
        cur[cur.length - 1] = { ...g, text: `${g.text}-` };
      }
      if (cur.length) words.push(cur);
      const trailing = sep.tabs;
      for (const word of words) for (const g of word) g.w = this.faces.measure(g.face, g.size, g.text, g.feat, g.cs);

      let x = at(p.offsets, li) + indentW;
      const out: DLItem[] = [];
      const rules: DLRule[] = [];
      const leaders: DLItem[] = [];
      let text: DLText | null = null;
      let textUnderline = false;
      let ulStart: number | null = null;
      let ulColor: string | undefined;
      let ulKind: UnderlineKind | undefined;
      const placed: { g: Glyphs; x1: number; x2: number }[] = [];
      const like = words[0]?.[0] ?? null;
      const tabTo = (k: number, g: Glyphs | null) => {
        const step = this.tabStep(p, k, x);
        if (step.leader && g) leaders.push(...this.leader(step.leader, x, x + step.w, g));
        x += step.w;
      };
      words.forEach((word, wi) => {
        const s = seps[wi] ?? { space: false, tabs: [] };
        const prev = wi > 0 ? words[wi - 1][words[wi - 1].length - 1] : null;
        if (prev && (ulStart !== null) && (s.tabs.length || !word[0]?.underline)) {
          rules.push(...underlineRule(ulStart, x, prev.size, ulColor, ulKind));
          ulStart = null;
        }
        if (s.space && prev) x += this.faces.measure(prev.face, prev.size, " ") + prev.cs;
        for (const k of s.tabs) tabTo(k, prev ?? word[0]);
        word.forEach((g, gi) => {
          if (text && gi === 0 && wi > 0 && !s.tabs.length && sameRun(text, g, textUnderline) && text.y === -(g.rise ?? 0)) {
            text.text += ` ${g.text}`;
            text.xs!.push(x);
          } else {
            text = textItem(g, x, input.src);
            textUnderline = g.underline;
            out.push(text);
          }
          if (g.underline && ulStart !== null && (g.ul !== ulKind || (g.ulc ?? g.color) !== ulColor)) {
            rules.push(...underlineRule(ulStart, x, g.size, ulColor, ulKind));
            ulStart = null;
          }
          if (g.underline && ulStart === null) {
            ulStart = x;
            ulColor = g.ulc ?? g.color;
            ulKind = g.ul;
          }
          if (!g.underline && ulStart !== null) {
            rules.push(...underlineRule(ulStart, x, g.size, ulColor, ulKind));
            ulStart = null;
          }
          if (g.strike || g.link || g.highlight) placed.push({ g, x1: x, x2: x + g.w });
          else if (placed.length) placed.push({ g, x1: x, x2: x });
          x += g.w;
        });
      });
      if (ulStart !== null) rules.push(...underlineRule(ulStart, x, input.style.size, ulColor, ulKind));
      // A tab ending the line still goes to its stop (a leader to the margin).
      for (const k of trailing) tabTo(k, words.length ? words[words.length - 1][words[words.length - 1].length - 1] : like);

      const extras: DLItem[] = [];
      for (let i = 0; i < placed.length; ) {
        const first = placed[i];
        let j = i;
        while (j + 1 < placed.length && !!placed[j + 1].g.strike === !!first.g.strike && !!placed[j + 1].g.strike2 === !!first.g.strike2 && first.g.strike) j += 1;
        if (first.g.strike) extras.push(...strikeRule(first.x1, placed[j].x2, first.g.size, first.g.color, !!first.g.strike2));
        i = j + 1;
      }
      for (let i = 0; i < placed.length; ) {
        const first = placed[i];
        let j = i;
        while (j + 1 < placed.length && placed[j + 1].g.link === first.g.link && first.g.link) j += 1;
        if (first.g.link) {
          const size = Math.max(...placed.slice(i, j + 1).map((e) => e.g.size));
          const link: DLLink = { t: "link", x: first.x1, y: -size * 0.85, w: placed[j].x2 - first.x1, h: size * 1.15, url: first.g.link };
          extras.push(link);
        }
        i = j + 1;
      }
      const bars: DLItem[] = [];
      for (let i = 0; i < placed.length; ) {
        const first = placed[i];
        let j = i;
        while (j + 1 < placed.length && placed[j + 1].g.highlight === first.g.highlight && first.g.highlight) j += 1;
        if (first.g.highlight) {
          let top = 0;
          let bottom = 0;
          for (const e of placed.slice(i, j + 1)) {
            top = Math.max(top, this.faces.ascent(e.g.face) * e.g.size + (e.g.rise ?? 0));
            bottom = Math.max(bottom, this.faces.descent(e.g.face) * e.g.size - (e.g.rise ?? 0));
          }
          const bar: DLRect = { t: "rect", x: first.x1, y: -top, w: placed[j].x2 - first.x1, h: top + bottom, color: first.g.highlight };
          bars.push(bar);
        }
        i = j + 1;
      }
      if (li === 0 && p.dropItems.length) out.unshift(...p.dropItems.map((d) => ({ ...d })));
      lines.push({ items: [...bars, ...leaders, ...out, ...rules, ...extras], width: x, chars });
    });
    return lines;
  }

  /** What fills a tab's gap: dots or dashes on a grid of their own (so
   *  leaders down a page line up), or a line. */
  private leader(kind: TabLeader, x1: number, x2: number, g: Glyphs): DLItem[] {
    if (kind === "line") {
      const rule: DLRule = { t: "rule", x1, y1: g.size * 0.13, x2, y2: g.size * 0.13, w: Math.max(0.4, g.size * 0.05) };
      if (g.color) rule.color = g.color;
      return [rule];
    }
    const ch = kind === "dot" ? "." : "-";
    const w = this.faces.measure(g.face, g.size, ch);
    const step = g.size * (kind === "dot" ? 0.5 : 0.6);
    const pad = g.size * 0.2;
    const xs: number[] = [];
    for (let x = Math.ceil((x1 + pad) / step) * step; x + w <= x2 - pad + 1e-6; x += step) xs.push(x);
    if (!xs.length) return [];
    const t: DLText = { t: "text", x: xs[0], y: 0, face: g.face, size: g.size, text: xs.map(() => ch).join(" "), xs };
    if (g.color) t.color = g.color;
    return [t];
  }
}

/** Capitals letter for letter: where a capital is more than one letter
 *  (ß), the one letter that is (ẞ), or the letter as it is. */
function upperSameLength(text: string, lang: string): string {
  let out = "";
  for (const ch of text) {
    const up = ch.toLocaleUpperCase(lang);
    out += up.length === ch.length ? up : ch === "ß" ? "ẞ" : ch;
  }
  return out;
}

function textItem(g: Glyphs, x: number, src?: number): DLText {
  const t: DLText = { t: "text", x, y: g.rise ? -g.rise : 0, face: g.face, size: g.size, text: g.text, xs: [x] };
  if (g.feat?.length) t.feat = g.feat;
  if (g.cs) t.cs = g.cs;
  if (src !== undefined) t.src = src;
  if (g.color) t.color = g.color;
  return t;
}

function underlineRule(x1: number, x2: number, size: number, color?: string, kind?: UnderlineKind): DLRule[] {
  const y = size * 0.13;
  const w = Math.max(0.4, size * 0.05);
  const rule: DLRule = { t: "rule", x1, y1: y, x2, y2: y, w };
  if (color) rule.color = color;
  switch (kind) {
    case "double": {
      const thin = Math.max(0.3, w * 0.7);
      return [
        { ...rule, w: thin },
        { ...rule, w: thin, y1: y + thin * 2.5, y2: y + thin * 2.5 },
      ];
    }
    case "dotted":
      return [{ ...rule, dash: [w, w * 1.6] }];
    case "dashed":
      return [{ ...rule, dash: [w * 5, w * 3] }];
    case "wavy":
      return [{ ...rule, y1: y + w, y2: y + w, wave: w * 1.4 }];
    default:
      return [rule];
  }
}

function strikeRule(x1: number, x2: number, size: number, color?: string, twice = false): DLRule[] {
  const y = -size * 0.27;
  const w = Math.max(0.4, size * 0.05);
  const rule: DLRule = { t: "rule", x1, y1: y, x2, y2: y, w };
  if (color) rule.color = color;
  if (!twice) return [rule];
  const thin = Math.max(0.3, w * 0.7);
  return [
    { ...rule, w: thin, y1: y - thin * 1.3, y2: y - thin * 1.3 },
    { ...rule, w: thin, y1: y + thin * 1.3, y2: y + thin * 1.3 },
  ];
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
    } else if (it.t === "anchor") {
      it.y += dy;
    } else {
      it.x += dx;
      it.y += dy;
    }
  }
  return items;
}
