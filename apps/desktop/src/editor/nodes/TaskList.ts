/**
 * Checklists, and bullet styles. Schema level 2.
 *
 * A checklist is a list of its own (`taskList` of `taskItem`s) rather than
 * a flag on bullets: an older app must not show a to-do list as plain
 * bullets and lose the ticks on the next edit — the level gate keeps it
 * out instead. A bullet list's `marker` is only how it is drawn.
 */

import { Extension, mergeAttributes, Node, type Editor } from "@tiptap/core";
import type { Node as PmNode, NodeType } from "@tiptap/pm/model";

import { markerAttr } from "../schema/sanitize";

export const TaskList = Node.create({
  name: "taskList",
  group: "block list",
  content: "taskItem+",

  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]', priority: 51 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["ul", mergeAttributes(HTMLAttributes, { "data-type": "taskList" }), 0];
  },

  addKeyboardShortcuts() {
    return {
      // Word has no key for a checklist; this is the one most editors use.
      "Mod-Shift-9": () => toggleChecklist(this.editor),
    };
  },
});

export const TaskItem = Node.create({
  name: "taskItem",
  content: "paragraph block*",
  defining: true,

  addAttributes() {
    return {
      checked: {
        default: null,
        // The next item starts unticked.
        keepOnSplit: false,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-checked") === "true" ? true : null),
        renderHTML: (attrs: { checked?: unknown }) => ({ "data-checked": attrs.checked === true ? "true" : "false" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]', priority: 51 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "li",
      mergeAttributes(HTMLAttributes, { "data-type": "taskItem" }),
      ["label", { contenteditable: "false" }, ["input", { type: "checkbox", ...(node.attrs.checked === true ? { checked: "checked" } : {}) }]],
      ["div", 0],
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      "Shift-Tab": () => this.editor.commands.liftListItem(this.name),
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const li = document.createElement("li");
      li.dataset.type = "taskItem";
      const label = document.createElement("label");
      label.contentEditable = "false";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", "Done");
      const content = document.createElement("div");
      label.append(box);
      li.append(label, content);

      const show = (n: PmNode) => {
        const on = n.attrs.checked === true;
        li.dataset.checked = on ? "true" : "false";
        box.checked = on;
        box.disabled = !editor.isEditable;
      };
      show(node);

      // The box mustn't take the caret out of the text.
      label.addEventListener("mousedown", (e) => e.preventDefault());
      box.addEventListener("change", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (!editor.isEditable || pos === undefined) {
          box.checked = !box.checked;
          return;
        }
        const now = editor.state.doc.nodeAt(pos);
        if (!now || now.type.name !== "taskItem") return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...now.attrs, checked: box.checked ? true : null }));
      });

      return {
        dom: li,
        contentDOM: content,
        update: (next) => {
          if (next.type.name !== "taskItem") return false;
          show(next);
          return true;
        },
      };
    };
  },
});

/** How a bullet list is marked (`•`, `–`, `→`, …). */
export const ListFormat = Extension.create({
  name: "listFormat",
  addGlobalAttributes() {
    return [
      {
        types: ["bulletList"],
        attributes: {
          marker: {
            default: null,
            parseHTML: (el: HTMLElement) => markerAttr(el.getAttribute("data-marker")),
            renderHTML: (attrs: { marker?: unknown }) => {
              const m = markerAttr(attrs.marker);
              return m ? { "data-marker": m } : {};
            },
          },
        },
      },
    ];
  },
});

/** Rebuild a list as another kind, keeping what its items hold. */
function retype(list: PmNode, listType: NodeType, itemType: NodeType): PmNode {
  const items: PmNode[] = [];
  list.forEach((item) => items.push(itemType.create(null, item.content)));
  return listType.create(null, items);
}

/**
 * Turn the selection into a checklist — or, in one already, back into
 * plain paragraphs. A bulleted or numbered list becomes a checklist item
 * for item (TipTap's own list toggle can't: the items are different nodes).
 */
export function toggleChecklist(editor: Editor): boolean {
  const { taskList, taskItem } = editor.state.schema.nodes;
  if (!taskList || !taskItem) return false;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type === taskList) return editor.chain().focus().liftListItem("taskItem").run();
    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      const pos = $from.before(depth);
      return editor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          if (dispatch) tr.replaceWith(pos, pos + node.nodeSize, retype(node, taskList, taskItem));
          return true;
        })
        .run();
    }
  }
  return editor.chain().focus().toggleList("taskList", "taskItem").run();
}

/** A bullet list with this marker (null: the usual bullets). In a checklist
 *  or a numbered list, that list becomes a bullet list. */
export function setBulletMarker(editor: Editor, marker: string | null): boolean {
  const value = markerAttr(marker);
  const { bulletList, listItem } = editor.state.schema.nodes;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type === bulletList) return editor.chain().focus().updateAttributes("bulletList", { marker: value }).run();
    if (node.type.name === "taskList") {
      const pos = $from.before(depth);
      return editor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          if (dispatch) {
            const made = retype(node, bulletList, listItem);
            tr.replaceWith(pos, pos + node.nodeSize, bulletList.create({ marker: value }, made.content));
          }
          return true;
        })
        .run();
    }
    if (node.type.name === "orderedList") break;
  }
  // (A numbered list changes kind in place, which keeps no attributes.)
  return editor
    .chain()
    .focus()
    .toggleList("bulletList", "listItem", false, { marker: value })
    .updateAttributes("bulletList", { marker: value })
    .run();
}
