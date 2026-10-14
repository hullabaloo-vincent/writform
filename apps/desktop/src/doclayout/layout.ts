/**
 * Laying a document out on pages: every paragraph is set into lines (first
 * fit, as a word processor does, so pages hold still while you type), the
 * lines flow down columns and across pages with headings kept to their
 * text and no line left alone at a page's top or foot, and each page gets
 * its header, footer and line numbers. Tables flow row by row (their
 * header row repeated on each page), footnotes sit at the foot of the
 * column that cites them and run over when they must, a table of contents
 * lists the headings with the pages they landed on, and a section starts a
 * new page with a sheet, margins and columns of its own.
 *
 * The result is a display list — the same thing a book's layout produces —
 * which the PDF writer, the printer and the preview all draw.
 */

import {
  fillSlot,
  formatPageNumber,
  pageDims,
  sectionSettings,
  sideMargins,
  slotsForPage,
  type DocSettings,
} from "../apps/documents/docSettings";
import { Composer, type RichRun, type SetPara, type TextStyle } from "../book/engine/compose";
import type { FaceSet } from "../book/engine/faces";
import type { Hyphenator } from "../book/engine/hyphenate";
import type { DisplayList, DLItem, DLPage, DLSection, PageStart, StructNode } from "../book/engine/types";
import type { Warning } from "../book/model/types";
import { BORDER_PAD_X, BORDER_PAD_Y, noteFormat, noteLabel, noteRestart, shownSize, type SectionProps } from "../editor/schema/sanitize";
import { CODE_FONT, CODE_SIZE, LIST_HANG, SINGLE } from "../editor/styles/sheet";
import { lineOffsets } from "./lineStarts";
import { type DocCell, LINK_COLOR, type DocBlock, type DocImage, type DocModel, type DocPara, type DocRun, type DocTable, type DocToc } from "./model";

/** Sub- and superscript: the type's size, and how far it moves, as shares
 *  of the size around it (styles.css draws the same). */
export const SCRIPT_SIZE = 0.65;
export const SUPER_RISE = 0.33;
export const SUB_DROP = 0.14;

/** Lines kept together at the foot and the top of a page. */
const ORPHANS = 2;
const WIDOWS = 2;
const EPS = 0.01;
const PX = 0.75;

/** A table's cells: the space between a cell's edge and its text, and the
 *  weight of its lines (styles.css draws the same). */
export const CELL_PAD_X = 5;
export const CELL_PAD_Y = 3;
export const CELL_LINE = 0.5;
const TABLE_INK = "#000000";

/** The rule above a column's footnotes: its length, and the room around it. */
const NOTE_RULE = 144;
const NOTE_GAP_ABOVE = 7;
const NOTE_GAP_BELOW = 4;
const NOTE_SEP = NOTE_GAP_ABOVE + NOTE_GAP_BELOW;

/** In a note's reference: where in the column's notes it points. */
const NOTE_LINK = "#wf-note-";
const noteAnchor = (index: number) => `wf-note-${index}`;

interface Row {
  h: number;
  /** Items relative to the column's left edge and the row's top. */
  items: DLItem[];
  /** A line of text (numbered when line numbers are on); its baseline. */
  baseline?: number;
  /** The notes cited on it (indices into the model's notes). */
  notes?: number[];
  /** A line of a paragraph: where its text starts in the editor's node. */
  at?: number;
  /** A table's row (or rows held together): which one it starts with. */
  tr?: number;
  /** Where it begins in the editor's document (rows set inside a table's
   *  cell know this, to say where a page begins when one is cut). */
  start?: PageStart | null;
  /** Only the space between two blocks. */
  gap?: boolean;
  /** What is left of a table's row after a page took its beginning: where
   *  each of its cells goes on, in the editor's document. */
  starts?: PageStart[];
  /**
   * A table's row can be cut: as much of each of its cells as fits in `h`,
   * and the rest. Null when nothing of it fits there (it goes to the next
   * column whole). With `force`, at least a line is taken whatever the room.
   */
  cut?: (h: number, force: boolean) => [Row, Row] | null;
  /** The least of it that may stand at the foot of a column. */
  min?: number;
}

interface Unit {
  block: DocBlock;
  rows: Row[];
  before: number;
  after: number;
  splittable: boolean;
  /** Rows that must stay together at the start (a drop cap's lines). */
  keepFirst: number;
  /** Its rows stand alone (a table's): one may end a page or start one. */
  loose?: boolean;
  /** Set again at the top when the unit runs over (a table's header row). */
  header?: Row;
}

/**
 * Set paragraphs, remembered between layouts: while a document is being
 * edited only the paragraph under the cursor changes, so the rest are
 * reused and a new layout is a matter of flowing rows.
 */
export class ParaCache {
  private live = new Map<string, Row[]>();
  private next = new Map<string, Row[]>();

  get(key: string): Row[] | undefined {
    const hit = this.live.get(key) ?? this.next.get(key);
    if (hit) this.next.set(key, hit);
    return hit;
  }

  set(key: string, rows: Row[]): void {
    this.next.set(key, rows);
  }

  /** Drop what the layout just finished didn't use. */
  sweep(): void {
    this.live = this.next;
    this.next = new Map();
  }
}

export interface DocLayoutInput {
  model: DocModel;
  faces: FaceSet;
  hyphenator: Hyphenator | null;
  /** Pixel sizes of the pictures, by address. */
  images: Map<string, { w: number; h: number }>;
  cache?: ParaCache;
}

function place(items: DLItem[], dx: number, dy: number, src?: number): DLItem[] {
  return items.map((it) => {
    if (it.t === "text") {
      const out = { ...it, x: it.x + dx, y: it.y + dy, ...(it.xs ? { xs: it.xs.map((v) => v + dx) } : {}) };
      if (src !== undefined) out.src = src;
      return out;
    }
    if (it.t === "rule") return { ...it, x1: it.x1 + dx, x2: it.x2 + dx, y1: it.y1 + dy, y2: it.y2 + dy };
    if (it.t === "anchor") return { ...it, y: it.y + dy };
    return { ...it, x: it.x + dx, y: it.y + dy };
  });
}

/** A checklist's box (ticked or not) or a tick, drawn rather than set in
 *  type: no text face is sure to have the characters. `right` is where the
 *  marker ends; `base` the line's baseline. */
function signItems(sign: "box" | "boxOn" | "tick", right: number, base: number, size: number): DLItem[] {
  const side = size * 0.62;
  const x = right - side;
  const top = base - side * 0.98;
  const w = Math.max(0.5, size * 0.055);
  const out: DLItem[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, weight = w): DLItem => ({ t: "rule", x1, y1, x2, y2, w: weight });
  if (sign !== "tick") {
    out.push(line(x, top, x + side, top), line(x, top + side, x + side, top + side), line(x, top - w / 2, x, top + side + w / 2), line(x + side, top - w / 2, x + side, top + side + w / 2));
  }
  if (sign !== "box") {
    const k = w * 1.5;
    out.push(line(x + side * 0.2, top + side * 0.55, x + side * 0.42, top + side * 0.78, k), line(x + side * 0.42, top + side * 0.78, x + side * 0.82, top + side * 0.24, k));
  }
  return out;
}

/** A paragraph's shading and borders, row by row (a paragraph may be split
 *  across pages): a bar behind each row, rules down its sides, and a rule
 *  above the first and below the last. A border stands off the text, so the
 *  first and last rows grow by that much. */
function decorate(rows: Row[], b: DocPara, width: number): Row[] {
  const border = b.border;
  const has = (side: string) => !!border && border.sides.includes(side);
  const bw = border?.width ?? 0;
  const padL = has("l") ? BORDER_PAD_X + bw : 0;
  const padR = has("r") ? BORDER_PAD_X + bw : 0;
  const x0 = b.left - padL;
  const x1 = b.left + width + padR;
  return rows.map((row, i) => {
    const first = i === 0;
    const last = i === rows.length - 1;
    // Joined to a neighbour: no rule on that side, and (below) the space
    // between the two is inside the box.
    const capTop = first && has("t") && !b.joinPrev;
    const capBottom = last && has("b") && !b.joinNext;
    const top = capTop ? BORDER_PAD_Y + bw : 0;
    const bottom = capBottom ? BORDER_PAD_Y + bw : last && b.joinNext ? b.after : 0;
    const h = row.h + top + bottom;
    const under: DLItem[] = [];
    // (A hair's overlap, so no seam shows between the rows' bars.)
    if (b.shade) under.push({ t: "rect", x: x0, y: 0, w: x1 - x0, h: last ? h : h + 0.3, color: b.shade });
    const over: DLItem[] = [];
    if (border) {
      const rule = (ax: number, ay: number, bx: number, by: number): DLItem => ({ t: "rule", x1: ax, y1: ay, x2: bx, y2: by, w: bw, color: border.color });
      if (capTop) over.push(rule(x0, bw / 2, x1, bw / 2));
      if (capBottom) over.push(rule(x0, h - bw / 2, x1, h - bw / 2));
      if (has("l")) over.push(rule(x0 + bw / 2, 0, x0 + bw / 2, h));
      if (has("r")) over.push(rule(x1 - bw / 2, 0, x1 - bw / 2, h));
    }
    return {
      h,
      ...(row.baseline !== undefined ? { baseline: row.baseline + top } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.at !== undefined ? { at: row.at } : {}),
      items: [...under, ...(top ? place(row.items, 0, top) : row.items), ...over],
    };
  });
}

/** The sheet, margins and columns one section is set on. */
interface Geometry {
  /** The document's settings with the section's own on top. */
  s: DocSettings;
  w: number;
  h: number;
  mt: number;
  textW: number;
  cols: number;
  colGap: number;
  colW: number;
  colH: number;
}

function geometryOf(base: DocSettings, props: SectionProps | null): Geometry {
  const s = sectionSettings(base, props);
  const dims = pageDims(s);
  const w = dims.w * 72;
  const h = dims.h * 72;
  const textW = Math.max(72, w - (s.ml + s.mr + s.gutter) * 72);
  const cols = Math.max(1, Math.min(3, s.cols));
  const colGap = cols > 1 ? s.colGap * 72 : 0;
  return {
    s,
    w,
    h,
    mt: s.mt * 72,
    textW,
    cols,
    colGap,
    colW: Math.max(36, (textW - colGap * (cols - 1)) / cols),
    colH: Math.max(72, h - (s.mt + s.mb) * 72),
  };
}

/**
 * A document's pages. Footnotes that start again on each page are numbered
 * by where they land, which is known only once the pages are made: so the
 * pages are made, the footnotes numbered again, and the pages made again
 * until no number changes (a label of another width can move a line), four
 * times at most.
 */
export function layoutDoc(input: DocLayoutInput): DisplayList {
  const { model } = input;
  if (noteRestart(model.settings.fnRestart) !== "page" || !model.notes.some((n) => n.kind === "foot")) return layoutPass(input);
  const format = noteFormat(model.settings.fnFormat, "1");
  let current = model;
  let used = model.notes.map((n) => n.number);
  let dl: DisplayList | null = null;
  for (let round = 0; round < 4; round += 1) {
    const where = new Map<number, number>();
    dl = layoutPass({ ...input, model: current }, where);
    const perPage = new Map<number, number>();
    const next = current.notes.map((note, i) => {
      if (note.kind !== "foot") return note.number;
      const page = where.get(i) ?? -1;
      const k = (perPage.get(page) ?? 0) + 1;
      perPage.set(page, k);
      return noteLabel(k, format);
    });
    if (round === 3 || next.every((label, i) => label === used[i])) break;
    used = next;
    current = relabelNotes(current, next);
  }
  return { ...dl!, noteLabels: used };
}

/** The model with its notes' numbers as given (each, in the order cited). */
export function relabelNotes(model: DocModel, labels: readonly string[]): DocModel {
  const runs = (list: DocRun[]): DocRun[] | null => {
    let changed = false;
    const out = list.map((r) => {
      const label = r.note !== undefined ? labels[r.note] : undefined;
      if (label === undefined || label === r.text) return r;
      changed = true;
      return { ...r, text: label };
    });
    return changed ? out : null;
  };
  const block = (b: DocBlock): DocBlock => {
    if (b.kind === "para") {
      const next = runs(b.runs);
      return next ? { ...b, runs: next } : b;
    }
    if (b.kind === "table") return { ...b, rows: b.rows.map((row) => row.map((cell) => ({ ...cell, blocks: cell.blocks.map(block) }))) };
    if (b.kind === "image" && b.caption) return { ...b, caption: block(b.caption) as DocPara };
    return b;
  };
  const notes = model.notes.map((note, i) => {
    const label = labels[i];
    if (label === undefined || label === note.number) return note;
    const [first, ...rest] = note.para.runs;
    return { ...note, number: label, para: { ...note.para, runs: [{ ...first, text: label }, ...rest] } };
  });
  return { ...model, notes, blocks: model.blocks.map(block) };
}

function layoutPass(input: DocLayoutInput, notePage?: Map<number, number>): DisplayList {
  const { model, faces } = input;
  const s = model.settings;
  const cache = input.cache ?? new ParaCache();
  const composer = new Composer(faces, input.hyphenator, model.meta.lang);
  const warnings: Warning[] = [];
  const overfull = new Set<number>();

  // ---- a tagged PDF: whose each item on a page is
  // The model's structure, with what only the layout can add (a link is as
  // many pieces as the lines it runs over. The contents has a line for
  // each heading that made it in).
  const struct: StructNode[] | undefined = model.struct ? [...model.struct] : undefined;
  /**
   * Say whose these items are: `tag`, an element of the structure (and
   * `lblTag` for a list item's marker). Words under a link become that
   * link's. Rules and bars stay nobody's: decoration. What already has an
   * owner keeps it (a table's cells are stamped as they are set).
   *
   * The items must be copies of the caller's own (`place` makes them): a
   * paragraph's rows are kept and shared between paragraphs set alike, so
   * an owner can never be written on those.
   */
  const stamp = (items: DLItem[], tag: number | undefined, lblTag?: number): DLItem[] => {
    if (!struct || tag === undefined) return items;
    for (const it of items) {
      if (it.t !== "link" || it.s !== undefined) continue;
      struct.push({ role: "Link", parent: tag, late: true });
      const link = struct.length - 1;
      it.s = link;
      for (const other of items) {
        if (other.t !== "text" || other.s !== undefined || other.lbl) continue;
        if (other.x >= it.x - 0.05 && other.x < it.x + it.w - 0.05 && other.y >= it.y - it.h && other.y <= it.y + it.h * 2) other.s = link;
      }
    }
    for (const it of items) {
      if (it.t === "text" && it.s === undefined) it.s = it.lbl && lblTag !== undefined ? lblTag : tag;
      else if (it.t === "image" && it.s === undefined) it.s = tag;
    }
    return items;
  };
  /** A block's rows as its own, where the rows are someone else's to keep. */
  const owned = (items: DLItem[], b: DocBlock): DLItem[] => (struct && b.tag !== undefined ? stamp(place(items, 0, 0), b.tag, b.kind === "para" ? b.lblTag : undefined) : items);

  // ---- characters a block's own face lacks are set in a face that has them
  const tryFamilies = (family: string) => [
    family,
    ...(model.chains[family] ?? []),
    ...model.fallbacks.filter((f) => f !== family),
  ];
  const coverRuns = (runs: RichRun[], family: string): RichRun[] => {
    if (!model.fallbacks.length && !Object.keys(model.chains).length) return runs;
    const out: RichRun[] = [];
    for (const run of runs) {
      const own = run.family ?? family;
      const face = faces.face(own, "regular");
      if (run.text === "\n" || faces.covers(face, run.text)) {
        out.push(run);
        continue;
      }
      const options = tryFamilies(own);
      let cur: { family: string; text: string } | null = null;
      for (const ch of run.text) {
        let pick = own;
        if (!/\s/.test(ch)) {
          pick = options.find((f) => faces.has(f) && faces.covers(faces.face(f, "regular"), ch)) ?? own;
        } else if (cur) pick = cur.family;
        if (cur && cur.family === pick) cur.text += ch;
        else {
          if (cur) out.push({ ...run, text: cur.text, ...(cur.family !== family ? { family: cur.family } : {}) });
          cur = { family: pick, text: ch };
        }
      }
      if (cur) out.push({ ...run, text: cur.text, ...(cur.family !== family ? { family: cur.family } : {}) });
    }
    return out;
  };

  const richRuns = (b: DocPara): RichRun[] =>
    coverRuns(
      b.runs.map((r: DocRun): RichRun => {
        if (r.text === "\n") return { text: "\n" };
        // (A tab is a space unless the paragraph has stops to take it to.)
        const run: RichRun = { text: b.tabs ? r.text : r.text.replace(/\t/g, " ") };
        if (r.bold) run.bold = true;
        if (r.italic) run.italic = true;
        if (r.underline || r.link || b.underline) run.underline = true;
        if (r.strike) run.strike = true;
        let size = r.size ?? b.size;
        if (r.family) run.family = r.family;
        if (r.code) {
          run.family = CODE_FONT;
          size *= CODE_SIZE;
        }
        if (r.vscript) {
          // Smaller, and lifted or dropped by a share of the full size.
          run.rise = (r.vscript === "super" ? SUPER_RISE : -SUB_DROP) * size;
          size *= SCRIPT_SIZE;
        }
        if (size !== b.size) run.size = size;
        const color = r.link ? LINK_COLOR : (r.color ?? b.color);
        if (color) run.color = color;
        if (r.link) run.link = r.link;
        // A note's number is a way to its note (and tells the flow which
        // notes a line brings with it).
        else if (r.note !== undefined && model.notes[r.note]?.kind === "foot") run.link = `${NOTE_LINK}${r.note}`;
        if (r.highlight) run.highlight = r.highlight;
        // Capitals as formatting: the letters stay as typed, drawn as
        // capitals or small capitals. Letter spacing in ems of its size.
        if (r.caps) run.caps = r.caps === "all" ? "upper" : "small";
        if (r.underline && r.ul) run.ul = r.ul;
        if (r.underline && r.ulc) run.ulColor = r.ulc;
        if (r.dstrike) run.strike2 = true;
        if (r.track) run.tracking = r.track / size;
        return run;
      }),
      b.family,
    );

  // ---- a paragraph, set into rows for a given width
  const paraRows = (b: DocPara, avail: number): { rows: Row[]; keepFirst: number } => {
    const width = Math.max(b.size * 4, avail - b.left - b.right);
    // (Where it came from and where it sits in the editor don't change
    // how it is set: an edit above it must find it here again.)
    const { src: _src, sect: _sect, pos: _pos, tag: _tag, lblTag: _lblTag, ...shape } = b;
    void _src;
    void _sect;
    void _pos;
    void _tag;
    void _lblTag;
    const key = JSON.stringify([shape, Math.round(width * 100)]);
    let rows = cache.get(key);
    const dropLines = b.dropCap ? 3 : 0;
    if (!rows) {
      const style: TextStyle = { family: b.family, size: b.size, ...(b.bold ? { bold: true } : {}), ...(b.italic ? { italic: true } : {}) };
      const face = faces.face(b.family, b.bold ? (b.italic ? "boldItalic" : "bold") : b.italic ? "italic" : "regular");
      const asc = faces.ascent(face);
      const desc = faces.descent(face);
      const set: SetPara = composer.setParagraph({
        runs: richRuns(b),
        style,
        width,
        align: b.align,
        indent: Math.max(0, b.first),
        ...(b.hang ? { hang: b.hang } : {}),
        hyphenate: !!input.hyphenator && !b.pre,
        dropCap: b.dropCap ? { lines: 3, family: b.family, leading: b.leading } : null,
        firstFit: true,
        // Stops are measured from the margin (a cell's left edge): the
        // paragraph's own left edge is that far in. (A hanging indent is no
        // stop here: a list's marker is hung without a tab, and a verse's
        // turnover isn't where a typed tab means to go.)
        ...(b.tabs ? { tabs: { ...b.tabs, origin: b.left, hang: null } } : {}),
      });
      if (set.overfull && !overfull.has(b.src)) {
        overfull.add(b.src);
        warnings.push({ kind: "overfull", message: "A word is wider than the page and runs past the margin.", src: b.src });
      }
      const offsets = lineOffsets(b.runs, set.lines.map((line) => line.chars), set.skipped);
      rows = set.lines.map((line, li) => {
        // A line is as tall as its largest type asks (a drop cap's lines
        // keep the paragraph's own pitch, which the cap was cut to).
        let type = b.size;
        let cited: number[] | undefined;
        const items: DLItem[] = [];
        let largest = 0;
        for (const it of line.items) {
          if (it.t === "text" && it.y === 0 && it.size > largest) largest = it.size;
          // A note's reference: remembered on the row, and pointed at its note.
          if (it.t === "link" && it.url?.startsWith(NOTE_LINK)) {
            const index = Number(it.url.slice(NOTE_LINK.length));
            (cited ??= []).push(index);
            items.push({ t: "link", x: it.x, y: it.y, w: it.w, h: it.h, to: noteAnchor(index) });
          } else items.push(it);
        }
        if (!b.dropCap && largest > 0) type = largest;
        const natural = type === b.size ? b.leading : type * SINGLE * b.line;
        const h = b.lineRule === "exact" && b.lineAt ? b.lineAt : b.lineRule === "atLeast" && b.lineAt ? Math.max(b.lineAt, natural) : natural;
        // The text sits in the middle of its line, as on screen.
        const baseline = (h - (asc + desc) * type) / 2 + asc * type;
        return { h, baseline, items: place(items, b.left, baseline), ...(cited ? { notes: cited } : {}), ...(offsets[li] !== undefined ? { at: offsets[li] } : {}) };
      });
      const head = rows[0];
      if (head && (b.marker || b.sign)) {
        const hung = Math.min(LIST_HANG * 0.4, b.size * 0.5);
        const base = head.baseline ?? 0;
        if (b.marker) {
          const marker = composer.setLine(b.marker, { ...style, ...(b.color ? { color: b.color } : {}) });
          // (Marked as the item's label, which a tagged PDF tells from its words.)
          const label = place(marker.items, b.left - hung - marker.width, base).map((it): DLItem => (it.t === "text" ? { ...it, lbl: true } : it));
          rows[0] = { ...head, items: [...label, ...head.items] };
        } else {
          rows[0] = { ...head, items: [...signItems(b.sign!, b.left - hung, base, b.size), ...head.items] };
        }
      }
      if ((b.shade || b.border) && rows.length) rows = decorate(rows, b, width);
      cache.set(key, rows);
    }
    return { rows, keepFirst: Math.min(dropLines, rows.length) };
  };

  // ---- a picture: the size the document gives it, else its own, within
  // the column and the page; its caption under it, kept with it
  const imageUnit = (b: DocImage, availW: number, colH: number): Unit => {
    const avail = Math.max(24, availW - b.left - b.right);
    // Its own size as shown: the part kept, turned.
    const own = input.images.get(b.url);
    const natural = own ? shownSize(own.w, own.h, b.view) : undefined;
    let w = (b.w ?? natural?.w ?? 0) * PX;
    let h = (b.h ?? 0) * PX;
    if (!w || (!h && !natural)) {
      // Nothing known about it: it can't be drawn.
      return { block: b, rows: [], before: 0, after: 0, splittable: false, keepFirst: 0 };
    }
    if (!h) h = natural ? (w * natural.h) / natural.w : w * 0.75;
    const captionOf = b.caption;
    const caption = captionOf ? paraRows(captionOf, availW).rows.map((r) => ({ ...r, items: owned(r.items, captionOf) })) : [];
    const captionH = caption.reduce((n, r) => n + r.h, 0);
    const scale = Math.min(1, avail / w, Math.max(24, colH - captionH) / h);
    w *= scale;
    h *= scale;
    const x = b.left + (b.align === "center" ? (avail - w) / 2 : b.align === "right" ? avail - w : 0);
    // (A small gap between the picture and its caption.)
    const gap = caption.length ? Math.min(6, (b.caption?.size ?? 10) * 0.4) : 0;
    return {
      block: b,
      rows: [
        {
          h: h + gap,
          items: [
            {
              t: "image",
              x,
              y: 0,
              w,
              h,
              ref: b.url,
              ...(b.round ? { round: b.round } : {}),
              ...(b.border ? { border: b.border } : {}),
              ...(b.view?.crop ? { crop: b.view.crop } : {}),
              ...(b.view?.rot ? { rot: b.view.rot } : {}),
            },
          ],
        },
        ...caption.map((r) => ({ h: r.h, items: r.items, ...(r.notes ? { notes: r.notes } : {}) })),
      ],
      before: b.before,
      after: b.after,
      splittable: false,
      keepFirst: 0,
    };
  };

  /** Units one under the other, as rows (a table cell's contents): the
   *  space between two is the larger of what each asks for. */
  const stack = (units: Unit[]): Row[] => {
    const rows: Row[] = [];
    let prevAfter = 0;
    for (const u of units) {
      if (!u.rows.length) continue;
      const gap = rows.length ? Math.max(prevAfter, u.before) : 0;
      if (gap) rows.push({ h: gap, items: [], gap: true });
      u.rows.forEach((row, i) => {
        const start = u.block.pos === undefined ? undefined : startOf(u, i);
        rows.push({ h: row.h, items: owned(row.items, u.block), ...(row.notes ? { notes: row.notes } : {}), ...(start ? { start } : {}) });
      });
      prevAfter = u.after;
    }
    return rows;
  };

  // ---- a table: columns, then each cell's contents set to its width, then
  // rows as tall as their tallest cell
  const tableUnit = (b: DocTable, availW: number, colH: number): Unit => {
    const empty: Unit = { block: b, rows: [], before: 0, after: 0, splittable: false, keepFirst: 0 };
    const count = Math.max(1, ...b.rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
    const full = Math.max(count * 12, availW - b.left - b.right);
    // A table at the left may start further in, and has that much less room.
    const indent = b.ind ? Math.max(0, Math.min(b.ind, full - count * 12)) : 0;
    const room = full - indent;
    let widths = b.cols && b.cols.length === count ? [...b.cols] : Array.from({ length: count }, () => room / count);
    const total = widths.reduce((a, w) => a + w, 0);
    // Wider than the text: every column gives a little.
    if (total > room) widths = widths.map((w) => (w * room) / total);
    const xs = [0];
    for (const w of widths) xs.push(xs[xs.length - 1] + w);
    const tableW = xs[xs.length - 1];

    // Where each cell sits: a cell spanning rows takes its columns out of
    // the rows below.
    interface Placed {
      row: number;
      col: number;
      cs: number;
      rs: number;
      bg?: string;
      edges?: DocCell["edges"];
      va?: DocCell["va"];
      rows: Row[];
      h: number;
    }
    const taken: boolean[][] = b.rows.map(() => Array.from({ length: count }, () => false));
    const cells: Placed[] = [];
    b.rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row) {
        while (c < count && taken[r][c]) c += 1;
        if (c >= count) break;
        const cs = Math.min(cell.colspan, count - c);
        const rs = Math.min(cell.rowspan, b.rows.length - r);
        for (let i = r; i < r + rs; i += 1) for (let j = c; j < c + cs; j += 1) taken[i][j] = true;
        const inner = Math.max(12, xs[c + cs] - xs[c] - 2 * CELL_PAD_X);
        const rows = stack(unitsOf(cell.blocks, inner, colH));
        cells.push({ row: r, col: c, cs, rs, ...(cell.bg ? { bg: cell.bg } : {}), ...(cell.edges ? { edges: cell.edges } : {}), ...(cell.va ? { va: cell.va } : {}), rows, h: rows.reduce((n, x) => n + x.h, 0) });
        c += cs;
      }
    });
    if (!cells.length) return empty;

    const least = model.body.size * SINGLE + 2 * CELL_PAD_Y;
    /** The least a row is tall: a line of text, or the row's own height. */
    const rowLeast = (r: number) => Math.max(least, b.rowH?.[r] ?? 0);
    const heights = b.rows.map((_, r) => rowLeast(r));
    for (const cell of cells) if (cell.rs === 1) heights[cell.row] = Math.max(heights[cell.row], cell.h + 2 * CELL_PAD_Y);
    for (const cell of cells) {
      if (cell.rs === 1) continue;
      let have = 0;
      for (let i = cell.row; i < cell.row + cell.rs; i += 1) have += heights[i];
      const need = cell.h + 2 * CELL_PAD_Y;
      if (need > have) heights[cell.row + cell.rs - 1] += need - have;
    }

    // Rows a spanning cell ties together move as one.
    const bands: { from: number; to: number }[] = [];
    for (let r = 0; r < b.rows.length; ) {
      let end = r;
      for (let i = r; i <= end; i += 1) for (const cell of cells) if (cell.row === i) end = Math.max(end, cell.row + cell.rs - 1);
      bands.push({ from: r, to: end });
      r = end + 1;
    }

    const x0 = b.left + indent + (b.align === "center" ? (room - tableW) / 2 : b.align === "right" ? room - tableW : 0);
    const lines = b.lines;
    const rule = (ax: number, ay: number, bx: number, by: number): DLItem => ({ t: "rule", x1: ax, y1: ay, x2: bx, y2: by, w: CELL_LINE, color: TABLE_INK });
    const tall = (rows: Row[]) => rows.reduce((n, r) => n + r.h, 0);

    /**
     * A stretch of the table that is set as one: the rows a spanning cell
     * ties together (most often a single row), or what is left of them once
     * a page has taken their beginning. A band can be CUT where a column
     * ends: each cell gives the lines that fit, and goes on in the next
     * column with the rest, as a word processor breaks a row across pages.
     */
    interface BandCell {
      cell: Placed;
      /** The band's row it starts in, and how many it runs down. */
      row: number;
      rs: number;
      /** Its lines still to be set. */
      lines: Row[];
    }
    interface Band {
      /** The least each row is tall. */
      base: number[];
      cells: BandCell[];
      /** The table's top edge is this band's, its bottom edge this band's. */
      first: boolean;
      last: boolean;
      /** Which of the table's rows its first row is, and whether it starts
       *  where that row does (not partway down it). */
      at: number;
      whole: boolean;
      /** Where its cells go on, when it is the rest of a row that was cut. */
      starts?: PageStart[];
    }

    /** Each row as tall as its tallest cell (a spanning cell's last row
     *  makes up what the cell still needs). */
    const heightsOf = (band: Band): number[] => {
      const hs = [...band.base];
      for (const c of band.cells) if (c.rs === 1) hs[c.row] = Math.max(hs[c.row], tall(c.lines) + 2 * CELL_PAD_Y);
      for (const c of band.cells) {
        if (c.rs === 1) continue;
        let have = 0;
        for (let i = c.row; i < c.row + c.rs; i += 1) have += hs[i];
        const need = tall(c.lines) + 2 * CELL_PAD_Y;
        if (need > have) hs[c.row + c.rs - 1] += need - have;
      }
      return hs;
    };

    const draw = (band: Band): Row => {
      const hs = heightsOf(band);
      const tops: number[] = [];
      let h = 0;
      for (const rowH of hs) {
        tops.push(h);
        h += rowH;
      }
      const under: DLItem[] = [];
      const text: DLItem[] = [];
      const over: DLItem[] = [];
      const cited: number[] = [];
      for (const { cell, row, rs, lines: set } of band.cells) {
        const left = x0 + xs[cell.col];
        const right = x0 + xs[cell.col + cell.cs];
        const top = tops[row];
        let ch = 0;
        for (let i = row; i < row + rs; i += 1) ch += hs[i];
        if (cell.bg) under.push({ t: "rect", x: left, y: top, w: right - left, h: ch, color: cell.bg });
        let y = top + CELL_PAD_Y;
        // In the middle or at the foot of a row taller than its words, when
        // the whole of the cell is here (a cell cut over a page starts at
        // the top on both).
        if (cell.va && set.length && set.length === cell.rows.length) {
          const spare = ch - 2 * CELL_PAD_Y - tall(set);
          if (spare > EPS) y += cell.va === "middle" ? spare / 2 : spare;
        }
        for (const line of set) {
          text.push(...place(line.items, left + CELL_PAD_X, y));
          if (line.notes) cited.push(...line.notes);
          y += line.h;
        }
        // The table's lines on each side of the cell, unless the cell has a
        // line of its own there (or says there is none).
        const sides = {
          t: lines === "all" || lines === "rows" || (lines === "box" && band.first && top === 0),
          b: lines === "all" || lines === "rows" || (lines === "box" && band.last && Math.abs(top + ch - h) < EPS),
          l: lines === "all" || (lines === "box" && cell.col === 0),
          r: lines === "all" || (lines === "box" && cell.col + cell.cs === count),
        };
        const ends = { t: [left, top, right, top], b: [left, top + ch, right, top + ch], l: [left, top, left, top + ch], r: [right, top, right, top + ch] } as const;
        for (const side of ["t", "b", "l", "r"] as const) {
          const own = cell.edges?.[side];
          const [ax, ay, bx, by] = ends[side];
          if (own) {
            if (own.w > 0) over.push({ t: "rule", x1: ax, y1: ay, x2: bx, y2: by, w: own.w, color: own.color });
          } else if (sides[side]) over.push(rule(ax, ay, bx, by));
        }
      }
      return { h, items: [...under, ...text, ...over], ...(cited.length ? { notes: cited } : {}) };
    };

    /** The band up to `h`, and the rest of it. */
    const cutBand = (band: Band, h: number, force: boolean): [Band, Band] | null => {
      const hs = heightsOf(band);
      const tops: number[] = [];
      let total = 0;
      for (const rowH of hs) {
        tops.push(total);
        total += rowH;
      }
      if (h >= total - EPS) return null;
      // The row the column's end falls in.
      let rc = 0;
      while (rc + 1 < hs.length && tops[rc + 1] <= h + EPS) rc += 1;
      // A row kept whole is cut only when it must be (taller than a page):
      // otherwise the rows above it stay and it goes on whole.
      const keptRow = !force && b.keep?.[band.at + rc] === true;
      if (keptRow && rc === 0) return null;
      /** How many of a cell's lines fit above a line drawn at `y`. */
      const fits = (c: BandCell, y: number, atLeast: number): number => {
        const room = y - tops[c.row] - 2 * CELL_PAD_Y;
        let n = 0;
        let used = 0;
        while (n < c.lines.length && (n < atLeast || used + c.lines[n].h <= room + EPS)) {
          used += c.lines[n].h;
          n += 1;
        }
        // (Never the space after a block alone, with the next one over the page.)
        while (n > atLeast && n < c.lines.length && c.lines[n - 1].gap) n -= 1;
        return n;
      };
      const covers = (c: BandCell) => c.row <= rc && c.row + c.rs - 1 >= rc;
      let take = band.cells.map((c) => (c.row + c.rs - 1 < rc ? c.lines.length : covers(c) ? fits(c, h, 0) : 0));
      // Every cell that starts in the row and has something in it must begin
      // on this side, or the row doesn't begin here at all: it is cut where
      // it starts (the rows above stay) or, the band's first, not cut.
      let whole = false;
      const begun = (c: BandCell) => c.lines.length === 0 || take[band.cells.indexOf(c)] > 0;
      if (keptRow || !band.cells.filter((c) => c.row === rc).every(begun)) {
        if (rc === 0) {
          if (!force) return null;
          take = band.cells.map((c) => (covers(c) ? fits(c, h, c.lines.length ? 1 : 0) : 0));
        } else {
          whole = true;
          take = band.cells.map((c) => (c.row + c.rs - 1 < rc ? c.lines.length : c.row < rc ? fits(c, tops[rc], 0) : 0));
        }
      }
      // (A cut that leaves nothing on this side is no cut.)
      if (take.every((n) => n === 0)) return null;
      const left = band.cells.map((c, i) => {
        let rest = c.lines.slice(take[i]);
        // (The space between two blocks isn't carried to the top of a page.)
        while (rest.length && rest[0].gap) rest = rest.slice(1);
        return rest;
      });
      if (left.every((rest) => rest.length === 0) && rc === hs.length - 1) return null;

      // This side: the rows above, and the row's beginning.
      const keep = whole ? rc : rc + 1;
      const head: Band = {
        base: band.base.slice(0, keep).map((v, i) => (!whole && i === rc ? 0 : v)),
        cells: band.cells
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.row < keep)
          .map(({ c, i }) => ({ cell: c.cell, row: c.row, rs: Math.min(c.rs, keep - c.row), lines: c.lines.slice(0, take[i]) })),
        first: band.first,
        last: false,
        at: band.at,
        whole: band.whole,
        ...(band.starts ? { starts: band.starts } : {}),
      };
      // The other side: the rest of the row (or the row whole), and the rows below.
      const from = rc;
      const rest: Band = {
        base: band.base.slice(from).map((v, i) => (!whole && i === 0 ? 0 : v)),
        cells: band.cells
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.row + c.rs - 1 >= from)
          .map(({ c, i }) => ({ cell: c.cell, row: Math.max(0, c.row - from), rs: c.row + c.rs - Math.max(c.row, from), lines: left[i] })),
        first: false,
        last: band.last,
        at: band.at + from,
        whole: false,
      };
      // Where the page that takes the rest begins: at a row of the table,
      // when the cut is where that row starts and no cell runs down across
      // it. Otherwise wherever each cell of the row goes on.
      const crossing = band.cells.some((c) => c.row < from && c.row + c.rs - 1 >= from);
      if (whole && !crossing) rest.whole = true;
      else {
        const starts = rest.cells
          .filter((c) => c.row === 0)
          .map((c) => c.lines.find((line) => !line.gap)?.start)
          .filter((v): v is PageStart => !!v);
        if (starts.length) rest.starts = starts;
      }
      return [head, rest];
    };

    const rowOf = (band: Band): Row => {
      // The least of it that may end a column: a first line of each cell
      // that starts it.
      const firstLines = band.cells.filter((c) => c.row === 0 && c.lines.length).map((c) => c.lines[0].h);
      return {
        ...draw(band),
        ...(band.whole ? { tr: band.at } : {}),
        ...(band.starts ? { starts: band.starts } : {}),
        min: (firstLines.length ? Math.max(...firstLines) : 0) + 2 * CELL_PAD_Y,
        cut: (h, force) => {
          const parts = cutBand(band, h, force);
          return parts && [rowOf(parts[0]), rowOf(parts[1])];
        },
      };
    };

    const out: Row[] = bands.map((band, bi) =>
      rowOf({
        base: heights.slice(band.from, band.to + 1).map((_, i) => rowLeast(band.from + i)),
        cells: cells.filter((c) => c.row >= band.from && c.row <= band.to).map((cell) => ({ cell, row: cell.row - band.from, rs: cell.rs, lines: cell.rows })),
        first: bi === 0,
        last: bi === bands.length - 1,
        at: band.from,
        whole: true,
      }),
    );

    const header = b.head && out.length > 1 && bands[0].to < b.rows.length - 1 ? out[0] : undefined;
    return { block: b, rows: out, before: b.before, after: b.after, splittable: out.length > 1, keepFirst: header ? 2 : 0, loose: true, ...(header ? { header } : {}) };
  };

  // ---- a table of contents: each heading, a row of dots, its page
  /** A heading's text as the outline shows it (a note's number isn't part). */
  const titleOf = (b: DocPara) => b.runs.map((r) => (r.text === "\n" ? " " : r.note !== undefined ? "" : r.text)).join("").replace(/\s+/g, " ").trim().slice(0, 200);
  /** The document's headings as the outline has them (`h1`, `h2`, … in
   *  order), which is also how the contents and the links name them. */
  const outline: { id: string; title: string; level: number }[] = [];
  for (const b of model.blocks) {
    if (b.kind !== "para" || !b.outline) continue;
    const title = titleOf(b);
    if (title) outline.push({ id: `h${outline.length + 1}`, title, level: b.outline });
  }
  const hasToc = model.blocks.some((b) => b.kind === "toc");
  /** The page each heading landed on, once a first layout has said. */
  let folios: Map<string, string> | null = null;

  /** A tagged PDF: the element each line of a contents is (made once, though
   *  the document may be flowed twice). */
  const tocItems = new Map<string, number>();
  const tocItem = (toc: number, id: string): number => {
    const key = `${toc}:${id}`;
    let item = tocItems.get(key);
    if (item === undefined) {
      struct!.push({ role: "TOCI", parent: toc, late: true });
      item = struct!.length - 1;
      tocItems.set(key, item);
    }
    return item;
  };

  const tocUnit = (b: DocToc, availW: number): Unit => {
    const width = Math.max(72, availW - b.left - b.right);
    const style: TextStyle = { family: b.family, size: b.size };
    const face = faces.face(b.family, "regular");
    const baseline = (b.leading - (faces.ascent(face) + faces.descent(face)) * b.size) / 2 + faces.ascent(face) * b.size;
    // Room for the widest page number there could be.
    const numberW = composer.setLine("000", style).width;
    const dotLine = composer.setLine(".", style);
    const dot = dotLine.width || b.size * 0.25;
    // (To a reader of a tagged PDF the dots are decoration, said so here:
    // otherwise they would be read out as the contents' own words.)
    const dotItems = dotLine.items.map((it): DLItem => ({ ...it, color: "#808080", ...(struct && it.t === "text" ? { s: -3 } : {}) }));
    const pitch = dot * 2.2;
    const rows: Row[] = [];
    for (const entry of outline) {
      if (entry.level > b.depth) continue;
      const indent = (entry.level - 1) * b.size * 1.5;
      const set = composer.setParagraph({
        runs: [{ text: entry.title, ...(entry.level === 1 ? { bold: true } : {}) }],
        style,
        width: Math.max(48, width - indent - numberW - b.size),
        align: "left",
        firstFit: true,
      });
      // A tagged PDF: the entry, and on each of its lines a link holding
      // the words and the page number. (The dots are decoration.)
      const entryTag = struct && b.tag !== undefined ? tocItem(b.tag, entry.id) : undefined;
      set.lines.forEach((line, i) => {
        let link: number | undefined;
        if (struct && entryTag !== undefined) {
          struct.push({ role: "Link", parent: entryTag, late: true });
          link = struct.length - 1;
        }
        const mine = (these: DLItem[]): DLItem[] => (link === undefined ? these : these.map((it): DLItem => (it.t === "text" ? { ...it, s: link } : it)));
        const items: DLItem[] = mine(place(line.items, b.left + indent, baseline));
        if (i === set.lines.length - 1) {
          const folio = folios?.get(entry.id) ?? "";
          const right = b.left + width;
          // Dots from the title to the number, on a common grid so the
          // rows of dots line up down the page.
          const from = Math.ceil((b.left + indent + line.width + b.size * 0.4) / pitch) * pitch;
          const to = right - numberW - b.size * 0.3;
          for (let x = from; x + dot <= to; x += pitch) items.push(...place(dotItems, x, baseline));
          if (folio) {
            const number = composer.setLine(folio, style);
            items.push(...mine(place(number.items, right - number.width, baseline)));
          }
        }
        items.push({ t: "link", x: b.left, y: 0, w: width, h: b.leading, to: entry.id, ...(link !== undefined ? { s: link } : {}) });
        rows.push({ h: b.leading, baseline, items });
      });
    }
    if (!rows.length) return { block: b, rows: [], before: 0, after: 0, splittable: false, keepFirst: 0 };
    return { block: b, rows, before: b.before, after: b.after, splittable: rows.length > 1, keepFirst: 0, loose: true };
  };

  /** Blocks as units for a column of `availW` (a page's, or a cell's). */
  function unitsOf(blocks: DocBlock[], availW: number, colH: number): Unit[] {
    return blocks.map((b): Unit => {
      if (b.kind === "para") {
        const { rows, keepFirst } = paraRows(b, availW);
        // (A block joined to the next carries the space between them inside
        // its box, as part of its last row.)
        return { block: b, rows, before: b.before, after: b.joinNext ? 0 : b.after, splittable: !b.keepLines && rows.length > 1, keepFirst };
      }
      if (b.kind === "rule") {
        const avail = Math.max(24, availW - b.left - b.right);
        const h = 6;
        const length = b.short ? Math.min(NOTE_RULE, avail) : avail;
        return {
          block: b,
          rows: [{ h, items: [{ t: "rule", x1: b.left, y1: h / 2, x2: b.left + length, y2: h / 2, w: 0.75, color: "#888888" }] }],
          before: b.before,
          after: b.after,
          splittable: false,
          keepFirst: 0,
        };
      }
      if (b.kind === "image") return imageUnit(b, availW, colH);
      if (b.kind === "table") return tableUnit(b, availW, colH);
      return tocUnit(b, availW);
    });
  }

  // ---- the document in sections: each starts a page, on its own sheet
  const runs: { props: SectionProps | null; blocks: DocBlock[] }[] = [{ props: null, blocks: [] }];
  for (const b of model.blocks) {
    if (b.sect) {
      // (A section at the very start is the first section's own setup.)
      if (runs[runs.length - 1].blocks.length) runs.push({ props: b.sect, blocks: [] });
      else runs[runs.length - 1].props = b.sect;
    }
    runs[runs.length - 1].blocks.push(b);
  }

  interface PageBuild {
    items: DLItem[];
    /** Baselines of the page's text lines, by column, for line numbers. */
    lines: { col: number; y: number }[];
    geo: Geometry;
    /** The number it prints. */
    number: number;
    /** Where its text begins in the editor's document (null: nowhere that
     *  can be pointed at); unset until something is placed on it. */
    start?: PageStart | null;
  }

  /** Where in the editor's document a unit's row begins. */
  const startOf = (u: Unit, row: number): PageStart | null => {
    const b = u.block;
    if (b.pos === undefined) return null;
    if (b.kind === "para") {
      if (row === 0) return b.from ? { pos: b.pos + 1 + b.from, inline: true } : { pos: b.pos, inline: false };
      const at = u.rows[row].at;
      return at === undefined ? null : { pos: b.pos + 1 + at, inline: true };
    }
    if (row === 0) return { pos: b.pos, inline: false };
    if (b.kind === "table") {
      const tr = u.rows[row].tr;
      const pos = tr === undefined ? undefined : b.rowPos?.[tr];
      if (pos !== undefined) return { pos, inline: false };
      // The rest of a row that was cut: where its cells go on.
      const [first, ...more] = u.rows[row].starts ?? [];
      return first ? { pos: first.pos, inline: first.inline, ...(more.length ? { also: more.map((m) => ({ pos: m.pos, inline: m.inline })) } : {}) } : null;
    }
    return null;
  };

  /** A footnote set to a column's width, remembered. */
  const noteRows = new Map<string, Row[]>();
  const rowsOfNote = (index: number, colW: number): Row[] => {
    const key = `${index}:${Math.round(colW * 100)}`;
    let rows = noteRows.get(key);
    if (!rows) {
      const note = model.notes[index];
      rows = note ? paraRows(note.para, colW).rows.map((r) => ({ h: r.h, items: owned(r.items, note.para) })) : [];
      // The first line is where the reference points.
      if (rows[0]) rows[0] = { ...rows[0], items: [{ t: "anchor", name: noteAnchor(index), y: 0 }, ...rows[0].items] };
      if (rows.length && note) rows[rows.length - 1] = { ...rows[rows.length - 1], h: rows[rows.length - 1].h + note.para.after };
      noteRows.set(key, rows);
    }
    return rows;
  };

  const flow = (): { pages: PageBuild[]; sections: DLSection[] } => {
    const pages: PageBuild[] = [];
    const sections: DLSection[] = [];
    let geo = geometryOf(s, runs[0].props);
    let nextNumber = s.pnStart;
    let col = 0;
    let y = 0;
    let atTop = true;
    let prevAfter = 0;
    let outlineAt = 0;
    /** This column's footnotes: their rows, and the room they take
     *  (with the rule above them). */
    let notes: { rows: Row[]; h: number } = { rows: [], h: 0 };
    /** Lines of notes that didn't fit where they were cited. */
    const carry: Row[] = [];
    const placed = new Set<number>();

    const columnX = (page: PageBuild) => sideMargins(page.geo.s, page.number).left * 72 + col * (page.geo.colW + page.geo.colGap);

    /** Set this column's notes at its foot. */
    const closeColumn = () => {
      const page = pages[pages.length - 1];
      if (notes.rows.length && page) {
        const g = page.geo;
        const x0 = columnX(page);
        let top = g.mt + g.colH - notes.h;
        page.items.push({ t: "rule", x1: x0, y1: top + NOTE_GAP_ABOVE, x2: x0 + Math.min(NOTE_RULE, g.colW), y2: top + NOTE_GAP_ABOVE, w: 0.5 });
        top += NOTE_SEP;
        for (const row of notes.rows) {
          page.items.push(...place(row.items, x0, top));
          top += row.h;
        }
      }
      notes = { rows: [], h: 0 };
    };
    /** A new column begins with what ran over from the last one's notes. */
    const openColumn = () => {
      y = 0;
      atTop = true;
      prevAfter = 0;
      if (!carry.length) return;
      // (Never the whole column: the text has to move too.)
      const limit = geo.colH * 0.6;
      let h = NOTE_SEP;
      const take: Row[] = [];
      while (carry.length && (take.length === 0 || h + carry[0].h <= limit)) {
        h += carry[0].h;
        take.push(carry.shift()!);
      }
      notes = { rows: take, h };
    };
    const newPage = () => {
      closeColumn();
      pages.push({ items: [], lines: [], geo, number: nextNumber });
      nextNumber += 1;
      col = 0;
      openColumn();
    };
    const nextColumn = () => {
      if (col + 1 < geo.cols) {
        closeColumn();
        col += 1;
        openColumn();
      } else newPage();
    };

    const heightOf = (rows: Row[], from: number, count: number) => {
      let h = 0;
      for (let i = from; i < from + count && i < rows.length; i += 1) h += rows[i].h;
      return h;
    };
    /** The least of a unit that may start a column: its first lines. */
    const headOf = (u: Unit) => {
      // (A table's row can be cut: its first lines are enough to begin with.)
      const first = u.rows[0];
      if (first?.cut && first.min !== undefined && !u.header) return Math.min(first.h, first.min);
      return heightOf(u.rows, 0, u.splittable ? Math.max(u.loose ? 1 : ORPHANS, u.keepFirst) : u.rows.length);
    };
    /** What a row's notes ask of the column: all of them, and the least
     *  (the rule, and the first line of the first). */
    const notesCost = (row: Row, seen: Set<number>, have: number): { ids: number[]; full: number; least: number } => {
      const ids = (row.notes ?? []).filter((id) => !placed.has(id) && !seen.has(id));
      if (!ids.length) return { ids, full: 0, least: 0 };
      const sep = have > 0 ? 0 : NOTE_SEP;
      let full = sep;
      for (const id of ids) full += heightOf(rowsOfNote(id, geo.colW), 0, Infinity);
      return { ids, full, least: sep + (rowsOfNote(ids[0], geo.colW)[0]?.h ?? 0) };
    };

    for (const run of runs) {
      // Closed on the sheet it was set on, before the next section's.
      closeColumn();
      geo = geometryOf(s, run.props);
      if (run.props?.pn !== undefined) nextNumber = run.props.pn;
      newPage();
      const units = unitsOf(run.blocks, geo.colW, geo.colH);

      for (let ui = 0; ui < units.length; ui += 1) {
        let u = units[ui];
        // (A table's rows may be cut as they are placed: on a copy, the
        // unit itself is set once and may be flowed again.)
        if (u.rows.some((row) => row.cut)) u = { ...u, rows: [...u.rows] };
        /** Pieces a cut has made here: not cut again in the same place. */
        const pieces = new Set<Row>();
        const b = u.block;
        const pageEmpty = atTop && col === 0;
        if (b.breakBefore && !pageEmpty) newPage();
        else if (b.kind === "para" && b.colBreak && !atTop) nextColumn();

        if (b.kind === "para" && b.outline && titleOf(b)) {
          const entry = outline[outlineAt];
          outlineAt += 1;
          // Recorded once its first row is placed (below).
          if (entry) sections.push({ id: entry.id, title: entry.title, firstPage: -1, folio: "", level: entry.level });
        }
        if (!u.rows.length) continue;

        let gap = atTop ? 0 : Math.max(prevAfter, u.before);

        // A heading goes where its text goes — and the text's first lines
        // bring their footnotes, which need room too.
        if (b.kind === "para" && b.keepNext && !atTop) {
          let need = gap + heightOf(u.rows, 0, u.rows.length);
          let last = u;
          const seen = new Set<number>();
          let cited = 0;
          const notesOf = (unit: Unit, count: number) => {
            for (let i = 0; i < count && i < unit.rows.length; i += 1) {
              const cost = notesCost(unit.rows[i], seen, notes.h + cited);
              cited += cost.full;
              for (const id of cost.ids) seen.add(id);
            }
          };
          notesOf(u, u.rows.length);
          for (let j = ui + 1; j < units.length; j += 1) {
            const next = units[j];
            if (!next.rows.length) continue;
            need += Math.max(last.after, next.before) + headOf(next);
            notesOf(next, next.splittable ? Math.max(next.loose ? 1 : ORPHANS, next.keepFirst) : next.rows.length);
            last = next;
            // A run of headings stays together with the first text after it.
            if (!(next.block.kind === "para" && next.block.keepNext)) break;
          }
          if (y + need + cited > geo.colH - notes.h + EPS && need + cited <= geo.colH) {
            nextColumn();
            gap = 0;
          }
        }

        const orphans = u.loose ? 1 : ORPHANS;
        const widows = u.loose ? 1 : WIDOWS;
        let start = 0;
        let guard = 0;
        while (start < u.rows.length && guard < 10000) {
          guard += 1;
          // A table that runs over begins again with its header row.
          const head = start > 0 && u.header ? u.header : null;
          const headH = head ? head.h : 0;
          const remaining = geo.colH - y - gap - notes.h - headH;
          const left = u.rows.length - start;
          let fit = 0;
          let used = 0;
          let extra = 0;
          const seen = new Set<number>();
          while (fit < left) {
            const row = u.rows[start + fit];
            const cost = notesCost(row, seen, notes.h + extra);
            if (used + row.h + extra + cost.full <= remaining + EPS) {
              used += row.h;
              extra += cost.full;
              for (const id of cost.ids) seen.add(id);
              fit += 1;
              continue;
            }
            // The line fits and its note can at least begin: the note
            // runs over to the next column's foot.
            if (cost.ids.length && used + row.h + extra + cost.least <= remaining + EPS) {
              used += row.h;
              fit += 1;
            }
            break;
          }
          if (fit < left) {
            // A table's row that won't fit goes as far as the column does,
            // and its cells go on in the next: as much of each as there is
            // room for here.
            const over = u.rows[start + fit];
            if (over.cut && !pieces.has(over)) {
              const space = remaining - used - extra;
              const parts = over.cut(space, false) ?? (atTop && fit === 0 ? over.cut(space, true) : null);
              if (parts) {
                pieces.add(parts[0]);
                u.rows.splice(start + fit, 1, parts[0], parts[1]);
                // (Two pieces now, whatever it was: one may end this column.)
                u.splittable = true;
                continue;
              }
            }
            const byHeight = fit;
            if (!u.splittable) fit = 0;
            else {
              // Leave at least two lines for the next page, and take at least
              // two (and a drop cap's lines) onto this one.
              if (left - fit < widows) fit = left - widows;
              const least = start === 0 ? Math.max(orphans, u.keepFirst) : 1;
              if (fit < least) fit = 0;
            }
            if (fit <= 0) {
              if (!atTop) {
                nextColumn();
                gap = 0;
                continue;
              }
              // Even a fresh column can't honour the rules: take what fits.
              fit = Math.max(1, byHeight);
            }
            used = heightOf(u.rows, start, fit);
          }
          const pageIndex = pages.length - 1;
          const build = pages[pageIndex];
          if (build.start === undefined) build.start = startOf(u, start);
          const x0 = columnX(build);
          let top = geo.mt + y + gap;
          if (start === 0 && b.kind === "para" && b.outline) {
            const section = sections[sections.length - 1];
            if (section && section.firstPage < 0) {
              section.firstPage = pageIndex;
              section.folio = formatPageNumber(build.number, geo.s.pnFormat);
              build.items.push({ t: "anchor", name: section.id, y: top });
            }
          }
          if (head) {
            // (Said once, where the table begins: set again at the top of a
            // page it is there for the eye, and belongs to nothing.)
            build.items.push(...place(head.items, x0, top, b.src).map((it): DLItem => (struct && (it.t === "text" || it.t === "image" || it.t === "link") ? { ...it, s: undefined } : it)));
            top += head.h;
          }
          const cited: number[] = [];
          for (let i = start; i < start + fit; i += 1) {
            const row = u.rows[i];
            build.items.push(...stamp(place(row.items, x0, top, b.src), b.tag, b.kind === "para" ? b.lblTag : undefined));
            if (row.baseline !== undefined) build.lines.push({ col, y: top + row.baseline });
            for (const id of row.notes ?? []) if (!placed.has(id) && !cited.includes(id)) cited.push(id);
            top += row.h;
          }
          y += gap + headH + used;
          atTop = false;
          gap = 0;
          start += fit;
          // The notes these lines cite: as much as the column has room for.
          for (const id of cited) {
            placed.add(id);
            notePage?.set(id, pages.length - 1);
            const rows = rowsOfNote(id, geo.colW);
            let i = 0;
            for (; i < rows.length; i += 1) {
              const sep = notes.h > 0 ? 0 : NOTE_SEP;
              if (carry.length || y + notes.h + sep + rows[i].h > geo.colH + EPS) break;
              notes.rows.push(rows[i]);
              notes.h += sep + rows[i].h;
            }
            carry.push(...rows.slice(i));
          }
          // What's left of the unit — or of its notes — goes on in the
          // next column.
          if (start < u.rows.length || carry.length) nextColumn();
        }
        prevAfter = atTop ? 0 : u.after;
      }
    }
    // Notes still running over get columns of their own.
    for (let guard = 0; carry.length && guard < 500; guard += 1) nextColumn();
    closeColumn();

    for (let i = sections.length - 1; i >= 0; i -= 1) if (sections[i].firstPage < 0) sections.splice(i, 1);
    return { pages, sections };
  };

  let { pages, sections } = flow();
  if (hasToc) {
    // The contents needs the pages its headings landed on: lay out again
    // with them (its lines are as tall either way, so nothing else moves).
    folios = new Map(sections.map((sec) => [sec.id, sec.folio]));
    ({ pages, sections } = flow());
  }

  // ---- headers, footers and line numbers
  const hfStyle: TextStyle = { family: model.body.family, size: Math.max(7, Math.round(model.body.size * 0.85 * 2) / 2) };
  const hfFace = faces.face(hfStyle.family, "regular");
  const numberStyle: TextStyle = { family: model.body.family, size: Math.max(6, Math.min(9, model.body.size * 0.7)) };
  const lastNumber = pages.length ? pages[pages.length - 1].number : s.pnStart;
  const out: DLPage[] = pages.map((build, index) => {
    const geo = build.geo;
    const gs = geo.s;
    const n = build.number;
    const x0 = sideMargins(gs, n).left * 72;
    const fields = {
      page: n,
      pages: lastNumber,
      title: model.meta.title,
      author: model.meta.author,
      date: model.meta.date,
      format: gs.pnFormat,
    };
    const slots = slotsForPage(gs, index, n);
    const band = (texts: [string, string, string], baseline: number, which: -1 | -2): DLItem[] => {
      const set: DLItem[] = [];
      texts.forEach((raw, side) => {
        const text = fillSlot(raw, fields).trim();
        if (!text) return;
        const line = composer.setLine(text, hfStyle);
        const x = side === 0 ? x0 : side === 1 ? x0 + (geo.textW - line.width) / 2 : x0 + geo.textW - line.width;
        // (A tagged PDF: a running head or foot, said to be one.)
        set.push(...place(line.items, x, baseline).map((it): DLItem => (struct && it.t === "text" ? { ...it, s: which } : it)));
      });
      return set;
    };
    const header = band(slots.header, gs.hd * 72 + faces.ascent(hfFace) * hfStyle.size, -1);
    const footer = band(slots.footer, geo.h - gs.fd * 72 - faces.descent(hfFace) * hfStyle.size, -2);
    const numbers: DLItem[] = [];
    if (gs.lineNumbers) {
      build.lines.forEach((line, i) => {
        const label = composer.setLine(String(i + 1), numberStyle);
        const x = x0 + line.col * (geo.colW + geo.colGap) - Math.min(18, geo.cols > 1 ? geo.colGap * 0.4 : 18) - label.width;
        numbers.push(...place(label.items, x, line.y).map((it) => (it.t === "text" ? { ...it, color: "#808080" } : it)));
      });
    }
    // In reading order: the header, the text, the footer.
    const items = [...header, ...build.items, ...numbers, ...footer];
    const sized = Math.abs(geo.w - model.page.w) > EPS || Math.abs(geo.h - model.page.h) > EPS;
    return {
      n: index + 1,
      folio: formatPageNumber(n, gs.pnFormat),
      side: n % 2 === 0 ? "verso" : "recto",
      role: "body",
      section: -1,
      items,
      // A section on another sheet (or turned on its side).
      ...(sized ? { size: { w: geo.w, h: geo.h } } : {}),
    };
  });

  for (const [family, chars] of faces.missing) {
    const list = [...chars].slice(0, 12).join(" ");
    warnings.push({
      kind: "missing-glyphs",
      message: `Some characters can’t be drawn in ${family} yet and are left blank: ${list}${chars.size > 12 ? " …" : ""}`,
    });
  }
  if (model.substitutions.length) {
    const said = (why: "missing" | "licence") =>
      model.substitutions
        .filter((sub) => sub[2] === why)
        .map(([asked, drawn]) => `${asked} → ${drawn}`)
        .join(", ");
    const missing = said("missing");
    const licence = said("licence");
    if (missing) warnings.push({ kind: "font", message: `Not on this device, so printed in a stand-in: ${missing}.` });
    if (licence) {
      warnings.push({ kind: "font", message: `Its licence doesn’t allow embedding, so printed in a stand-in: ${licence}.` });
    }
  }

  return {
    trim: { w: model.page.w, h: model.page.h },
    faces: faces.faces,
    pages: out,
    sections,
    meta: { title: model.meta.title, author: model.meta.author, subject: model.meta.subject, lang: model.meta.lang, ...(model.meta.keywords ? { keywords: model.meta.keywords } : {}) },
    warnings,
    insideMargin: s.gutter,
    starts: pages.map((build) => build.start ?? null),
    bodyH: pages.map((build) => build.geo.colH),
    ...(struct ? { struct } : {}),
  };
}
