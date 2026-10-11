/**
 * Footnotes and endnotes. Schema level 2.
 *
 * A note is an inline node that sits where its reference number is, and
 * holds its own text. So the note travels with the sentence it belongs to
 * — cut, pasted, deleted or restored together — and two people can write
 * in the same note at once (its text is ordinary document text to the
 * sync engine, merged like any other).
 *
 * In the text only the number shows. Selecting it opens the note in a
 * small editor of its own beneath the reference; on the page (preview,
 * print, PDF) footnotes are set at the foot of the page they're cited on
 * and endnotes at the end of the document. Numbers are worked out from
 * the order of the notes, never stored.
 */

import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { toggleMark } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import type { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { StepMap } from "@tiptap/pm/transform";
import { EditorView } from "@tiptap/pm/view";

import { showRev } from "../review/TrackMarks";
import { noteKind, noteNumber, type NoteKind } from "../schema/sanitize";

/** The note editors that are open, by the reference they hang from (so
 *  something outside — a test — can reach the one for a given note). */
export const openNotes = new WeakMap<Element, EditorView>();

// (How a note's kind and number are read lives with the other readers,
// where the page layout — which runs in a worker — can reach it.)
export { noteKind, noteNumber, type NoteKind };

/** The number of the note at `pos` among the notes of its kind. */
function numberAt(doc: PmNode, pos: number, kind: NoteKind): number {
  let n = 0;
  doc.nodesBetween(0, Math.min(doc.content.size, pos + 1), (node, at) => {
    if (node.type.name === "footnote" && at <= pos && noteKind(node.attrs.kind) === kind) n += 1;
    return node.type.name !== "footnote";
  });
  return Math.max(1, n);
}

/** A note open for writing: an editor of its own, whose every change goes
 *  into the document as it's made. */
export interface NoteEditorHandle {
  view: EditorView;
  /** The note as it now stands in the document (someone else's typing in
   *  it, an undo): shown as the smallest change that explains it. */
  update(next: PmNode): void;
  /** Take the caret, at the end of what's written. */
  focusEnd(): void;
  destroy(): void;
}

/**
 * Open a note for writing inside `mount` — beside its number in the text,
 * or in the list of notes at the end of the document. What's typed is
 * stepped into the document at once; Enter and Escape say "done".
 */
export function mountNoteEditor(opts: {
  editor: Editor;
  /** Where the note is in the document now. */
  position: () => number | undefined;
  node: PmNode;
  mount: HTMLElement;
  onDone: () => void;
}): NoteEditorHandle {
  const { editor } = opts;
  const outer = editor.view;
  const kind = noteKind(opts.node.attrs.kind);

  /** What's typed in the note goes into the document as it's typed. */
  const dispatchInner = (tr: Transaction) => {
    const { state, transactions } = view.state.applyTransaction(tr);
    view.updateState(state);
    if (tr.getMeta("fromOutside")) return;
    const at = opts.position();
    if (at === undefined) return;
    const outerTr = outer.state.tr;
    const offset = StepMap.offset(at + 1);
    for (const one of transactions) {
      for (const step of one.steps) {
        const mapped = step.map(offset);
        if (mapped) outerTr.step(mapped);
      }
    }
    if (outerTr.docChanged) outer.dispatch(outerTr);
  };

  const marks = outer.state.schema.marks;
  const bind: Record<string, (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean> = {
    Escape: () => {
      opts.onDone();
      return true;
    },
    Enter: () => {
      opts.onDone();
      return true;
    },
    "Mod-z": () => editor.commands.undo(),
    "Mod-Shift-z": () => editor.commands.redo(),
    "Mod-y": () => editor.commands.redo(),
  };
  if (marks.bold) bind["Mod-b"] = toggleMark(marks.bold);
  if (marks.italic) bind["Mod-i"] = toggleMark(marks.italic);
  if (marks.underline) bind["Mod-u"] = toggleMark(marks.underline);
  const view: EditorView = new EditorView(opts.mount, {
    state: EditorState.create({ doc: opts.node, plugins: [keymap(bind)] }),
    dispatchTransaction: dispatchInner,
    editable: () => editor.isEditable,
    attributes: { class: "wf-fn-text", "aria-label": kind === "end" ? "Endnote" : "Footnote", spellcheck: "true" },
    handleDOMEvents: {
      mousedown: () => {
        // A click in the note takes the focus from the text around it.
        if (outer.hasFocus()) view.focus();
        return false;
      },
    },
  });

  return {
    view,
    update(next) {
      const state = view.state;
      const start = next.content.findDiffStart(state.doc.content);
      if (start === null || start === undefined) return;
      const diff = next.content.findDiffEnd(state.doc.content);
      if (!diff) return;
      let { a: endA, b: endB } = diff;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      view.dispatch(state.tr.replace(start, endB, next.slice(start, endA)).setMeta("fromOutside", true));
    },
    focusEnd() {
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).setMeta("fromOutside", true));
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}

/** One note of a document, for a list of them. */
export interface NoteEntry {
  /** Where its reference is in the text. */
  pos: number;
  kind: NoteKind;
  /** Its number as written beside the text (1, 2, 3 — i, ii, iii). */
  label: string;
  text: string;
  /** Someone has suggested removing it. */
  removed: boolean;
}

/** Every footnote and endnote, in the order they are cited. */
export function listNotes(doc: PmNode): NoteEntry[] {
  const out: NoteEntry[] = [];
  const count = { foot: 0, end: 0 };
  doc.descendants((node, pos) => {
    if (node.type.name !== "footnote") return true;
    const kind = noteKind(node.attrs.kind);
    count[kind] += 1;
    out.push({
      pos,
      kind,
      label: noteNumber(count[kind], kind),
      text: node.textContent,
      removed: typeof node.attrs.tc === "string" && /(^|\n)del:/.test(node.attrs.tc),
    });
    return false;
  });
  return out;
}

export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  content: "text*",
  // One unit in the text around it: the caret steps over it, a click
  // selects it.
  atom: true,

  addAttributes() {
    return {
      kind: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute("data-kind") === "end" ? "end" : null),
        renderHTML: (attrs: { kind?: unknown }) => (attrs.kind === "end" ? { "data-kind": "end" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-footnote]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-footnote": "" }), 0];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const outer = editor.view;
      const dom = document.createElement("sup");
      dom.className = "wf-fn";
      let current = node;
      let inner: NoteEditorHandle | null = null;
      let pop: HTMLDivElement | null = null;
      let reposition: (() => void) | null = null;

      const show = (n: PmNode) => {
        if (noteKind(n.attrs.kind) === "end") dom.dataset.kind = "end";
        else delete dom.dataset.kind;
        // A note someone suggests adding or removing says so instead.
        if (!showRev(dom, n.attrs.tc)) dom.title = n.textContent.slice(0, 300) || (noteKind(n.attrs.kind) === "end" ? "Empty endnote" : "Empty footnote");
      };
      show(node);

      const position = (): number | undefined => (typeof getPos === "function" ? getPos() : undefined);

      const close = (focusOuter: boolean) => {
        if (!inner) return;
        inner.destroy();
        inner = null;
        openNotes.delete(dom);
        if (reposition) {
          window.removeEventListener("scroll", reposition, true);
          window.removeEventListener("resize", reposition);
          reposition = null;
        }
        pop?.remove();
        pop = null;
        dom.classList.remove("open");
        if (focusOuter) {
          const at = position();
          if (at !== undefined) {
            const after = Math.min(outer.state.doc.content.size, at + current.nodeSize);
            outer.dispatch(outer.state.tr.setSelection(TextSelection.near(outer.state.doc.resolve(after), 1)));
          }
          outer.focus();
        }
      };

      const open = () => {
        if (inner) return;
        const at = position();
        if (at === undefined) return;
        const kind = noteKind(current.attrs.kind);
        pop = document.createElement("div");
        pop.className = "wf-fn-pop";
        pop.contentEditable = "false";
        const head = document.createElement("div");
        head.className = "wf-fn-head";
        const label = document.createElement("span");
        label.textContent = `${kind === "end" ? "Endnote" : "Footnote"} ${noteNumber(numberAt(outer.state.doc, at, kind), kind)}`;
        head.append(label);
        const button = (text: string, title: string, run: () => void) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = text;
          b.title = title;
          // The note's own editor keeps the focus.
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", run);
          head.append(b);
          return b;
        };
        if (editor.isEditable) {
          button(kind === "end" ? "Make footnote" : "Make endnote", kind === "end" ? "Set it at the foot of its page" : "Set it at the end of the document", () => {
            const here = position();
            if (here === undefined) return;
            close(false);
            outer.dispatch(outer.state.tr.setNodeMarkup(here, undefined, { ...current.attrs, kind: kind === "end" ? null : "end" }));
            outer.focus();
          });
          button("Delete", "Delete this note", () => {
            const here = position();
            if (here === undefined) return;
            close(false);
            outer.dispatch(outer.state.tr.delete(here, here + current.nodeSize));
            outer.focus();
          });
        }
        button("Done", "Back to the text (Esc)", () => close(true));
        const body = document.createElement("div");
        body.className = "wf-fn-body";
        pop.append(head, body);
        dom.append(pop);
        dom.classList.add("open");

        inner = mountNoteEditor({ editor, position, node: current, mount: body, onDone: () => close(true) });
        openNotes.set(dom, inner.view);

        // Beside its number, wherever that is on the screen — fixed there,
        // so nothing that clips or scrolls (the sheet, a table) cuts it off.
        reposition = () => {
          if (!pop) return;
          const at2 = dom.getBoundingClientRect();
          const w = pop.offsetWidth;
          const h = pop.offsetHeight;
          const left = Math.max(8, Math.min(at2.left, window.innerWidth - w - 8));
          // Under the number; above it where there's no room below.
          const below = at2.bottom + 6;
          const top = below + h > window.innerHeight - 8 && at2.top - 6 - h > 8 ? at2.top - 6 - h : below;
          pop.style.left = `${left}px`;
          pop.style.top = `${top}px`;
        };
        reposition();
        window.addEventListener("scroll", reposition, true);
        window.addEventListener("resize", reposition);
        if (editor.isEditable) inner.focusEnd();
      };

      return {
        dom,
        selectNode: () => {
          dom.classList.add("ProseMirror-selectednode");
          open();
        },
        deselectNode: () => {
          dom.classList.remove("ProseMirror-selectednode");
          close(false);
        },
        update: (next) => {
          if (next.type.name !== "footnote") return false;
          const reopened = inner && next.attrs.kind !== current.attrs.kind;
          current = next;
          show(next);
          // Someone else's typing in the same note (or an undo) arrives in
          // the open editor.
          if (inner && !reopened) inner.update(next);
          return true;
        },
        // Events in the note's editor are its own.
        stopEvent: (event) => !!pop && pop.contains(event.target as globalThis.Node),
        ignoreMutation: () => true,
        destroy: () => close(false),
      };
    };
  },
});

/** Put a new note where the selection ends and open it for writing. */
export function insertNote(editor: Editor, kind: NoteKind): boolean {
  return editor
    .chain()
    .command(({ tr, state, dispatch }) => {
      const type = state.schema.nodes.footnote;
      if (!type) return false;
      const { $to } = state.selection;
      // Notes go in running text (and not inside another note).
      if (!$to.parent.isTextblock || !$to.parent.type.spec.content?.includes("inline")) return false;
      for (let d = $to.depth; d > 0; d -= 1) if ($to.node(d).type === type) return false;
      if (!$to.parent.canReplaceWith($to.index(), $to.index(), type)) return false;
      if (dispatch) {
        tr.insert($to.pos, type.create(kind === "end" ? { kind: "end" } : null));
        tr.setSelection(NodeSelection.create(tr.doc, $to.pos));
        tr.scrollIntoView();
      }
      return true;
    })
    .run();
}

/** How many notes of each kind a document has. */
export function countNotes(doc: PmNode): { foot: number; end: number } {
  const out = { foot: 0, end: 0 };
  doc.descendants((node) => {
    if (node.type.name === "footnote") {
      out[noteKind(node.attrs.kind)] += 1;
      return false;
    }
    return true;
  });
  return out;
}
