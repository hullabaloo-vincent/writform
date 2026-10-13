import type { BlockInput } from "../types";

/**
 * How much of a block the reports read. 2: prose, sentences and all.
 * 1: its words count and its sentences don't (a list item, a table cell,
 * someone else's words). 0: not read (a heading, verse, a footnote).
 */
export function proseKind(block: BlockInput): 0 | 1 | 2 {
  if (block.note || block.role === "heading" || block.role === "caps" || block.role === "verse") return 0;
  if (block.role === "extract" || block.cell || block.list) return 1;
  return 2;
}
