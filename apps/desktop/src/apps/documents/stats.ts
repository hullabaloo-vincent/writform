/**
 * Word counts that cost nothing per keystroke on a 100k-word book.
 * ProseMirror shares every unchanged node between successive states, so a
 * count cached per node object only re-counts the paragraphs that changed.
 */

import type { Node as PmNode } from "@tiptap/pm/model";

import { countWords } from "../../lib/wordCount";

const cache = new WeakMap<PmNode, number>();

function nodeWords(node: PmNode): number {
  const hit = cache.get(node);
  if (hit !== undefined) return hit;
  let words: number;
  if (node.isTextblock) {
    // Leaves (line breaks, images) count as spaces: "end⏎start" is two words.
    words = countWords(node.textBetween(0, node.content.size, " ", " "));
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
  return countWords(doc.textBetween(from, to, " ", " "));
}
