/**
 * Imports that are clearly books come in as book manuscripts: when the
 * detector finds a chapter structure (three or more chapters, or Heading-1
 * chapters in a long text), the import is converted in JSON — structure
 * marked, title page lifted into the book's details, punctuation made
 * typographic — and created in the Manuscript format.
 */

import type { JSONContent } from "@tiptap/core";

import { applyToJson, frontMatterPatch } from "./apply";
import { detectStructure, planOps, summarize, type PlanChoices } from "./detect";

function words(content: JSONContent): number {
  let n = 0;
  const walk = (node: JSONContent) => {
    if (node.text) n += node.text.split(/\s+/).filter(Boolean).length;
    for (const c of node.content ?? []) walk(c);
  };
  walk(content);
  return n;
}

export function asManuscript(
  content: JSONContent,
  fileMeta: { title?: string; author?: string } = {},
): { content: JSONContent; bookPatch: Record<string, unknown>; summary: string } | null {
  const detected = detectStructure(content.content ?? []);
  const structural = detected.candidates.filter(
    (c) => c.accepted && (c.kind === "chapter" || c.kind === "part" || c.kind === "section"),
  );
  const headingChapters = structural.filter((c) => c.reason.startsWith("Heading")).length;
  const confident = structural.length >= 3 || (headingChapters >= 1 && words(content) >= 10_000);
  if (!confident) return null;

  const choices: PlanChoices = {
    blankPolicy: detected.blankPolicy,
    extractFront: true,
    removeContents: true,
  };
  const converted = applyToJson(content, planOps(detected, choices), { punctuation: true });
  const bookPatch = frontMatterPatch(detected.front);
  if (!bookPatch["meta.title"] && fileMeta.title) bookPatch["meta.title"] = fileMeta.title;
  if (!bookPatch["meta.author"] && fileMeta.author) bookPatch["meta.author"] = fileMeta.author;
  return { content: converted, bookPatch, summary: summarize(detected, choices) };
}
