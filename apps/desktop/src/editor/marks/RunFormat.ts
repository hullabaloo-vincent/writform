/**
 * Formatting a run of text can carry beyond bold and italic: a typeface, a
 * size, a colour, a highlight, and sub- or superscript. Schema level 2.
 *
 * Five separate marks, one property each, so two people changing the colour
 * and the size of the same words at the same moment both win — one mark
 * with five attributes would be last-writer-takes-all.
 *
 * On screen each mark only names its value in a custom property
 * (`--wf-tc: #c00000`); the Document format's stylesheet turns that into
 * colour, size and so on. A format with its own conventions (a manuscript
 * is always its book's type) simply has no such rule, so the marks survive
 * a change of format without being drawn.
 *
 * Values are sanitised where they are read and drawn, never rejected: see
 * ../schema/sanitize.ts.
 */

import { Mark } from "@tiptap/core";

import { fontCssFamily } from "../../fonts/css";
import { isFontId } from "../../fonts/ids";
import { colorAttr, sizeAttr, vscriptAttr } from "../schema/sanitize";

export const FontFamilyMark = Mark.create({
  name: "fontFamily",
  addAttributes() {
    return {
      f: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute("data-ff");
          return v && isFontId(v) ? v : null;
        },
        renderHTML: (attrs: { f?: unknown }) => {
          const css = isFontId(attrs.f) ? fontCssFamily(attrs.f) : null;
          return css ? { "data-ff": attrs.f as string, style: `--wf-ff: ${css}` } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-ff]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

export const FontSizeMark = Mark.create({
  name: "fontSize",
  addAttributes() {
    return {
      pt: {
        default: null,
        parseHTML: (el: HTMLElement) => sizeAttr(Number(el.getAttribute("data-fs"))),
        renderHTML: (attrs: { pt?: unknown }) => {
          const pt = sizeAttr(attrs.pt);
          return pt === null ? {} : { "data-fs": String(pt), style: `--wf-fs: ${pt}pt` };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-fs]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

export const TextColorMark = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      c: {
        default: null,
        parseHTML: (el: HTMLElement) => colorAttr(el.getAttribute("data-tc")),
        renderHTML: (attrs: { c?: unknown }) => {
          const c = colorAttr(attrs.c);
          return c ? { "data-tc": c, style: `--wf-tc: ${c}` } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-tc]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

export const HighlightMark = Mark.create({
  name: "highlight",
  addAttributes() {
    return {
      c: {
        default: null,
        parseHTML: (el: HTMLElement) => colorAttr(el.getAttribute("data-hl")),
        renderHTML: (attrs: { c?: unknown }) => {
          const c = colorAttr(attrs.c);
          return c ? { "data-hl": c, style: `--wf-hl: ${c}` } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-hl]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

export const VScriptMark = Mark.create({
  name: "vscript",
  addAttributes() {
    return {
      v: {
        default: null,
        parseHTML: (el: HTMLElement) => vscriptAttr(el.getAttribute("data-vs")),
        renderHTML: (attrs: { v?: unknown }) => {
          const v = vscriptAttr(attrs.v);
          return v ? { "data-vs": v } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-vs]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", HTMLAttributes, 0];
  },
});

/** The level-2 marks, in the order they nest. */
export const RUN_MARKS = [FontFamilyMark, FontSizeMark, TextColorMark, HighlightMark, VScriptMark];

/** Their names, for code that clears or copies "character formatting". */
export const RUN_MARK_NAMES = ["fontFamily", "fontSize", "textColor", "highlight", "vscript"] as const;
