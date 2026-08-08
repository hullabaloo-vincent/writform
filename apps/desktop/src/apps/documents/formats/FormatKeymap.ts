import { Extension, InputRule } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

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

/**
 * Tab, in priority order: indent the list item, cycle the format's element
 * vocabulary, or insert a tab character. Every branch consumes the key —
 * unbound, Tab moves focus to the toolbar and leaves the page behind, which
 * reads as "Tab does nothing" in plain documents where no format claims it.
 */
function handleTab(editor: Editor, format: string, dir: 1 | -1): boolean {
  if (editor.isActive("listItem")) {
    return dir === 1
      ? editor.commands.sinkListItem("listItem") || indent(editor)
      : editor.commands.liftListItem("listItem") || outdent(editor);
  }
  if (cycleElement(editor, format, dir)) return true;
  return dir === 1 ? indent(editor) : outdent(editor);
}

function handleEnter(editor: Editor, format: string): boolean {
  const spec = FORMAT_SPECS[format];
  if (!spec || !editor.isActive("paragraph")) return false;
  const { $from, empty } = editor.state.selection;
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
      if (FORMAT_SPECS[format]) {
        shortcuts.Enter = () => handleEnter(this.editor, format);
        if (format === "screenplay") {
          FORMAT_SPECS.screenplay.elements.forEach((element, index) => {
            shortcuts[`Mod-${index + 1}`] = () => setElement(this.editor, element.id);
          });
        }
      }
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
