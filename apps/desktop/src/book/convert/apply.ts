/**
 * Carry out a conversion plan (detect.ts → planOps):
 * - `applyToJson` for imports and combines — nothing is anchored to the text
 *   yet, so punctuation can be normalized freely too;
 * - `applyToEditor` for a live document — attribute changes only wherever
 *   possible (the text objects survive, and with them comments), applied
 *   from the end backwards in chunks, quickly enough to be one undo step.
 */

import type { Editor, JSONContent } from "@tiptap/core";

import type { QuoteStyle } from "../../editor/SmartPunctuation";
import { normalizeRuns } from "../model/punctuation";
import { blockOffsets } from "../model/structure";
import type { BlockOp, FrontMatterFind } from "./detect";

function withoutLevel(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...(attrs ?? {}) };
  delete out.level;
  return out;
}

function stripLeading(block: JSONContent, n: number): JSONContent {
  const content = [...(block.content ?? [])];
  const first = content[0];
  if (!first?.text) return block;
  const rest = first.text.slice(n);
  if (rest) content[0] = { ...first, text: rest };
  else content.shift();
  return { ...block, content: content.length ? content : undefined };
}

/** Curly quotes / dashes / ellipses / single spaces through a block's text
 *  runs (code is left alone). */
export function normalizeBlock(block: JSONContent, quotes?: QuoteStyle): JSONContent {
  if (block.type === "codeBlock") return block;
  const content = block.content;
  if (!content) return block;
  if (content.some((c) => c.type === "text" || c.type === "hardBreak")) {
    const textIdx = content
      .map((c, i) => (c.type === "text" && !(c.marks ?? []).some((m) => m.type === "code") ? i : -1))
      .filter((i) => i >= 0);
    const fixed = normalizeRuns(
      textIdx.map((i) => content[i].text ?? ""),
      { quotes },
    );
    const next = [...content];
    textIdx.forEach((i, k) => {
      next[i] = { ...next[i], text: fixed[k] };
    });
    return { ...block, content: next.filter((c) => c.type !== "text" || c.text) };
  }
  return { ...block, content: content.map((c) => normalizeBlock(c, quotes)) };
}

export function applyToJson(
  content: JSONContent,
  ops: Map<number, BlockOp>,
  opts: { punctuation?: boolean; quotes?: QuoteStyle } = {},
): JSONContent {
  const out: JSONContent[] = [];
  (content.content ?? []).forEach((block, i) => {
    const op = ops.get(i);
    let b = block;
    if (op?.action === "delete") return;
    if (op?.action === "scene") {
      out.push({ type: "horizontalRule" });
      return;
    }
    if (op?.action === "element" && op.element) {
      b =
        b.type === "heading"
          ? { ...b, type: "paragraph", attrs: { ...withoutLevel(b.attrs), element: op.element } }
          : { ...b, attrs: { ...(b.attrs ?? {}), element: op.element } };
    }
    if (op?.clearPageBreak && b.attrs) b = { ...b, attrs: { ...b.attrs, pageBreakBefore: null } };
    if (op?.strip) b = stripLeading(b, op.strip);
    if (opts.punctuation) b = normalizeBlock(b, opts.quotes);
    out.push(b);
  });
  if (out.length === 0) out.push({ type: "paragraph" });
  return { ...content, content: out };
}

/** The book-map patch for what was lifted off the hand-typed title page. */
export function frontMatterPatch(front: FrontMatterFind): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (front.title) patch["meta.title"] = front.title.slice(0, 300);
  if (front.author) patch["meta.author"] = front.author.slice(0, 200);
  if (front.copyright) {
    patch["meta.copyrightNotice"] = "custom";
    patch["meta.copyrightText"] = front.copyright.slice(0, 4000);
  }
  if (front.copyrightYear) patch["meta.copyrightYear"] = front.copyrightYear;
  if (front.copyrightHolder) patch["meta.copyrightHolder"] = front.copyrightHolder.slice(0, 200);
  if (front.dedication) patch["meta.dedication"] = front.dedication.slice(0, 2000);
  if (front.alsoBy?.length) patch["meta.alsoBy"] = front.alsoBy.slice(0, 60);
  return patch;
}

/**
 * Apply the plan to the open document in ONE transaction — one undo step,
 * and no window for a collaborator's edit to shift the block positions
 * between chunks. It's mostly attribute changes, so the sync update stays
 * small. Comments survive on every block whose text isn't rewritten.
 */
export function applyToEditor(editor: Editor, ops: Map<number, BlockOp>): void {
  const doc = editor.state.doc;
  const offsets = blockOffsets(doc);
  const { paragraph, horizontalRule } = editor.schema.nodes;
  const work = [...ops.entries()]
    .filter(([i, op]) => i < doc.childCount && (op.action !== "keep" || op.strip || op.clearPageBreak))
    .sort((a, b) => b[0] - a[0]);
  // Back to front: changing block i never moves blocks before it.
  const tr = editor.state.tr;
  for (const [i, op] of work) {
    const node = doc.child(i);
    const start = offsets[i];
    const end = offsets[i + 1];
    if (op.action === "delete") {
      tr.delete(start, end);
      continue;
    }
    if (op.action === "scene") {
      tr.replaceWith(start, end, horizontalRule.create());
      continue;
    }
    const attrs: Record<string, unknown> = { ...node.attrs };
    if (op.clearPageBreak) attrs.pageBreakBefore = null;
    if (op.action === "element" && op.element) {
      attrs.element = op.element;
      if (node.type.name === "heading") {
        delete attrs.level;
        tr.setNodeMarkup(start, paragraph, attrs);
      } else {
        tr.setNodeMarkup(start, undefined, attrs);
      }
    } else if (op.clearPageBreak) {
      tr.setNodeMarkup(start, undefined, attrs);
    }
    if (op.strip && node.firstChild?.isText) {
      tr.delete(start + 1, start + 1 + Math.min(op.strip, node.firstChild.nodeSize));
    }
  }
  editor.view.dispatch(tr.scrollIntoView());
}
