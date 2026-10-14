/**
 * Tables made over: rows sorted by a column, a table split in two, text
 * set out in a table, a table back to text. Each is one step of Undo, and
 * never a tracked suggestion (as other table edits aren't).
 */

import type { Editor } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { selectedRect, TableMap } from "@tiptap/pm/tables";

import { untracked } from "../review/Suggesting";
import { parseCols } from "../schema/sanitize";
import { tableAt } from "./Table";

/** A cell's words, its paragraphs joined by a space. */
const cellText = (cell: PmNode): string => {
  const parts: string[] = [];
  cell.forEach((block) => parts.push(block.textContent));
  return parts.join(" ").trim();
};

/** Whether any cell of the table spans more than one row. */
const spansRows = (table: PmNode): boolean => {
  let spans = false;
  table.descendants((node) => {
    if (node.type.name === "tableCell" && (node.attrs.rowspan ?? 1) > 1) spans = true;
    return !spans && node.type.name !== "tableCell";
  });
  return spans;
};

/** A number as a writer types one ("1,250", "$40", "12%"), or null. */
function numberIn(text: string): number | null {
  const bare = text.replace(/[\s,$€£¥%]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(bare)) return null;
  return Number(bare);
}

/**
 * Sort the rows of the table at the caret by the column the caret is in
 * (`dir` 1 A to Z, -1 Z to A). A header row stays first. Numbers come
 * before words and go by their value, words by the language's order.
 * Refused (false) where a cell spans rows.
 */
export function sortRows(editor: Editor, dir: 1 | -1, lang?: string): boolean {
  const { state } = editor;
  const at = tableAt(state);
  if (!at || spansRows(at.node)) return false;
  let col: number;
  try {
    col = selectedRect(state).left;
  } catch {
    return false;
  }
  const map = TableMap.get(at.node);
  const rows: PmNode[] = [];
  at.node.forEach((row) => rows.push(row));
  const head = at.node.attrs.head === true ? rows.slice(0, 1) : [];
  const body = rows.slice(head.length);
  const key = (row: PmNode, index: number): string => {
    // The cell at the column, counting spans across.
    const rel = map.map[(index + head.length) * map.width + col];
    const cell = at.node.nodeAt(rel);
    void row;
    return cell ? cellText(cell) : "";
  };
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });
  const keyed = body.map((row, i) => ({ row, text: key(row, i), i }));
  keyed.sort((a, b) => {
    const na = numberIn(a.text);
    const nb = numberIn(b.text);
    let c: number;
    if (na !== null && nb !== null) c = na - nb;
    else if (na !== null) c = -1;
    else if (nb !== null) c = 1;
    else c = collator.compare(a.text, b.text);
    return c * dir || a.i - b.i;
  });
  const table = at.node.copy(Fragment.from([...head, ...keyed.map((k) => k.row)]));
  const tr = state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, table);
  // (The caret stays in the table, so another sort can follow.)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(state.selection.from, at.pos + table.nodeSize - 2))));
  editor.view.dispatch(untracked(tr));
  editor.view.focus();
  return true;
}

/**
 * Split the table at the caret into two, the second starting with the
 * caret's row (a paragraph between them). Refused at its first row, or
 * where a cell spans across the split.
 */
export function splitTable(editor: Editor): boolean {
  const { state } = editor;
  const at = tableAt(state);
  if (!at) return false;
  let row: number;
  try {
    row = selectedRect(state).top;
  } catch {
    return false;
  }
  if (row <= 0) return false;
  const map = TableMap.get(at.node);
  // A cell above the split reaching below it: no clean place to cut.
  for (let col = 0; col < map.width; col += 1) {
    if (map.map[(row - 1) * map.width + col] === map.map[row * map.width + col]) return false;
  }
  const rows: PmNode[] = [];
  at.node.forEach((r) => rows.push(r));
  const cols = parseCols(at.node.attrs.cols, map.width);
  const first = at.node.type.create({ ...at.node.attrs }, rows.slice(0, row));
  const second = at.node.type.create({ ...at.node.attrs, head: null, ...(cols ? {} : { cols: null }) }, rows.slice(row));
  const between = state.schema.nodes.paragraph.create();
  const tr = state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, [first, between, second]);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at.pos + first.nodeSize + 1)));
  editor.view.dispatch(untracked(tr));
  editor.view.focus();
  return true;
}

/**
 * The paragraphs the selection touches, made a table: a row a paragraph,
 * its cells parted where a tab is (or a comma, when no line has a tab).
 * False when the selection is in a table or holds no paragraph.
 */
export function textToTable(editor: Editor): boolean {
  const { state } = editor;
  const { from, to } = state.selection;
  const paras: { node: PmNode; pos: number }[] = [];
  let inside = false;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type.name === "table") inside = true;
    if (node.type.name === "paragraph" && parent === state.doc) paras.push({ node, pos });
    return node.type.name !== "paragraph" && node.type.name !== "table";
  });
  if (inside || !paras.length) return false;
  const tabbed = paras.some((p) => p.node.textContent.includes("\t"));
  const sep = tabbed ? "\t" : ",";
  const lines = paras.map((p) => p.node.textContent.split(sep).map((s) => (tabbed ? s : s.trim())));
  const width = Math.max(...lines.map((l) => l.length));
  const { table, tableRow, tableCell, paragraph } = state.schema.nodes;
  const rows = lines.map((cells) =>
    tableRow.create(
      null,
      Array.from({ length: width }, (_, i) => tableCell.create(null, paragraph.create(null, cells[i] ? state.schema.text(cells[i]) : undefined))),
    ),
  );
  const start = paras[0].pos;
  const end = paras[paras.length - 1].pos + paras[paras.length - 1].node.nodeSize;
  const tr = state.tr.replaceWith(start, end, table.create(null, rows));
  tr.setSelection(TextSelection.near(tr.doc.resolve(start + 3)));
  editor.view.dispatch(untracked(tr));
  editor.view.focus();
  return true;
}

/** The table at the caret, made paragraphs: a row each, its cells parted
 *  by tabs. */
export function tableToText(editor: Editor): boolean {
  const { state } = editor;
  const at = tableAt(state);
  if (!at) return false;
  const paras: PmNode[] = [];
  at.node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cellText(cell)));
    const text = cells.join("\t");
    paras.push(state.schema.nodes.paragraph.create(null, text ? state.schema.text(text) : undefined));
  });
  const tr = state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, paras);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at.pos + 1)));
  editor.view.dispatch(untracked(tr));
  editor.view.focus();
  return true;
}
