/**
 * Combine separate documents (chapters drafted one per document) into one
 * book manuscript, in the order given. Each source's structure is detected
 * the same way a conversion would; a source that doesn't open with its own
 * chapter heading gets one from its title. Sources are never modified.
 */

import type { JSONContent } from "@tiptap/core";

import { applyToJson } from "./apply";
import { detectStructure, planOps } from "./detect";

export interface CombineSource {
  title: string;
  json: JSONContent;
  /** The source's book details (dotted keys), if it had any. */
  book?: Record<string, unknown> | null;
}

const CHAPTER_LEVEL = new Set(["chapter_heading", "part_heading", "section_heading"]);

function isEmptyBlock(b: JSONContent): boolean {
  if (b.type !== "paragraph") return false;
  const text = (b.content ?? []).map((c) => c.text ?? "").join("");
  return !text.trim();
}

function opensWithHeading(blocks: JSONContent[]): boolean {
  const first = blocks.find((b) => !isEmptyBlock(b));
  if (!first) return false;
  if (first.type === "heading") return ((first.attrs?.level as number) ?? 1) === 1;
  return CHAPTER_LEVEL.has((first.attrs?.element as string) ?? "");
}

export function combineDocuments(
  sources: CombineSource[],
  opts: { titleHeadings: boolean } = { titleHeadings: true },
): { content: JSONContent; bookSeed: Record<string, unknown> | null } {
  const out: JSONContent[] = [];
  for (const source of sources) {
    const detected = detectStructure(source.json.content ?? []);
    const ops = planOps(detected, {
      blankPolicy: detected.blankPolicy,
      extractFront: false,
      removeContents: false,
    });
    let blocks = applyToJson(source.json, ops).content ?? [];
    // Trim blank lines at both ends.
    let start = 0;
    let end = blocks.length;
    while (start < end && isEmptyBlock(blocks[start])) start += 1;
    while (end > start && isEmptyBlock(blocks[end - 1])) end -= 1;
    blocks = blocks.slice(start, end);
    if (opts.titleHeadings && !opensWithHeading(blocks)) {
      const title = source.title.trim() || "Untitled";
      out.push({
        type: "paragraph",
        attrs: { element: "chapter_heading" },
        content: [{ type: "text", text: title }],
      });
    }
    out.push(...blocks);
  }
  const bookSeed = sources.find((s) => s.book && Object.keys(s.book).length)?.book ?? null;
  return {
    content: { type: "doc", content: out.length ? out : [{ type: "paragraph" }] },
    bookSeed,
  };
}
