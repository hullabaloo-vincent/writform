import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

import { fontCssFamily } from "../fonts/css";
import { isFontId } from "../fonts/ids";
import { MENU_FONTS } from "../fonts/registry";
import { lineCss } from "./styles/sheet";

/**
 * Paragraph-level typography: alignment, font family, font size, and an
 * explicit page break — all as node ATTRIBUTES on paragraphs/headings
 * (rendered as `data-*`, styled by CSS), never as text marks or new node
 * types. That's a data-safety decision: the Yjs binding deletes text
 * carrying marks an older client's schema doesn't know, and deletes unknown
 * node types outright, while unknown attributes merely drop. Like
 * DocElement, switching a document's format never invalidates content —
 * format CSS simply outranks these attributes where it has opinions.
 */

/** The document font menu (the app's own fonts; see fonts/registry.ts). */
export const DOC_FONTS = MENU_FONTS.map((f) => ({ id: f.id, label: f.menu ?? f.name, css: f.css }));

/** The sizes the menus offer. Any size in range is valid (a Word file's
 *  13 pt stays 13 pt); these are just the ones worth a click. */
export const DOC_FONT_SIZES = [10, 11, 12, 14, 16, 18, 24] as const;
export const FONT_SIZE_MIN = 4;
export const FONT_SIZE_MAX = 200;
/** Word's own ladder, for "grow" and "shrink". */
export const SIZE_LADDER = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72] as const;

/** Word-processor line-spacing multiples (data-line values; CSS maps each to
 *  a visually equivalent line-height, exports map to real spacing). */
export const DOC_LINE_SPACINGS = [1, 1.15, 1.3, 1.5, 2] as const;

/** Space before/after a paragraph, in points. 0 is meaningful ("no space
 *  after this one"); null falls back to the document default. */
export const DOC_PARA_SPACES = [0, 4, 8, 12, 16, 24, 36] as const;

export type DocAlign = "center" | "right" | "justify";

export interface Typography {
  /** null = left (the format's default). */
  align: DocAlign | null;
  /** null = the format's own typeface. */
  font: string | null;
  /** Point size; null = the format's own size. */
  size: number | null;
  /** Line-spacing multiple; null = the format's own leading. */
  line: number | null;
  /** Space above the paragraph in points; null = format default. */
  sa: number | null;
  /** Space below the paragraph in points; null = format default. */
  sb: number | null;
  /** Oversized first letter set into the opening lines (book chapters). */
  dropCap: true | null;
  /** Word's Ctrl+Enter semantics: the break belongs before this block. */
  pageBreakBefore: true | null;
}

/** The fonts the stylesheet has a `[data-font]` rule for. Any other font id
 *  (a book face, a catalog or system font) renders its own stack. */
const STYLED_FONT_IDS = new Set<string>(DOC_FONTS.map((f) => f.id));
const within = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
/** Values are numbers within sane bounds; the menus' lists are a subset. */
export const isFontSize = (v: unknown): v is number => within(v, FONT_SIZE_MIN, FONT_SIZE_MAX);
export const isLineSpacing = (v: unknown): v is number => within(v, 0.5, 5);
export const isParaSpace = (v: unknown): v is number => within(v, 0, 200);
const ALIGNS = new Set(["center", "right", "justify"]);
const TYPO_KEYS = [
  "align",
  "font",
  "size",
  "line",
  "sa",
  "sb",
  "dropCap",
  "pageBreakBefore",
] as const;

export interface TextFormatOptions {
  /** Bind ⌘⇧L/E/R/J + ⌘↩. Off for previews and the scripted formats. */
  shortcuts: boolean;
  /** Bind just ⌘⇧L/E/R (left/center/right) — Manuscript, where alignment
   *  is meaning (a centered sign, a right-set sign-off) but justification
   *  belongs to the book design. (Its ⌘↩ page break is the format keymap's,
   *  which knows what the line after the break should be.) */
  alignShortcuts: boolean;
}

export const TextFormat = Extension.create<TextFormatOptions>({
  name: "textFormat",

  addOptions() {
    return { shortcuts: false, alignShortcuts: false };
  },

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          align: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute("data-align") ?? el.style.textAlign;
              return v && ALIGNS.has(v) ? v : null;
            },
            renderHTML: (attrs: { align?: string | null }) =>
              attrs.align ? { "data-align": attrs.align } : {},
          },
          font: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute("data-font");
              return v && isFontId(v) ? v : null;
            },
            renderHTML: (attrs: { font?: string | null }) => {
              if (!attrs.font) return {};
              const css = STYLED_FONT_IDS.has(attrs.font) ? null : fontCssFamily(attrs.font);
              return css ? { "data-font": attrs.font, style: `font-family: ${css}` } : { "data-font": attrs.font };
            },
          },
          size: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = Number(el.getAttribute("data-size"));
              return isFontSize(v) ? v : null;
            },
            renderHTML: (attrs: { size?: number | null }) =>
              isFontSize(attrs.size) ? { "data-size": String(attrs.size), style: `--wf-sz: ${attrs.size}pt` } : {},
          },
          line: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = Number(el.getAttribute("data-line"));
              return isLineSpacing(v) ? v : null;
            },
            renderHTML: (attrs: { line?: number | null }) =>
              isLineSpacing(attrs.line) ? { "data-line": String(attrs.line), style: `--wf-lh: ${lineCss(attrs.line)}` } : {},
          },
          sa: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute("data-sa");
              if (raw === null) return null;
              const v = Number(raw);
              return isParaSpace(v) ? v : null;
            },
            renderHTML: (attrs: { sa?: number | null }) =>
              isParaSpace(attrs.sa) ? { "data-sa": String(attrs.sa), style: `--wf-sa: ${attrs.sa}pt` } : {},
          },
          sb: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute("data-sb");
              if (raw === null) return null;
              const v = Number(raw);
              return isParaSpace(v) ? v : null;
            },
            renderHTML: (attrs: { sb?: number | null }) =>
              isParaSpace(attrs.sb) ? { "data-sb": String(attrs.sb), style: `--wf-sb: ${attrs.sb}pt` } : {},
          },
          dropCap: {
            default: null,
            // The continuation paragraph after Enter must not sprout its own
            // giant initial.
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-dropcap") ? true : null),
            renderHTML: (attrs: { dropCap?: true | null }) =>
              attrs.dropCap ? { "data-dropcap": "1" } : {},
          },
          pageBreakBefore: {
            default: null,
            // Enter at the end of a broken-before block must not clone the
            // break onto the continuation paragraph.
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-page-break") ? true : null),
            renderHTML: (attrs: { pageBreakBefore?: true | null }) =>
              attrs.pageBreakBefore ? { "data-page-break": "1" } : {},
          },
        },
      },
    ];
  },

  addKeyboardShortcuts() {
    const map: Record<string, () => boolean> = {};
    if (!this.options.shortcuts && !this.options.alignShortcuts) return map;
    map["Mod-Shift-l"] = () => setTypography(this.editor, { align: null });
    map["Mod-Shift-e"] = () => setTypography(this.editor, { align: "center" });
    map["Mod-Shift-r"] = () => setTypography(this.editor, { align: "right" });
    if (!this.options.shortcuts) return map;
    map["Mod-Shift-j"] = () => setTypography(this.editor, { align: "justify" });
    map["Mod-Enter"] = () => insertPageBreak(this.editor);
    return map;
  },
});

/** Apply a typography patch to every paragraph/heading in the selection.
 *  One transaction, so a multi-paragraph change is one undo step. */
export function setTypography(editor: Editor, patch: Partial<Typography>): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      let changed = false;
      for (const range of state.selection.ranges) {
        state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
          const next = { ...node.attrs, ...patch };
          if (TYPO_KEYS.every((k) => node.attrs[k] === next[k])) return;
          if (dispatch) tr.setNodeMarkup(pos, undefined, next);
          changed = true;
        });
      }
      return changed;
    })
    .run();
}

export function setDocAlign(editor: Editor, align: DocAlign | "left"): boolean {
  return setTypography(editor, { align: align === "left" ? null : align });
}

export function setDocFont(editor: Editor, font: string | null): boolean {
  return setTypography(editor, { font: font && isFontId(font) ? font : null });
}

export function setDocFontSize(editor: Editor, size: number | null): boolean {
  return setTypography(editor, { size: isFontSize(size) ? size : null });
}

export function setDocLineSpacing(editor: Editor, line: number | null): boolean {
  return setTypography(editor, { line: isLineSpacing(line) ? line : null });
}

export function setDocSpaceAbove(editor: Editor, sa: number | null): boolean {
  return setTypography(editor, { sa: isParaSpace(sa) ? sa : null });
}

export function setDocSpaceBelow(editor: Editor, sb: number | null): boolean {
  return setTypography(editor, { sb: isParaSpace(sb) ? sb : null });
}

export function toggleDropCap(editor: Editor): boolean {
  const cur = curTypography(editor).dropCap;
  return setTypography(editor, { dropCap: cur ? null : true });
}

/** The selection's typography, for toolbar active states. */
export function curTypography(editor: Editor): Typography {
  const p = editor.getAttributes("paragraph");
  const h = editor.getAttributes("heading");
  const pick = <K extends keyof Typography>(k: K): Typography[K] =>
    ((p[k] ?? h[k]) as Typography[K] | undefined) ?? (null as Typography[K]);
  return {
    align: pick("align"),
    font: pick("font"),
    size: pick("size"),
    line: pick("line"),
    sa: pick("sa"),
    sb: pick("sb"),
    dropCap: pick("dropCap"),
    pageBreakBefore: pick("pageBreakBefore"),
  };
}

export function togglePageBreakBefore(editor: Editor): boolean {
  const cur = curTypography(editor).pageBreakBefore;
  return setTypography(editor, { pageBreakBefore: cur ? null : true });
}

/**
 * Word's ⌘↩: what follows the cursor starts on a new page. At the start of
 * a paragraph (or on an empty one) that's the paragraph itself, and no
 * empty line is left behind on the page before. Anywhere else the paragraph
 * splits there; `element` sets the new half's element (a manuscript's next
 * line) and a line break just before the cursor goes with the split.
 */
export function insertPageBreak(editor: Editor, element?: string | null): boolean {
  const { $from, empty } = editor.state.selection;
  const block = $from.parent;
  if (block.type.name !== "paragraph" && block.type.name !== "heading") return false;
  if (empty && $from.parentOffset === 0) {
    return editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        if (dispatch && !block.attrs.pageBreakBefore) {
          tr.setNodeMarkup($from.before(), undefined, { ...block.attrs, pageBreakBefore: true });
        }
        return true;
      })
      .run();
  }
  const lineBreakBefore = empty && $from.nodeBefore?.type.name === "hardBreak";
  return editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch && lineBreakBefore) tr.delete($from.pos - 1, $from.pos);
      return true;
    })
    .splitBlock()
    .command(({ tr, dispatch }) => {
      const { $from } = tr.selection;
      const node = $from.parent;
      if (node.type.name !== "paragraph" && node.type.name !== "heading") return false;
      if (dispatch) {
        tr.setNodeMarkup($from.before(), undefined, {
          ...node.attrs,
          pageBreakBefore: true,
          ...(element !== undefined && node.type.name === "paragraph" ? { element } : {}),
        });
      }
      return true;
    })
    .run();
}
