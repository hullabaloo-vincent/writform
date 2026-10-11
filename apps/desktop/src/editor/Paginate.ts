import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";

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
 * SIMPLE (the fallback: no map yet, the engine failed, or the writer chose
 * it). Each top-level block that would straddle a page boundary — or that
 * carries an explicit `pageBreakBefore` — is pushed to the next page with a
 * `padding-top` node decoration, so boundaries land in whitespace and the
 * overlay can draw a physical gap between pages.
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
  pages: number;
  /** Extra bottom padding (px) that fills the last page to full height. */
  fill: number;
}

/** The layout engine's pages, for one state of the document. */
export interface PageMapFor {
  /** The document it was made for (a map for another is out of date). */
  doc: PmNode;
  pages: number;
  /** Where each page's text begins (the first page's too); null where
   *  that can't be pointed at. */
  starts: ({ pos: number; inline: boolean } | null)[];
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

/** Force a re-measure (page view toggled, settings changed). */
export function reflowPagination(editor: Editor): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(paginateKey, "reflow"));
}

interface Push {
  pos: number;
  end: number;
  push: number;
}

type SpacerKind = "block" | "inline" | "row";

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
  while ($pos.depth > 0 && $pos.index() === 0) {
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
    const cell = document.createElement("td");
    cell.colSpan = 100;
    row.append(cell);
    return row;
  }
  const el = document.createElement(kind === "inline" ? "span" : "div");
  el.className = kind === "inline" ? "wf-pg-space wf-pg-inline" : "wf-pg-space";
  return el;
}

/** A spacer's height is its cell's, for a table row. */
const sized = (el: HTMLElement): HTMLElement => (el.tagName === "TR" ? ((el.firstElementChild as HTMLElement | null) ?? el) : el);

class PaginateView {
  private ro: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastLayoutJson = "";
  private destroyed = false;
  /** As printed: the map last applied, its spacers by key, and what is
   *  known of its pages. */
  private applied: PageMapFor | null = null;
  private spacers = new Map<string, HTMLElement>();
  private exact: { pages: number; bodyH: number[] } | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly opts: PaginateOptions,
  ) {
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(view.dom);
    this.schedule();
  }

  update(view: EditorView, prevState: EditorState) {
    void view;
    if (this.view.state.doc !== prevState.doc) this.schedule();
  }

  noteMeta() {
    this.schedule();
  }

  destroy() {
    this.destroyed = true;
    this.ro?.disconnect();
    this.ro = null;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(wait = 120) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.measure();
    }, wait);
  }

  private emit(result: PageLayoutResult | null) {
    const json = JSON.stringify(result);
    if (json === this.lastLayoutJson) return;
    this.lastLayoutJson = json;
    this.opts.onLayout(result);
  }

  /** Leave the as-printed view: its spacers go. */
  private leaveExact() {
    this.applied = null;
    this.exact = null;
    this.spacers.clear();
  }

  /** Put a spacer where each page of a new map begins. */
  private applyMap(map: PageMapFor) {
    const view = this.view;
    const doc = view.state.doc;
    const decos: Decoration[] = [];
    const used = new Map<string, HTMLElement>();
    map.starts.forEach((start, page) => {
      if (page === 0 || !start) return;
      const at = resolvePageStart(doc, start);
      if (!at) return;
      // (By page and kind: the element stays the same as its place moves.)
      const key = `${at.kind}:${page}`;
      const el = this.spacers.get(key) ?? makeSpacer(at.kind);
      used.set(key, el);
      decos.push(Decoration.widget(at.pos, el, { side: -1, key, page, ignoreSelection: true }));
    });
    this.spacers = used;
    this.applied = map;
    this.exact = { pages: map.pages, bodyH: map.bodyH };
    view.dispatch(view.state.tr.setMeta(paginateKey, DecorationSet.create(doc, decos)));
  }

  /** As printed: size each spacer so its page is as tall as the paper's
   *  (or as its text, where the screen needs more), and report the gaps. */
  private measureExact(spec: PageSpec, cur: DecorationSet) {
    const view = this.view;
    const dom = view.dom as HTMLElement;
    const sheet = dom.closest(".wf-page") as HTMLElement | null;
    const exact = this.exact;
    if (!sheet || !exact) {
      this.emit(null);
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
    /** The least a run of pages is tall on screen, px. */
    const least = (from: number, to: number) => {
      let h = 0;
      for (let page = from; page < to; page += 1) h += ((exact.bodyH[page] ?? fallbackH) / 72) * PX_PER_IN * scale;
      return h + PAGE_GAP * Math.max(0, to - from - 1);
    };

    const pmRect = dom.getBoundingClientRect();
    const sheetTop = sheet.getBoundingClientRect().top;
    // Read everything, then write: a spacer's size doesn't change how much
    // text lies between it and the one before.
    const marks = cur
      .find()
      .map((d) => ({ at: d.from, page: (d.spec as { page?: number }).page, el: this.spacers.get((d.spec as { key?: string }).key ?? "") }))
      .filter((m): m is { at: number; page: number; el: HTMLElement } => m.page !== undefined && !!m.el && m.el.isConnected)
      .sort((a, b) => a.at - b.at || a.page - b.page)
      .map((m) => {
        const rect = m.el.getBoundingClientRect();
        return { ...m, top: rect.top, height: rect.height };
      });

    const bands: PageBand[] = [];
    let contentStart = pmRect.top + padT;
    let firstPage = 0;
    let shift = 0;
    for (const mark of marks) {
      const used = mark.top - contentStart;
      const height = Math.round(PAGE_GAP + Math.max(0, least(firstPage, mark.page) - used));
      if (Math.abs(height - mark.height) >= 0.5) sized(mark.el).style.height = `${height}px`;
      bands.push({ y: Math.round(mark.top + shift + height - PAGE_GAP - sheetTop), page: mark.page + 1, clean: true });
      shift += height - mark.height;
      contentStart = mark.top + mark.height;
      firstPage = mark.page;
    }
    const lastUsed = pmRect.bottom - padB - contentStart;
    const fill = Math.max(0, Math.round(least(firstPage, exact.pages) - lastUsed));
    this.emit({ bands, gap: PAGE_GAP, pages: exact.pages, fill });
  }

  private measure() {
    if (this.destroyed || this.view.isDestroyed) return;
    const view = this.view;
    const state = view.state;
    const spec = this.opts.getSpec();
    const cur = paginateKey.getState(state) ?? DecorationSet.empty;

    if (!spec) {
      this.leaveExact();
      if (cur.find().length > 0) {
        view.dispatch(state.tr.setMeta(paginateKey, DecorationSet.empty));
      }
      this.emit(null);
      return;
    }

    // As printed, when the engine has said where the pages fall.
    const map = this.opts.getMap();
    if (map === "pending") {
      if (!this.exact) {
        if (cur.find().length > 0) view.dispatch(state.tr.setMeta(paginateKey, DecorationSet.empty));
        this.emit(null);
        return;
      }
      this.measureExact(spec, cur);
      return;
    }
    if (map) {
      if (map !== this.applied && map.doc === state.doc) {
        // (The dispatch brings us back here to size the new spacers.)
        const entering = !this.exact;
        this.applyMap(map);
        if (entering) this.lastLayoutJson = "";
        this.schedule(0);
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
      view.dispatch(state.tr.setMeta(paginateKey, DecorationSet.empty));
      this.schedule(0);
      return;
    }

    const dom = view.dom as HTMLElement;
    const sheet = dom.closest(".wf-page") as HTMLElement | null;
    if (!sheet) {
      this.emit(null);
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
    const span = contentH + PAGE_GAP;

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

    const next: (Push & { node: PmNode })[] = [];
    const dirtyPages = new Set<number>();
    let acc = 0;
    let maxBottom = 0;
    let index = 0;

    state.doc.forEach((node, offset) => {
      const el = view.nodeDOM(offset) as HTMLElement | null;
      const isFirst = index === 0;
      index += 1;
      if (!el || !(el instanceof HTMLElement)) return;

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
        next.push({ pos: offset, end: offset + node.nodeSize, push, node });
      }

      const textTop = naturalTop + acc;
      const textBottom = textTop + naturalH;
      maxBottom = Math.max(maxBottom, textBottom);
      if (naturalH > contentH) {
        // Which boundaries does this block's text cross?
        const firstB = Math.floor((textTop + PAGE_GAP) / span) + 1;
        for (let k = firstB; k * span - PAGE_GAP < textBottom; k += 1) {
          dirtyPages.add(k - 1);
        }
      }
    });

    const pages = Math.max(1, Math.floor(Math.max(0, maxBottom - 1) / span) + 1);
    const fill = Math.max(0, Math.round(pages * span - PAGE_GAP - maxBottom));

    // Only redecorate when the pushes actually changed; the dispatch below
    // re-triggers update → measure, and this equality check ends the loop.
    const same =
      next.length === applied.length &&
      next.every((n) => {
        const a = appliedByPos.get(n.pos);
        return a !== undefined && Math.abs(a - n.push) < 1;
      });
    if (!same) {
      const set = DecorationSet.create(
        state.doc,
        next.map((n) =>
          Decoration.node(
            n.pos,
            n.end,
            { style: `padding-top: ${Math.round(n.push)}px`, class: "wf-pg-push" },
            { push: n.push },
          ),
        ),
      );
      view.dispatch(state.tr.setMeta(paginateKey, set));
    }

    const bands: PageBand[] = [];
    for (let k = 0; k < pages - 1; k += 1) {
      bands.push({
        y: Math.round(sheetOffset + (k + 1) * span - PAGE_GAP),
        page: k + 2,
        clean: !dirtyPages.has(k),
      });
    }
    this.emit({ bands, gap: PAGE_GAP, pages, fill });
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
    let pluginView: PaginateView | null = null;
    return [
      new Plugin<DecorationSet>({
        key: paginateKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr: Transaction, old: DecorationSet) {
            const meta = tr.getMeta(paginateKey) as DecorationSet | "reflow" | undefined;
            if (meta === "reflow") {
              pluginView?.noteMeta();
              return old.map(tr.mapping, tr.doc);
            }
            if (meta) return meta;
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return paginateKey.getState(state);
          },
        },
        view(editorView) {
          pluginView = new PaginateView(editorView, opts);
          return pluginView;
        },
      }),
    ];
  },
});
