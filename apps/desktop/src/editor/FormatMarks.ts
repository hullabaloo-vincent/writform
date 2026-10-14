import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { chapterFocus } from "./ChapterFocus";

/**
 * Formatting marks: what is in the text and cannot be seen. A dot for each
 * space, an arrow for a tab, a small ring for a no-break space, a bent
 * arrow where a line is broken by hand, a hook where a word may be
 * hyphenated. (The mark at each paragraph's end is the stylesheet's: see
 * `.wf-show-marks`.)
 *
 * They are drawn, never put in: each is a class on the character itself,
 * and the stylesheet draws the sign over it. Nothing is added to the text,
 * so copying, finding, counting and exporting see what they always did.
 *
 * Only what is on screen is marked. A long book has a hundred thousand
 * spaces, and a mark each would be a hundred thousand things to keep. The
 * paragraphs in view (and a screen either side) are found whenever the
 * page scrolls or the text changes.
 */

interface Marks {
  /** The stretch of the text that is marked (`from >= to`: none). */
  from: number;
  to: number;
  set: DecorationSet;
}

const key = new PluginKey<Marks>("wf-format-marks");
const NONE: Marks = { from: 0, to: 0, set: DecorationSet.empty };
/** More than this in one stretch is not marked until the page says what is in view. */
const MOST = 80_000;

const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const MARKED = new RegExp(`[ \\t${NBSP}${NARROW_NBSP}${SOFT_HYPHEN}]`, "g");
const CLASS: Record<string, string> = { " ": "wf-mk wf-mk-sp", "\t": "wf-mk wf-mk-tab", [NBSP]: "wf-mk wf-mk-nb", [NARROW_NBSP]: "wf-mk wf-mk-nb", [SOFT_HYPHEN]: "wf-mk wf-mk-shy" };

const lineBreak = (): HTMLElement => {
  const el = document.createElement("span");
  el.className = "wf-mk-br";
  el.contentEditable = "false";
  return el;
};

/** The marks for a stretch of the text. */
export function marksFor(doc: PmNode, from: number, to: number): Decoration[] {
  const out: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code) return false;
    if (node.isText) {
      const text = node.text ?? "";
      MARKED.lastIndex = 0;
      for (let m = MARKED.exec(text); m; m = MARKED.exec(text)) {
        const at = pos + m.index;
        if (at >= from && at < to) out.push(Decoration.inline(at, at + 1, { class: CLASS[m[0]] }));
      }
      return false;
    }
    if (node.type.name === "hardBreak" && pos >= from && pos < to) out.push(Decoration.widget(pos, lineBreak, { side: -1, key: "wf-mk-br", ignoreSelection: true }));
    return true;
  });
  return out;
}

const made = (doc: PmNode, from: number, to: number): Marks => {
  const a = Math.max(0, from);
  const b = Math.min(doc.content.size, to);
  return a >= b ? NONE : { from: a, to: b, set: DecorationSet.create(doc, marksFor(doc, a, b)) };
};

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    const overflow = getComputedStyle(up).overflowY;
    if (overflow === "auto" || overflow === "scroll") return up;
  }
  return null;
}

/** The stretch of the text on screen: `seen` exactly, `wide` with a screen
 *  more above and below (what is marked, so that a little scrolling finds
 *  its marks already there). */
function inView(view: EditorView, scroller: HTMLElement | null): { seen: [number, number]; wide: [number, number] } {
  const size = view.state.doc.content.size;
  const kids = view.dom.children;
  // (While one chapter is shown the rest is hidden and has no place on the
  // page: only the chapter's own blocks are looked through.)
  const focus = chapterFocus(view.state);
  const whole: [number, number] = focus ? [focus.from, focus.to] : [0, size];
  if (!kids.length) return { seen: whole, wide: whole };
  let low = 0;
  let high = kids.length - 1;
  if (focus) {
    const index = (pos: number) => Array.prototype.indexOf.call(kids, view.nodeDOM(pos)) as number;
    const a = index(focus.from);
    const b = index(focus.last);
    if (a < 0 || b < a) return { seen: whole, wide: whole };
    low = a;
    high = b;
  }
  const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const range = (top: number, bottom: number): [number, number] => {
    // The first block that ends below `top`, the last that begins above `bottom`.
    let lo = low;
    let hi = high;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom < top) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;
    lo = first;
    hi = high;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (kids[mid].getBoundingClientRect().top > bottom) hi = mid - 1;
      else lo = mid;
    }
    const last = lo;
    try {
      const from = first === low ? whole[0] : Math.max(0, view.posAtDOM(kids[first], 0) - 1);
      const to = last >= high ? whole[1] : Math.min(size, view.posAtDOM(kids[last + 1], 0) - 1);
      return [from, Math.max(from, to)];
    } catch {
      return whole;
    }
  };
  const screen = Math.max(0, box.bottom - box.top);
  return { seen: range(box.top, box.bottom), wide: range(box.top - screen, box.bottom + screen) };
}

/** A way to ask each editor's marks to look again (the switch was turned). */
const again = new WeakMap<EditorView, () => void>();

export const FormatMarks = Extension.create<{ on: () => boolean }>({
  name: "formatMarks",

  addOptions() {
    return { on: () => false };
  },

  addProseMirrorPlugins() {
    const on = this.options.on;
    return [
      new Plugin<Marks>({
        key,
        state: {
          init: () => NONE,
          apply(tr, value) {
            const asked = tr.getMeta(key) as [number, number] | undefined;
            if (asked) return made(tr.doc, asked[0], asked[1]);
            if (!tr.docChanged || value.from >= value.to) return value;
            const from = tr.mapping.map(value.from, -1);
            const to = tr.mapping.map(value.to, 1);
            // While an input method is composing, the marks only move with
            // the text: redrawing the letters it is working on would break
            // the composition off.
            if (tr.getMeta("composition") !== undefined) return { from, to, set: value.set.map(tr.mapping, tr.doc) };
            // (A change that swaps the whole text in: wait to be told what is in view.)
            if (to - from > MOST) return NONE;
            return made(tr.doc, from, to);
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.set,
        },
        view(view) {
          const scroller = scrollerOf(view.dom as HTMLElement);
          let frame = 0;
          let forced = false;
          const look = () => {
            frame = 0;
            if (view.isDestroyed) return;
            const now = key.getState(view.state) ?? NONE;
            if (!on()) {
              if (now.from < now.to) view.dispatch(view.state.tr.setMeta(key, [0, 0]));
              return;
            }
            const { seen, wide } = inView(view, scroller);
            const covered = now.from < now.to && now.from <= seen[0] && now.to >= seen[1];
            if (covered && !forced) return;
            forced = false;
            view.dispatch(view.state.tr.setMeta(key, wide));
          };
          const soon = () => {
            if (!frame) frame = requestAnimationFrame(look);
          };
          again.set(view, () => {
            forced = true;
            soon();
          });
          scroller?.addEventListener("scroll", soon, { passive: true });
          window.addEventListener("resize", soon);
          soon();
          return {
            update: (v, prev) => {
              if (prev.doc !== v.state.doc) soon();
            },
            destroy: () => {
              if (frame) cancelAnimationFrame(frame);
              scroller?.removeEventListener("scroll", soon);
              window.removeEventListener("resize", soon);
              again.delete(view);
            },
          };
        },
      }),
    ];
  },
});

/** The switch was turned: mark, or unmark. */
export function refreshFormatMarks(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return;
  try {
    again.get(editor.view)?.();
  } catch {
    // Not mounted.
  }
}

/** How much of the text is marked now (for tests). */
export function markedStretch(editor: Editor): [number, number] {
  const now = key.getState(editor.state) ?? NONE;
  return [now.from, now.to];
}
