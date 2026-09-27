import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

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

export const DOC_FONTS = [
  { id: "times", label: "Times", css: "'Times New Roman', Times, serif" },
  {
    id: "palatino",
    label: "Palatino",
    css: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
  },
  { id: "sans", label: "Sans", css: "-apple-system, 'Segoe UI', Arial, sans-serif" },
  { id: "mono", label: "Typewriter", css: "'Courier Prime', 'Courier New', Courier, monospace" },
  {
    id: "comic",
    label: "Comic Sans",
    css: "'Comic Sans MS', 'Comic Sans', 'Chalkboard SE', 'Comic Neue', cursive",
  },
] as const;

export const DOC_FONT_SIZES = [10, 11, 12, 14, 16, 18, 24] as const;

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

const FONT_IDS = new Set<string>(DOC_FONTS.map((f) => f.id));
const SIZES = new Set<number>(DOC_FONT_SIZES);
const LINES = new Set<number>(DOC_LINE_SPACINGS);
const SPACES = new Set<number>(DOC_PARA_SPACES);
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

interface TextFormatOptions {
  /** Bind ⌘⇧L/E/R/J + ⌘↩. Off for previews and non-Plain formats. */
  shortcuts: boolean;
}

export const TextFormat = Extension.create<TextFormatOptions>({
  name: "textFormat",

  addOptions() {
    return { shortcuts: false };
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
              return v && FONT_IDS.has(v) ? v : null;
            },
            renderHTML: (attrs: { font?: string | null }) =>
              attrs.font ? { "data-font": attrs.font } : {},
          },
          size: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = Number(el.getAttribute("data-size"));
              return SIZES.has(v) ? v : null;
            },
            renderHTML: (attrs: { size?: number | null }) =>
              attrs.size ? { "data-size": String(attrs.size) } : {},
          },
          line: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = Number(el.getAttribute("data-line"));
              return LINES.has(v) ? v : null;
            },
            renderHTML: (attrs: { line?: number | null }) =>
              attrs.line ? { "data-line": String(attrs.line) } : {},
          },
          sa: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute("data-sa");
              if (raw === null) return null;
              const v = Number(raw);
              return SPACES.has(v) ? v : null;
            },
            renderHTML: (attrs: { sa?: number | null }) =>
              attrs.sa === null || attrs.sa === undefined ? {} : { "data-sa": String(attrs.sa) },
          },
          sb: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute("data-sb");
              if (raw === null) return null;
              const v = Number(raw);
              return SPACES.has(v) ? v : null;
            },
            renderHTML: (attrs: { sb?: number | null }) =>
              attrs.sb === null || attrs.sb === undefined ? {} : { "data-sb": String(attrs.sb) },
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
    if (!this.options.shortcuts) return map;
    map["Mod-Shift-l"] = () => setTypography(this.editor, { align: null });
    map["Mod-Shift-e"] = () => setTypography(this.editor, { align: "center" });
    map["Mod-Shift-r"] = () => setTypography(this.editor, { align: "right" });
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
  return setTypography(editor, { font: font && FONT_IDS.has(font) ? font : null });
}

export function setDocFontSize(editor: Editor, size: number | null): boolean {
  return setTypography(editor, { size: size !== null && SIZES.has(size) ? size : null });
}

export function setDocLineSpacing(editor: Editor, line: number | null): boolean {
  return setTypography(editor, { line: line !== null && LINES.has(line) ? line : null });
}

export function setDocSpaceAbove(editor: Editor, sa: number | null): boolean {
  return setTypography(editor, { sa: sa !== null && SPACES.has(sa) ? sa : null });
}

export function setDocSpaceBelow(editor: Editor, sb: number | null): boolean {
  return setTypography(editor, { sb: sb !== null && SPACES.has(sb) ? sb : null });
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

/** Word's ⌘↩: split the paragraph and start the new one on a fresh page. */
export function insertPageBreak(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .splitBlock()
    .command(({ tr, dispatch }) => {
      const { $from } = tr.selection;
      const node = $from.parent;
      if (node.type.name !== "paragraph" && node.type.name !== "heading") return false;
      if (dispatch) {
        tr.setNodeMarkup($from.before(), undefined, {
          ...node.attrs,
          pageBreakBefore: true,
        });
      }
      return true;
    })
    .run();
}
