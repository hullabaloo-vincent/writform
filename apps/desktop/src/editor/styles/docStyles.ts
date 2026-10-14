/**
 * A document's styles, where they are kept: `Y.Map("styles")`, one small
 * JSON string per style — the changes it has made to a built-in style, or
 * a style of its own. Beside the text, not in it, so an older app (which
 * never looks here) shows the same words in the built-in look, and nothing
 * about the content's schema changes.
 */

import * as Y from "yjs";

import { isFontId } from "../../fonts/ids";
import { colorAttr, encodeTabs, firstIndentAttr, indentAttr, numberAttr, parseTabs, sizeAttr } from "../schema/sanitize";
import {
  CUSTOM_STYLE,
  CUSTOM_STYLE_MAX,
  isBuiltinStyle,
  NORMAL_STYLE,
  STYLE_NAME_MAX,
  type StyleAlign,
  type StyleEntry,
  type StyleOverrides,
  type StyleProps,
} from "./sheet";

export const STYLES_MAP = "styles";

const ALIGNS: StyleAlign[] = ["left", "center", "right", "justify"];

/** A style's properties as stored or typed, kept only where they make sense. */
export function cleanStyleProps(raw: unknown): StyleProps {
  const out: StyleProps = {};
  if (!raw || typeof raw !== "object") return out;
  const v = raw as Record<string, unknown>;
  if (v.font === null) out.font = null;
  else if (isFontId(v.font)) out.font = v.font;
  const size = sizeAttr(v.size);
  if (size !== null) out.size = size;
  for (const key of ["bold", "italic", "underline", "keepNext"] as const) {
    if (typeof v[key] === "boolean") out[key] = v[key];
  }
  if (v.color === null) out.color = null;
  else if (colorAttr(v.color)) out.color = colorAttr(v.color);
  if (ALIGNS.includes(v.align as StyleAlign)) out.align = v.align as StyleAlign;
  const line = numberAttr(v.line, 0.5, 5);
  if (line !== null) out.line = line;
  const before = numberAttr(v.before, 0, 200);
  if (before !== null) out.before = before;
  const after = numberAttr(v.after, 0, 200);
  if (after !== null) out.after = after;
  const indL = indentAttr(v.indL);
  if (indL !== null) out.indL = indL;
  const indR = indentAttr(v.indR);
  if (indR !== null) out.indR = indR;
  const indF = firstIndentAttr(v.indF);
  if (indF !== null) out.indF = indF;
  if (v.tabs === null) out.tabs = null;
  else {
    const tabs = encodeTabs(parseTabs(v.tabs));
    if (tabs && tabs !== "none") out.tabs = tabs;
  }
  return out;
}

function parseEntry(id: string, value: unknown): StyleEntry | null {
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const entry: StyleEntry = { props: cleanStyleProps(raw) };
    if (CUSTOM_STYLE.test(id)) {
      const name = typeof raw.name === "string" ? raw.name.trim().slice(0, STYLE_NAME_MAX) : "";
      if (!name) return null;
      entry.name = name;
      if (typeof raw.base === "string" && raw.base !== id && (isBuiltinStyle(raw.base) || CUSTOM_STYLE.test(raw.base))) {
        entry.base = raw.base;
      }
    }
    return entry;
  } catch {
    // an entry this build can't read is a style it doesn't have
    return null;
  }
}

export function readDocStyles(doc: Y.Doc): StyleOverrides {
  const out: StyleOverrides = {};
  let custom = 0;
  doc.getMap(STYLES_MAP).forEach((value, id) => {
    const builtin = isBuiltinStyle(id) && id !== NORMAL_STYLE;
    if (!builtin && !CUSTOM_STYLE.test(id)) return;
    if (!builtin && custom >= CUSTOM_STYLE_MAX) return;
    const entry = parseEntry(id, value);
    if (!entry) return;
    if (!builtin) custom += 1;
    out[id] = entry;
  });
  return out;
}

/** The same table from a plain snapshot of the map (exports, previews). */
export function stylesFromSnapshot(snapshot: Record<string, unknown> | undefined): StyleOverrides {
  const out: StyleOverrides = {};
  for (const [id, value] of Object.entries(snapshot ?? {})) {
    if (!(isBuiltinStyle(id) && id !== NORMAL_STYLE) && !CUSTOM_STYLE.test(id)) continue;
    const entry = parseEntry(id, value);
    if (entry) out[id] = entry;
  }
  return out;
}

export function encodeStyleEntry(entry: StyleEntry): string {
  return JSON.stringify({
    ...(entry.name ? { name: entry.name.trim().slice(0, STYLE_NAME_MAX) } : {}),
    ...(entry.base ? { base: entry.base } : {}),
    ...cleanStyleProps(entry.props),
  });
}

/** Change a style (null: a built-in back to how it comes, a custom one gone). */
export function writeDocStyle(doc: Y.Doc, id: string, entry: StyleEntry | null): void {
  if (id === NORMAL_STYLE || (!isBuiltinStyle(id) && !CUSTOM_STYLE.test(id))) return;
  const map = doc.getMap(STYLES_MAP);
  if (!entry || (isBuiltinStyle(id) && Object.keys(cleanStyleProps(entry.props)).length === 0)) {
    if (map.has(id)) map.delete(id);
    return;
  }
  const value = encodeStyleEntry(entry);
  if (map.get(id) !== value) map.set(id, value);
}

export function onDocStylesChange(doc: Y.Doc, fn: () => void): () => void {
  const map = doc.getMap(STYLES_MAP);
  map.observe(fn);
  return () => map.unobserve(fn);
}

/** A fresh id for a style of the document's own. */
export function newStyleId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = `u-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (CUSTOM_STYLE.test(id) && !used.has(id)) return id;
  }
}

/** The format level a document's styles need: a style with tab stops is
 *  level 4 (an older app changing that style would lose them). */
export function styleLevel(doc: Y.Doc): number {
  return Object.values(readDocStyles(doc)).some((entry) => entry.props.tabs) ? 4 : 1;
}
