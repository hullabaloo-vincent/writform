/**
 * Pasting into a book manuscript (from Word, a web page, another doc):
 * structure is translated into the manuscript's elements — a Heading 1
 * becomes a Chapter Heading, smaller headings Subheadings, a "* * *" line a
 * scene break — and the leading tabs/spaces writers use to indent are
 * dropped (indents are the book design's job).
 */

import { Extension } from "@tiptap/core";
import { Fragment, type Node as PmNode, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { SCENE_MARK } from "../../apps/documents/formats/FormatKeymap";

function stripLeading(node: PmNode): PmNode {
  const first = node.firstChild;
  if (!first || !first.isText || !first.text) return node;
  const trimmed = first.text.replace(/^[\t \u00A0]+/, "");
  if (trimmed === first.text) return node;
  const children: PmNode[] = [];
  node.forEach((child, _offset, i) => {
    if (i === 0) {
      if (trimmed) children.push(node.type.schema.text(trimmed, first.marks));
    } else {
      children.push(child);
    }
  });
  return node.copy(Fragment.from(children));
}

function translate(node: PmNode, open: boolean): PmNode {
  const schema = node.type.schema;
  const paragraph = schema.nodes.paragraph;
  if (node.type.name === "heading" && paragraph) {
    const level = (node.attrs.level as number) ?? 1;
    return paragraph.create(
      { ...node.attrs, element: level === 1 ? "chapter_heading" : "subheading" },
      node.content,
      node.marks,
    );
  }
  if (node.type.name === "paragraph") {
    const text = node.textContent;
    // An open end merges into the surrounding paragraph: it must stay a
    // textblock, so it can't become a (leaf) scene break.
    if (!open && text.trim() && SCENE_MARK.test(text) && schema.nodes.horizontalRule) {
      return schema.nodes.horizontalRule.create();
    }
    return stripLeading(node);
  }
  return node;
}

export const ManuscriptPaste = Extension.create({
  name: "manuscriptPaste",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("wf-ms-paste"),
        props: {
          transformPasted: (slice) => {
            // Only whole pasted blocks change; a phrase pasted into a
            // paragraph (an open slice of one textblock) is left alone.
            if (slice.content.childCount < 2 && slice.openStart > 0) return slice;
            const blocks: PmNode[] = [];
            const last = slice.content.childCount - 1;
            slice.content.forEach((node, _offset, i) => {
              const open = (i === 0 && slice.openStart > 0) || (i === last && slice.openEnd > 0);
              blocks.push(node.isBlock ? translate(node, open) : node);
            });
            return new Slice(Fragment.from(blocks), slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
});
