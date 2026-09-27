import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Block-level pagination for the writing sheet. When page view is on, each
 * top-level block that would straddle a page boundary — or that carries an
 * explicit `pageBreakBefore` — is pushed to the next page with a
 * `padding-top` node decoration, so boundaries land in whitespace and the
 * overlay can draw a physical gap between pages. Decorations are pure
 * presentation: nothing enters the document, the Yjs history, or a
 * collaborator's screen.
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

interface PaginateOptions {
  /** Current page spec, or null when page view is off. Read per measure. */
  getSpec: () => PageSpec | null;
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

class PaginateView {
  private ro: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastLayoutJson = "";
  private destroyed = false;

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

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.measure();
    }, 120);
  }

  private emit(result: PageLayoutResult | null) {
    const json = JSON.stringify(result);
    if (json === this.lastLayoutJson) return;
    this.lastLayoutJson = json;
    this.opts.onLayout(result);
  }

  private measure() {
    if (this.destroyed || this.view.isDestroyed) return;
    const view = this.view;
    const state = view.state;
    const spec = this.opts.getSpec();
    const cur = paginateKey.getState(state) ?? DecorationSet.empty;

    if (!spec) {
      if (cur.find().length > 0) {
        view.dispatch(state.tr.setMeta(paginateKey, DecorationSet.empty));
      }
      this.emit(null);
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
    const applied: Push[] = cur.find().map((d) => ({
      pos: d.from,
      end: d.to,
      push: (d.spec as { push?: number }).push ?? 0,
    }));
    const appliedBefore = (pos: number) =>
      applied.reduce((sum, a) => (a.pos < pos ? sum + a.push : sum), 0);
    const appliedAt = (pos: number) => applied.find((a) => a.pos === pos)?.push ?? 0;

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
      const wantsBreak = Boolean(node.attrs?.pageBreakBefore) && !isFirst && !atPageTop;
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
        const a = applied.find((x) => x.pos === n.pos);
        return a !== undefined && Math.abs(a.push - n.push) < 1;
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
