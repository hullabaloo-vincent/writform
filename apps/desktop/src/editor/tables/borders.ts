/**
 * A table's cell borders and its looks (no new vocabulary: a cell's own
 * lines are `bdr`, level 3; a cell's shading `bg` and the table's `lines`
 * and `head` are older still).
 *
 * A line drawn on a cell's side is drawn on the side of the cell facing it
 * too, so the edge two cells share says the same from both (Word draws
 * the one that says more, the page layout the cell's own).
 */

import type { Editor } from "@tiptap/core";
import { selectedRect, TableMap } from "@tiptap/pm/tables";

import { untracked } from "../review/Suggesting";
import { cellEdges, encodeCellEdges, type CellEdges, type CellSide, type Edge } from "../schema/sanitize";
import { tableAt } from "./Table";

/** Which of the selected cells' sides: every one, the selection's outside,
 *  the lines inside it, one edge of it, or no lines at all. */
export type BorderWhich = "all" | "outside" | "inside" | "top" | "bottom" | "left" | "right" | "none";

const OPPOSITE: Record<CellSide, CellSide> = { t: "b", b: "t", l: "r", r: "l" };

/**
 * Draw `edge` on the sides `which` names of the selected cells (or of the
 * cell the caret is in). "none" draws none: every side of them is said to
 * have no line, the table's own lines included.
 */
export function setCellBorders(editor: Editor, which: BorderWhich, edge: Edge): boolean {
  const { state } = editor;
  const at = tableAt(state);
  if (!at) return false;
  let rect;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  const map = rect.map;
  const tableStart = rect.tableStart;
  const none: Edge = { w: 0, color: edge.color };
  // Each cell's new sides, by its position in the table.
  const want = new Map<number, CellEdges>();
  const put = (row: number, col: number, side: CellSide, e: Edge) => {
    if (row < 0 || col < 0 || row >= map.height || col >= map.width) return;
    const pos = map.map[row * map.width + col];
    const now = want.get(pos) ?? {};
    now[side] = e;
    want.set(pos, now);
  };
  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let col = rect.left; col < rect.right; col += 1) {
      const top = row === rect.top;
      const bottom = row === rect.bottom - 1;
      const left = col === rect.left;
      const right = col === rect.right - 1;
      const sides: [CellSide, boolean][] = [
        ["t", which === "all" || which === "none" || (which === "outside" && top) || (which === "inside" && !top) || (which === "top" && top)],
        ["b", which === "all" || which === "none" || (which === "outside" && bottom) || (which === "inside" && !bottom) || (which === "bottom" && bottom)],
        ["l", which === "all" || which === "none" || (which === "outside" && left) || (which === "inside" && !left) || (which === "left" && left)],
        ["r", which === "all" || which === "none" || (which === "outside" && right) || (which === "inside" && !right) || (which === "right" && right)],
      ];
      for (const [side, on] of sides) {
        if (!on) continue;
        const e = which === "none" ? none : edge;
        put(row, col, side, e);
        // The neighbour across the edge says the same of it.
        const [dr, dc] = side === "t" ? [-1, 0] : side === "b" ? [1, 0] : side === "l" ? [0, -1] : [0, 1];
        put(row + dr, col + dc, OPPOSITE[side], e);
      }
    }
  }
  const tr = state.tr;
  for (const [rel, sides] of want) {
    const pos = tableStart + rel;
    const cell = tr.doc.nodeAt(pos);
    if (!cell) continue;
    const edges = { ...(cellEdges(cell.attrs.bdr) ?? {}), ...sides };
    tr.setNodeMarkup(pos, undefined, { ...cell.attrs, bdr: encodeCellEdges(edges) });
  }
  editor.view.dispatch(untracked(tr));
  editor.view.focus();
  return true;
}

/** The table looks to start from: lines, a header row, rows shaded in turn. */
export const TABLE_LOOKS = [
  { id: "grid", name: "Grid", lines: null, head: null, headBg: null, band: null },
  { id: "header", name: "Header row", lines: null, head: true, headBg: "#e8e8e8", band: null },
  { id: "banded", name: "Banded rows", lines: "rows", head: true, headBg: "#d9e2f3", band: "#f2f2f2" },
  { id: "simple", name: "Simple", lines: "rows", head: null, headBg: null, band: null },
  { id: "boxed", name: "Boxed", lines: "box", head: true, headBg: "#f2f2f2", band: null },
] as const;
export type TableLookId = (typeof TABLE_LOOKS)[number]["id"];

/** Give the table at the caret one of the looks: its lines, its header
 *  row, its cells' shading (each cell's own lines taken away). */
export function applyTableLook(editor: Editor, id: TableLookId): boolean {
  const look = TABLE_LOOKS.find((l) => l.id === id);
  const at = tableAt(editor.state);
  if (!look || !at) return false;
  const tr = editor.state.tr;
  tr.setNodeMarkup(at.pos, undefined, { ...at.node.attrs, lines: look.lines, head: look.head });
  const map = TableMap.get(at.node);
  const start = at.pos + 1;
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row += 1) {
    for (let col = 0; col < map.width; col += 1) {
      const rel = map.map[row * map.width + col];
      if (seen.has(rel)) continue;
      seen.add(rel);
      const cell = tr.doc.nodeAt(start + rel);
      if (!cell) continue;
      const bg = row === 0 && look.head ? look.headBg : look.band && row % 2 === (look.head ? 0 : 1) ? look.band : null;
      tr.setNodeMarkup(start + rel, undefined, { ...cell.attrs, bg, bdr: null });
    }
  }
  editor.view.dispatch(untracked(tr));
  editor.view.focus();
  return true;
}
