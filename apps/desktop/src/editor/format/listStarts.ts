import { Extension, InputRule } from "@tiptap/core";
import { canJoin, findWrapping } from "@tiptap/pm/transform";

/**
 * More ways to start a numbered list by typing its first label: "1) ",
 * "a. ", "a) ", "A. ", "i. ", "I. " (the editor's own rule already takes
 * "1. "). The list that is made is the one the ribbon's numbering menu
 * makes: a list has a kind of number and a number to start at, and no
 * bracket of its own, so "1) " and "1. " make the same list.
 *
 * Letters are words too ("a", "I"), so this is careful where the plain
 * rule need not be: the label has to be ALL there is in the paragraph, and
 * the paragraph a plain one. Backspace straight after puts back what was
 * typed.
 */

interface Kind {
  find: RegExp;
  type: string | null;
  /** The number the label stands for. */
  start: (label: string) => number;
}

const letter = (label: string) => label.toLowerCase().charCodeAt(0) - 96;

const KINDS: Kind[] = [
  // (The bracket only: "1. " is the editor's own rule.)
  { find: /^(\d{1,4})\)\s$/, type: null, start: (label) => Number(label) },
  // i and I are roman one, never the ninth letter.
  { find: /^(i)[.)]\s$/, type: "i", start: () => 1 },
  { find: /^(I)[.)]\s$/, type: "I", start: () => 1 },
  { find: /^([a-hj-z])[.)]\s$/, type: "a", start: letter },
  { find: /^([A-HJ-Z])[.)]\s$/, type: "A", start: letter },
];

export const ListStarts = Extension.create({
  name: "listStarts",

  addInputRules() {
    const list = this.editor.schema.nodes.orderedList;
    if (!list) return [];
    return KINDS.map(
      (kind) =>
        new InputRule({
          find: kind.find,
          handler: ({ state, range, match }) => {
            const $from = state.doc.resolve(range.from);
            const para = $from.parent;
            // A plain paragraph holding the label and nothing else. (The
            // space that set this off is not in the text yet.)
            if (para.type.name !== "paragraph" || para.attrs.element || para.textContent !== match[0].slice(0, -1)) return null;
            const start = kind.start(match[1]);
            if (!(start >= 1)) return null;
            const attrs = { type: kind.type, start };
            const tr = state.tr.delete(range.from, range.to);
            const blockRange = tr.doc.resolve(range.from).blockRange();
            const wrapping = blockRange && findWrapping(blockRange, list, attrs);
            if (!wrapping) return null;
            tr.wrap(blockRange, wrapping);
            // The next label of the list just above carries that list on.
            const before = tr.doc.resolve(range.from - 1).nodeBefore;
            if (before && before.type === list && (before.attrs.type ?? null) === kind.type && before.childCount + Number(before.attrs.start ?? 1) === start && canJoin(tr.doc, range.from - 1)) {
              tr.join(range.from - 1);
            }
            return undefined;
          },
        }),
    );
  },
});
