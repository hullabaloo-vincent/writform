/**
 * Where the issue being looked at occurs, drawn in the text. Decorations:
 * nothing in the document changes. The plugin is added when the Check
 * panel opens and taken away when it closes, so a closed panel costs the
 * editor nothing at all.
 */

import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface Painted {
  from: number;
  to: number;
  current?: boolean;
  /** Which of the reports' six tints (a finding's places have their own). */
  slot?: number;
}

const proofKey = new PluginKey<DecorationSet>("wf-proof");

/** How many places are drawn at once. (The list always has them all.) */
export const PAINT_MAX = 500;

function build(doc: Parameters<typeof DecorationSet.create>[0], ranges: Painted[]): DecorationSet {
  const size = doc.content.size;
  const list: Decoration[] = [];
  for (const r of ranges) {
    if (r.from < 0 || r.to > size) continue;
    const cls = `wf-proof-hit${r.slot === undefined ? "" : ` s${r.slot % 6}`}${r.current ? " current" : ""}`;
    if (r.to > r.from) list.push(Decoration.inline(r.from, r.to, { class: cls }));
    else {
      // Nothing to underline (a space that is missing): a mark between letters.
      list.push(
        Decoration.widget(
          r.from,
          () => {
            const gap = document.createElement("span");
            gap.className = `wf-proof-gap${r.current ? " current" : ""}`;
            return gap;
          },
          { side: -1, key: `gap${r.current ? "c" : ""}` },
        ),
      );
    }
  }
  return DecorationSet.create(doc, list);
}

export function addProofPlugin(editor: Editor): void {
  if (proofKey.getState(editor.state)) return;
  editor.registerPlugin(
    new Plugin<DecorationSet>({
      key: proofKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const next = tr.getMeta(proofKey) as Painted[] | undefined;
          if (next) return build(tr.doc, next);
          return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
        },
      },
      props: { decorations: (state) => proofKey.getState(state) },
    }),
  );
}

export function removeProofPlugin(editor: Editor): void {
  if (!editor.isDestroyed && proofKey.getState(editor.state)) editor.unregisterPlugin(proofKey);
}

export const hasProofPlugin = (editor: Editor): boolean => !!proofKey.getState(editor.state);

/** Draw these places (none: clear). Never moves the selection, and is not
 *  a step anyone can undo. */
export function paintProof(editor: Editor, ranges: Painted[]): void {
  if (editor.isDestroyed || !proofKey.getState(editor.state)) return;
  editor.view.dispatch(editor.state.tr.setMeta(proofKey, ranges.slice(0, PAINT_MAX)).setMeta("addToHistory", false));
}
