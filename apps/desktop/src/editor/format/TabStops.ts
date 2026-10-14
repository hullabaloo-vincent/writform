/**
 * Tab stops on the writing page (Document format). Every tab character is
 * given the width that takes the text after it to its stop: the
 * paragraph's own stops (`tabs`, level 4), else stops every so often from
 * the margin (`tabStop` in the document's settings), as Word and the
 * printed page (doclayout) have them. A right, centre or decimal stop
 * places the text after the tab against it.
 *
 * The caret, the selection and typing stay the browser's: a tab is still a
 * tab character, only given a width. How the width is given depends on the
 * webview, learned once: a `tab-size` of its own on the tab (the browser
 * then takes it to the stop), or where that isn't honoured, the tab drawn
 * as a box of that width.
 *
 * Measured before the next paint after any change, in one read and then
 * one write. A width is corrected by where its tab really ended, so a few
 * passes settle it whatever the webview counts from (at most three per
 * version of the text). Nothing is written while an input method composes.
 */

import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { decimalMark, nextTab, parseTabs, TAB_EVERY, type TabLeader, type TabStop } from "../schema/sanitize";
import type { ResolvedStyles } from "../styles/sheet";
import { scaleOf } from "../ui/scale";
import { styleIdOf } from "./effective";

/** How a tab is given its width here: "size" its own tab-size, "width" a
 *  box of that width. */
export type TabMode = "size" | "width";
let learned: TabMode | null = null;
/** For tests: say how widths are given (null: learn it again). */
export function setTabMode(mode: TabMode | null): void {
  learned = mode;
}

/** What one tab was last given: `v` its tab-size or its width (own
 *  pixels, as the mode says), and the leader of the stop it goes to. */
interface Given {
  v: number;
  leader: TabLeader | null;
}

interface TabsState {
  set: DecorationSet;
  given: Map<number, Given>;
}

export const tabStopsKey = new PluginKey<TabsState>("wf-tab-stops");

const PX_PER_PT = 96 / 72;
/** Less than this a width doesn't change. */
const SETTLED = 0.25 * PX_PER_PT;
const PASSES = 3;

interface Options {
  /** Points between the stops a paragraph doesn't set itself. */
  every: () => number;
  /** The text's language (a decimal stop's mark). */
  lang: () => string;
  /** The stops a named style gives a paragraph (none: null). */
  styleStops: (node: PmNode) => TabStop[] | null;
}

/** The stops a paragraph goes by: its own, else its style's ("none": no
 *  stops of its own at all). */
function stopsOf(node: PmNode, opts: Options): TabStop[] {
  const own = parseTabs(node.attrs.tabs);
  if (own === "none") return [];
  if (own) return own;
  return opts.styleStops(node) ?? [];
}

/** Where the tab characters of a textblock are. */
function tabsIn(node: PmNode, pos: number): number[] {
  const out: number[] = [];
  node.forEach((child, offset) => {
    if (!child.isText || !child.text) return;
    for (let i = child.text.indexOf("\t"); i >= 0; i = child.text.indexOf("\t", i + 1)) out.push(pos + 1 + offset + i);
  });
  return out;
}

function styleOf(given: Given | undefined, mode: TabMode): string | undefined {
  if (!given) return undefined;
  const v = Math.max(1, Math.round(given.v * 100) / 100);
  return mode === "size" ? `tab-size: ${v}px; -moz-tab-size: ${v}px` : `display: inline-block; width: ${v}px; overflow: hidden; vertical-align: baseline`;
}

function decorate(state: EditorState, given: Map<number, Given>): DecorationSet {
  const mode = learned ?? "size";
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    for (const at of tabsIn(node, pos)) {
      const g = given.get(at);
      const style = styleOf(g, mode);
      decos.push(Decoration.inline(at, at + 1, { class: "wf-tab", ...(style ? { style } : {}), ...(g?.leader ? { "data-leader": g.leader } : {}) }));
    }
    return false;
  });
  return DecorationSet.create(state.doc, decos);
}

/** The webview's way, learned from a hidden line: a tab-size of its own
 *  on a tab that takes the next letter to 100 px. */
function learn(): TabMode {
  if (learned) return learned;
  if (typeof document === "undefined") return "width";
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font:16px monospace;tab-size:8";
  const tab = document.createElement("span");
  tab.style.cssText = "tab-size:100px";
  tab.textContent = "\t";
  const after = document.createElement("span");
  after.textContent = "x";
  box.append(tab, after);
  document.body.append(box);
  const at = after.getBoundingClientRect().left - box.getBoundingClientRect().left;
  box.remove();
  learned = Math.abs(at - 100) < 2 ? "size" : "width";
  return learned;
}

class TabView {
  private cancel: (() => void) | null = null;
  private passes = 0;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly opts: Options,
  ) {
    this.schedule();
  }

  update(view: EditorView, prev: EditorState) {
    if (view.state.doc !== prev.doc) {
      this.passes = 0;
      this.schedule();
    } else if (tabStopsKey.getState(view.state) !== tabStopsKey.getState(prev)) {
      this.schedule();
    }
  }

  destroy() {
    this.destroyed = true;
    this.cancel?.();
  }

  /** Measure again (the stops or their spacing changed outside the text). */
  again() {
    this.passes = 0;
    this.schedule();
  }

  private schedule() {
    if (this.cancel || this.destroyed) return;
    const run = () => {
      this.cancel = null;
      this.measure();
    };
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(run);
      this.cancel = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(run, 16);
      this.cancel = () => clearTimeout(id);
    }
  }

  private measure() {
    const view = this.view;
    if (this.destroyed || view.isDestroyed || view.composing || this.passes >= PASSES) return;
    const mode = learn();
    const state = tabStopsKey.getState(view.state);
    if (!state) return;
    const next = new Map<number, Given>();
    let moved = false;
    view.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (node.type.spec.code) return false;
      const tabs = tabsIn(node, pos);
      if (!tabs.length) return false;
      const el = view.nodeDOM(pos);
      if (!(el instanceof HTMLElement)) return false;
      if (this.paragraph(node, pos, el, tabs, mode, state.given, next)) moved = true;
      return false;
    });
    // A tab gone since: nothing to keep for it.
    if (!moved && next.size === state.given.size) return;
    this.passes += 1;
    view.dispatch(view.state.tr.setMeta(tabStopsKey, next).setMeta("addToHistory", false));
  }

  /** One paragraph's tabs, in order along each line. True when a width moved. */
  private paragraph(node: PmNode, pos: number, el: HTMLElement, tabs: number[], mode: TabMode, old: Map<number, Given>, next: Map<number, Given>): boolean {
    const spans = [...el.querySelectorAll<HTMLElement>("span.wf-tab")];
    if (spans.length !== tabs.length) return false;
    const view = this.view;
    const k = scaleOf(view.dom as HTMLElement) || 1;
    const column = (el.closest("td, th") as HTMLElement | null) ?? (view.dom as HTMLElement);
    const ccs = getComputedStyle(column);
    const colLeft = column.getBoundingClientRect().left + ((parseFloat(ccs.paddingLeft) || 0) + (parseFloat(ccs.borderLeftWidth) || 0)) * k;
    const cs = getComputedStyle(el);
    const contentLeft = el.getBoundingClientRect().left + ((parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0)) * k;
    const font = parseFloat(cs.fontSize) || 16;
    const minAdvance = font * 0.3;
    const own = (x: number) => (x - colLeft) / k;
    const indentPx = own(contentLeft);
    // (A hanging indent is no stop: as on the printed page, see doclayout.)
    const hang = null;
    const stops = stopsOf(node, this.opts);
    const every = this.opts.every() > 0 ? this.opts.every() : TAB_EVERY;
    const mark = decimalMark(this.opts.lang());
    let moved = false;
    let lineTop: number | null = null;
    let shift = 0;
    for (let i = 0; i < tabs.length; i += 1) {
      const r = spans[i].getBoundingClientRect();
      if (lineTop === null || Math.abs(r.top - lineTop) > font * k * 0.5) {
        lineTop = r.top;
        shift = 0;
      }
      const start = own(r.left) + shift;
      const end = own(r.right) + shift;
      const stop = nextTab(stops, every, start / PX_PER_PT, hang, minAdvance / PX_PER_PT);
      let target = stop.pt * PX_PER_PT;
      if (stop.kind !== "l") {
        const until = i + 1 < tabs.length ? tabs[i + 1] : pos + node.nodeSize - 1;
        const segment = this.segment(tabs[i] + 1, until, r.top, font * k, stop.kind === "d" ? mark : null);
        target -= stop.kind === "c" ? segment / 2 : segment;
        target = Math.max(target, start + minAdvance);
      }
      const advance = Math.max(minAdvance, target - start);
      let v: number;
      if (mode === "width") v = advance;
      else {
        // The browser takes the tab to its next multiple of tab-size,
        // counted from where it counts: correct the last size by where the
        // tab really ended.
        const was = old.get(tabs[i]);
        v = was ? was.v + (start + advance - end) : start + advance - indentPx;
        if (!(v > 0)) v = advance;
      }
      const prev = old.get(tabs[i]);
      if (!prev || Math.abs(prev.v - v) > SETTLED || prev.leader !== stop.leader) moved = true;
      next.set(tabs[i], { v, leader: stop.leader });
      shift += advance - (end - start);
    }
    return moved;
  }

  /** How wide the text from `from` to `to` is on the line at `top`, up to
   *  the decimal mark when one is asked for (own pixels). */
  private segment(from: number, to: number, top: number, lineH: number, mark: string | null): number {
    const view = this.view;
    if (to <= from) return 0;
    let end = to;
    if (mark) {
      const text = view.state.doc.textBetween(from, to);
      const at = text.indexOf(mark);
      if (at >= 0) end = from + at;
    }
    if (end <= from) return 0;
    try {
      const a = view.domAtPos(from);
      const b = view.domAtPos(end);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = [...range.getClientRects()].filter((rc) => rc.width > 0 && Math.abs(rc.top - top) < lineH * 0.6);
      if (!rects.length) return 0;
      const k = scaleOf(view.dom as HTMLElement) || 1;
      return (Math.max(...rects.map((rc) => rc.right)) - Math.min(...rects.map((rc) => rc.left))) / k;
    } catch {
      return 0;
    }
  }
}

const views = new WeakMap<EditorView, TabView>();

/** Measure the tabs again (the document's stop spacing changed). */
export function refreshTabStops(view: EditorView): void {
  views.get(view)?.again();
}

export const TabStops = Extension.create<Options>({
  name: "tabStops",

  addOptions() {
    return { every: () => TAB_EVERY, lang: () => "en-US", styleStops: () => null };
  },

  addKeyboardShortcuts() {
    return {
      // In a table Tab moves to the next cell: Ctrl+Tab types a tab there.
      "Ctrl-Tab": () => {
        const { $from } = this.editor.state.selection;
        for (let d = $from.depth; d > 0; d -= 1) {
          const name = $from.node(d).type.name;
          if (name === "tableCell" || name === "tableHeader") return this.editor.chain().command(({ tr, dispatch }) => (dispatch && tr.insertText("\t"), true)).run();
        }
        return false;
      },
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin<TabsState>({
        key: tabStopsKey,
        state: {
          init: (_, state) => ({ set: decorate(state, new Map()), given: new Map() }),
          apply(tr, prev, _old, state) {
            const given = tr.getMeta(tabStopsKey) as Map<number, Given> | undefined;
            if (given) return { set: decorate(state, given), given };
            if (!tr.docChanged) return prev;
            // The widths go with their tabs until they are measured again.
            const carried = new Map<number, Given>();
            for (const [at, g] of prev.given) {
              const mapped = tr.mapping.mapResult(at, 1);
              if (!mapped.deleted) carried.set(mapped.pos, g);
            }
            return { set: decorate(state, carried), given: carried };
          },
        },
        props: {
          decorations: (state) => tabStopsKey.getState(state)?.set ?? null,
        },
        view: (view) => {
          const tv = new TabView(view, opts);
          views.set(view, tv);
          return tv;
        },
      }),
    ];
  },
});

/** The stops a block's named style gives it (none: null). */
export function styleTabStops(node: PmNode, styles: ResolvedStyles | undefined): TabStop[] | null {
  if (!styles) return null;
  const tabs = parseTabs(styles.look(styleIdOf(node, null, styles)).tabs);
  return Array.isArray(tabs) ? tabs : null;
}

/** A caret next to a tab: where the stop is, for the Tabs dialog. */
export function caretParagraph(state: EditorState): { node: PmNode; pos: number } | null {
  const { $from } = state.selection;
  if (!(state.selection instanceof TextSelection) && !state.selection.empty) return null;
  if (!$from.parent.isTextblock || $from.depth < 1) return null;
  return { node: $from.parent, pos: $from.before() };
}
