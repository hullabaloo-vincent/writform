/**
 * Paragraph formatting beyond alignment and spacing: indents (left, right,
 * first line or hanging), an exact or minimum line height, keeping a
 * paragraph with the next or in one piece, shading and borders. Schema
 * level 2 — attributes on paragraphs and headings, like TextFormat's, drawn
 * through custom properties so other formats can ignore them.
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  colorAttr,
  encodeBorder,
  encodeSection,
  firstIndentAttr,
  INDENT_MAX,
  indentAttr,
  lineAtAttr,
  lineRuleAttr,
  parseBorder,
  parseSection,
  parseTabs,
  encodeTabs,
  roundPt,
  type Border,
  type LineRule,
  type SectionProps,
} from "../schema/sanitize";
import { nextStyleIsNormal } from "../styles/sheet";

export interface ParaFormatAttrs {
  /** Left and right indents, points. */
  indL: number | null;
  indR: number | null;
  /** First line, points: positive in, negative hanging. */
  indF: number | null;
  /** A line height that isn't a multiple: exactly, or at least, `lineAt`. */
  lineRule: LineRule | null;
  lineAt: number | null;
  keepNext: true | null;
  keepLines: true | null;
  /** Background, `#rrggbb`. */
  shade: string | null;
  /** Borders, encoded (see sanitize.ts). */
  bdr: string | null;
  /** A section starts here, encoded (see `parseSection`). */
  sect: string | null;
  /** The text goes on at the top of the next column from here. */
  colBreak: true | null;
  /** Its own tab stops, encoded (`parseTabs`; level 4). */
  tabs: string | null;
}

export const PARA_FORMAT_KEYS = ["indL", "indR", "indF", "lineRule", "lineAt", "keepNext", "keepLines", "shade", "bdr"] as const;
/** The same, of level 4. */
export const PARA_FORMAT_KEYS_4 = ["tabs"] as const;
/** Where a paragraph falls on the page, not how it looks: not something a
 *  style, the painter or "clear formatting" carries. */
export const PARA_BREAK_KEYS = ["sect", "colBreak"] as const;

/** One step of the indent buttons, points (half an inch). */
export const INDENT_STEP = 36;

const num = (el: HTMLElement, name: string) => {
  const raw = el.getAttribute(name);
  return raw === null ? null : Number(raw);
};

export const ParaFormat = Extension.create({
  name: "paraFormat",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          indL: {
            default: null,
            parseHTML: (el: HTMLElement) => indentAttr(num(el, "data-il")),
            renderHTML: (attrs: { indL?: unknown }) => {
              const v = indentAttr(attrs.indL);
              return v === null ? {} : { "data-il": String(v), style: `--wf-il: ${v}pt` };
            },
          },
          indR: {
            default: null,
            parseHTML: (el: HTMLElement) => indentAttr(num(el, "data-ir")),
            renderHTML: (attrs: { indR?: unknown }) => {
              const v = indentAttr(attrs.indR);
              return v === null ? {} : { "data-ir": String(v), style: `--wf-ir: ${v}pt` };
            },
          },
          indF: {
            default: null,
            parseHTML: (el: HTMLElement) => firstIndentAttr(num(el, "data-if")),
            renderHTML: (attrs: { indF?: unknown }) => {
              const v = firstIndentAttr(attrs.indF);
              return v === null ? {} : { "data-if": String(v), style: `--wf-if: ${v}pt` };
            },
          },
          lineRule: {
            default: null,
            parseHTML: (el: HTMLElement) => lineRuleAttr(el.getAttribute("data-lr")),
            renderHTML: (attrs: { lineRule?: unknown; lineAt?: unknown }) => {
              const rule = lineRuleAttr(attrs.lineRule);
              // A rule without its height says nothing.
              return rule && lineAtAttr(attrs.lineAt) !== null ? { "data-lr": rule } : {};
            },
          },
          lineAt: {
            default: null,
            parseHTML: (el: HTMLElement) => lineAtAttr(num(el, "data-la")),
            renderHTML: (attrs: { lineAt?: unknown }) => {
              const v = lineAtAttr(attrs.lineAt);
              return v === null ? {} : { "data-la": String(v), style: `--wf-la: ${v}pt` };
            },
          },
          keepNext: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-kn") ? true : null),
            renderHTML: (attrs: { keepNext?: unknown }) => (attrs.keepNext === true ? { "data-kn": "1" } : {}),
          },
          keepLines: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-kl") ? true : null),
            renderHTML: (attrs: { keepLines?: unknown }) => (attrs.keepLines === true ? { "data-kl": "1" } : {}),
          },
          shade: {
            default: null,
            parseHTML: (el: HTMLElement) => colorAttr(el.getAttribute("data-shade")),
            renderHTML: (attrs: { shade?: unknown }) => {
              const c = colorAttr(attrs.shade);
              return c ? { "data-shade": c, style: `--wf-shade: ${c}` } : {};
            },
          },
          bdr: {
            default: null,
            parseHTML: (el: HTMLElement) => encodeBorder(parseBorder(el.getAttribute("data-bdr-v"))),
            renderHTML: (attrs: { bdr?: unknown }) => {
              const b = parseBorder(attrs.bdr);
              if (!b) return {};
              return {
                // `data-bdr` is just the sides, for the stylesheet's selectors.
                "data-bdr": b.sides,
                "data-bdr-v": encodeBorder(b)!,
                style: `--wf-bw: ${b.width}pt; --wf-bc: ${b.color}`,
              };
            },
          },
          sect: {
            default: null,
            // A new paragraph after this one is in the section, not a new one.
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => encodeSection(parseSection(el.getAttribute("data-sect"))),
            renderHTML: (attrs: { sect?: unknown }) => {
              const v = encodeSection(parseSection(attrs.sect));
              return v ? { "data-sect": v, "data-break": "section" } : {};
            },
          },
          tabs: {
            default: null,
            parseHTML: (el: HTMLElement) => encodeTabs(parseTabs(el.getAttribute("data-tabs"))),
            renderHTML: (attrs: { tabs?: unknown }) => {
              const v = encodeTabs(parseTabs(attrs.tabs));
              return v ? { "data-tabs": v } : {};
            },
          },
          colBreak: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => (el.getAttribute("data-col-break") ? true : null),
            renderHTML: (attrs: { colBreak?: unknown; sect?: unknown }) =>
              attrs.colBreak === true ? { "data-col-break": "1", ...(parseSection(attrs.sect) ? {} : { "data-break": "column" }) } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    // Neighbours with the same border are one box (no rule between them,
    // no gap), as in Word and in the page layout (doclayout/model.ts).
    const key = new PluginKey<DecorationSet>("wf-joined-borders");
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => joinedBorders(state.doc),
          apply: (tr, old) => (tr.docChanged ? joinedBorders(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { $from, $to, empty } = this.editor.state.selection;
        const block = $from.parent;
        // Splitting a paragraph in two copies its attributes to both halves
        // (only a split at its END leaves the ones marked not to be kept).
        // What says where a paragraph falls — a page, column or section
        // break — a drop cap and a chapter's own art belong to the first
        // half alone.
        const once = ["pageBreakBefore", "sect", "colBreak", "dropCap", "art", "artFacing"].filter((k) => block.attrs[k]);
        if (once.length && isPara(block) && $from.depth === 1 && $from.sameParent($to) && $to.parentOffset < block.content.size) {
          return this.editor
            .chain()
            .splitBlock()
            .command(({ tr, dispatch }) => {
              const at = tr.selection.$from;
              const cleared: Record<string, unknown> = { ...at.parent.attrs };
              for (const k of once) cleared[k] = null;
              if (dispatch) tr.setNodeMarkup(at.before(), undefined, cleared);
              return true;
            })
            .run();
        }
        // After a title, a subtitle or a caption comes body text.
        if (!empty || block.type.name !== "paragraph" || !nextStyleIsNormal(block.attrs.element as string | null)) return false;
        if ($from.parentOffset !== block.content.size || $from.depth !== 1) return false;
        return this.editor
          .chain()
          .splitBlock()
          .command(({ tr, dispatch }) => {
            const at = tr.selection.$from;
            if (dispatch) tr.setNodeMarkup(at.before(), undefined, { ...at.parent.attrs, element: null });
            return true;
          })
          .run();
      },
      // Backspace at the start of an indented paragraph takes the indent
      // off first (its first line, then a step of the left edge), as in Word.
      Backspace: () => {
        const { $from, empty } = this.editor.state.selection;
        const block = $from.parent;
        if (!empty || $from.parentOffset !== 0) return false;
        if (block.type.name !== "paragraph" && block.type.name !== "heading") return false;
        if (firstIndentAttr(block.attrs.indF)) return setBlockAttrs(this.editor, { indF: null });
        if (indentAttr(block.attrs.indL)) return stepIndent(this.editor, -1);
        return false;
      },
    };
  },
});

const isPara = (node: PmNode) => node.type.name === "paragraph" || node.type.name === "heading";
const BOX_KEYS = ["bdr", "shade", "indL", "indR"] as const;

function joinedBorders(doc: PmNode): DecorationSet {
  const decos: Decoration[] = [];
  const visit = (parent: PmNode, start: number) => {
    let prev: { node: PmNode; pos: number } | null = null;
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (isPara(child) && parseBorder(child.attrs.bdr)) {
        if (prev && !child.attrs.pageBreakBefore && BOX_KEYS.every((k) => prev!.node.attrs[k] === child.attrs[k])) {
          decos.push(
            Decoration.node(prev.pos, prev.pos + prev.node.nodeSize, { class: "wf-join-next" }),
            Decoration.node(pos, pos + child.nodeSize, { class: "wf-join-prev" }),
          );
        }
        prev = { node: child, pos };
        return;
      }
      prev = null;
      if (!child.isTextblock && !child.isLeaf) visit(child, pos + 1);
    });
  };
  visit(doc, 0);
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

/**
 * Set attributes on every paragraph and heading the selection touches. One
 * transaction (one undo step); only the keys in `patch` are compared, so
 * this serves any block attribute.
 */
export function setBlockAttrs(editor: Editor, patch: Record<string, unknown>, focus = true): boolean {
  const keys = Object.keys(patch);
  const chain = focus ? editor.chain().focus() : editor.chain();
  return chain
    .command(({ tr, state, dispatch }) => {
      let changed = false;
      for (const range of state.selection.ranges) {
        state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
          // A node only takes the attributes its type has.
          const own = keys.filter((k) => k in node.attrs);
          if (own.every((k) => node.attrs[k] === patch[k])) return;
          const next: Record<string, unknown> = { ...node.attrs };
          for (const k of own) next[k] = patch[k];
          if (dispatch) tr.setNodeMarkup(pos, undefined, next);
          changed = true;
        });
      }
      return changed;
    })
    .run();
}

/** The paragraph formatting at the selection (its first paragraph's). */
export function curParaFormat(editor: Editor): ParaFormatAttrs {
  const p = editor.getAttributes("paragraph");
  const h = editor.getAttributes("heading");
  const pick = (k: string) => p[k] ?? h[k] ?? null;
  return {
    indL: indentAttr(pick("indL")),
    indR: indentAttr(pick("indR")),
    indF: firstIndentAttr(pick("indF")),
    lineRule: lineRuleAttr(pick("lineRule")),
    lineAt: lineAtAttr(pick("lineAt")),
    keepNext: pick("keepNext") === true ? true : null,
    keepLines: pick("keepLines") === true ? true : null,
    shade: colorAttr(pick("shade")),
    bdr: encodeBorder(parseBorder(pick("bdr"))),
    sect: encodeSection(parseSection(pick("sect"))),
    colBreak: pick("colBreak") === true ? true : null,
    tabs: encodeTabs(parseTabs(pick("tabs"))),
  };
}

/** The block the caret is in (the first of a selection). */
function caretBlock(editor: Editor): { node: PmNode; pos: number } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    const node = $from.node(d);
    if (isPara(node)) return { node, pos: $from.before(d) };
  }
  return null;
}

/**
 * The section the caret is in: the nearest paragraph at or before it, at
 * the top level, that starts one — or null in the document's first section
 * (which is the document's own page setup).
 */
export function sectionAt(editor: Editor): { pos: number; props: SectionProps } | null {
  const { doc, selection } = editor.state;
  const index = selection.$from.index(0);
  let found: { pos: number; props: SectionProps } | null = null;
  doc.forEach((node, pos, i) => {
    if (i > index) return;
    const props = isPara(node) ? parseSection(node.attrs.sect) : null;
    if (props) found = { pos, props };
  });
  return found;
}

/** Start a section at the paragraph the caret is in (or change the one that
 *  starts there); null takes the section break away. Top-level paragraphs
 *  only: a section can't begin inside a list or a table. */
export function setSection(editor: Editor, props: SectionProps | null, at?: number): boolean {
  const { state } = editor;
  const pos = at ?? (state.selection.$from.depth >= 1 ? state.selection.$from.before(1) : -1);
  const node = pos >= 0 ? state.doc.nodeAt(pos) : null;
  if (!node || !isPara(node)) return false;
  editor.view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, sect: encodeSection(props) }));
  editor.view.focus();
  return true;
}

/** Send the paragraph the caret is in to the top of the next column (or,
 *  again, take the column break away). */
export function toggleColumnBreak(editor: Editor): boolean {
  const block = caretBlock(editor);
  if (!block) return false;
  return setBlockAttrs(editor, { colBreak: block.node.attrs.colBreak === true ? null : true });
}

/**
 * Move the selected paragraphs' left edge in or out by one step. Each
 * paragraph moves from where it is, so a staggered selection stays
 * staggered.
 */
export function stepIndent(editor: Editor, dir: 1 | -1): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      let changed = false;
      for (const range of state.selection.ranges) {
        state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
          const cur = indentAttr(node.attrs.indL) ?? 0;
          // Out from between steps lands on the step below, as in Word.
          const stepped = dir > 0 ? Math.floor(cur / INDENT_STEP + 1) * INDENT_STEP : Math.ceil(cur / INDENT_STEP - 1) * INDENT_STEP;
          const next = Math.max(0, Math.min(INDENT_MAX, roundPt(stepped)));
          if (next === cur) return;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indL: next || null });
          changed = true;
        });
      }
      return changed;
    })
    .run();
}

export function setShade(editor: Editor, color: string | null): boolean {
  return setBlockAttrs(editor, { shade: color ? colorAttr(color) : null });
}

export function setBorder(editor: Editor, border: Border | null): boolean {
  return setBlockAttrs(editor, { bdr: encodeBorder(border) });
}

/** Line spacing as a multiple (clearing any exact height), or as an exact /
 *  minimum height in points. */
export function setLineHeight(editor: Editor, value: { multiple: number | null } | { rule: LineRule; at: number }): boolean {
  if ("rule" in value) {
    const at = lineAtAttr(value.at);
    if (at === null) return false;
    return setBlockAttrs(editor, { lineRule: value.rule, lineAt: at });
  }
  return setBlockAttrs(editor, { line: value.multiple, lineRule: null, lineAt: null });
}
