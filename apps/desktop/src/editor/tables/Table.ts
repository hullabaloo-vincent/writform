/**
 * Tables. Schema level 2.
 *
 * Built on prosemirror-tables (cell selection, keyboard movement, pasting
 * a block of cells, keeping the grid rectangular) with this document's own
 * vocabulary, which differs from the library's defaults in two ways that
 * matter for a shared document:
 *
 *  - Column widths are ONE string on the table (`cols`: points, space
 *    separated), not an array on every cell. The Yjs binding compares
 *    attribute values with `!==`, so an array would be rewritten on every
 *    keystroke; and one attribute means two people dragging two columns
 *    don't leave the cells of a column disagreeing about its width.
 *  - A header row is a property of the table (`head`), not a second kind of
 *    cell — one node type fewer for every reader of the document to know.
 *
 * `colspan` and `rowspan` default to 1 (the library does arithmetic on
 * them), the one exception to "new attributes default to null".
 *
 * Schema level 4 adds a row's least height (`h`, points) and keeping it
 * whole (`keep`), where a cell's words sit (`va`), and where a table
 * narrower than the text sits (`align`, or `ind` in from the left).
 */

import { callOrReturn, getExtensionField, mergeAttributes, Node, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  mergeCells,
  selectedRect,
  setCellAttr,
  splitCell,
  tableEditing,
  TableMap,
} from "@tiptap/pm/tables";

import { showRev } from "../review/TrackMarks";
import { scaleOf } from "../ui/scale";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  CELL_SIDES,
  cellEdges,
  cellVAlign,
  COL_MAX,
  COL_MIN,
  colorAttr,
  encodeCellEdges,
  encodeCols,
  linesAttr,
  parseCols,
  roundPt,
  rowHeight,
  rowKeep,
  TABLE_LINES,
  tableAlign,
  tableIndent,
  toHexColor,
  type CellEdges,
  type CellVAlign,
  type TableAlign,
  type TableLines,
} from "../schema/sanitize";

declare module "@tiptap/core" {
  interface NodeConfig<Options, Storage> {
    /** prosemirror-tables' name for what a node is in a table. */
    tableRole?: string | ((this: { name: string; options: Options; storage: Storage }) => string);
  }
}

// (How a table's lines and column widths are read lives with the other
// readers, where the page layout — which runs in a worker — can reach it.)
export { COL_MAX, COL_MIN, encodeCols, linesAttr, parseCols, TABLE_LINES, type TableLines };

const span = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
};

/** How many columns a table has (its widest row). */
export function columnCount(table: PmNode): number {
  let count = 0;
  table.forEach((row) => {
    let n = 0;
    row.forEach((cell) => {
      n += span(cell.attrs.colspan);
    });
    count = Math.max(count, n);
  });
  return count;
}

export const TableRow = Node.create({
  name: "tableRow",
  content: "tableCell*",
  tableRole: "row",
  addAttributes() {
    return {
      // As tall as its tallest cell needs, and at least this (points).
      h: {
        default: null,
        parseHTML: (el: HTMLElement) => rowHeight(Number(el.getAttribute("data-h"))),
        renderHTML: (attrs: { h?: unknown }) => {
          const h = rowHeight(attrs.h);
          return h ? { "data-h": String(h), style: `height: ${h}pt` } : {};
        },
      },
      // Goes to the next page whole rather than being cut.
      keep: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-keep") ? true : null),
        renderHTML: (attrs: { keep?: unknown }) => (rowKeep(attrs.keep) ? { "data-keep": "1" } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "tr" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["tr", HTMLAttributes, 0];
  },
});

export const TableCell = Node.create({
  name: "tableCell",
  content: "block+",
  tableRole: "cell",
  isolating: true,

  addAttributes() {
    return {
      colspan: {
        default: 1,
        parseHTML: (el: HTMLElement) => span(el.getAttribute("colspan")),
        renderHTML: (attrs: { colspan?: unknown }) => (span(attrs.colspan) > 1 ? { colspan: String(span(attrs.colspan)) } : {}),
      },
      rowspan: {
        default: 1,
        parseHTML: (el: HTMLElement) => span(el.getAttribute("rowspan")),
        renderHTML: (attrs: { rowspan?: unknown }) => (span(attrs.rowspan) > 1 ? { rowspan: String(span(attrs.rowspan)) } : {}),
      },
      bg: {
        default: null,
        parseHTML: (el: HTMLElement) => colorAttr(el.getAttribute("data-bg")) ?? toHexColor(el.style.backgroundColor || el.getAttribute("bgcolor")),
        renderHTML: (attrs: { bg?: unknown }) => {
          const c = colorAttr(attrs.bg);
          return c ? { "data-bg": c, style: `background-color: ${c}` } : {};
        },
      },
      // Where its words sit when the row is taller than they are (level 4).
      va: {
        default: null,
        parseHTML: (el: HTMLElement) => cellVAlign(el.getAttribute("data-va")),
        renderHTML: (attrs: { va?: unknown }) => {
          const va = cellVAlign(attrs.va);
          return va ? { "data-va": va } : {};
        },
      },
      // Lines of the cell's own (schema level 3): what Word draws with cell
      // borders, as a rule down the side of a column.
      bdr: {
        default: null,
        parseHTML: (el: HTMLElement) => encodeCellEdges(cellEdges(el.getAttribute("data-bdr"))),
        renderHTML: (attrs: { bdr?: unknown }) => {
          const edges = cellEdges(attrs.bdr);
          return edges ? { "data-bdr": encodeCellEdges(edges) as string, style: edgesCss(edges) } : {};
        },
      },
    };
  },

  parseHTML() {
    // A pasted header cell is a cell (its table says it has a header row).
    return [{ tag: "td" }, { tag: "th" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["td", HTMLAttributes, 0];
  },
});

/** A cell's own lines as CSS (each side it says something of). */
function edgesCss(edges: CellEdges): string {
  const names = { t: "top", r: "right", b: "bottom", l: "left" } as const;
  return CELL_SIDES.filter((side) => edges[side])
    .map((side) => (edges[side]!.w > 0 ? `border-${names[side]}: ${edges[side]!.w}pt solid ${edges[side]!.color}` : `border-${names[side]}: 0`))
    .join("; ");
}

/**
 * A table's columns as shares of its width. Its width is its columns' own,
 * but never more than there is room for: on a sheet narrower than the paper
 * (a small window, a phone) the columns keep their proportions and the
 * table fits, where widths in points would run it off the side.
 */
const shares = (widths: number[]): string[] => {
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  return widths.map((w) => `${Math.round((w / total) * 100000) / 1000}%`);
};
const widthCss = (widths: number[]): string => `min(100%, ${roundPt(widths.reduce((a, b) => a + b, 0))}pt)`;

const colElements = (table: PmNode): [string, Record<string, string>][] => {
  const count = columnCount(table);
  const widths = parseCols(table.attrs.cols, count);
  const parts = widths ? shares(widths) : null;
  return Array.from({ length: count }, (_, i): [string, Record<string, string>] => ["col", parts ? { style: `width: ${parts[i]}` } : {}]);
};

/** Where the table sits: its own width (or the text's, shared out) and,
 *  narrower than the text, at the left, in the middle or at the right. */
const placeCss = (table: PmNode): { width: string; marginLeft: string; marginRight: string } => {
  const widths = parseCols(table.attrs.cols, columnCount(table));
  const align = tableAlign(table.attrs.align);
  const ind = align ? null : tableIndent(table.attrs.ind);
  const own = widths ? roundPt(widths.reduce((a, b) => a + b, 0)) : null;
  return {
    width: ind ? (own ? `min(100% - ${ind}pt, ${own}pt)` : `calc(100% - ${ind}pt)`) : own ? widthCss(widths!) : "",
    marginLeft: ind ? `${ind}pt` : align ? "auto" : "",
    marginRight: align === "center" ? "auto" : "",
  };
};

const tableStyle = (table: PmNode): string | null => {
  const place = placeCss(table);
  const parts = [place.width && `width: ${place.width}`, place.marginLeft && `margin-left: ${place.marginLeft}`, place.marginRight && `margin-right: ${place.marginRight}`].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
};

export const Table = Node.create({
  name: "table",
  group: "block",
  content: "tableRow+",
  tableRole: "table",
  isolating: true,
  // Its keys (Tab between cells) come before a format's own Tab.
  priority: 200,

  addAttributes() {
    return {
      cols: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute("data-cols");
          return raw && /^[\d. ]+$/.test(raw) ? raw.trim() : null;
        },
        renderHTML: (attrs: { cols?: unknown }) => (typeof attrs.cols === "string" && attrs.cols ? { "data-cols": attrs.cols } : {}),
      },
      head: {
        default: null,
        // A pasted table whose first row is all header cells has one.
        parseHTML: (el: HTMLElement) => {
          if (el.getAttribute("data-head")) return true;
          const first = el.querySelector("tr");
          return first && first.children.length > 0 && [...first.children].every((c) => c.tagName === "TH") ? true : null;
        },
        renderHTML: (attrs: { head?: unknown }) => (attrs.head === true ? { "data-head": "1" } : {}),
      },
      lines: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute("data-lines");
          return v && v !== "all" && (TABLE_LINES as readonly string[]).includes(v) ? v : null;
        },
        renderHTML: (attrs: { lines?: unknown }) => (linesAttr(attrs.lines) !== "all" ? { "data-lines": linesAttr(attrs.lines) } : {}),
      },
      // Where it sits when narrower than the text (level 4).
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => tableAlign(el.getAttribute("data-align")),
        renderHTML: (attrs: { align?: unknown }) => {
          const align = tableAlign(attrs.align);
          return align ? { "data-align": align } : {};
        },
      },
      ind: {
        default: null,
        parseHTML: (el: HTMLElement) => tableIndent(Number(el.getAttribute("data-ind"))),
        renderHTML: (attrs: { ind?: unknown }) => {
          const ind = tableIndent(attrs.ind);
          return ind ? { "data-ind": String(ind) } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "table" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const style = tableStyle(node);
    return [
      "div",
      { class: "wf-table-wrap" },
      ["table", mergeAttributes(HTMLAttributes, style ? { style } : {}), ["colgroup", ...colElements(node)], ["tbody", 0]],
    ];
  },

  // Every node's spec gets its `tableRole`, which is how the table library
  // finds what's what.
  extendNodeSchema(extension) {
    const context = { name: extension.name, options: extension.options, storage: extension.storage };
    return { tableRole: callOrReturn(getExtensionField(extension, "tableRole", context)) };
  },

  addNodeView() {
    return ({ node, getPos, editor, HTMLAttributes }) => {
      const dom = document.createElement("div");
      dom.className = "wf-table-wrap";
      const table = document.createElement("table");
      const colgroup = document.createElement("colgroup");
      const body = document.createElement("tbody");
      table.append(colgroup, body);
      dom.append(table);
      let current = node;

      const show = (n: PmNode) => {
        for (const name of [...table.getAttributeNames()]) if (name.startsWith("data-")) table.removeAttribute(name);
        for (const [key, value] of Object.entries(HTMLAttributes)) if (typeof value === "string") table.setAttribute(key, value);
        // Whether it is a suggestion shows on the frame, and follows the
        // node (the attributes above are as it was first drawn).
        for (const key of ["data-rev", "data-rev-v", "data-c", "title"]) table.removeAttribute(key);
        showRev(dom, n.attrs.tc);
        if (typeof n.attrs.cols === "string" && n.attrs.cols) table.setAttribute("data-cols", n.attrs.cols);
        if (n.attrs.head === true) table.setAttribute("data-head", "1");
        if (linesAttr(n.attrs.lines) !== "all") table.setAttribute("data-lines", linesAttr(n.attrs.lines));
        const align = tableAlign(n.attrs.align);
        if (align) table.setAttribute("data-align", align);
        const ind = tableIndent(n.attrs.ind);
        if (ind) table.setAttribute("data-ind", String(ind));
        const count = columnCount(n);
        const widths = parseCols(n.attrs.cols, count);
        const parts = widths ? shares(widths) : null;
        const place = placeCss(n);
        table.style.width = place.width;
        table.style.marginLeft = place.marginLeft;
        table.style.marginRight = place.marginRight;
        while (colgroup.children.length > count) colgroup.lastChild!.remove();
        while (colgroup.children.length < count) colgroup.append(document.createElement("col"));
        [...colgroup.children].forEach((col, i) => {
          (col as HTMLElement).style.width = parts ? parts[i] : "";
        });
      };
      show(node);

      // ---- dragging a column's right edge (a mouse; touch uses the ribbon)
      let hover = -1;
      let drag: { col: number; startX: number; widths: number[]; pt: number } | null = null;
      /** Points to a pixel on the screen: 0.75 of one, on a page at its own
       *  size. (A zoomed page's pixels are larger or smaller than that.) */
      const pt = (): number => 0.75 / scaleOf(dom);
      /** The columns' widths in points: the table's own, or as they are
       *  drawn when it has none (the text's width shared out). */
      const measured = (): number[] => {
        const own = parseCols(current.attrs.cols, colgroup.children.length);
        if (own) return own;
        const PX = pt();
        return [...colgroup.children].map((col) => (col as HTMLElement).getBoundingClientRect().width * PX);
      };
      const columnAt = (e: PointerEvent): number => {
        const cell = (e.target as Element | null)?.closest?.("td");
        if (!cell || !body.contains(cell)) return -1;
        const rect = cell.getBoundingClientRect();
        if (rect.right - e.clientX > 5 || e.clientX > rect.right + 2) return -1;
        // The cell's last column, from where it sits in its row.
        let col = 0;
        for (let el = cell.previousElementSibling; el; el = el.previousElementSibling) col += span(el.getAttribute("colspan"));
        // (Cells pushed right by a rowspan above aren't counted here; the
        // table map knows.)
        const pos = editor.view.posAtDOM(cell, 0);
        const start = (typeof getPos === "function" ? getPos() : undefined) ?? -1;
        if (start >= 0) {
          try {
            const map = TableMap.get(current);
            const $cell = editor.state.doc.resolve(pos);
            for (let d = $cell.depth; d > 0; d -= 1) {
              if ($cell.node(d).type.name === "tableCell") {
                col = map.colCount($cell.before(d) - start - 1);
                break;
              }
            }
          } catch {
            // fall back to the count above
          }
        }
        return col + span(cell.getAttribute("colspan")) - 1;
      };
      const onMove = (e: PointerEvent) => {
        if (drag) {
          const next = Math.max(COL_MIN, drag.widths[drag.col] + (e.clientX - drag.startX) * drag.pt);
          (colgroup.children[drag.col] as HTMLElement).style.width = `${next}pt`;
          const total = drag.widths.reduce((a, b, i) => a + (i === drag!.col ? next : b), 0);
          table.style.width = `${total}pt`;
          return;
        }
        if (e.pointerType !== "mouse" || !editor.isEditable) return;
        const col = columnAt(e);
        if (col !== hover) {
          hover = col;
          dom.classList.toggle("wf-col-resize", col >= 0);
        }
      };
      const onDown = (e: PointerEvent) => {
        if (hover < 0 || e.button !== 0 || !editor.isEditable) return;
        e.preventDefault();
        const widths = measured();
        drag = { col: Math.min(hover, widths.length - 1), startX: e.clientX, widths, pt: pt() };
        // Every column gets a width of its own from here on.
        widths.forEach((w, i) => {
          (colgroup.children[i] as HTMLElement).style.width = `${w}pt`;
        });
        dom.setPointerCapture(e.pointerId);
      };
      const onUp = (e: PointerEvent) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        dom.releasePointerCapture(e.pointerId);
        const widths = d.widths.slice();
        widths[d.col] = Math.max(COL_MIN, d.widths[d.col] + (e.clientX - d.startX) * d.pt);
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        const now = editor.state.doc.nodeAt(pos);
        if (!now || now.type.name !== "table") return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...now.attrs, cols: encodeCols(widths) }));
      };
      dom.addEventListener("pointermove", onMove);
      dom.addEventListener("pointerdown", onDown);
      dom.addEventListener("pointerup", onUp);
      dom.addEventListener("pointercancel", onUp);

      return {
        dom,
        contentDOM: body,
        update: (next) => {
          if (next.type.name !== "table") return false;
          current = next;
          if (!drag) show(next);
          return true;
        },
        // The widths set while dragging are ours, not an edit to read back.
        ignoreMutation: (mutation) => mutation.type === "attributes" && (mutation.target === table || mutation.target === dom || colgroup.contains(mutation.target)),
        destroy: () => {
          dom.removeEventListener("pointermove", onMove);
          dom.removeEventListener("pointerdown", onDown);
          dom.removeEventListener("pointerup", onUp);
          dom.removeEventListener("pointercancel", onUp);
        },
      };
    };
  },

  addKeyboardShortcuts() {
    const wipe = () => {
      // Every cell selected, then Delete: the table goes, not just its text.
      const { selection } = this.editor.state;
      if (!(selection instanceof CellSelection)) return false;
      let cells = 0;
      selection.$anchorCell.node(-1).descendants((n) => {
        if (n.type.name === "tableCell") cells += 1;
        return n.type.name !== "tableCell";
      });
      let chosen = 0;
      selection.forEachCell(() => {
        chosen += 1;
      });
      return chosen === cells ? deleteTable(this.editor.state, this.editor.view.dispatch) : false;
    };
    return {
      Tab: () => tableTab(this.editor, 1),
      "Shift-Tab": () => tableTab(this.editor, -1),
      Backspace: wipe,
      Delete: wipe,
      "Mod-Backspace": wipe,
    };
  },

  addProseMirrorPlugins() {
    return [
      tableEditing({ allowTableNodeSelection: false }),
      // The table the caret is in shows where its cells are (faint lines
      // where it draws none); the others look as they print.
      new Plugin({
        key: new PluginKey("wf-table-on"),
        props: {
          decorations(state) {
            const { $from } = state.selection;
            for (let d = $from.depth; d > 0; d -= 1) {
              if ($from.node(d).type.name === "table") {
                return DecorationSet.create(state.doc, [Decoration.node($from.before(d), $from.after(d), { class: "wf-table-on" })]);
              }
            }
            return null;
          },
        },
      }),
    ];
  },
});

/** Tab in a table: the next cell (a new row after the last one); Shift-Tab
 *  the cell before. False outside a table. */
export function tableTab(editor: Editor, dir: 1 | -1): boolean {
  const { state, view } = editor;
  if (!isInTable(state)) return false;
  if (goToNextCell(dir)(state, view.dispatch)) return true;
  if (dir === -1) return true;
  // Past the last cell: a new row, and into it.
  if (!addRowAfter(state, view.dispatch)) return true;
  goToNextCell(1)(editor.state, view.dispatch);
  return true;
}

export { isInTable };

/** A new table where the caret is, the caret in its first cell. */
export function insertTable(editor: Editor, rows: number, cols: number): boolean {
  const r = Math.min(100, Math.max(1, Math.round(rows)));
  const c = Math.min(20, Math.max(1, Math.round(cols)));
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const { table, tableRow, tableCell, paragraph } = state.schema.nodes;
      if (!table || !tableRow || !tableCell) return false;
      const node = table.create(
        null,
        Array.from({ length: r }, () => tableRow.create(null, Array.from({ length: c }, () => tableCell.create(null, paragraph.create())))),
      );
      if (dispatch) {
        const at = tr.selection.from;
        tr.replaceSelectionWith(node);
        // Into the first cell (the table landed at or after where we were).
        let pos = -1;
        tr.doc.nodesBetween(Math.max(0, at - 1), tr.doc.content.size, (n, p) => {
          if (pos < 0 && n === node) pos = p;
          return pos < 0;
        });
        if (pos >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)));
        tr.scrollIntoView();
      }
      return true;
    })
    .run();
}

/** The table the selection is in. */
export function tableAt(state: EditorState): { node: PmNode; pos: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    if ($from.node(d).type.name === "table") return { node: $from.node(d), pos: $from.before(d) };
  }
  return null;
}

/** Run one of the table library's commands and, in the same step, put the
 *  table's column widths right for the columns it now has. */
function withCols(
  editor: Editor,
  command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
  widthsAfter: (widths: number[], rect: { left: number; right: number }) => number[],
): boolean {
  const { state, view } = editor;
  const at = tableAt(state);
  if (!at || !isInTable(state)) return false;
  const rect = selectedRect(state);
  const before = parseCols(at.node.attrs.cols, rect.map.width);
  const ok = command(state, (tr) => {
    const now = tr.doc.nodeAt(at.pos);
    if (now && now.type.name === "table") {
      const next = before ? widthsAfter(before, rect) : null;
      const cols = next && next.length === columnCount(now) ? encodeCols(next) : null;
      if (now.attrs.cols !== cols) tr.setNodeMarkup(at.pos, undefined, { ...now.attrs, cols });
    }
    view.dispatch(tr);
  });
  if (ok) view.focus();
  return ok;
}

const plain = (editor: Editor, command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean): boolean => {
  const ok = command(editor.state, editor.view.dispatch);
  if (ok) editor.view.focus();
  return ok;
};

export const tableCommands = {
  rowAbove: (e: Editor) => plain(e, addRowBefore),
  rowBelow: (e: Editor) => plain(e, addRowAfter),
  deleteRow: (e: Editor) => plain(e, deleteRow),
  columnLeft: (e: Editor) => withCols(e, addColumnBefore, (w, r) => [...w.slice(0, r.left), w[r.left], ...w.slice(r.left)]),
  columnRight: (e: Editor) => withCols(e, addColumnAfter, (w, r) => [...w.slice(0, r.right), w[r.right - 1], ...w.slice(r.right)]),
  deleteColumn: (e: Editor) => withCols(e, deleteColumn, (w, r) => [...w.slice(0, r.left), ...w.slice(r.right)]),
  deleteTable: (e: Editor) => plain(e, deleteTable),
  merge: (e: Editor) => plain(e, mergeCells),
  split: (e: Editor) => plain(e, splitCell),
  canMerge: (e: Editor) => mergeCells(e.state),
  canSplit: (e: Editor) => splitCell(e.state),
  /** Shade the selected cells (null: none). */
  shade: (e: Editor, color: string | null) => plain(e, setCellAttr("bg", color ? colorAttr(color) : null)),
};

/** Change the table the selection is in. */
export function setTableAttrs(editor: Editor, patch: { head?: true | null; lines?: TableLines | null; cols?: string | null; align?: TableAlign | null; ind?: number | null }): boolean {
  const at = tableAt(editor.state);
  if (!at) return false;
  const next = { ...at.node.attrs, ...patch, ...(patch.lines === "all" ? { lines: null } : {}) };
  editor.view.dispatch(editor.state.tr.setNodeMarkup(at.pos, undefined, next));
  editor.view.focus();
  return true;
}

/** What the ribbon's Table tab shows about the table under the caret. */
export function curTable(editor: Editor): {
  head: boolean;
  lines: TableLines;
  sized: boolean;
  bg: string | null;
  align: TableAlign | null;
  ind: number | null;
  va: CellVAlign | null;
  rowH: number | null;
  keep: boolean;
} | null {
  const at = tableAt(editor.state);
  if (!at) return null;
  const { $from } = editor.state.selection;
  let bg: string | null = null;
  let va: CellVAlign | null = null;
  let rowH: number | null = null;
  let keep = false;
  for (let d = $from.depth; d > 0; d -= 1) {
    const n = $from.node(d);
    if (n.type.name === "tableCell") {
      bg = colorAttr(n.attrs.bg);
      va = cellVAlign(n.attrs.va);
    } else if (n.type.name === "tableRow") {
      rowH = rowHeight(n.attrs.h);
      keep = rowKeep(n.attrs.keep) === true;
      break;
    }
  }
  const align = tableAlign(at.node.attrs.align);
  return {
    head: at.node.attrs.head === true,
    lines: linesAttr(at.node.attrs.lines),
    sized: parseCols(at.node.attrs.cols, columnCount(at.node)) !== null,
    bg,
    align,
    ind: align ? null : tableIndent(at.node.attrs.ind),
    va,
    rowH,
    keep,
  };
}

/** The rows the selection touches: the selected cells' rows, or the row of
 *  the caret. Positions of the rows, in order. */
function selectedRows(state: EditorState): number[] {
  const at = tableAt(state);
  if (!at) return [];
  const rect = selectedRect(state);
  const out: number[] = [];
  let pos = at.pos + 1;
  at.node.forEach((row, _offset, i) => {
    if (i >= rect.top && i < rect.bottom) out.push(pos);
    pos += row.nodeSize;
  });
  return out;
}

/** Change the rows the selection touches. */
export function setRowAttrs(editor: Editor, patch: { h?: number | null; keep?: true | null }): boolean {
  const rows = selectedRows(editor.state);
  if (!rows.length) return false;
  const tr = editor.state.tr;
  for (const pos of rows) {
    const row = tr.doc.nodeAt(pos);
    if (!row || row.type.name !== "tableRow") continue;
    const next = { ...row.attrs, ...("h" in patch ? { h: rowHeight(patch.h) } : {}), ...("keep" in patch ? { keep: rowKeep(patch.keep) } : {}) };
    tr.setNodeMarkup(pos, undefined, next);
  }
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Where the words of the selected cells sit (null: at the top). */
export function setCellVAlign(editor: Editor, va: CellVAlign | null): boolean {
  return plain(editor, setCellAttr("va", va));
}

/**
 * The rows the selection touches all as tall as the tallest of them (every
 * row of the table when the caret is in one cell), as they are drawn now.
 * A row's height is a least: a row with more to hold still grows.
 */
export function distributeRows(editor: Editor): boolean {
  const { state, view } = editor;
  const at = tableAt(state);
  if (!at) return false;
  const many = state.selection instanceof CellSelection;
  const rows = many ? selectedRows(state) : [];
  if (!many) {
    let pos = at.pos + 1;
    at.node.forEach((row) => {
      rows.push(pos);
      pos += row.nodeSize;
    });
  }
  if (rows.length < 2) return false;
  let tallest = 0;
  for (const pos of rows) {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) continue;
    tallest = Math.max(tallest, dom.getBoundingClientRect().height * (0.75 / scaleOf(dom)));
  }
  const h = rowHeight(Math.round(tallest * 10) / 10);
  if (!h) return false;
  const tr = state.tr;
  for (const pos of rows) {
    const row = tr.doc.nodeAt(pos);
    if (row && row.type.name === "tableRow") tr.setNodeMarkup(pos, undefined, { ...row.attrs, h });
  }
  view.dispatch(tr);
  view.focus();
  return true;
}

/**
 * The selected columns all the same width, sharing what they take now (every
 * column when the caret is in one cell).
 */
export function distributeColumns(editor: Editor): boolean {
  const { state } = editor;
  const at = tableAt(state);
  if (!at || !isInTable(state)) return false;
  const rect = selectedRect(state);
  const count = rect.map.width;
  const own = parseCols(at.node.attrs.cols, count);
  // (Without widths of its own the columns already share the width equally.)
  if (!own) return false;
  const many = state.selection instanceof CellSelection && rect.right - rect.left > 1;
  const from = many ? rect.left : 0;
  const to = many ? rect.right : count;
  const share = own.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  const widths = own.map((w, i) => (i >= from && i < to ? Math.max(COL_MIN, Math.min(COL_MAX, share)) : w));
  return setTableAttrs(editor, { cols: encodeCols(widths) });
}

/** Make the column the caret is in wider or narrower (touch screens, where
 *  there's no edge to drag). `full` is the width columns share when the
 *  table has none of its own. */
export function stepColumn(editor: Editor, dir: 1 | -1, full: number): boolean {
  const { state } = editor;
  const at = tableAt(state);
  if (!at || !isInTable(state)) return false;
  const rect = selectedRect(state);
  const count = rect.map.width;
  const widths = parseCols(at.node.attrs.cols, count) ?? Array.from({ length: count }, () => full / count);
  const col = Math.min(count - 1, rect.left);
  widths[col] = Math.min(COL_MAX, Math.max(COL_MIN, widths[col] + dir * 18));
  return setTableAttrs(editor, { cols: encodeCols(widths) });
}
