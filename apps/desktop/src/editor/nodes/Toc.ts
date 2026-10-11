/**
 * A table of contents. Schema level 2.
 *
 * One block that lists the document's headings, kept current as they
 * change — nothing is stored but how deep it goes. In the text it shows
 * the headings (click one to go there); on the page (preview, print, PDF)
 * each gets its page number, and in a Word file it is a real contents
 * field that Word can update.
 */

import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

import { showRev } from "../review/TrackMarks";

export const TOC_DEPTH = 3;
export const tocDepth = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6 ? v : TOC_DEPTH);

export interface TocEntry {
  level: number;
  title: string;
  pos: number;
}

/** The headings a contents block lists (top-level headings with text). */
export function tocEntries(doc: PmNode, depth: number): TocEntry[] {
  const out: TocEntry[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name !== "heading") return;
    const level = Number(node.attrs.level) || 1;
    const title = node.textContent.replace(/\s+/g, " ").trim();
    if (title && level <= depth) out.push({ level, title, pos });
  });
  return out;
}

export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      depth: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = Number(el.getAttribute("data-depth"));
          return Number.isInteger(v) && v >= 1 && v <= 6 && v !== TOC_DEPTH ? v : null;
        },
        renderHTML: (attrs: { depth?: unknown }) => (tocDepth(attrs.depth) !== TOC_DEPTH ? { "data-depth": String(tocDepth(attrs.depth)) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toc": "" })];
  },

  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("div");
      dom.className = "wf-toc";
      dom.dataset.toc = "";
      dom.contentEditable = "false";
      let current = node;
      let shown = "";
      showRev(dom, node.attrs.tc);

      const draw = () => {
        const entries = tocEntries(editor.state.doc, tocDepth(current.attrs.depth));
        const key = JSON.stringify(entries.map((e) => [e.level, e.title]));
        if (key === shown) {
          // Same list; the headings may have moved.
          [...dom.querySelectorAll<HTMLElement>("[data-pos]")].forEach((el, i) => {
            if (entries[i]) el.dataset.pos = String(entries[i].pos);
          });
          return;
        }
        shown = key;
        dom.textContent = "";
        if (!entries.length) {
          const empty = document.createElement("p");
          empty.className = "wf-toc-empty";
          empty.textContent = "Table of contents — headings you add will be listed here.";
          dom.append(empty);
          return;
        }
        for (const entry of entries) {
          const row = document.createElement("a");
          row.className = "wf-toc-row";
          row.dataset.level = String(entry.level);
          row.dataset.pos = String(entry.pos);
          row.textContent = entry.title;
          dom.append(row);
        }
      };
      draw();

      // Headings change anywhere in the document; redraw after the typing.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onUpdate = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(draw, 150);
      };
      editor.on("update", onUpdate);

      const onClick = (e: MouseEvent) => {
        const row = (e.target as Element | null)?.closest?.<HTMLElement>("[data-pos]");
        if (!row) return;
        const pos = Number(row.dataset.pos);
        if (!Number.isFinite(pos) || pos + 1 > editor.state.doc.content.size) return;
        e.preventDefault();
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))).scrollIntoView());
        editor.view.focus();
      };
      dom.addEventListener("click", onClick);

      return {
        dom,
        update: (next) => {
          if (next.type.name !== "toc") return false;
          const changed = next.attrs.depth !== current.attrs.depth;
          current = next;
          showRev(dom, next.attrs.tc);
          if (changed) {
            shown = "";
            draw();
          }
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => {
          if (timer) clearTimeout(timer);
          editor.off("update", onUpdate);
          dom.removeEventListener("click", onClick);
        },
      };
    };
  },
});

/** Put a table of contents where the caret is (as a block of its own). */
export function insertToc(editor: Editor, depth: number = TOC_DEPTH): boolean {
  return editor
    .chain()
    .focus()
    .insertContent({ type: "toc", ...(depth !== TOC_DEPTH ? { attrs: { depth: tocDepth(depth) } } : {}) })
    .run();
}
