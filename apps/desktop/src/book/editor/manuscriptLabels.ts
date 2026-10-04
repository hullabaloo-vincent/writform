/**
 * Chapter and part labels in the Manuscript editor — "Chapter Three" above a
 * chapter heading, exactly as the book design will number it — plus a quiet
 * warning when a typed number ("Chapter 7") no longer matches where the
 * chapter sits. Node-decoration ATTRIBUTES drawn by CSS `::before`, not
 * widgets: nothing is inserted into the editable DOM, so the caret and
 * selection never trip over a label.
 */

import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

import type { BookDesign } from "../model/presets";
import { presetDesign } from "../model/presets";
import { scanStructure } from "../model/structure";

export const manuscriptLabelsKey = new PluginKey<DecorationSet>("wf-ms-labels");

type LabelDesign = Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">;

function build(doc: PmNode, design: LabelDesign): DecorationSet {
  const { entries } = scanStructure(doc, "manuscript", design);
  const decos: Decoration[] = [];
  for (const entry of entries) {
    if (entry.kind !== "chapter" && entry.kind !== "part") continue;
    const node = doc.child(entry.index);
    const attrs: Record<string, string> = {};
    if (entry.mismatch && entry.label) {
      attrs["data-label-warn"] = `Prints as ${entry.label}`;
    } else if (entry.literal === null && entry.label) {
      // The number isn't visible in the text: show what will print.
      attrs["data-label"] = entry.label;
    }
    if (Object.keys(attrs).length) {
      decos.push(Decoration.node(entry.pos, entry.pos + node.nodeSize, attrs));
    }
  }
  return DecorationSet.create(doc, decos);
}

export interface ManuscriptLabelsOptions {
  /** Read on every rebuild, so a design change shows after a refresh. */
  getDesign: () => LabelDesign;
}

export const ManuscriptLabels = Extension.create<ManuscriptLabelsOptions>({
  name: "manuscriptLabels",

  addOptions() {
    return { getDesign: () => presetDesign("classic") };
  },

  addProseMirrorPlugins() {
    const getDesign = () => this.options.getDesign();
    return [
      new Plugin<DecorationSet>({
        key: manuscriptLabelsKey,
        state: {
          init: (_, state) => build(state.doc, getDesign()),
          apply: (tr, set, _old, state) =>
            tr.docChanged || tr.getMeta(manuscriptLabelsKey) ? build(state.doc, getDesign()) : set,
        },
        props: {
          decorations: (state) => manuscriptLabelsKey.getState(state),
        },
      }),
    ];
  },
});

/** Re-label after the book design changed (numbering style, label word). */
export function refreshManuscriptLabels(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(manuscriptLabelsKey, true));
}
