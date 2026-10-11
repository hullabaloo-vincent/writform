/**
 * A document's word count, opening words and plain text, read straight from
 * its Yjs state (no editor needed) — for the organizer's cards and for
 * searching. Mirrors the server's list details: headings ("Chapter One")
 * never make the excerpt.
 */

import * as Y from "yjs";

const HEADINGISH = /heading|chapter_subtitle|stanza_title|character|transition/;
const EXCERPT_CHARS = 180;

function textOf(node: unknown): string {
  if (node instanceof Y.XmlText) {
    let out = "";
    for (const op of node.toDelta() as { insert: unknown }[]) {
      if (typeof op.insert === "string") out += op.insert;
    }
    return out;
  }
  if (node instanceof Y.XmlElement) {
    if (node.nodeName === "hardBreak") return " ";
    const inline = node.nodeName === "paragraph" || node.nodeName === "heading";
    return node
      .toArray()
      .map(textOf)
      .join(inline ? "" : " ");
  }
  return "";
}

/** Up to `max` characters, cut at a word, with an ellipsis. */
export function shorten(text: string, max = EXCERPT_CHARS): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const kept = space > max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.!?—–-]+$/, "")}…`;
}

export interface DocDigest {
  words: number;
  excerpt: string;
  /** Every block's text, one to a line: what a search reads. */
  text: string;
}

export function ydocStats(doc: Y.Doc): { words: number; excerpt: string } {
  const { words, excerpt } = ydocDigest(doc);
  return { words, excerpt };
}

export function ydocDigest(doc: Y.Doc): DocDigest {
  let words = 0;
  let excerpt = "";
  let first = "";
  const lines: string[] = [];
  for (const block of doc.getXmlFragment("default").toArray()) {
    const text = textOf(block).trim();
    if (!text) continue;
    words += text.split(/\s+/).length;
    lines.push(text);
    if (!first) first = text;
    if (
      !excerpt &&
      block instanceof Y.XmlElement &&
      block.nodeName !== "heading" &&
      !HEADINGISH.test(String(block.getAttribute("element") ?? ""))
    ) {
      excerpt = text;
    }
  }
  return { words, excerpt: shorten(excerpt || first), text: lines.join("\n") };
}

/** The same for an encoded state (a copy being created). */
export function stateDigest(state: Uint8Array): DocDigest {
  const doc = new Y.Doc();
  try {
    if (state.length) Y.applyUpdate(doc, state);
    return ydocDigest(doc);
  } finally {
    doc.destroy();
  }
}
