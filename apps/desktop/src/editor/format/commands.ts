/**
 * Formatting commands the ribbon offers beyond the editor's own: change
 * case, clear formatting, sort, grow and shrink, list numbering — each one
 * transaction, so each is one undo step. Level-1 vocabulary only (what
 * needs level 2 is in run.ts, ParaFormat.ts and nodes/TaskList.ts).
 */

import { specialCharacter } from "../ui/symbols";
import { getMarkRange, type Editor } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState } from "@tiptap/pm/state";

import { isStyleElement } from "../styles/sheet";


export type CaseKind = "sentence" | "lower" | "upper" | "title" | "toggle";

function recase(text: string, kind: CaseKind, startOfSentence: boolean): { text: string; sentenceOpen: boolean } {
  switch (kind) {
    case "lower":
      return { text: text.toLocaleLowerCase(), sentenceOpen: false };
    case "upper":
      return { text: text.toLocaleUpperCase(), sentenceOpen: false };
    case "toggle":
      return {
        text: [...text].map((ch) => (ch === ch.toLocaleLowerCase() ? ch.toLocaleUpperCase() : ch.toLocaleLowerCase())).join(""),
        sentenceOpen: false,
      };
    case "title":
      return {
        text: text.toLocaleLowerCase().replace(/(^|[\s\-–—("“‘])(\p{L})/gu, (_, lead: string, ch: string) => lead + ch.toLocaleUpperCase()),
        sentenceOpen: false,
      };
    default: {
      // Sentence case: lower everything, then capitalize after . ! ? and at
      // the start. The state carries across the selection's text nodes.
      let open = startOfSentence;
      let out = "";
      for (const ch of text.toLocaleLowerCase()) {
        if (open && /\p{L}/u.test(ch)) {
          out += ch.toLocaleUpperCase();
          open = false;
        } else {
          out += ch;
          if (/[.!?]/.test(ch)) open = true;
          else if (!/[\s"'”’)\]]/.test(ch)) open = false;
        }
      }
      return { text: out, sentenceOpen: open };
    }
  }
}

/** Change the case of the selected text, keeping its formatting. */
export function changeCase(editor: Editor, kind: CaseKind): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const edits: { from: number; to: number; text: string; node: PmNode }[] = [];
      let open = true;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) open = true;
        if (!node.isText || !node.text) return;
        const start = Math.max(from, pos);
        const end = Math.min(to, pos + node.nodeSize);
        const before = node.text.slice(start - pos, end - pos);
        const next = recase(before, kind, open);
        open = next.sentenceOpen;
        if (next.text !== before && next.text.length === before.length) edits.push({ from: start, to: end, text: next.text, node });
      });
      if (!edits.length) return false;
      if (dispatch) {
        // Back to front, so earlier positions stay put.
        for (const e of edits.reverse()) tr.replaceWith(e.from, e.to, state.schema.text(e.text, e.node.marks));
      }
      return true;
    })
    .run();
}

/** Word's "Clear All Formatting": plain body text, no marks, no paragraph
 *  settings. */
export function clearFormatting(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .unsetAllMarks()
    .command(({ tr, state, dispatch }) => {
      const paragraph = state.schema.nodes.paragraph;
      for (const range of state.selection.ranges) {
        state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
          // Where it falls on the page isn't formatting: breaks stay.
          const keep = {
            ...(node.attrs.pageBreakBefore ? { pageBreakBefore: true } : {}),
            ...(node.attrs.sect ? { sect: node.attrs.sect } : {}),
            ...(node.attrs.colBreak ? { colBreak: true } : {}),
          };
          // A named style goes too (back to body text); a scripted format's
          // element is what the line is, not how it looks, and stays.
          const named = typeof node.attrs.element === "string" && isStyleElement(node.attrs.element);
          const element = node.type === paragraph && !named ? { element: node.attrs.element ?? null } : {};
          if (dispatch) tr.setNodeMarkup(pos, paragraph, { ...element, ...keep });
        });
      }
      return true;
    })
    .run();
}

const plain = (node: PmNode) => node.textContent.trim().toLocaleLowerCase();

/**
 * Sort A→Z (or Z→A): the items of the list the cursor is in, or else the
 * selected paragraphs. Numbers sort as numbers ("2" before "10").
 */
export function sortBlocks(editor: Editor, descending = false): boolean {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const order = (a: PmNode, b: PmNode) => (descending ? -1 : 1) * collator.compare(plain(a), plain(b));
  return editor
    .chain()
    .focus()
    .command(({ tr, state, dispatch }) => {
      const { $from, $to } = state.selection;
      // Inside a list: sort that list's items.
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name !== "bulletList" && node.type.name !== "orderedList") continue;
        const items: PmNode[] = [];
        node.forEach((child) => items.push(child));
        const sorted = [...items].sort(order);
        if (sorted.every((n, i) => n === items[i])) return false;
        if (dispatch) tr.replaceWith($from.start(depth), $from.end(depth), Fragment.from(sorted));
        return true;
      }
      // Otherwise the selected top-level blocks (a selection that ends at
      // the very start of a block doesn't take that block in).
      const count = state.doc.childCount;
      const first = Math.min($from.index(0), count - 1);
      let last = Math.min($to.index(0), count - 1);
      if (last > first && $to.depth > 0 && $to.pos === $to.start(1) && !state.selection.empty) last -= 1;
      if (last <= first) return false;
      const blocks: PmNode[] = [];
      let start = 0;
      let end = 0;
      state.doc.forEach((child, offset, index) => {
        if (index === first) start = offset;
        if (index >= first && index <= last) blocks.push(child);
        if (index === last) end = offset + child.nodeSize;
      });
      const sorted = [...blocks].sort(order);
      if (sorted.every((n, i) => n === blocks[i])) return false;
      if (dispatch) tr.replaceWith(start, end, Fragment.from(sorted));
      return true;
    })
    .run();
}

/** The numbering style of the list the cursor is in (`1`, `a`, `A`, `i`, `I`). */
export function setNumbering(editor: Editor, type: string | null): boolean {
  if (!editor.isActive("orderedList")) {
    return editor.chain().focus().toggleOrderedList().updateAttributes("orderedList", { type }).run();
  }
  return editor.chain().focus().updateAttributes("orderedList", { type }).run();
}

/**
 * Where the numbered list the cursor is in starts counting: back at 1, or
 * on from the numbered list before it (the nearest earlier one beside it —
 * the usual case is a list interrupted by a paragraph).
 */
export function setListStart(editor: Editor, how: "restart" | "continue"): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "orderedList") continue;
    let start = 1;
    if (how === "continue") {
      const parent = $from.node(depth - 1);
      const index = $from.index(depth - 1);
      for (let i = index - 1; i >= 0; i -= 1) {
        const before = parent.child(i);
        if (before.type.name !== "orderedList") continue;
        start = (Number(before.attrs.start) || 1) + before.childCount;
        break;
      }
    }
    const pos = $from.before(depth);
    return editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        if (node.attrs.start === start) return false;
        if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, start });
        return true;
      })
      .run();
  }
  return false;
}

/** Today's date, as text where the cursor is. */
export function insertDate(editor: Editor): boolean {
  const text = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return editor.chain().focus().insertContent(text).run();
}

/**
 * A no-break space, a no-break hyphen or an optional hyphen where the caret
 * is (over what is selected). Put in as typed text, so it takes the
 * formatting it is typed into. (Not through the editor's own "insert
 * content": that reads its argument as a page of HTML, where a lone space
 * is nothing at all.)
 */
export function insertSpecial(editor: Editor, id: string): boolean {
  const char = specialCharacter(id);
  if (!char || !editor.isEditable) return false;
  const { state, view } = editor;
  if (!state.selection.$from.parent.isTextblock) return false;
  view.dispatch(state.tr.insertText(char).scrollIntoView());
  view.focus();
  return true;
}

/** A web address as typed, made into one a link can hold — or null. */
export function normalizeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return value;
  // No scheme a link may carry.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  if (/^[^\s]+\.[^\s]+$/.test(value)) return `https://${value}`;
  return null;
}

/** Link the selection (or insert `text` as a link when nothing is selected). */
export function applyLink(editor: Editor, href: string, text: string): boolean {
  const { empty } = editor.state.selection;
  if (empty && !editor.isActive("link")) {
    const label = text.trim() || href;
    return editor
      .chain()
      .focus()
      .insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] })
      .run();
  }
  return editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

export function removeLink(editor: Editor): boolean {
  return editor.chain().focus().extendMarkRange("link").unsetLink().run();
}

/** A link in the text: where it is, where it goes, and its words. */
export interface LinkHere {
  from: number;
  to: number;
  href: string;
  text: string;
  /** Its words are plain text (no picture or note inside), so they can be
   *  retyped in a field. */
  plain: boolean;
}

/**
 * The link the selection is on: the caret in it or at either end of it, or
 * a selection that stays inside it. Null for a selection that reaches past
 * the link — that is about the text, not the link.
 */
export function linkAtSelection(state: EditorState): LinkHere | null {
  const type = state.schema.marks.link;
  if (!type) return null;
  const { from, to } = state.selection;
  const range = getMarkRange(state.doc.resolve(from), type);
  if (!range || from < range.from || to > range.to) return null;
  const mark = state.doc.nodeAt(range.from)?.marks.find((m) => m.type === type);
  const href = typeof mark?.attrs.href === "string" ? mark.attrs.href : "";
  if (!href) return null;
  let plain = true;
  state.doc.nodesBetween(range.from, range.to, (node) => {
    if (node.isInline && !node.isText) plain = false;
  });
  return { from: range.from, to: range.to, href, text: state.doc.textBetween(range.from, range.to, " "), plain };
}

/**
 * Change where a link goes and, when `text` is given and different, its
 * words (which then take the formatting the link began with). The caret
 * ends up after it.
 */
export function updateLink(editor: Editor, link: LinkHere, href: string, text: string | null): boolean {
  const { state } = editor;
  const type = state.schema.marks.link;
  const first = state.doc.nodeAt(link.from);
  if (!type || !first) return false;
  const old = first.marks.find((m) => m.type === type);
  const tr = state.tr;
  let to = link.to;
  const words = text?.trim() ? text : null;
  if (words !== null && link.plain && words !== link.text) {
    tr.replaceWith(link.from, link.to, state.schema.text(words, first.marks));
    to = link.from + words.length;
  }
  tr.removeMark(link.from, to, type).addMark(link.from, to, type.create({ ...old?.attrs, href }));
  tr.setSelection(TextSelection.create(tr.doc, Math.min(to, tr.doc.content.size)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Take the link off its words (the words stay). */
export function unlinkAt(editor: Editor, link: LinkHere): boolean {
  const type = editor.state.schema.marks.link;
  if (!type) return false;
  editor.view.dispatch(editor.state.tr.removeMark(link.from, link.to, type));
  editor.view.focus();
  return true;
}

/** A link's destination as a reader would say it: "example.com/page",
 *  "Email ada@example.com", "Call 555 0100". */
export function describeHref(href: string): string {
  const mail = /^mailto:([^?]*)/i.exec(href);
  if (mail) return `Email ${decodeURIComponent(mail[1])}`;
  const tel = /^tel:(.*)/i.exec(href);
  if (tel) return `Call ${tel[1]}`;
  return href.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Whether following this address is something the app will do (a web
 *  page, an email, a phone number — nothing that runs). */
export const canOpenHref = (href: string): boolean => /^(https?:\/\/|mailto:|tel:)/i.test(href);
