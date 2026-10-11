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
import { COL_MAX, COL_MIN, colorAttr, encodeCols, linesAttr, parseCols, roundPt, TABLE_LINES, toHexColor, type TableLines } from "../schema/sanitize";

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

const colElements = (table: PmNode): [string, Record<string, string>][] => {
  const count = columnCount(table);
  const widths = parseCols(table.attrs.cols, count);
  return Array.from({ length: count }, (_, i): [string, Record<string, string>] => ["col", widths ? { style: `width: ${widths[i]}pt` } : {}]);
};

const tableStyle = (table: PmNode): string | null => {
  const widths = parseCols(table.attrs.cols, columnCount(table));
  // Its own widths, or the width of the text shared out.
  return widths ? `width: ${roundPt(widths.reduce((a, b) => a + b, 0))}pt` : null;
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
        const count = columnCount(n);
        const widths = parseCols(n.attrs.cols, count);
        table.style.width = widths ? `${roundPt(widths.reduce((a, b) => a + b, 0))}pt` : "";
        while (colgroup.children.length > count) colgroup.lastChild!.remove();
        while (colgroup.children.length < count) colgroup.append(document.createElement("col"));
        [...colgroup.children].forEach((col, i) => {
          (col as HTMLElement).style.width = widths ? `${widths[i]}pt` : "";
        });
      };
      show(node);

      // ---- dragging a column's right edge (a mouse; touch uses the ribbon)
      let hover = -1;
      let drag: { col: number; startX: number; widths: number[] } | null = null;
      const PX = 0.75;
      const measured = (): number[] => [...colgroup.children].map((col) => (col as HTMLElement).getBoundingClientRect().width * PX);
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
          const next = Math.max(COL_MIN, drag.widths[drag.col] + (e.clientX - drag.startX) * PX);
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
        drag = { col: Math.min(hover, widths.length - 1), startX: e.clientX, widths };
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
        widths[d.col] = Math.max(COL_MIN, d.widths[d.col] + (e.clientX - d.startX) * PX);
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
    return [tableEditing({ allowTableNodeSelection: false })];
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
function tableAt(state: EditorState): { node: PmNode; pos: number } | null {
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
export function setTableAttrs(editor: Editor, patch: { head?: true | null; lines?: TableLines | null; cols?: string | null }): boolean {
  const at = tableAt(editor.state);
  if (!at) return false;
  const next = { ...at.node.attrs, ...patch, ...(patch.lines === "all" ? { lines: null } : {}) };
  editor.view.dispatch(editor.state.tr.setNodeMarkup(at.pos, undefined, next));
  editor.view.focus();
  return true;
}

/** What the ribbon's Table tab shows about the table under the caret. */
export function curTable(editor: Editor): { head: boolean; lines: TableLines; sized: boolean; bg: string | null } | null {
  const at = tableAt(editor.state);
  if (!at) return null;
  const { $from } = editor.state.selection;
  let bg: string | null = null;
  for (let d = $from.depth; d > 0; d -= 1) {
    if ($from.node(d).type.name === "tableCell") {
      bg = colorAttr($from.node(d).attrs.bg);
      break;
    }
  }
  return {
    head: at.node.attrs.head === true,
    lines: linesAttr(at.node.attrs.lines),
    sized: parseCols(at.node.attrs.cols, columnCount(at.node)) !== null,
    bg,
  };
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
