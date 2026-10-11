/**
 * The text without its markup: a document's JSON as it would stand with
 * every suggested change accepted. What printing, PDFs, books and the
 * plain-text exports are made from — a suggestion someone hasn't decided
 * on yet is shown in the editor, not on paper.
 */

import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";

import { contentSchema } from "../schema/content";
import { resolvedJson } from "./resolve";

function schema(): Schema | null {
  try {
    return contentSchema();
  } catch {
    return null;
  }
}

export function finalJson<T extends JSONContent>(doc: T): T {
  return resolvedJson(doc, "accept", schema()) as T;
}
