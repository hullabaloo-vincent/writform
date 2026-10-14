import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { carryAcross } from "./Paginate";
import { showRange } from "./ui/reveal";

/**
 * Where the writer last changed the text: the last few places, newest
 * first, so a key can take them back there after reading up the page
 * (Shift+F5 in a word processor).
 *
 * A place is where the caret was left by an edit. Edits in one paragraph
 * are one place (the latest). The places are kept true as the text changes
 * around them, by the writer or by someone else. What others change, and
 * an undo, is not the writer's writing and makes no place.
 */

const KEEP = 4;

interface Places {
  /** Newest first. */
  list: number[];
  /** Which of them was last gone back to (-1: none since the last edit). */
  at: number;
}

export const editPlacesKey = new PluginKey<Places>("wf-edit-places");

/** Two places in one paragraph (or cell, or line of a script). */
function together(doc: PmNode, a: number, b: number): boolean {
  try {
    const $a = doc.resolve(a);
    const $b = doc.resolve(b);
    return $a.depth > 0 && $a.depth === $b.depth && $a.start() === $b.start();
  } catch {
    return false;
  }
}

export const EditPlaces = Extension.create({
  name: "editPlaces",

  addProseMirrorPlugins() {
    return [
      new Plugin<Places>({
        key: editPlacesKey,
        state: {
          init: () => ({ list: [], at: -1 }),
          apply(tr, value, _old, next) {
            const went = tr.getMeta(editPlacesKey) as number | undefined;
            if (went !== undefined) return { ...value, at: went };
            if (!tr.docChanged) return value;
            const size = tr.doc.content.size;
            // A change from the shared document (someone else's, or an
            // undo) replaces the text whole: places are carried over what
            // did not change. The writer's own are mapped as usual.
            const foreign = !!(tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin;
            const carry = foreign ? carryAcross(tr.before, tr.doc) : (pos: number) => tr.mapping.map(pos);
            const list: number[] = [];
            for (const pos of value.list) {
              const now = carry(pos);
              if (now !== null && now >= 0 && now <= size && !list.some((p) => together(tr.doc, p, now))) list.push(now);
            }
            if (foreign) return { list, at: Math.min(value.at, list.length - 1) };
            const head = next.selection.head;
            const rest = list.filter((p) => !together(tr.doc, p, head));
            return { list: [head, ...rest].slice(0, KEEP), at: -1 };
          },
        },
      }),
    ];
  },
});

/** The places, newest first (for tests, and to say whether there are any). */
export function editPlaces(editor: Editor): number[] {
  return editPlacesKey.getState(editor.state)?.list ?? [];
}

/**
 * Go back to where the text was last changed. Again goes to the place
 * before that, and round to the newest after the oldest. (From the place
 * just written in, the first step goes to the one before: there is nothing
 * to go back to in where the caret already is.)
 */
export function goBackToEdit(editor: Editor): boolean {
  const places = editPlacesKey.getState(editor.state);
  if (!places || !places.list.length) return false;
  const { list } = places;
  let next = (places.at + 1) % list.length;
  if (places.at < 0 && list.length > 1 && together(editor.state.doc, list[0], editor.state.selection.head)) next = 1;
  editor.view.dispatch(editor.state.tr.setMeta(editPlacesKey, next));
  showRange(editor.view, list[next], list[next], true);
  return true;
}
