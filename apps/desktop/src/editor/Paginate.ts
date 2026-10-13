import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { textWindow } from "./ui/bubblePlace";

/**
 * Page view for the writing sheet, two ways.
 *
 * AS PRINTED. Given the layout engine's page map — where each page of the
 * printed document begins in the text (see doclayout) — a spacer is put at
 * each of those places: before a block, between two rows of a table, or in
 * the middle of a paragraph, where the printed page turns. So the screen
 * shows the same text on each page as the PDF and the printer do, and the
 * same number of pages. The lines within a page are still the browser's
 * (it wraps a little differently from the engine), so a page on screen is
 * as tall as its text needs — never shorter than the paper's.
 *
 * BETWEEN TWO PAGES, either way, the sheet shows what paper has there: the
 * rest of the page above, its bottom margin, the gap between the sheets,
 * and the top margin of the page below — so text never starts right under
 * the gap (`breakSpace`).
 *
 * SIMPLE (the fallback: no map yet, the engine failed, or the writer chose
 * it). Each top-level block that would straddle a page boundary — or that
 * carries an explicit `pageBreakBefore` — is pushed to the next page with a
 * `padding-top` node decoration, so boundaries land in whitespace and the
 * overlay can draw a physical gap between pages.
 *
 * WHILE THE TEXT CHANGES the gaps between the sheets stay where they are
 * and the text moves across them. Each change is followed before the next
 * paint: the blank at the foot of the page being written on takes up what
 * was typed, so nothing below it moves. A page that runs over (the engine
 * hasn't said yet where its last line goes) runs into its own bottom
 * margin for that moment rather than pushing every sheet below it down and
 * back. The gaps and the last page's fill are drawn here, straight onto
 * the sheet, in the same pass as the spacers are sized, so text and gaps
 * are never seen apart.
 *
 * Either way the decorations are pure presentation: nothing enters the
 * document, the Yjs history, or a collaborator's screen.
 *
 * Simple view, in detail:
 *
 * Geometry: `padding-top` never collapses (margins would) and doesn't move
 * the block's border box — it grows it downward, so a pushed block's TEXT
 * starts on the next page while its box spans the gap. All bookkeeping
 * below works on border boxes and subtracts our own pushes (kept in each
 * decoration's spec) to recover natural positions.
 *
 * Small screens: the sheet is narrower than the configured paper, so a
 * print page's worth of text needs more on-screen height. Capacity scales
 * by (configured text width / actual text width), keeping page counts
 * honest on phones.
 *
 * Blocks taller than a page can't be split without real layout; boundaries
 * inside one are reported `clean: false` and drawn as hairlines instead of
 * gaps.
 */

export interface PageSpec {
  /** All inches. */
  w: number;
  h: number;
  mt: number;
  mr: number;
  mb: number;
  ml: number;
}

export interface PageBand {
  /** Top of the gap, in px from the sheet's (.wf-page) top edge. */
  y: number;
  /** Number of the page that starts below this band. */
  page: number;
  /** False when the boundary falls inside an oversized block. */
  clean: boolean;
}

export interface PageLayoutResult {
  bands: PageBand[];
  gap: number;
  /** The top margin under each gap, px (where the next page's text starts). */
  lead: number;
  pages: number;
  /** Extra bottom padding (px) that fills the last page to full height.
   *  (Less than none while its text runs into the bottom margin.) */
  fill: number;
}

/** The layout engine's pages, for one state of the document. */
export interface PageMapFor {
  /** The document it was made for (a map for another is out of date). */
  doc: PmNode;
  pages: number;
  /** Where each page's text begins (the first page's too); null where
   *  that can't be pointed at. A page that begins inside a table's row
   *  (cut across pages) begins in each of the row's cells: `also` are the
   *  others. */
  starts: ({ pos: number; inline: boolean; also?: { pos: number; inline: boolean }[] } | null)[];
  /** How tall each page's text area is, pt. */
  bodyH: number[];
}

interface PaginateOptions {
  /** Current page spec, or null when page view is off. Read per measure. */
  getSpec: () => PageSpec | null;
  /** The engine's page map; `"pending"` while the first one is being made
   *  (nothing is marked meanwhile, rather than the simple view flashing
   *  up and then changing); or null to paginate by measuring blocks. */
  getMap: () => PageMapFor | "pending" | null;
  onLayout: (result: PageLayoutResult | null) => void;
}

const paginateKey = new PluginKey<DecorationSet>("wf-paginate");
const PX_PER_IN = 96;
/** Visual gap between pages, px (unscaled — it's chrome, not paper). */
export const PAGE_GAP = 40;

/** Force a re-measure (page view toggled, settings changed, a new page
 *  map). Nothing is dispatched: no one else has anything to do about it. */
export function reflowPagination(editor: Editor): void {
  if (editor.isDestroyed) return;
  let view: EditorView;
  try {
    view = editor.view;
  } catch {
    return; // not mounted
  }
  views.get(view)?.reflow();
}

interface Push {
  pos: number;
  end: number;
  push: number;
}

type SpacerKind = "block" | "inline" | "row";

/** What a spacer's decoration says of itself. */
interface SpaceSpec {
  side: -1;
  key: string;
  /** The page that begins after it (counting from 0). */
  page: number;
  ignoreSelection: true;
  el: HTMLElement;
}

const spaceDeco = (pos: number, spec: SpaceSpec): Decoration => Decoration.widget(pos, spec.el, spec);
const pushDeco = (pos: number, end: number, push: number): Decoration =>
  Decoration.node(pos, end, { style: `padding-top: ${Math.round(push)}px`, class: "wf-pg-push" }, { push });

/** Before the next paint, so a change and what it does to the pages are
 *  seen together. */
function beforePaint(run: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
}

/**
 * Where a place in one text is in another, going by the one stretch in
 * which the two differ; null inside that stretch.
 *
 * (A change that comes through the shared document — someone else's, or an
 * undo — replaces the whole text in a single step, and mapping through it
 * would lose every mark on the sheet.)
 */
export function carryAcross(before: PmNode, after: PmNode): (pos: number) => number | null {
  const start = before.content.findDiffStart(after.content);
  const end = start === null ? null : before.content.findDiffEnd(after.content);
  if (start === null || !end) return (pos) => pos;
  let { a, b } = end;
  // (Text that repeats on both sides of the change can make the ends overlap.)
  const over = start - Math.min(a, b);
  if (over > 0) {
    a += over;
    b += over;
  }
  return (pos) => (pos <= start ? pos : pos >= a ? pos + (b - a) : null);
}

/** The marks on the sheet, after a change to the text. */
function carried(old: DecorationSet, tr: Transaction): DecorationSet {
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  if (!sync?.isChangeOrigin) return old.map(tr.mapping, tr.doc);
  const marks = old.find();
  if (marks.length === 0) return old;
  const move = carryAcross(tr.before, tr.doc);
  const kept: Decoration[] = [];
  for (const mark of marks) {
    const from = move(mark.from);
    if (from === null) continue;
    const spec = mark.spec as Partial<SpaceSpec> & { push?: number };
    if (spec.el && spec.key !== undefined) kept.push(spaceDeco(from, spec as SpaceSpec));
    else if (spec.push !== undefined) {
      const to = move(mark.to);
      const node = tr.doc.nodeAt(from);
      if (to !== null && node && from + node.nodeSize === to) kept.push(pushDeco(from, to, spec.push));
    }
  }
  return DecorationSet.create(tr.doc, kept);
}

/**
 * What lies between the last line of one page and the first of the next,
 * top to bottom: what was left of the page (`blank`), its bottom margin,
 * the gap between the sheets, the next page's top margin. `bar` is where
 * the gap begins within it.
 *
 * Less than nothing left: the text has run over its page (while typing,
 * until its pages are worked out again) and is in the bottom margin, as
 * far as there is one.
 */
export function breakSpace(blank: number, marginBottom: number, marginTop: number): { height: number; bar: number } {
  const bar = Math.max(0, blank + marginBottom);
  return { height: bar + PAGE_GAP + marginTop, bar };
}

/**
 * How much room a page's text has on screen: the paper's (`least`), or
 * more where the screen wraps the text into more than that. A line or so
 * over (`give`) is let into the bottom margin instead: the screen's lines
 * are the browser's, now and then one more than the engine's, and pages
 * that all stand at the same height are worth more than a margin that is
 * exact. While the text is ahead of the engine's pages (`held`: the room
 * it had when they last agreed) it keeps that, so the gap under it stays
 * where it is.
 */
export function pageRoom(least: number, used: number, held: number | null, give = 0): number {
  return held ?? Math.max(least, used - give);
}

/** How far a page's text may run into its bottom margin before the page
 *  is made taller instead, px: half of it, two lines at the most. */
export const marginGive = (marginBottom: number): number => Math.min(marginBottom / 2, 48);

/** How many columns a table has (its first row's cells, with their spans). */
export function tableColumns(table: PmNode): number {
  let count = 0;
  table.firstChild?.forEach((cell) => {
    const span = Number(cell.attrs.colspan);
    count += Number.isFinite(span) && span > 0 ? span : 1;
  });
  return Math.max(1, count);
}

/**
 * Where a page's start is marked in the editor: before a block (the
 * outermost one that starts there — a list, not its first item's
 * paragraph), between two rows of a table, or inside a paragraph.
 */
export function resolvePageStart(doc: PmNode, start: { pos: number; inline: boolean }): { pos: number; kind: SpacerKind } | null {
  let pos = start.pos;
  if (pos < 0 || pos > doc.content.size) return null;
  if (start.inline) {
    const $pos = doc.resolve(pos);
    if (!$pos.parent.isTextblock) return null;
    if ($pos.parentOffset > 0) return { pos, kind: "inline" };
    // The very start of a paragraph is the paragraph's start.
    pos = $pos.before();
  }
  let $pos = doc.resolve(pos);
  if (!$pos.nodeAfter || $pos.nodeAfter.isInline) return null;
  // (Not out of a table's cell: a page that begins with a cell's first
  // block begins inside that cell, where its row was cut.)
  const inCell = () => {
    const role = $pos.parent.type.spec.tableRole as string | undefined;
    return role === "cell" || role === "header_cell";
  };
  while ($pos.depth > 0 && $pos.index() === 0 && !inCell()) {
    pos = $pos.before();
    $pos = doc.resolve(pos);
  }
  const role = $pos.nodeAfter?.type.spec.tableRole as string | undefined;
  if (role === "cell" || role === "header_cell") return null;
  return { pos, kind: role === "row" ? "row" : "block" };
}

function makeSpacer(kind: SpacerKind): HTMLElement {
  if (kind === "row") {
    const row = document.createElement("tr");
    row.className = "wf-pg-space wf-pg-row";
    // (Its one cell spans the table's columns — exactly: a cell wider than
    // the table adds columns to it, and a table told it has a hundred
    // shares its width among a hundred. `applyMap` sets the span.)
    row.append(document.createElement("td"));
    return row;
  }
  const el = document.createElement(kind === "inline" ? "span" : "div");
  el.className = kind === "inline" ? "wf-pg-space wf-pg-inline" : "wf-pg-space";
  return el;
}

/** A spacer's height is its cell's, for a table row. */
const sized = (el: HTMLElement): HTMLElement => (el.tagName === "TR" ? ((el.firstElementChild as HTMLElement | null) ?? el) : el);

/**
 * What page view draws on the sheet itself: the gap between two pages (or
 * a hairline, where a boundary falls inside a block too tall to move), the
 * number of the page each begins, and the room that fills out the last
 * page. Written straight to the page in the pass that places the text, so
 * the two are never a frame apart.
 */
class Guides {
  private sheet: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private bars = new Map<number, { el: HTMLElement; clean: boolean | null; top: number }>();
  private fill = -1;

  show(sheet: HTMLElement, layout: PageLayoutResult) {
    if (this.sheet !== sheet || !this.host?.isConnected) {
      this.clear();
      const host = document.createElement("div");
      host.className = "wf-page-guides";
      host.setAttribute("aria-hidden", "true");
      const first = document.createElement("span");
      first.className = "wf-page-num-first";
      first.textContent = "Page 1";
      host.append(first);
      sheet.append(host);
      this.sheet = sheet;
      this.host = host;
    }
    const host = this.host!;
    const seen = new Set<number>();
    for (const band of layout.bands) {
      seen.add(band.page);
      let bar = this.bars.get(band.page);
      if (!bar) {
        const el = document.createElement("div");
        const label = document.createElement("span");
        label.textContent = `Page ${band.page}`;
        el.append(label);
        host.append(el);
        bar = { el, clean: null, top: NaN };
        this.bars.set(band.page, bar);
      }
      if (bar.clean !== band.clean) {
        bar.el.className = band.clean ? "wf-page-gap" : "wf-page-guide";
        bar.el.style.height = band.clean ? `${layout.gap}px` : "";
        bar.clean = band.clean;
      }
      const top = band.clean ? band.y : band.y + layout.gap + layout.lead;
      // (Not for the fraction of a pixel that rounding moves it by.)
      if (!(Math.abs(top - bar.top) < 0.75)) {
        bar.el.style.top = `${top}px`;
        bar.top = top;
      }
    }
    for (const [page, bar] of this.bars) {
      if (seen.has(page)) continue;
      bar.el.remove();
      this.bars.delete(page);
    }
    if (this.fill !== layout.fill) {
      sheet.style.setProperty("--wfd-fill", `${layout.fill}px`);
      this.fill = layout.fill;
    }
  }

  clear() {
    this.host?.remove();
    this.sheet?.style.removeProperty("--wfd-fill");
    this.sheet = null;
    this.host = null;
    this.bars.clear();
    this.fill = -1;
  }
}

const views = new WeakMap<EditorView, PaginateView>();

class PaginateView {
  private ro: ResizeObserver | null = null;
  private cancel: (() => void) | null = null;
  private lastLayoutJson = "";
  private destroyed = false;
  private readonly guides = new Guides();
  /** As printed: the map last applied and what is known of its pages. */
  private applied: PageMapFor | null = null;
  private exact: { pages: number; bodyH: number[] } | null = null;
  /** The room the text before each spacer has on screen (by the page that
   *  begins after it, and the page that run of text began with). */
  private rooms = new Map<number, { from: number; h: number }>();
  /** The height each spacer was last given. */
  private given = new WeakMap<HTMLElement, number>();
  /** Whether the caret was in view before the page breaks last moved. */
  private caretWasSeen = false;

  constructor(
    private readonly view: EditorView,
    private readonly opts: PaginateOptions,
  ) {
    views.set(view, this);
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(view.dom);
    // (A map that arrived while an input method was composing waits for it.)
    view.dom.addEventListener("compositionend", this.reflow);
    this.schedule();
  }

  update(view: EditorView, prevState: EditorState) {
    void view;
    if (this.view.state.doc !== prevState.doc) this.schedule();
  }

  reflow = () => {
    this.schedule();
  };

  destroy() {
    this.destroyed = true;
    this.view.dom.removeEventListener("compositionend", this.reflow);
    this.ro?.disconnect();
    this.ro = null;
    this.cancel?.();
    this.cancel = null;
    this.guides.clear();
    views.delete(this.view);
  }

  /** One pass, before the next paint, however many changes ask for it. */
  private schedule() {
    if (this.cancel || this.destroyed) return;
    this.cancel = beforePaint(() => {
      this.cancel = null;
      this.measure();
    });
  }

  private present(sheet: HTMLElement | null, result: PageLayoutResult | null) {
    if (sheet && result) this.guides.show(sheet, result);
    else this.guides.clear();
    const json = JSON.stringify(result);
    if (json === this.lastLayoutJson) return;
    this.lastLayoutJson = json;
    this.opts.onLayout(result);
  }

  /** Change what is marked on the sheet (nothing, when it is as wanted). */
  private put(set: DecorationSet, cur: DecorationSet): DecorationSet {
    if (set === DecorationSet.empty && cur.find().length === 0) return cur;
    this.view.dispatch(this.view.state.tr.setMeta(paginateKey, set));
    return set;
  }

  /** Whether the caret is where it can be seen: the text has focus and
   *  its line is in the part of the window the page shows in. */
  private caretSeen(): boolean {
    const view = this.view;
    try {
      if (!view.hasFocus()) return false;
      const at = view.coordsAtPos(view.state.selection.head);
      const within = textWindow(view.dom as HTMLElement);
      return at.bottom > within.top && at.top < within.bottom;
    } catch {
      return false; // not laid out
    }
  }

  /** Leave the as-printed view. */
  private leaveExact() {
    this.applied = null;
    this.exact = null;
    this.rooms.clear();
  }

  /** Put a spacer where each page of a new map begins. */
  private applyMap(map: PageMapFor, cur: DecorationSet): DecorationSet {
    const doc = this.view.state.doc;
    const have = new Map<string, { at: number; el: HTMLElement }>();
    for (const d of cur.find()) {
      const spec = d.spec as Partial<SpaceSpec>;
      if (spec.key !== undefined && spec.el) have.set(spec.key, { at: d.from, el: spec.el });
    }
    const decos: Decoration[] = [];
    let moved = false;
    map.starts.forEach((start, page) => {
      if (page === 0 || !start) return;
      // (One place, but for a table's row cut across pages: one in each cell.)
      [start, ...(start.also ?? [])].forEach((place, part) => {
        const at = resolvePageStart(doc, place);
        if (!at) return;
        // (By page and kind: the element stays the same as its place moves.)
        const key = part ? `${at.kind}:${page}:${part}` : `${at.kind}:${page}`;
        const was = have.get(key);
        const el = was?.el ?? makeSpacer(at.kind);
        if (at.kind === "row") {
          const span = tableColumns(doc.resolve(at.pos).parent);
          const cell = sized(el) as HTMLTableCellElement;
          if (cell.colSpan !== span) cell.colSpan = span;
        }
        if (was?.at !== at.pos) moved = true;
        decos.push(spaceDeco(at.pos, { side: -1, key, page, ignoreSelection: true, el }));
      });
    });
    this.applied = map;
    this.exact = { pages: map.pages, bodyH: map.bodyH };
    // Most changes to the text leave every page beginning where it did —
    // and the spacers have already moved along with their text.
    if (!moved && decos.length === cur.find().length) return cur;
    this.caretWasSeen = this.caretSeen();
    const set = DecorationSet.create(doc, decos);
    this.view.dispatch(this.view.state.tr.setMeta(paginateKey, set));
    return set;
  }

  /** As printed: size each spacer so its page is as tall as the paper's
   *  (or as its text, where the screen needs more), and draw the gaps. */
  private measureExact(spec: PageSpec, cur: DecorationSet) {
    const view = this.view;
    const dom = view.dom as HTMLElement;
    const sheet = dom.closest(".wf-page") as HTMLElement | null;
    const exact = this.exact;
    if (!sheet || !exact) {
      this.present(null, null);
      return;
    }
    const cs = getComputedStyle(dom);
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const actualTextW = Math.max(50, dom.clientWidth - padL - padR);
    const specTextW = Math.max(1, spec.w - spec.ml - spec.mr) * PX_PER_IN;
    const scale = Math.min(4, Math.max(1, specTextW / actualTextW));
    const fallbackH = (spec.h - spec.mt - spec.mb) * 72;
    // The sheet's own margins, as drawn (its bottom padding also holds what
    // fills out the last page).
    const fillNow = parseFloat(sheet.style.getPropertyValue("--wfd-fill")) || 0;
    const marginTop = padT;
    const marginBottom = Math.max(0, padB - fillNow);
    /** The least a run of pages is tall on screen, px (with what lies
     *  between them, where a page's start couldn't be marked). */
    const least = (from: number, to: number) => {
      let h = 0;
      for (let page = from; page < to; page += 1) h += ((exact.bodyH[page] ?? fallbackH) / 72) * PX_PER_IN * scale;
      return h + breakSpace(0, marginBottom, marginTop).height * Math.max(0, to - from - 1);
    };
    // The pages are the engine's for this very text — or the text has
    // changed since (typing) and its answer is on the way: until it comes,
    // every page keeps the room it had and the gaps stay where they are.
    const settled = this.applied?.doc === view.state.doc;
    const give = marginGive(marginBottom);

    const sheetTop = sheet.getBoundingClientRect().top;
    const placed = cur
      .find()
      .map((d) => ({ at: d.from, page: (d.spec as Partial<SpaceSpec>).page, el: (d.spec as Partial<SpaceSpec>).el }))
      .filter((m): m is { at: number; page: number; el: HTMLElement } => m.page !== undefined && !!m.el && m.el.isConnected)
      .sort((a, b) => a.page - b.page || a.at - b.at);
    // The spacers of each page together: one, but where a table's row is cut
    // across pages (then one in each of its cells, side by side).
    const pagesMarked: (typeof placed)[] = [];
    for (const m of placed) {
      const last = pagesMarked[pagesMarked.length - 1];
      if (last && last[0].page === m.page) last.push(m);
      else pagesMarked.push([m]);
    }
    const beside = pagesMarked.some((group) => group.length > 1);

    let pmRect = dom.getBoundingClientRect();
    let bands: PageBand[] = [];
    let rooms = new Map<number, { from: number; h: number }>();
    let contentStart = pmRect.top + padT;
    let firstPage = 0;
    // Read everything, then write: a spacer's size doesn't change how much
    // text lies between it and the one before. (Spacers side by side in one
    // row do lean on each other while they are being sized: then it is done
    // again, a few times at most, until they agree.)
    for (let round = 0; round < (beside ? 4 : 1); round += 1) {
      pmRect = dom.getBoundingClientRect();
      const read = pagesMarked.map((group) =>
        group.map((m) => {
          const rect = m.el.getBoundingClientRect();
          return { ...m, top: rect.top, height: rect.height };
        }),
      );
      bands = [];
      rooms = new Map();
      contentStart = pmRect.top + padT;
      firstPage = 0;
      let shift = 0;
      let wrote = false;
      for (const group of read) {
        // The page ends where the lowest of its cut cells does.
        const lead = group.reduce((a, b) => (b.top > a.top ? b : a));
        const used = lead.top - contentStart;
        const was = this.rooms.get(lead.page);
        const room = pageRoom(least(firstPage, lead.page), used, !settled && was && was.from === firstPage ? was.h : null, give);
        rooms.set(lead.page, { from: firstPage, h: room });
        const space = breakSpace(room - used, marginBottom, marginTop);
        for (const mark of group) {
          // (A cell that ended higher up makes up the difference: all of
          // them go on at the same height on the next page.)
          const height = Math.round((space.height + (lead.top - mark.top)) * 100) / 100;
          if (this.given.get(mark.el) !== height) {
            sized(mark.el).style.height = `${height}px`;
            this.given.set(mark.el, height);
            wrote = true;
          }
        }
        const height = Math.round(space.height * 100) / 100;
        bands.push({ y: Math.round(lead.top + shift + space.bar - sheetTop), page: lead.page + 1, clean: true });
        shift += height - lead.height;
        contentStart = lead.top + lead.height;
        firstPage = lead.page;
      }
      if (!wrote) break;
    }
    // The last page, the same way: what fills it out to a whole sheet gives
    // up what is typed, and a line that runs over is in its bottom margin
    // (less than no fill) until the engine has made a page for it.
    const lastUsed = pmRect.bottom - padB - contentStart;
    const wasLast = this.rooms.get(exact.pages);
    const lastRoom = pageRoom(least(firstPage, exact.pages), lastUsed, !settled && wasLast && wasLast.from === firstPage ? wasLast.h : null, give);
    rooms.set(exact.pages, { from: firstPage, h: lastRoom });
    this.rooms = rooms;
    const fill = Math.round(Math.max(-marginBottom, lastRoom - lastUsed) * 100) / 100;
    this.present(sheet, { bands, gap: PAGE_GAP, lead: Math.round(marginTop), pages: exact.pages, fill });
  }

  private measure() {
    if (this.destroyed || this.view.isDestroyed) return;
    const view = this.view;
    const spec = this.opts.getSpec();
    const cur = paginateKey.getState(view.state) ?? DecorationSet.empty;

    if (!spec) {
      this.leaveExact();
      this.put(DecorationSet.empty, cur);
      this.present(null, null);
      return;
    }

    // As printed, when the engine has said where the pages fall.
    const map = this.opts.getMap();
    if (map === "pending") {
      if (this.exact) {
        this.measureExact(spec, cur);
        return;
      }
      this.put(DecorationSet.empty, cur);
      this.present(null, null);
      return;
    }
    if (map) {
      // (Not while an input method is composing: a mark moved through the
      // text it is working on can break the composition off.)
      if (map !== this.applied && map.doc === view.state.doc && !view.composing) {
        // (Coming from the simple view: say so, whatever the count.)
        if (!this.exact) this.lastLayoutJson = "";
        const set = this.applyMap(map, cur);
        // Placed and sized in the one pass: a spacer is never seen unsized.
        this.measureExact(spec, set);
        // The line being written has gone over to the next page, and out of
        // view with it: go after it.
        if (set !== cur && this.caretWasSeen && !this.caretSeen()) view.dispatch(view.state.tr.scrollIntoView());
        return;
      }
      if (this.exact) {
        this.measureExact(spec, cur);
        return;
      }
      // (A map for an older text, and none applied yet: simple until the
      // next one arrives.)
    } else if (this.exact) {
      // Back to the simple view: start from nothing.
      this.leaveExact();
      this.measureSimple(spec, this.put(DecorationSet.empty, cur));
      return;
    }
    this.measureSimple(spec, cur);
  }

  /** The simple view: push each block that would straddle a boundary. */
  private measureSimple(spec: PageSpec, cur: DecorationSet) {
    const view = this.view;
    const state = view.state;
    const dom = view.dom as HTMLElement;
    const sheet = dom.closest(".wf-page") as HTMLElement | null;
    if (!sheet) {
      this.present(null, null);
      return;
    }
    const cs = getComputedStyle(dom);
    const padT = parseFloat(cs.paddingTop) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const actualTextW = Math.max(50, dom.clientWidth - padL - padR);
    const specTextW = Math.max(1, spec.w - spec.ml - spec.mr) * PX_PER_IN;
    const scale = Math.min(4, Math.max(1, specTextW / actualTextW));
    const contentH = Math.max(120, (spec.h - spec.mt - spec.mb) * PX_PER_IN * scale);
    // Between two pages: the bottom margin, the gap, the top margin.
    const fillNow = parseFloat(sheet.style.getPropertyValue("--wfd-fill")) || 0;
    const marginTop = padT;
    const marginBottom = Math.max(0, (parseFloat(cs.paddingBottom) || 0) - fillNow);
    const between = breakSpace(0, marginBottom, marginTop);
    const span = contentH + between.height;

    const pmRect = dom.getBoundingClientRect();
    const sheetRect = sheet.getBoundingClientRect();
    const originY = pmRect.top + padT; // content-space zero, viewport coords
    const sheetOffset = originY - sheetRect.top; // content zero within the sheet

    // Pushes currently applied, so measured positions can be de-pushed.
    // Blocks are walked in document order, so one sorted pass with a
    // running sum replaces a scan of every push per block (a novel has
    // thousands of blocks and hundreds of pushes).
    const applied: Push[] = cur
      .find()
      .map((d) => ({
        pos: d.from,
        end: d.to,
        push: (d.spec as { push?: number }).push ?? 0,
      }))
      .sort((a, b) => a.pos - b.pos);
    const appliedByPos = new Map(applied.map((a) => [a.pos, a.push]));
    let appliedCursor = 0;
    let appliedSum = 0;
    const appliedBefore = (pos: number) => {
      while (appliedCursor < applied.length && applied[appliedCursor].pos < pos) {
        appliedSum += applied[appliedCursor].push;
        appliedCursor += 1;
      }
      return appliedSum;
    };
    const appliedAt = (pos: number) => appliedByPos.get(pos) ?? 0;

    const next: Push[] = [];
    const dirtyPages = new Set<number>();
    let acc = 0;
    let maxBottom = 0;
    let index = 0;
    // Each block's element, found by walking the sheet beside the document
    // (asking the view for each is a search from the top every time, and
    // this runs after every change).
    let beside = dom.firstElementChild;

    state.doc.forEach((node, offset) => {
      let el: Element | null = null;
      for (let probe = beside, tries = 0; probe && tries < 6; probe = probe.nextElementSibling, tries += 1) {
        if ((probe as { pmViewDesc?: { node?: PmNode } }).pmViewDesc?.node === node) {
          el = probe;
          break;
        }
      }
      el ??= view.nodeDOM(offset) as Element | null;
      const isFirst = index === 0;
      index += 1;
      if (!el || !(el instanceof HTMLElement)) return;
      beside = el.nextElementSibling;

      const rect = el.getBoundingClientRect();
      const naturalTop = rect.top - originY - appliedBefore(offset);
      const naturalH = Math.max(0, rect.height - appliedAt(offset));

      const top = naturalTop + acc;
      const page = Math.max(0, Math.floor(top / span));
      const posIn = top - page * span;

      let push = 0;
      const atPageTop = posIn < 1;
      // (A section starts a page too.)
      const wantsBreak = (Boolean(node.attrs?.pageBreakBefore) || Boolean(node.attrs?.sect)) && !isFirst && !atPageTop;
      const landsInGap = posIn > contentH - 0.5;
      const overflows = posIn + naturalH > contentH + 0.5 && naturalH <= contentH;
      if (wantsBreak || landsInGap || overflows) {
        push = (page + 1) * span - top;
        acc += push;
      }
      if (push > 0.5) {
        next.push({ pos: offset, end: offset + node.nodeSize, push });
      }

      const textTop = naturalTop + acc;
      const textBottom = textTop + naturalH;
      maxBottom = Math.max(maxBottom, textBottom);
      if (naturalH > contentH) {
        // Which boundaries does this block's text cross?
        const firstB = Math.floor((textTop + between.height) / span) + 1;
        for (let k = firstB; k * span - between.height < textBottom; k += 1) {
          dirtyPages.add(k - 1);
        }
      }
    });

    const pages = Math.max(1, Math.floor(Math.max(0, maxBottom - 1) / span) + 1);
    const fill = Math.max(0, Math.round(pages * span - between.height - maxBottom));

    // Only redecorate when the pushes actually changed.
    const same =
      next.length === applied.length &&
      next.every((n) => {
        const a = appliedByPos.get(n.pos);
        return a !== undefined && Math.abs(a - n.push) < 1;
      });
    if (!same) {
      const set = DecorationSet.create(
        state.doc,
        next.map((n) => pushDeco(n.pos, n.end, n.push)),
      );
      view.dispatch(state.tr.setMeta(paginateKey, set));
    }

    const bands: PageBand[] = [];
    for (let k = 0; k < pages - 1; k += 1) {
      bands.push({
        y: Math.round(sheetOffset + (k + 1) * span - between.height + between.bar),
        page: k + 2,
        clean: !dirtyPages.has(k),
      });
    }
    this.present(sheet, { bands, gap: PAGE_GAP, lead: Math.round(marginTop), pages, fill });
  }
}

export const Paginate = Extension.create<PaginateOptions>({
  name: "paginate",

  addOptions() {
    return {
      getSpec: () => null,
      getMap: () => null,
      onLayout: () => {},
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin<DecorationSet>({
        key: paginateKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr: Transaction, old: DecorationSet) {
            const meta = tr.getMeta(paginateKey) as DecorationSet | undefined;
            if (meta) return meta;
            return tr.docChanged ? carried(old, tr) : old;
          },
        },
        props: {
          decorations(state) {
            return paginateKey.getState(state);
          },
        },
        view: (editorView) => new PaginateView(editorView, opts),
      }),
    ];
  },
});
