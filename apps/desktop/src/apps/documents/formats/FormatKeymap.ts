import { Extension, InputRule } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

import { SCENE_MARK } from "../../../book/model/chapters";
import { insertPageBreak } from "../../../editor/TextFormat";
import { opensSection } from "./DocElement";
import { FORMAT_SPECS } from "./elements";

function currentElement(editor: Editor, format: string): string | null {
  const spec = FORMAT_SPECS[format];
  if (!spec) return null;
  const attrs = editor.getAttributes("paragraph");
  return (attrs.element as string | undefined) ?? spec.defaultElement;
}

function cycleElement(editor: Editor, format: string, dir: 1 | -1): boolean {
  const spec = FORMAT_SPECS[format];
  if (!spec || !editor.isActive("paragraph")) return false;
  const current = currentElement(editor, format);
  const ids = spec.elements.map((e) => e.id);
  const at = Math.max(0, ids.indexOf(current ?? spec.defaultElement));
  const next = ids[(at + dir + ids.length) % ids.length];
  return editor.chain().focus().updateAttributes("paragraph", { element: next }).run();
}

function setElement(editor: Editor, element: string): boolean {
  if (!editor.isActive("paragraph")) return false;
  return editor.chain().focus().updateAttributes("paragraph", { element }).run();
}

function indent(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      // insertText rather than insertContent: a lone tab handed to the HTML
      // parser is whitespace, and collapses to nothing.
      if (dispatch) tr.insertText("\t");
      return true;
    })
    .run();
}

/** Shift-Tab eats the tab character before the cursor, if that's what's
 *  there. Anything else falls through so Shift-Tab can still walk focus out
 *  of the editor — Tab alone never escapes, so this is the way back. */
function outdent(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parentOffset === 0) return false;
  const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset);
  if (before !== "\t") return false;
  return editor
    .chain()
    .focus()
    .deleteRange({ from: $from.pos - 1, to: $from.pos })
    .run();
}

const TAB_HINT_KEY = "wf-hint-ms-tab";

/** Once per device: why Tab "did nothing" on a Manuscript line. */
function tabHintOnce() {
  try {
    if (localStorage.getItem(TAB_HINT_KEY)) return;
    localStorage.setItem(TAB_HINT_KEY, "1");
  } catch {
    return;
  }
  void import("../../../platform/toast").then(({ toast }) =>
    toast(
      "Indents are automatic in Manuscript. Press Tab on an empty line to change its element.",
      "info",
      { durationMs: 7000 },
    ),
  );
}

/**
 * Tab, in priority order: indent the list item; cycle the format's element
 * vocabulary (script formats anywhere, prose formats only on an empty line);
 * otherwise what the format says — swallow (Manuscript: indents are
 * automatic, and Tab must never turn body text into a heading), or insert a
 * tab character. Every branch consumes Tab — unbound, it moves focus to the
 * toolbar and leaves the page behind. Shift-Tab on text falls through so
 * focus can still leave the editor.
 */
function handleTab(editor: Editor, format: string, dir: 1 | -1): boolean {
  if (editor.isActive("listItem")) {
    return dir === 1
      ? editor.commands.sinkListItem("listItem") || indent(editor)
      : editor.commands.liftListItem("listItem") || outdent(editor);
  }
  const spec = FORMAT_SPECS[format];
  const { $from } = editor.state.selection;
  const emptyLine = $from.parent.isTextblock && $from.parent.content.size === 0;
  if (spec && (spec.tabOnText === "cycle" || emptyLine)) {
    if (cycleElement(editor, format, dir)) return true;
  }
  if (spec?.tabOnText === "swallow") {
    if (dir === -1) return outdent(editor);
    tabHintOnce();
    return true;
  }
  return dir === 1 ? indent(editor) : outdent(editor);
}

export { SCENE_MARK };

function handleEnter(editor: Editor, format: string): boolean {
  const spec = FORMAT_SPECS[format];
  if (!spec || !editor.isActive("paragraph")) return false;
  // Inside a list, Enter makes the next item (the list keymap handles it).
  if (editor.isActive("listItem")) return false;
  const { $from, empty } = editor.state.selection;
  const atEnd = empty && $from.parentOffset === $from.parent.content.size;

  if (format === "manuscript" && atEnd) {
    const text = $from.parent.textContent;
    // Typing a scene-break mark on its own line and pressing Enter makes a
    // real scene break (the book design draws the ornament).
    if (text.trim() && SCENE_MARK.test(text)) {
      const start = $from.before();
      const end = $from.after();
      return editor
        .chain()
        .command(({ tr, state, dispatch }) => {
          const { horizontalRule, paragraph } = state.schema.nodes;
          if (!horizontalRule || !paragraph) return false;
          if (dispatch) {
            tr.replaceWith(start, end, [
              horizontalRule.create(),
              paragraph.create({ element: spec.defaultElement }),
            ]);
            tr.setSelection(TextSelection.create(tr.doc, start + 2));
            tr.scrollIntoView();
          }
          return true;
        })
        .run();
    }
  }
  // Verse: Enter is a new line; Enter on an empty last line ends the stanza.
  if (
    format === "manuscript" &&
    empty &&
    $from.parent.content.size > 0 &&
    (editor.getAttributes("paragraph").element as string | undefined) === "verse"
  ) {
    if (atEnd && $from.nodeBefore?.type.name === "hardBreak") {
      return editor
        .chain()
        .command(({ tr, dispatch }) => {
          if (dispatch) tr.delete($from.pos - 1, $from.pos);
          return true;
        })
        .splitBlock()
        .updateAttributes("paragraph", { element: "verse" })
        .run();
    }
    return editor.chain().setHardBreak().run();
  }
  // Enter at the very start of a line with text opens an empty line ABOVE
  // it and leaves this line's element alone. (Splitting here used to hand
  // the text to the new half and re-type it as the follower element.)
  if (empty && $from.parentOffset === 0 && $from.parent.content.size > 0) {
    return editor
      .chain()
      .command(({ tr, state, dispatch }) => {
        const paragraph = state.schema.nodes.paragraph;
        if (!paragraph) return false;
        if (dispatch) {
          tr.insert($from.before(), paragraph.create({ element: spec.defaultElement }));
          tr.scrollIntoView();
        }
        return true;
      })
      .run();
  }
  // Enter on an empty paragraph resets it to the default element instead of
  // stacking blank lines in an exotic element (Final Draft behavior).
  if (empty && $from.parent.content.size === 0) {
    const current = currentElement(editor, format);
    if (current !== spec.defaultElement) {
      return editor
        .chain()
        .focus()
        .updateAttributes("paragraph", { element: spec.defaultElement })
        .run();
    }
    return false; // default split — a plain empty default paragraph
  }
  const follower = spec.follower[currentElement(editor, format) ?? ""] ?? spec.defaultElement;
  return editor
    .chain()
    .focus()
    .splitBlock()
    .updateAttributes("paragraph", { element: follower })
    .run();
}

/**
 * ⌘↩ in a book manuscript: what follows the cursor starts a new page — a
 * letter, a poem, an interlude on a page of its own. Like Enter, a line
 * split here goes on as the element's follower. At the start of a chapter
 * heading there's nothing to do: chapters always start on a new page. (The
 * key is taken either way, so it never falls through to a line break.)
 */
function breakPage(editor: Editor, format: string): boolean {
  const spec = FORMAT_SPECS[format];
  const { $from, empty } = editor.state.selection;
  if (empty && $from.parentOffset === 0 && opensSection($from.parent)) return true;
  const follower = spec.follower[currentElement(editor, format) ?? ""] ?? spec.defaultElement;
  insertPageBreak(editor, follower);
  return true;
}

/**
 * Per-format keymap: Tab / Shift-Tab cycle the paragraph's element type,
 * Enter starts the format-defined follower element. Typing `INT.`/`EXT.`
 * at the start of a screenplay paragraph promotes it to a scene heading.
 * Tab is bound for every format, including plain documents, where it
 * indents instead.
 */
export function formatKeymap(format: string) {
  return Extension.create({
    name: "formatKeymap",

    addKeyboardShortcuts() {
      const shortcuts: Record<string, () => boolean> = {
        Tab: () => handleTab(this.editor, format, 1),
        "Shift-Tab": () => handleTab(this.editor, format, -1),
      };
      const spec = FORMAT_SPECS[format];
      if (spec) {
        shortcuts.Enter = () => handleEnter(this.editor, format);
        // ⌘1… picks elements wherever the format names a shortcut
        // (Screenplay ⌘1–6, Manuscript ⌘1–9).
        for (const element of spec.elements) {
          const digit = /^⌘(\d)$/.exec(element.shortcut ?? "")?.[1];
          if (digit) shortcuts[`Mod-${digit}`] = () => setElement(this.editor, element.id);
        }
      }
      if (format === "manuscript") shortcuts["Mod-Enter"] = () => breakPage(this.editor, format);
      return shortcuts;
    },

    addInputRules() {
      if (format !== "screenplay") return [];
      return [
        new InputRule({
          find: /^(INT|EXT|INT\/EXT|I\/E)\.\s$/,
          handler: ({ state, range }) => {
            const $pos = state.doc.resolve(range.from);
            if ($pos.parent.type.name !== "paragraph") return;
            state.tr.setNodeMarkup($pos.before(), undefined, {
              ...$pos.parent.attrs,
              element: "scene_heading",
            });
          },
        }),
      ];
    },
  });
}
