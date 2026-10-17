/**
 * Moving through the board by keyboard: the arrows go from card to card
 * (an empty cell's place is its "+"), Home and End to the first and last
 * column. Pure: the board says what is where, this says where to go.
 */

export interface GridModel {
  /** cells[row][column]: the card ids there, in order. */
  cells: string[][][];
}

/** A place on the board: a card (`index` ≥ 0) or a cell's "+" (-1). */
export interface GridAt {
  row: number;
  col: number;
  index: number;
}

const clampIndex = (model: GridModel, row: number, col: number, index: number): number => {
  const n = model.cells[row]?.[col]?.length ?? 0;
  if (n === 0) return -1;
  return Math.max(0, Math.min(index, n - 1));
};

export function nextFocus(model: GridModel, at: GridAt, key: string): GridAt | null {
  const rows = model.cells.length;
  const cols = rows ? model.cells[0].length : 0;
  if (!rows || !cols) return null;
  const cell = model.cells[at.row]?.[at.col] ?? [];
  switch (key) {
    case "ArrowDown":
      if (at.index >= 0 && at.index < cell.length - 1) return { ...at, index: at.index + 1 };
      if (at.row + 1 < rows) return { row: at.row + 1, col: at.col, index: clampIndex(model, at.row + 1, at.col, 0) };
      return null;
    case "ArrowUp":
      if (at.index > 0) return { ...at, index: at.index - 1 };
      if (at.row > 0) {
        const n = model.cells[at.row - 1][at.col].length;
        return { row: at.row - 1, col: at.col, index: n ? n - 1 : -1 };
      }
      return null;
    case "ArrowRight":
      if (at.col + 1 < cols) return { row: at.row, col: at.col + 1, index: clampIndex(model, at.row, at.col + 1, at.index) };
      return null;
    case "ArrowLeft":
      if (at.col > 0) return { row: at.row, col: at.col - 1, index: clampIndex(model, at.row, at.col - 1, at.index) };
      return null;
    case "Home":
      return { row: at.row, col: 0, index: clampIndex(model, at.row, 0, 0) };
    case "End":
      return { row: at.row, col: cols - 1, index: clampIndex(model, at.row, cols - 1, 0) };
    default:
      return null;
  }
}

/** Where a card goes for Alt and an arrow: a column over, or a place up or
 *  down in its cell (past the cell's edge, into the next plot line). Gives
 *  the cell and the card it goes before (null: the end). */
export function moveTarget(model: GridModel, at: GridAt, key: string): { row: number; col: number; before: string | null } | null {
  const rows = model.cells.length;
  const cols = rows ? model.cells[0].length : 0;
  const cell = model.cells[at.row]?.[at.col] ?? [];
  const id = cell[at.index];
  if (!id) return null;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const col = at.col + (key === "ArrowLeft" ? -1 : 1);
    if (col < 0 || col >= cols) return null;
    const there = model.cells[at.row][col];
    return { row: at.row, col, before: there[Math.max(0, at.index)] ?? null };
  }
  if (key === "ArrowUp") {
    if (at.index > 0) return { row: at.row, col: at.col, before: cell[at.index - 1] };
    if (at.row > 0) return { row: at.row - 1, col: at.col, before: null };
    return null;
  }
  if (key === "ArrowDown") {
    if (at.index < cell.length - 1) return { row: at.row, col: at.col, before: cell[at.index + 2] ?? null };
    if (at.row + 1 < rows) return { row: at.row + 1, col: at.col, before: model.cells[at.row + 1][at.col][0] ?? null };
    return null;
  }
  return null;
}
