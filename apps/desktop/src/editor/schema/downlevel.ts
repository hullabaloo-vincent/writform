/**
 * Down-conversion: content rewritten to fit an older schema level, for the
 * places that can't take newer vocabulary — a server that hasn't been
 * updated yet, or a paste into a document held at a lower level.
 *
 * The words always survive. What the level can't express degrades:
 *  - marks and attributes it doesn't know are dropped;
 *  - a block it doesn't know becomes plain paragraphs of its text (a table
 *    becomes a paragraph per cell paragraph), or nothing if it has no text;
 *  - an inline node it doesn't know becomes its text in brackets (a
 *    footnote), or nothing;
 *  - a level without tracked changes gets the text with them accepted:
 *    what someone suggested deleting is left out, not brought back.
 */

import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";

import { resolvedJson } from "../review/resolve";
import { levels as buildLevels, type Levels } from "./levels";

function plainText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainText).join("");
}

interface Converter {
  inline(children: JSONContent[]): JSONContent[];
  blocks(node: JSONContent): JSONContent[];
}

/** `schema` is this build's full schema (it says what is a block, a
 *  textblock, inline); `level` is what the result may use. */
function converter(level: number, schema: Schema, lv: Levels): Converter {
  const attrsOf = (name: string, attrs: JSONContent["attrs"]) => {
    if (!attrs) return undefined;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (lv.knowsNodeAttr(name, key, level)) kept[key] = value;
    }
    return kept;
  };

  const marksOf = (marks: JSONContent["marks"]) => {
    const kept = (marks ?? [])
      .filter((m) => lv.knowsMark(m.type, level))
      .map((m) => {
        if (!m.attrs) return m;
        const attrs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(m.attrs)) {
          if (lv.knowsMarkAttr(m.type, key, level)) attrs[key] = value;
        }
        return { ...m, attrs };
      });
    return kept.length ? kept : undefined;
  };

  const tidy = (node: JSONContent): JSONContent => {
    const out: JSONContent = { ...node };
    if (out.attrs === undefined) delete out.attrs;
    if (out.marks === undefined) delete out.marks;
    if (out.content === undefined) delete out.content;
    return out;
  };

  /** Deleted, as a tracked change this level can't hold. */
  const struck = (node: JSONContent): boolean =>
    (!lv.knowsMark("deletion", level) && !!node.marks?.some((m) => m.type === "deletion")) ||
    (!lv.knowsNodeAttr(node.type ?? "", "tc", level) && typeof node.attrs?.tc === "string" && node.attrs.tc.includes("del:") && node.type !== "paragraph" && node.type !== "heading");

  const inline = (children: JSONContent[]): JSONContent[] => {
    const out: JSONContent[] = [];
    for (const child of children) {
      if (struck(child)) continue;
      const name = child.type ?? "text";
      if (name === "text") {
        if (child.text) out.push(tidy({ ...child, marks: marksOf(child.marks) }));
      } else if (lv.knowsNode(name, level)) {
        out.push(
          tidy({
            ...child,
            attrs: attrsOf(name, child.attrs),
            marks: marksOf(child.marks),
            content: child.content ? inline(child.content) : undefined,
          }),
        );
      } else {
        const text = plainText(child).trim();
        if (text) out.push({ type: "text", text: ` [${text}]` });
      }
    }
    return out;
  };

  const paragraph = (content: JSONContent[]): JSONContent[] =>
    content.length ? [{ type: "paragraph", content }] : [];

  const blocks = (node: JSONContent): JSONContent[] => {
    if (struck(node)) return [];
    const name = node.type ?? "paragraph";
    const type = schema.nodes[name];
    const children = node.content ?? [];
    const known = lv.knowsNode(name, level);
    if (!type) {
      // Not even this build knows it: keep whatever words it has.
      return paragraph(plainText(node).trim() ? [{ type: "text", text: plainText(node) }] : []);
    }
    if (type.isTextblock) {
      const content = inline(children);
      if (!known) return paragraph(content);
      return [tidy({ ...node, attrs: attrsOf(name, node.attrs), content: content.length ? content : undefined })];
    }
    if (type.isLeaf) return known ? [tidy({ ...node, attrs: attrsOf(name, node.attrs) })] : [];
    const content = children.flatMap(blocks);
    // A container the level doesn't know dissolves into what it held.
    if (!known) return content;
    return content.length ? [tidy({ ...node, attrs: attrsOf(name, node.attrs), content })] : [];
  };

  return { inline, blocks };
}

/** A whole document (`{ type: "doc", … }`) at `level`. */
export function downlevelJson(source: JSONContent, level: number, schema: Schema, lv: Levels = buildLevels): JSONContent {
  if (lv.ofJson(source) <= level) return source;
  // (Accepted properly first, so paragraphs a suggestion joins are joined.)
  const doc = lv.knowsMark("deletion", level) ? source : resolvedJson(source, "accept", schema);
  const content = (doc.content ?? []).flatMap(converter(level, schema, lv).blocks);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** A pasted or dropped slice at `level` (unchanged when it already fits). */
export function downlevelSlice(slice: Slice, level: number, schema: Schema, lv: Levels = buildLevels): Slice {
  const json = (slice.content.toJSON() ?? []) as JSONContent[];
  if (json.every((node) => lv.ofJson(node) <= level)) return slice;
  const convert = converter(level, schema, lv);
  if (slice.content.firstChild?.isInline) {
    return new Slice(Fragment.fromJSON(schema, convert.inline(json)), 0, 0);
  }
  const content = json.flatMap(convert.blocks);
  // The open ends only still fit if the outer structure is what it was.
  const same = content.length === json.length && content.every((node, i) => node.type === json[i].type);
  return new Slice(Fragment.fromJSON(schema, content), same ? slice.openStart : 0, same ? slice.openEnd : 0);
}
