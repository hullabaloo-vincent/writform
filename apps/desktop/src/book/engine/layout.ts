/**
 * Book layout: the book model set into pages on a baseline grid.
 *
 * Every text line sits on the grid, so lines back up through the paper and
 * facing pages align. Paragraphs never leave a widow or an orphan (a page
 * runs a line short instead — after first trying to set a paragraph on it
 * one line tighter or looser), headings keep two lines with them, and a
 * scene break never ends a page (at the top of one, the ornament shows even
 * when the design uses blank-line breaks, so the break isn't lost).
 *
 * Generated pages: half title, also-by, title page, copyright, dedication,
 * epigraph, contents (page numbers filled in once everything is placed),
 * about the author. Chapters open lower on the page with no running head;
 * they start on right-hand pages when the book asks, with blank left-hand
 * pages inserted. Roman folios in the front matter, arabic from 1 on the
 * first body page (always a right-hand page).
 *
 * The same engine sets the submission manuscript ("smf"): Letter/A4, 1″
 * margins, 12/24, ragged right, every paragraph indented ½″, the
 * "Surname / TITLE / page" header and a title page with contact details.
 */

import { bookFont, ornamentFamily } from "../fonts/registry";
import { toRoman } from "../model/chapters";
import { contentsLabel, copyrightParagraphs, wantsContents } from "../model/frontmatter";
import { SMF_DESIGN, type BookDesign } from "../model/presets";
import type { PageGeometry } from "../model/trims";
import type { BookModel, EpigraphBlock, Run, Section, Warning } from "../model/types";
import { roundedWordCount, smfNames } from "../smf/names";
import { Composer, shift, type Align, type ParaInput, type SetPara, type TextStyle } from "./compose";
import type { FaceSet } from "./faces";
import type { Hyphenator } from "./hyphenate";
import type { DisplayList, DLItem, DLPage, DLSection, PageRole } from "./types";

const PT = 72;
const EPS = 1e-6;

export interface ImageInfo {
  /** Pixel size of the prepared image. */
  w: number;
  h: number;
}

export interface LayoutOptions {
  model: BookModel;
  target: "paperback" | "smf";
  faces: FaceSet;
  hyphenator: Hyphenator | null;
  geometry: PageGeometry;
  images?: Map<string, ImageInfo>;
  now?: Date;
  /** Sections set by earlier runs (the live preview), reused when their
   *  text and the settings haven't changed. Must belong to `faces`. */
  cache?: SectionCache;
}

interface CachedSection {
  /** The section's block index when it was set (items' `src` are moved by
   *  the difference when it's reused further up or down the book). */
  base: number;
  pages: PageDraft[];
  overfull: number;
  overfullSrc?: number;
}

/**
 * Laid-out sections kept between runs. Every section starts a new page, so
 * one whose content and settings are unchanged lays out identically — the
 * live preview re-sets only the chapter being edited. Keys ignore where the
 * section sits in the manuscript (block numbers are made relative), so
 * typing a paragraph in chapter 3 doesn't invalidate chapters 4 onward.
 */
export class SectionCache {
  private readonly entries = new Map<string, CachedSection>();
  private readonly used = new Set<string>();

  get(key: string): CachedSection | undefined {
    const hit = this.entries.get(key);
    if (hit) this.used.add(key);
    return hit;
  }

  set(key: string, value: CachedSection) {
    this.entries.set(key, value);
    this.used.add(key);
  }

  /** Forget what the last job didn't use. */
  sweep() {
    for (const key of this.entries.keys()) if (!this.used.has(key)) this.entries.delete(key);
    this.used.clear();
  }
}

/** The body font a submission manuscript uses (Times New Roman isn't ours
 *  to embed; Libertinus is the closest bundled face). */
export function smfFamily(font: "courier" | "times"): string {
  return font === "courier" ? "courier-prime" : "libertinus";
}

/** Letter or A4 with 1″ margins. */
export function smfGeometry(paper: "letter" | "a4"): PageGeometry {
  const size = paper === "a4" ? { w: 8.27, h: 11.69 } : { w: 8.5, h: 11 };
  return { ...size, top: 1, bottom: 1, inside: 1, outside: 1 };
}

/** The design a target is set in. */
export function designFor(model: BookModel, target: "paperback" | "smf"): BookDesign {
  if (target === "paperback") return model.book.design;
  const family = smfFamily(model.book.smf.font);
  return { ...SMF_DESIGN, bodyFont: family, headingFont: family };
}

/** The ornament a design draws and the family that has its glyphs
 *  (asterisks when no bundled family does). */
export function ornamentFor(text: string, design: BookDesign): { text: string; family: string } {
  const family = ornamentFamily(text, [design.bodyFont, design.headingFont]);
  if (family) return { text, family };
  return { text: "* * *", family: design.bodyFont };
}

// ---------------------------------------------------------------- types

interface Row {
  /** Height in grid lines. */
  h: number;
  /** Items with y relative to the row's (first) baseline. */
  items: DLItem[];
  /** The page may not end just before this row. */
  noBreakBefore?: boolean;
  /** Vertical space: dropped at the top of a page. */
  discard?: boolean;
  /** After this row, round the position up to the next grid line. */
  snap?: boolean;
  /** A page break before this row. */
  forceBreak?: boolean;
  /** Scene break: the ornament drawn at a page top, and whether the break
   *  is otherwise just space. */
  scene?: { top: DLItem[]; blank: boolean };
  para?: ParaRef;
}

interface ParaRef {
  set: SetPara;
  x: number;
  keepWithPrev: boolean;
}

interface PageDraft {
  role: PageRole;
  /** DisplayList.sections index, or -1. */
  section: number;
  /** x from the text block's left edge; y from the page top. */
  items: DLItem[];
  head: boolean;
  folio: "none" | "normal" | "drop";
  /** Arabic numbering starts on this page. */
  arabicStart?: boolean;
}

interface HeadingSpec {
  kind: Section["kind"];
  label: string;
  title: string;
  subtitle?: string;
  epigraph?: EpigraphBlock | null;
}

// ---------------------------------------------------------------- layout

export function layoutBook(o: LayoutOptions): DisplayList {
  return new Layout(o).run();
}

class Layout {
  private readonly smf: boolean;
  private readonly design: BookDesign;
  private readonly composer: Composer;
  private readonly S: number;
  private readonly L: number;
  private readonly pageW: number;
  private readonly pageH: number;
  private readonly textTop: number;
  private readonly textW: number;
  private readonly textH: number;
  private readonly inside: number;
  private readonly outside: number;
  private readonly firstBaseline: number;
  private readonly capacity: number;
  private readonly headBaseline: number;
  private readonly footBaseline: number;
  private readonly body: TextStyle;
  private readonly sceneOrnament: { text: string; family: string };
  private readonly headingOrnament: { text: string; family: string } | null;
  private readonly warnings: Warning[] = [];
  private readonly sections: DLSection[] = [];
  /** Running-head text per section. */
  private readonly heads: string[] = [];
  /** Contents keys ("s3", "about") → section index. */
  private readonly keys = new Map<string, number>();
  private readonly pages: PageDraft[] = [];
  private readonly toc: { page: PageDraft; y: number; key: string }[] = [];
  private overfull = 0;
  private overfullSrc: number | undefined;
  private partOpen = false;
  /** Everything besides a section's own content that shapes its pages. */
  private readonly contextKey: string;

  constructor(private readonly o: LayoutOptions) {
    this.smf = o.target === "smf";
    this.design = designFor(o.model, o.target);
    const d = this.design;
    this.composer = new Composer(o.faces, d.hyphenate ? o.hyphenator : null, o.model.book.meta.language || "en-US");
    this.S = d.bodySize;
    this.L = d.leading;
    const g = o.geometry;
    this.pageW = g.w * PT;
    this.pageH = g.h * PT;
    this.inside = g.inside * PT;
    this.outside = g.outside * PT;
    this.textW = this.pageW - this.inside - this.outside;

    const font = bookFont(d.bodyFont);
    const figures = d.figures === "oldstyle" && font.oldstyle ? ["onum"] : d.figures === "lining" && font.oldstyle ? ["lnum"] : undefined;
    this.body = { family: d.bodyFont, size: this.S, ...(figures ? { features: figures } : {}) };
    if (this.smf && o.model.book.smf.italics === "underline") this.body.underlineItalic = true;

    const cap = o.faces.capHeight(o.faces.face(d.bodyFont, "regular")) * this.S;
    let top = g.top * PT;
    // Running heads and folios need room inside the trim (a safe quarter
    // inch and then some): a very tight top margin moves the text down.
    const minHead = 0.375 * PT + cap;
    if (!this.smf && top + cap - 2 * this.L < minHead) top = minHead + 2 * this.L - cap;
    this.textTop = top;
    this.textH = this.pageH - top - g.bottom * PT;
    this.firstBaseline = top + cap;
    this.capacity = Math.max(4, Math.floor((this.textH - cap) / this.L + EPS) + 1);
    this.headBaseline = this.smf ? 0.5 * PT + cap : this.firstBaseline - 2 * this.L;
    const textBottom = this.pageH - g.bottom * PT;
    this.footBaseline = Math.min(textBottom + 1.6 * this.L, this.pageH - 0.3 * PT);

    this.sceneOrnament = this.smf ? { text: "#", family: d.bodyFont } : ornamentFor(d.ornament || "* * *", d);
    if (!this.smf && d.sceneBreak === "ornament" && d.ornament && this.sceneOrnament.text !== d.ornament) {
      this.warnings.push({ kind: "missing-glyphs", message: `The ornament “${d.ornament}” isn’t in the book’s fonts; asterisks print instead.` });
    }
    this.headingOrnament = !this.smf && d.headingOrnament ? ornamentFor(d.headingOrnament, d) : null;
    const { meta, smf } = o.model.book;
    this.contextKey = JSON.stringify([o.target, d, g, meta.language, meta.title, smf.font, smf.italics, smf.paper]);
  }

  run(): DisplayList {
    const model = this.o.model;
    if (this.smf) this.smfTitlePage();
    else this.frontMatter();

    const firstBody = model.sections.findIndex((s) => s.matter === "body");
    const firstChapter = model.sections.findIndex((s) => s.kind === "chapter");
    const arabicAt = model.book.print.arabicStart === "first-chapter" && firstChapter >= 0 ? firstChapter : firstBody;
    model.sections.forEach((section, i) => this.section(section, `s${i}`, !this.smf && i === arabicAt));
    if (!this.smf && arabicAt < 0 && this.pages.length) this.pages[0].arabicStart = true;

    if (this.smf) this.smfEnd();
    else this.backMatter();
    return this.assemble();
  }

  // ------------------------------------------------------------ pages

  private page(role: PageRole, section = -1, opts: Partial<PageDraft> = {}): PageDraft {
    const p: PageDraft = { role, section, items: [], head: false, folio: "none", ...opts };
    this.pages.push(p);
    return p;
  }

  /** The next page is a right-hand page; a blank goes in first if needed. */
  private ensureRecto() {
    if (this.pages.length % 2 === 1) this.page("blank");
  }

  private ensureVerso() {
    if (this.pages.length % 2 === 0) this.page("blank");
  }

  private addSection(title: string, level: number, head: string, key?: string): number {
    this.sections.push({ id: `p${this.sections.length + 1}`, title, firstPage: this.pages.length, folio: "", level });
    this.heads.push(head);
    const index = this.sections.length - 1;
    if (key) this.keys.set(key, index);
    return index;
  }

  private y(pos: number): number {
    return this.firstBaseline + pos * this.L;
  }

  /** The first grid line at least `gap` below `y`. */
  private slotAfter(y: number, gap: number): number {
    return Math.max(0, Math.ceil((y + gap - this.firstBaseline) / this.L - EPS));
  }

  // ------------------------------------------------------------ text helpers

  private para(input: Omit<ParaInput, "style"> & { style?: TextStyle }): SetPara {
    const set = this.composer.setParagraph({ style: this.body, ...input });
    if (set.overfull) {
      this.overfull += set.overfull;
      this.overfullSrc ??= input.src;
    }
    return set;
  }

  /** Display lines (titles, labels…): balanced, from baseline `y` down by
   *  `leading`. Returns the items and the last baseline. */
  private display(
    runs: Run[] | string,
    style: TextStyle,
    y: number,
    leading: number,
    opts: { align?: Align; width?: number; x?: number } = {},
  ): { items: DLItem[]; last: number } {
    const set = this.composer.setParagraph({
      runs: typeof runs === "string" ? [{ text: runs }] : runs,
      style,
      width: opts.width ?? this.textW,
      align: opts.align ?? "center",
      hyphenate: false,
      balance: true,
    });
    const items: DLItem[] = [];
    let last = y;
    set.lines.forEach((line, i) => {
      last = y + i * leading;
      items.push(...shift(line.items, opts.x ?? 0, last));
    });
    return { items, last };
  }

  private headingStyle(size: number, extra: Partial<TextStyle> = {}): TextStyle {
    return { family: this.design.headingFont, size, ...extra };
  }

  private capOf(style: TextStyle): number {
    const faces = this.o.faces;
    return faces.capHeight(faces.face(style.family, style.italic ? "italic" : "regular")) * style.size;
  }

  // ------------------------------------------------------------ openers

  /** A chapter or section opener's heading block, sunk down the page.
   *  Items in page coordinates, and the y where the block ends. */
  private opener(section: HeadingSpec): { items: DLItem[]; bottom: number } {
    const d = this.design;
    const S = this.S;
    const items: DLItem[] = [];
    const align: Align = d.headingAlign === "left" && !this.smf ? "left" : "center";
    const y0 = this.textTop + (this.smf ? 1 / 3 : d.sink) * this.textH;
    let last: number | null = null;
    const showTitle = !!section.title && (section.kind !== "chapter" || d.chapterTitle === "show");

    if (this.smf) {
      for (const line of [section.label, showTitle ? section.title : "", section.subtitle ?? ""].filter(Boolean)) {
        const r = this.display(line, this.body, last === null ? y0 + this.capOf(this.body) : last + this.L, this.L);
        items.push(...r.items);
        last = r.last;
      }
      return { items, bottom: (last ?? y0) + this.S * 0.3 };
    }

    // Titles take most of the measure, centred (or flush left).
    const inset = align === "center" ? this.textW * 0.07 : 0;
    const narrow = { align, width: this.textW * 0.86, x: inset };
    if (section.label) {
      const numeral = /^\d+$/.test(section.label.trim());
      const style: TextStyle = numeral
        ? this.headingStyle(S * 2.6)
        : d.labelCase === "smallcaps"
          ? this.headingStyle(S * 1.2, { caps: "small", tracking: 0.06 })
          : d.labelCase === "upper"
            ? this.headingStyle(S * 0.95, { caps: "upper", tracking: 0.18 })
            : this.headingStyle(S * 1.3);
      const r = this.display(section.label, style, y0 + this.capOf(style), style.size * 1.2, { align });
      items.push(...r.items);
      last = r.last;
    }
    if (showTitle) {
      const size = section.label ? S * 1.75 : S * 2.1;
      const style = this.headingStyle(size, {
        italic: d.titleItalic,
        ...(d.titleCase === "upper"
          ? { caps: "upper" as const, tracking: 0.06 }
          : d.titleCase === "smallcaps"
            ? { caps: "small" as const, tracking: 0.03 }
            : {}),
      });
      const first = last === null ? y0 + this.capOf(style) : last + size * 1.3 + S * 0.5;
      const r = this.display(section.title, style, first, size * 1.2, narrow);
      items.push(...r.items);
      last = r.last;
    }
    if (section.subtitle) {
      const style: TextStyle = { family: d.bodyFont, size: S * 1.15, italic: true };
      const r = this.display(section.subtitle, style, (last ?? y0) + style.size * 1.9, style.size * 1.25, narrow);
      items.push(...r.items);
      last = r.last;
    }
    if (this.headingOrnament && section.kind === "chapter") {
      const style: TextStyle = { family: this.headingOrnament.family, size: S * 1.4 };
      const r = this.display(this.headingOrnament.text, style, (last ?? y0) + S * 2.3, S, { align });
      items.push(...r.items);
      last = r.last;
    }
    if (section.epigraph) {
      const r = this.epigraphBlock(section.epigraph, (last ?? y0) + S * 2.8);
      items.push(...r.items);
      last = r.last;
    }
    return { items, bottom: (last ?? y0) + S * 0.3 };
  }

  /** An epigraph in a heading block or on its own page: italic, smaller,
   *  inset both sides, the attribution set right. Off the grid (it's part
   *  of the heading). */
  private epigraphBlock(epi: EpigraphBlock, firstBaseline: number): { items: DLItem[]; last: number } {
    const style: TextStyle = { ...this.body, size: this.S * 0.95 };
    const width = this.textW * 0.78;
    const x = (this.textW - width) / 2;
    const leading = this.L * 0.95;
    const items: DLItem[] = [];
    let y = firstBaseline;
    let last = y;
    const place = (set: SetPara) => {
      for (const line of set.lines) {
        items.push(...shift(line.items, x, y));
        last = y;
        y += leading;
      }
    };
    epi.paras.forEach((runs, i) => {
      if (i > 0) y += leading * 0.35;
      place(this.composer.setParagraph({ runs, style, width, align: "left", italicBlock: true, hyphenate: false }));
    });
    if (epi.attribution) {
      place(
        this.composer.setParagraph({
          runs: [{ text: "— " }, ...epi.attribution],
          style: { ...style, size: this.S * 0.9 },
          width,
          align: "right",
          hyphenate: false,
        }),
      );
    }
    return { items, last };
  }

  // ------------------------------------------------------------ sections

  private section(section: Section, key: string, startArabic: boolean) {
    const print = this.o.model.book.print;
    if (section.kind === "part") this.partOpen = true;
    else if (section.matter !== "body") this.partOpen = false;
    const level = section.kind === "chapter" && this.partOpen ? 1 : 0;

    if (!this.smf && (section.kind === "part" || startArabic || print.recto || section.matter !== "body")) {
      this.ensureRecto();
    }
    const head = section.title || section.label || this.o.model.book.meta.title;
    const index = this.addSection(contentsLabel(section), level, head, key);

    const cache = this.o.cache;
    const cacheKey = cache ? this.sectionKey(section, startArabic) : "";
    const cached = cache?.get(cacheKey);
    if (cached) {
      const delta = section.src - cached.base;
      for (const p of cached.pages) this.pages.push({ ...p, section: index, items: cloneItems(p.items, delta) });
      this.overfull += cached.overfull;
      if (cached.overfullSrc !== undefined) this.overfullSrc ??= cached.overfullSrc + delta;
      return;
    }
    const firstPage = this.pages.length;
    const overfullBefore = this.overfull;
    const srcBefore = this.overfullSrc;
    this.sectionPages(section, index, startArabic);
    cache?.set(cacheKey, {
      base: section.src,
      pages: this.pages.slice(firstPage).map((p) => ({ ...p, items: cloneItems(p.items) })),
      overfull: this.overfull - overfullBefore,
      overfullSrc: srcBefore === undefined ? this.overfullSrc : undefined,
    });
  }

  /** A section's content, its block numbers made relative to its heading
   *  (so the key survives edits elsewhere), with the images' sizes. */
  private sectionKey(section: Section, startArabic: boolean): string {
    const base = section.src;
    const images: unknown[] = [];
    const body = JSON.stringify({ ...section, id: "" }, (k, v) => {
      if (k === "src" && typeof v === "number" && v >= 0) return v - base;
      if (k === "url" && typeof v === "string") images.push(this.o.images?.get(v) ?? null);
      return v;
    });
    return `${this.contextKey}|${startArabic}|${JSON.stringify(images)}|${body}`;
  }

  private sectionPages(section: Section, index: number, startArabic: boolean) {
    const d = this.design;
    if (section.kind === "part" && !this.smf) {
      const p = this.page("part", index, { arabicStart: startArabic });
      const y = this.textTop + this.textH * 0.3;
      let last = y;
      if (section.label) {
        const style =
          d.labelCase === "upper"
            ? this.headingStyle(this.S * 1.05, { caps: "upper", tracking: 0.2 })
            : d.labelCase === "smallcaps"
              ? this.headingStyle(this.S * 1.35, { caps: "small", tracking: 0.08 })
              : this.headingStyle(this.S * 1.35);
        const r = this.display(section.label, style, y, style.size * 1.2);
        p.items.push(...r.items);
        last = r.last + this.S * 2.6;
      }
      if (section.title) {
        const style = this.headingStyle(this.S * 2.2, {
          italic: d.titleItalic,
          ...(d.titleCase === "upper" ? { caps: "upper" as const, tracking: 0.06 } : {}),
        });
        const r = this.display(section.title, style, last, style.size * 1.2, { width: this.textW * 0.86, x: this.textW * 0.07 });
        p.items.push(...r.items);
      }
      // Text under a part heading continues on the following pages.
      if (section.blocks.length) this.flow(this.rows(section, false), index, 0, null);
      return;
    }

    const hasHeading = this.smf || section.kind !== "untitled";
    const heading = hasHeading && (section.label || section.title || section.subtitle || section.epigraph) ? this.opener(section) : null;
    const start = heading ? this.slotAfter(heading.bottom, (this.smf ? 1.6 : 2.2) * this.L) : 0;
    const first = this.page(heading ? "opener" : "body", index, {
      arabicStart: startArabic,
      folio: heading ? (d.folioOnOpeners || this.smf ? "drop" : "none") : "normal",
    });
    if (heading) first.items.push(...heading.items);
    this.flow(this.rows(section, !!heading), index, start, first);
  }

  /** Lay rows onto pages; `first` is the page already begun (an opener),
   *  `start` the grid line its text starts on. */
  private flow(rows: Row[], section: number, start: number, first: PageDraft | null) {
    let page = first ?? this.page("body", section, { head: !this.smf, folio: "normal" });
    let pos = first ? start : 0;
    let i = 0;
    while (i < rows.length) {
      let fit = this.fill(rows, i, pos);
      if (fit.end < rows.length && fit.short >= 1) {
        // Before running the page short, try setting a paragraph on it a
        // line tighter or looser so the page fills.
        fit = this.loosen(rows, i, pos, fit) ?? fit;
      }
      let at = pos;
      for (let j = i; j < fit.end; j += 1) {
        const r = rows[j];
        if (at <= EPS && r.discard) continue;
        const y = this.y(at);
        if (r.scene && at <= EPS) page.items.push(...placeAt(r.scene.top, y));
        else if (!r.scene?.blank) page.items.push(...placeAt(r.items, y));
        at += this.rowH(r, at);
      }
      i = fit.end;
      if (i < rows.length) {
        page = this.page("body", section, { head: !this.smf, folio: "normal" });
        pos = 0;
      }
    }
  }

  /** A row's height at a position: grid snapping, and a blank-line scene
   *  break at a page top shows its ornament with a line of space. */
  private rowH(r: Row, at: number): number {
    if (r.scene?.blank && at <= EPS) return 2;
    return r.snap ? Math.ceil(at + r.h - EPS) - at : r.h;
  }

  /** How far rows from `i` fill a page starting at grid line `pos`: the
   *  row the page ends before, and how many lines short it runs. */
  private fill(rows: Row[], i: number, pos: number): { end: number; short: number } {
    const cap = this.capacity;
    let at = pos;
    let lastLegal = -1;
    let legalAt = at;
    let j = i;
    for (; j < rows.length; j += 1) {
      const r = rows[j];
      if (j > i && r.forceBreak) return { end: j, short: 0 };
      if (at <= EPS && r.discard) continue;
      const h = this.rowH(r, at);
      if (at + (r.discard ? 0 : h) > cap + EPS) break;
      at += h;
      if (j + 1 < rows.length && !rows[j + 1].noBreakBefore) {
        lastLegal = j + 1;
        legalAt = at;
      }
    }
    if (j >= rows.length) return { end: rows.length, short: 0 };
    // Nothing fits on a fresh page (an outsized row): place it anyway.
    if (j === i && pos <= EPS) return { end: i + 1, short: 0 };
    if (!rows[j].noBreakBefore) return { end: j, short: Math.max(0, cap - at) };
    if (lastLegal > i) return { end: lastLegal, short: Math.max(0, cap - legalAt) };
    // No legal break anywhere on the page (a long keep): break where full.
    return { end: pos <= EPS ? Math.max(j, i + 1) : j, short: 0 };
  }

  private loosen(rows: Row[], i: number, pos: number, fit: { end: number; short: number }) {
    const refs: ParaRef[] = [];
    for (let j = Math.min(rows.length - 1, fit.end + 2); j >= i && refs.length < 4; j -= 1) {
      const ref = rows[j].para;
      if (!ref || refs.includes(ref)) continue;
      // Only paragraphs that start on this page (earlier pages are set).
      if (rows.findIndex((r) => r.para === ref) < i) continue;
      refs.push(ref);
    }
    for (const ref of refs) {
      for (const loose of [-1, 1]) {
        const alt = ref.set.rebreak(loose);
        if (!alt) continue;
        const from = rows.findIndex((r) => r.para === ref);
        let to = from;
        while (to < rows.length && rows[to].para === ref) to += 1;
        const old = rows.slice(from, to);
        const altRows = this.paraRows({ ...ref, set: alt });
        rows.splice(from, old.length, ...altRows);
        const trial = this.fill(rows, i, pos);
        if (trial.short < 1 && trial.short < fit.short - EPS) return trial;
        rows.splice(from, altRows.length, ...old);
      }
    }
    return null;
  }

  // ------------------------------------------------------------ rows

  private paraRows(ref: ParaRef): Row[] {
    const lines = ref.set.lines;
    const n = lines.length;
    return lines.map((line, i) => ({
      h: 1,
      items: shift(cloneItems(line.items), ref.x, 0),
      noBreakBefore:
        (i === 0 && ref.keepWithPrev) || (n >= 2 && (i === 1 || i === n - 1)) || (i > 0 && i < ref.set.keepFirst),
      para: ref,
    }));
  }

  private rows(section: Section, hasHeading: boolean): Row[] {
    const d = this.design;
    const rows: Row[] = [];
    let keepNext = false;
    let breakNext = false;
    const push = (r: Row) => {
      if (keepNext) r.noBreakBefore = true;
      if (breakNext) r.forceBreak = true;
      keepNext = false;
      breakNext = false;
      rows.push(r);
    };
    const pushPara = (set: SetPara, x: number, extra?: (rows: Row[]) => void) => {
      const pr = this.paraRows({ set, x, keepWithPrev: keepNext });
      if (breakNext && pr.length) pr[0].forceBreak = true;
      extra?.(pr);
      keepNext = false;
      breakNext = false;
      rows.push(...pr);
    };
    const space = (h: number, snap = false) => push({ h, items: [], discard: true, snap });
    const justify: Align = d.justify ? "justify" : "left";
    const indentPt = this.smf ? 0.5 * PT : d.indent * this.S;

    for (const block of section.blocks) {
      switch (block.kind) {
        case "para": {
          const centered = block.align === "center" || block.align === "right";
          const indent = centered ? 0 : this.smf || block.indent ? indentPt : 0;
          // Drop caps and lead-ins open the story's sections (chapters,
          // prologue, epilogue) — not forewords or acknowledgments.
          const opener = block.opener && hasHeading && !this.smf && block.align === "left" && section.matter === "body";
          const input = {
            runs: block.runs,
            width: this.textW,
            align: centered ? block.align : justify,
            indent,
            hyphenate: d.hyphenate,
            leadIn: opener ? d.leadIn : ("none" as const),
            src: block.src,
          };
          let set: SetPara | null = null;
          if (opener && d.dropCap >= 2) {
            // A drop cap needs as many lines beside it as it is tall: an
            // opening paragraph that's too short gets a smaller one.
            for (let lines = d.dropCap; lines >= 2 && !set; lines -= 1) {
              const trial = this.composer.setParagraph({ style: this.body, ...input, dropCap: { lines, family: d.headingFont, leading: this.L } });
              if (trial.lines.length < lines) continue;
              set = trial;
              if (trial.overfull) {
                this.overfull += trial.overfull;
                this.overfullSrc ??= block.src;
              }
            }
          }
          pushPara(set ?? this.para(input), 0);
          break;
        }
        case "scene":
          push(this.sceneRow());
          keepNext = true;
          break;
        case "subheading": {
          space(1);
          const style: TextStyle = this.smf ? this.body : { ...this.body, caps: "small", tracking: 0.05 };
          const set = this.para({ runs: block.runs, style, width: this.textW * 0.9, align: "center", hyphenate: false, src: block.src });
          set.lines.forEach((line, i) =>
            push({ h: 1, items: shift(cloneItems(line.items), this.textW * 0.05, 0), noBreakBefore: i > 0 }),
          );
          keepNext = true;
          push({ h: 1, items: [] });
          keepNext = true;
          break;
        }
        case "blockquote": {
          const inset = this.smf ? 0.5 * PT : this.S * 1.6;
          const style: TextStyle = !this.smf && d.blockquote === "smaller" ? { ...this.body, size: this.S * 0.92 } : this.body;
          space(0.5);
          block.paras.forEach((p, i) => {
            const centered = p.align === "center" || p.align === "right";
            pushPara(
              this.para({
                runs: p.runs,
                style,
                width: this.textW - 2 * inset,
                align: centered ? p.align : justify,
                indent: i > 0 && !centered ? indentPt : 0,
                hyphenate: d.hyphenate,
                italicBlock: !this.smf && d.blockquote === "indent-italic",
                src: block.src,
              }),
              inset,
            );
          });
          space(0.5, true);
          break;
        }
        case "verse": {
          const inset = this.smf ? 0.5 * PT : this.S * 2;
          space(0.5);
          // A short stanza stays together; a long one may break, but never
          // leaving a single line behind or ahead.
          const stanza: Row[] = [];
          for (const line of block.lines) {
            const set = this.para({ runs: line, width: this.textW - inset, align: "left", hang: this.S * 1.5, hyphenate: false, src: block.src });
            for (const l of set.lines) stanza.push({ h: 1, items: shift(cloneItems(l.items), inset, 0) });
          }
          const n = stanza.length;
          stanza.forEach((r, i) => {
            if (n <= 6 ? i > 0 : i === 1 || i === n - 1) r.noBreakBefore = true;
            push(r);
          });
          space(0.5, true);
          break;
        }
        case "epigraph": {
          space(0.5);
          const width = this.textW * 0.78;
          const x = (this.textW - width) / 2;
          const style: TextStyle = { ...this.body, size: this.smf ? this.S : this.S * 0.95 };
          for (const runs of block.paras) {
            pushPara(this.para({ runs, style, width, align: "left", italicBlock: !this.smf, hyphenate: false, src: block.src }), x);
          }
          if (block.attribution) {
            keepNext = true;
            pushPara(this.para({ runs: [{ text: "— " }, ...block.attribution], style, width, align: "right", hyphenate: false, src: block.src }), x);
          }
          space(0.5, true);
          break;
        }
        case "list": {
          const inset = this.S * 1.6;
          space(0.5);
          block.items.forEach((runs, i) => {
            const marker = this.composer.setLine(block.ordered ? `${i + 1}.` : "•", this.body);
            const set = this.para({ runs, width: this.textW - inset, align: justify, hyphenate: d.hyphenate, src: block.src });
            pushPara(set, inset, (pr) => {
              if (pr.length) pr[0].items.push(...shift(marker.items, inset - marker.width - this.S * 0.5, 0));
            });
          });
          space(0.5, true);
          break;
        }
        case "image": {
          const r = this.imageRow(block.url);
          if (r) push(r);
          break;
        }
        case "pageBreak":
          breakNext = true;
          break;
      }
    }
    return rows;
  }

  private sceneRow(): Row {
    const d = this.design;
    const orn = this.sceneOrnament;
    const asterisks = /^[*\s]+$/.test(orn.text);
    // A single dingbat (⁂ ❦) is drawn larger than a run of marks.
    const single = [...orn.text.trim()].length === 1;
    const style: TextStyle = {
      family: orn.family,
      size: asterisks ? this.S : single ? this.S * 1.45 : this.S * 1.1,
      tracking: asterisks ? 0.1 : 0,
    };
    const line = this.composer.setLine(orn.text, style);
    const x = (this.textW - line.width) / 2;
    // Asterisks ride high; drop them toward the x-height.
    const drop = asterisks ? this.S * 0.25 : 0;
    const top = shift(cloneItems(line.items), x, drop);
    if (this.smf) return { h: 1, items: top, scene: { top, blank: false } };
    if (d.sceneBreak === "blank") return { h: 1, items: [], scene: { top, blank: true } };
    // Two grid lines, the ornament centred optically between the text above
    // and the text below.
    const faces = this.o.faces;
    const xh = faces.capHeight(faces.face(d.bodyFont, "regular")) * 0.66 * this.S;
    const ornCap = faces.capHeight(faces.face(orn.family, "regular")) * style.size;
    const mid = 0.5 * this.L - xh / 2 + ornCap / 2 + drop;
    return { h: 2, items: shift(cloneItems(line.items), x, mid), scene: { top, blank: false } };
  }

  private imageRow(url: string): Row | null {
    const info = this.o.images?.get(url);
    if (!info || !info.w || !info.h) return null;
    // At least 150 pixels per inch on paper; never wider than the text.
    let w = Math.min(this.textW, (info.w * PT) / 150);
    let h = (w * info.h) / info.w;
    const maxH = (this.capacity - 2) * this.L;
    if (h > maxH) {
      w *= maxH / h;
      h = maxH;
    }
    const slots = Math.max(1, Math.ceil((h + 0.6 * this.L) / this.L));
    const cap = this.capOf(this.body);
    const top = -cap + ((slots - 1) * this.L + cap - h) / 2;
    return { h: slots, items: [{ t: "image", x: (this.textW - w) / 2, y: top, w, h, ref: url }] };
  }

  // ------------------------------------------------------------ front & back

  private frontMatter() {
    const { meta, print } = this.o.model.book;
    const d = this.design;
    const S = this.S;
    const title = meta.title || "Untitled";
    const upper = d.titleCase === "upper" ? { caps: "upper" as const, tracking: 0.06 } : {};
    const alsoByFront = meta.alsoBy.length > 0 && print.alsoBy === "front";

    if (print.halfTitle) {
      const p = this.page("half-title");
      const style = this.headingStyle(S * 1.5, upper);
      p.items.push(...this.display(title, style, this.textTop + this.textH * 0.25, style.size * 1.25, { width: this.textW * 0.85, x: this.textW * 0.075 }).items);
      // Its back: the also-by list, or blank.
      if (alsoByFront) this.alsoByPage(false);
      else this.page("blank");
    } else if (alsoByFront) {
      this.ensureVerso();
      this.alsoByPage(false);
    }

    if (print.titlePage) {
      this.ensureRecto();
      const p = this.page("title");
      const style = this.headingStyle(S * 2.4, upper);
      const t = this.display(title, style, this.textTop + this.textH * 0.2, style.size * 1.15, { width: this.textW * 0.9, x: this.textW * 0.05 });
      p.items.push(...t.items);
      let y = t.last;
      if (meta.subtitle) {
        const st: TextStyle = { family: d.bodyFont, size: S * 1.3, italic: true };
        const r = this.display(meta.subtitle, st, y + st.size * 2.2, st.size * 1.25, { width: this.textW * 0.85, x: this.textW * 0.075 });
        p.items.push(...r.items);
        y = r.last;
      }
      if (meta.author) {
        const st = this.headingStyle(S * 1.35, { tracking: 0.04 });
        p.items.push(...this.display(meta.author, st, Math.max(y + S * 4, this.textTop + this.textH * 0.58), st.size * 1.2).items);
      }
      if (meta.publisher) {
        const st: TextStyle = { family: d.bodyFont, size: S * 0.95, caps: "small", tracking: 0.08 };
        p.items.push(...this.display(meta.publisher, st, this.textTop + this.textH - S * 0.4, st.size * 1.2).items);
      }
    }
    if (print.copyright) {
      this.ensureVerso();
      this.copyrightPage();
    }

    if (meta.dedication.trim() && print.dedication) {
      this.ensureRecto();
      const p = this.page("dedication");
      const st: TextStyle = { family: d.bodyFont, size: S * 1.05, italic: true };
      let y = this.textTop + this.textH * 0.22;
      for (const line of meta.dedication.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const r = this.display(line, st, y, this.L, { width: this.textW * 0.75, x: this.textW * 0.125 });
        p.items.push(...r.items);
        y = r.last + this.L;
      }
    }

    if (meta.epigraph.trim() && print.epigraph) {
      this.ensureRecto();
      const p = this.page("epigraph");
      const epi: EpigraphBlock = {
        kind: "epigraph",
        paras: meta.epigraph
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text) => [{ text }]),
        attribution: meta.epigraphSource ? [{ text: meta.epigraphSource }] : null,
        src: -1,
      };
      p.items.push(...this.epigraphBlock(epi, this.textTop + this.textH * 0.22).items);
    }

    if (wantsContents(print.toc, this.o.model.sections)) this.contents();
  }

  private alsoByPage(back: boolean) {
    const { meta } = this.o.model.book;
    const heading = meta.author ? `Also by ${meta.author}` : "Also by";
    if (back) {
      this.ensureRecto();
      const index = this.addSection(heading, 0, heading, "alsoby");
      const p = this.page("back", index);
      const head = this.opener({ kind: "section", label: "", title: heading });
      p.items.push(...head.items);
      let y = this.y(this.slotAfter(head.bottom, 2.2 * this.L));
      for (const t of meta.alsoBy) {
        const r = this.display([{ text: t, italic: true }], this.body, y, this.L);
        p.items.push(...r.items);
        y = r.last + this.L;
      }
      return;
    }
    const p = this.page("also-by");
    const st: TextStyle = { family: this.design.bodyFont, size: this.S, caps: "small", tracking: 0.08 };
    const r = this.display(heading, st, this.textTop + this.textH * 0.12, this.L);
    p.items.push(...r.items);
    let y = r.last + this.L * 2;
    for (const t of meta.alsoBy) {
      const line = this.display([{ text: t, italic: true }], this.body, y, this.L);
      p.items.push(...line.items);
      y = line.last + this.L;
    }
  }

  private copyrightPage() {
    const p = this.page("copyright");
    const paras = copyrightParagraphs(this.o.model.book.meta, this.o.now ?? new Date());
    const size = this.S * 0.8;
    const leading = size * 1.3;
    const style: TextStyle = { ...this.body, size };
    const sets = paras.map((text) => this.composer.setParagraph({ runs: [{ text }], style, width: this.textW, align: "left", hyphenate: false }));
    const gap = leading * 0.7;
    const lines = sets.reduce((n, s) => n + s.lines.length, 0);
    const height = (lines - 1) * leading + (sets.length - 1) * gap;
    // Set at the foot of the page, the traditional place.
    const bottom = this.y(this.capacity - 1);
    let y = Math.max(this.firstBaseline, bottom - height);
    if (bottom - height < this.firstBaseline) {
      this.warnings.push({ kind: "overfull", message: "The copyright page runs longer than a page — shorten the custom notice." });
    }
    for (const set of sets) {
      for (const line of set.lines) {
        if (y <= this.pageH - 0.4 * PT) p.items.push(...shift(line.items, 0, y));
        y += leading;
      }
      y += gap;
    }
  }

  private contents() {
    this.ensureRecto();
    const index = this.addSection("Contents", 0, "Contents");
    const head = this.opener({ kind: "section", label: "", title: "Contents" });
    let page = this.page("toc", index);
    page.items.push(...head.items);
    let pos = this.slotAfter(head.bottom, 2.2 * this.L);

    const { meta, print } = this.o.model.book;
    const entries: { label: string; part: boolean; key: string }[] = [];
    this.o.model.sections.forEach((s, i) => {
      if (s.kind !== "untitled") entries.push({ label: contentsLabel(s), part: s.kind === "part", key: `s${i}` });
    });
    if (meta.aboutAuthor.trim() && print.aboutAuthor) entries.push({ label: "About the Author", part: false, key: "about" });
    if (meta.alsoBy.length && print.alsoBy === "back") {
      entries.push({ label: meta.author ? `Also by ${meta.author}` : "Also by", part: false, key: "alsoby" });
    }

    const width = this.textW - this.composer.setLine("000", this.body).width - this.S * 1.5;
    entries.forEach((e, i) => {
      const style: TextStyle = e.part ? { ...this.body, caps: "small", tracking: 0.06 } : this.body;
      const set = this.composer.setParagraph({ runs: [{ text: e.label }], style, width, align: "left", hang: this.S * 1.2, hyphenate: false });
      const gapBefore = e.part && i > 0 ? 1 : 0;
      if (pos + gapBefore + set.lines.length > this.capacity) {
        page = this.page("toc", index, { folio: "normal" });
        pos = 0;
      } else {
        pos += gapBefore;
      }
      set.lines.forEach((line, li) => page.items.push(...shift(line.items, 0, this.y(pos + li))));
      this.toc.push({ page, y: this.y(pos + set.lines.length - 1), key: e.key });
      pos += set.lines.length;
    });
  }

  private backMatter() {
    const { meta, print } = this.o.model.book;
    if (meta.aboutAuthor.trim() && print.aboutAuthor) {
      this.ensureRecto();
      const index = this.addSection("About the Author", 0, "About the Author", "about");
      const head = this.opener({ kind: "section", label: "", title: "About the Author" });
      const first = this.page("back", index);
      first.items.push(...head.items);
      const d = this.design;
      const rows: Row[] = [];
      meta.aboutAuthor
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((text, i) => {
          const set = this.para({
            runs: [{ text }],
            width: this.textW,
            align: d.justify ? "justify" : "left",
            indent: i > 0 ? d.indent * this.S : 0,
            hyphenate: d.hyphenate,
          });
          rows.push(...this.paraRows({ set, x: 0, keepWithPrev: false }));
        });
      this.flow(rows, index, this.slotAfter(head.bottom, 2.2 * this.L), first);
    }
    if (meta.alsoBy.length && print.alsoBy === "back") this.alsoByPage(true);
  }

  // ------------------------------------------------------------ manuscript

  private smfTitlePage() {
    const { meta, contact } = this.o.model.book;
    const p = this.page("title");
    const leading = this.S * 1.2;
    const contactLines = [contact.legalName || meta.author, ...contact.address.split("\n"), contact.phone, contact.email]
      .map((l) => (l ?? "").trim())
      .filter(Boolean);
    let y = this.firstBaseline;
    const count = this.composer.setLine(roundedWordCount(this.o.model.words), this.body);
    p.items.push(...shift(count.items, this.textW - count.width, y));
    for (const line of contactLines) {
      p.items.push(...shift(this.composer.setLine(line, this.body).items, 0, y));
      y += leading;
    }
    if (contact.agent.trim()) {
      y += leading;
      for (const line of contact.agent.split("\n").map((l) => l.trim()).filter(Boolean)) {
        p.items.push(...shift(this.composer.setLine(line, this.body).items, 0, y));
        y += leading;
      }
    }
    if (!contact.legalName && !contact.email) {
      this.warnings.push({ kind: "contact", message: "No contact details for the title page — add them in Book ▸ Submission manuscript." });
    }
    const t = this.display((meta.title || "Untitled").toLocaleUpperCase(meta.language || "en-US"), this.body, this.pageH / 2, this.L);
    p.items.push(...t.items);
    let ty = t.last;
    if (meta.subtitle) {
      const s = this.display(meta.subtitle, this.body, ty + this.L, this.L);
      p.items.push(...s.items);
      ty = s.last;
    }
    p.items.push(...this.display(`by ${meta.author || contact.legalName || "Author"}`, this.body, ty + this.L * 2, this.L).items);
  }

  private smfEnd() {
    const last = this.pages[this.pages.length - 1];
    if (!last || this.pages.length < 2) return;
    // "END", centred, a blank line below the last text.
    const lowest = last.items.reduce(
      (m, it) => Math.max(m, it.t === "rule" ? it.y1 : it.t === "image" ? it.y + it.h : it.y),
      this.firstBaseline - this.L,
    );
    let slot = this.slotAfter(lowest, 2 * this.L - EPS);
    let page = last;
    if (slot >= this.capacity) {
      page = this.page("body", last.section, { folio: "normal" });
      slot = 0;
    }
    const end = this.composer.setLine("END", this.body);
    page.items.push(...shift(end.items, (this.textW - end.width) / 2, this.y(slot)));
  }

  // ------------------------------------------------------------ assembly

  private assemble(): DisplayList {
    const model = this.o.model;
    const { meta } = model.book;
    const d = this.design;
    if (!this.smf && this.pages.length % 2 === 1) this.page("blank");

    // Folios: roman until the arabic start, then arabic from 1. The
    // manuscript numbers every page after its title page.
    const folios: string[] = [];
    {
      let roman = 0;
      let arabic = 0;
      let arabicOn = false;
      this.pages.forEach((p, i) => {
        if (this.smf) {
          folios.push(i === 0 ? "" : String(i));
          return;
        }
        if (p.arabicStart) arabicOn = true;
        if (arabicOn) folios.push(String((arabic += 1)));
        else folios.push(toRoman((roman += 1)).toLowerCase());
      });
    }
    for (const s of this.sections) s.folio = folios[s.firstPage] ?? "";

    const headStyle: TextStyle =
      d.headStyle === "italic"
        ? { family: d.bodyFont, size: this.S * 0.95, italic: true }
        : { family: d.bodyFont, size: this.S * 0.88, caps: "all", tracking: 0.1 };
    const folioStyle: TextStyle = { ...this.body, size: this.S * 0.95 };
    const smf = this.smf ? smfNames(model) : null;

    // Contents page numbers, now that every section has its page.
    for (const entry of this.toc) {
      const target = this.keys.get(entry.key);
      if (target === undefined) continue;
      const num = this.composer.setLine(this.sections[target].folio, this.body);
      entry.page.items.push(...shift(num.items, this.textW - num.width, entry.y));
    }

    let current = -1;
    const pages: DLPage[] = this.pages.map((draft, i) => {
      const n = i + 1;
      const recto = this.smf || n % 2 === 1;
      const folio = folios[i];
      if (draft.section >= 0) current = draft.section;
      const items = draft.items;

      if (smf) {
        if (i > 0) {
          const header = this.composer.setLine(`${smf.surname} / ${smf.shortTitle} / ${folio}`, this.body);
          items.push(...shift(header.items, this.textW - header.width, this.headBaseline));
        }
      } else {
        if (draft.head && d.runningHeads !== "none") {
          const text =
            d.runningHeads === "author-title"
              ? recto
                ? meta.title
                : meta.author || meta.title
              : recto
                ? (current >= 0 ? this.heads[current] : "") || meta.title
                : meta.title;
          if (text) {
            const head = this.composer.setLine(text, headStyle);
            // A head too long for the line is left off rather than crowded.
            if (head.width <= this.textW * 0.8) items.push(...shift(head.items, (this.textW - head.width) / 2, this.headBaseline));
          }
        }
        if (draft.folio !== "none" && draft.role !== "blank") {
          const f = this.composer.setLine(folio, folioStyle);
          const outsideX = recto ? this.textW - f.width : 0;
          if (draft.folio === "drop" || d.folio === "bottom-center") {
            items.push(...shift(f.items, (this.textW - f.width) / 2, this.footBaseline));
          } else if (d.folio === "bottom-outside") {
            items.push(...shift(f.items, outsideX, this.footBaseline));
          } else {
            items.push(...shift(f.items, outsideX, this.headBaseline));
          }
        }
      }

      // Text-block coordinates → page coordinates.
      shift(items, recto ? this.inside : this.outside, 0);
      return {
        n,
        folio: draft.role === "blank" || draft.folio === "none" || !folio ? null : folio,
        side: recto ? "recto" : "verso",
        role: draft.role,
        section: draft.section,
        items,
      };
    });

    if (this.overfull) {
      this.warnings.push({
        kind: "overfull",
        message: `${this.overfull} line${this.overfull === 1 ? " is" : "s are"} slightly too wide (a long word or link that can’t break).`,
        ...(this.overfullSrc !== undefined && this.overfullSrc >= 0 ? { src: this.overfullSrc } : {}),
      });
    }
    for (const [family, chars] of this.o.faces.missing) {
      const list = [...chars].filter((c) => c.trim()).slice(0, 12).join(" ");
      if (list) {
        this.warnings.push({
          kind: "missing-glyphs",
          message: `${bookFont(family).label} has no ${list} — ${chars.size === 1 ? "it prints" : "they print"} as a blank box.`,
        });
      }
    }
    if (!this.smf && pages.length < 24) {
      this.warnings.push({ kind: "page-count", message: `${pages.length} pages — KDP and IngramSpark need at least 24 for a paperback.` });
    }

    return {
      trim: { w: this.pageW, h: this.pageH },
      faces: this.o.faces.faces.slice(),
      pages,
      sections: this.sections,
      meta: {
        title: meta.title || "Untitled",
        author: meta.author,
        subject: meta.description.slice(0, 200),
        lang: meta.language || "en-US",
      },
      warnings: this.warnings,
      insideMargin: this.inside / PT,
    };
  }
}

function cloneItems(items: DLItem[], srcDelta = 0): DLItem[] {
  return items.map((it) => {
    if (it.t !== "text") return { ...it };
    const copy = { ...it, ...(it.xs ? { xs: it.xs.slice() } : {}) };
    if (srcDelta && copy.src !== undefined && copy.src >= 0) copy.src += srcDelta;
    return copy;
  });
}

/** Copies of row items moved down to a baseline. */
function placeAt(items: DLItem[], y: number): DLItem[] {
  return shift(cloneItems(items), 0, y);
}
