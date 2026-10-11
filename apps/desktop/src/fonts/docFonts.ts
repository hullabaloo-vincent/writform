/**
 * A document's own record of the fonts it uses beyond the app's built-in
 * ones: for each, its name and kind. So a device that has never heard of
 * "gf:crimson-pro" (an older app, a font no longer in the catalog) or
 * doesn't have "sys:Bembo" still knows what to call it and what kind of
 * face to stand in with. Kept in `Y.Map("fonts")`, one small string per
 * font — nothing in the ProseMirror schema.
 */

import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";

import type { FontInfo } from "./css";
import { isFamilyName, isFontId } from "./ids";
import { knownFont, type FontCategory } from "./registry";

const CATEGORIES: FontCategory[] = ["serif", "sans-serif", "monospace", "display", "handwriting"];

export function readDocFontTable(doc: Y.Doc): Record<string, FontInfo> {
  const out: Record<string, FontInfo> = {};
  doc.getMap("fonts").forEach((value, id) => {
    if (!isFontId(id) || typeof value !== "string") return;
    try {
      const raw = JSON.parse(value) as { n?: unknown; c?: unknown };
      if (!isFamilyName(raw.n)) return;
      out[id] = { name: raw.n, ...(CATEGORIES.includes(raw.c as FontCategory) ? { category: raw.c as FontCategory } : {}) };
    } catch {
      // an entry this build can't read is simply not known
    }
  });
  return out;
}

/** Record a font the document now uses (the app's own need no record). */
export function noteDocFont(doc: Y.Doc, id: string, info: FontInfo | undefined): void {
  if (!info || !isFontId(id) || knownFont(id) || !isFamilyName(info.name)) return;
  const map = doc.getMap("fonts");
  const value = JSON.stringify({ n: info.name, ...(info.category ? { c: info.category } : {}) });
  if (map.get(id) !== value) map.set(id, value);
}

/**
 * Change everything set in `from` to `to` (null: the document's body
 * font) — paragraphs and runs of text alike. One undo step. Returns how
 * many places changed.
 */
export function replaceDocFont(editor: Editor, from: string, to: string | null): number {
  let changed = 0;
  editor
    .chain()
    .command(({ tr, state, dispatch }) => {
      const mark = state.schema.marks.fontFamily;
      state.doc.descendants((node, pos) => {
        if ((node.type.name === "paragraph" || node.type.name === "heading") && node.attrs.font === from) {
          changed += 1;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, font: to });
        }
        if (mark && node.isText && node.marks.some((m) => m.type === mark && m.attrs.f === from)) {
          changed += 1;
          if (dispatch) {
            if (to) tr.addMark(pos, pos + node.nodeSize, mark.create({ f: to }));
            else tr.removeMark(pos, pos + node.nodeSize, mark);
          }
        }
      });
      return changed > 0;
    })
    .run();
  return changed;
}

const keys = new WeakMap<object, string>();

/** A cheap fingerprint of which fonts a document's paragraphs and text
 *  name (remembered per version of the document: the ribbon asks often). */
export function fontKey(editor: Editor): string {
  const doc = editor.state.doc;
  const hit = keys.get(doc);
  if (hit !== undefined) return hit;
  const ids = new Set<string>();
  doc.descendants((node) => {
    const font = node.attrs.font;
    if (typeof font === "string" && font) ids.add(font);
    for (const mark of node.marks) {
      if (mark.type.name === "fontFamily" && typeof mark.attrs.f === "string" && mark.attrs.f) ids.add(mark.attrs.f);
    }
  });
  const key = [...ids].sort().join("|");
  keys.set(doc, key);
  return key;
}
