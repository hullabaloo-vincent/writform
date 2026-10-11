/**
 * Word counts that cost nothing per keystroke on a 100k-word book.
 * ProseMirror shares every unchanged node between successive states, so a
 * count cached per node object only re-counts the paragraphs that changed.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { countWords } from "../../lib/wordCount";

const cache = new WeakMap<PmNode, number>();

/** Words someone has suggested deleting aren't counted: the count is of the
 *  text as it would stand. (Suggested insertions are.) */
const struck = (node: PmNode) => node.marks.some((m) => m.type.name === "deletion");

function nodeWords(node: PmNode): number {
  const hit = cache.get(node);
  if (hit !== undefined) return hit;
  let words: number;
  if (node.isTextblock) {
    // Leaves (line breaks, images) count as spaces: "end⏎start" is two
    // words. A note's own words aren't the text's: its number is a space.
    let text = "";
    node.forEach((child) => {
      text += child.isText && !struck(child) ? (child.text ?? "") : " ";
    });
    words = countWords(text);
  } else {
    words = 0;
    node.forEach((child) => {
      words += nodeWords(child);
    });
  }
  cache.set(node, words);
  return words;
}

/** Words in a whole document (or any node). */
export function countDocWords(doc: PmNode): number {
  return nodeWords(doc);
}

/** Words in a selection, or null when it's just a cursor. */
export function countRangeWords(doc: PmNode, from: number, to: number): number | null {
  if (to <= from) return null;
  // (As above: the text of the paragraphs, not of the notes they cite.)
  let text = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "footnote") {
      text += " ";
      return false;
    }
    if (node.isText) text += struck(node) ? " " : (node.text ?? "").slice(Math.max(0, from - pos), Math.max(0, to - pos));
    else if (node.isLeaf || node.isTextblock) text += " ";
    return true;
  });
  return countWords(text);
}
