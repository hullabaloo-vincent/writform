import { Extension, type Editor } from "@tiptap/core";

import { wordRangeAt } from "./wordAt";

export type WordMark = "bold" | "italic" | "underline";

/**
 * Bold, italic or underline with nothing selected: when the caret is inside
 * a word, the whole word takes it (or loses it, if all of it had it), and
 * the caret stays where it is. Anywhere else, and with a selection, it is
 * the editor's own toggle: what is selected, or what is typed next.
 */
export function toggleWordMark(editor: Editor, name: WordMark): boolean {
  const { state } = editor;
  const type = state.schema.marks[name];
  const { empty, $from } = state.selection;
  const word = type && empty && editor.isEditable && $from.parent.type.allowsMarkType(type) ? wordRangeAt($from) : null;
  if (!type || !word) {
    const chain = editor.chain().focus();
    return (name === "bold" ? chain.toggleBold() : name === "italic" ? chain.toggleItalic() : chain.toggleUnderline()).run();
  }
  // All of it has the mark: take it off. Any of it has not: put it on all.
  let all = true;
  state.doc.nodesBetween(word.from, word.to, (node) => {
    if (node.isText && !type.isInSet(node.marks)) all = false;
  });
  const tr = state.tr;
  if (all) tr.removeMark(word.from, word.to, type);
  else tr.addMark(word.from, word.to, type.create());
  // (What is typed next goes by the word it is typed into, as ever.)
  tr.setStoredMarks(null);
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** The three keys, ahead of the editor's own bindings for them. */
export const WordMarks = Extension.create({
  name: "wordMarks",
  priority: 1000,

  addKeyboardShortcuts() {
    const on = (name: WordMark) => () => {
      const { empty, $from } = this.editor.state.selection;
      // (Only the case that is new: the rest is left to who had the key.)
      if (!empty || !wordRangeAt($from)) return false;
      return toggleWordMark(this.editor, name);
    };
    return {
      "Mod-b": on("bold"),
      "Mod-B": on("bold"),
      "Mod-i": on("italic"),
      "Mod-I": on("italic"),
      "Mod-u": on("underline"),
      "Mod-U": on("underline"),
    };
  },
});
