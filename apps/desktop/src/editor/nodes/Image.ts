import Image from "@tiptap/extension-image";
import type { Editor, NodeViewRenderer } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";

import { normalizeAttachmentSrc } from "../../lib/backend";
import { moveHandle, movePicture } from "../format/movePicture";
import { showRev } from "../review/TrackMarks";
import { CAPTION_MAX, encodeImageBorder, imageAlign, imageBorder, imageCaption, imageRound, type Edge, type ImageAlign } from "../schema/sanitize";

// (How a picture's attributes are read lives with the other readers, where
// the page layout — which runs in a worker — can reach it.)
export { CAPTION_MAX, imageAlign, imageCaption, type ImageAlign };

/** How a picture sits and what's written under it, on the element that
 *  holds it. */
function dress(holder: HTMLElement, caption: HTMLElement, node: PmNode): void {
  const align = imageAlign(node.attrs.align);
  if (align) holder.dataset.align = align;
  else delete holder.dataset.align;
  const text = imageCaption(node.attrs.caption);
  caption.textContent = text ?? "";
  caption.hidden = !text;
  showRev(holder, node.attrs.tc);
  const img = holder.querySelector("img");
  if (img) frame(img, node);
}

/** A picture's outline and corners, on the picture itself. */
function frame(img: HTMLImageElement, node: PmNode): void {
  const border = imageBorder(node.attrs.bdr);
  img.style.border = border ? `${border.w}pt solid ${border.color}` : "";
  // (Drawn inside the picture's own size: an outline doesn't move the text.)
  img.style.boxSizing = border ? "border-box" : "";
  const round = imageRound(node.attrs.round);
  if (!round) {
    img.style.borderRadius = "";
    return;
  }
  // A share of the shorter side, as paper has it. (Where the size isn't
  // known yet, a share of each side: the same thing for a square.)
  const w = Number(node.attrs.width);
  const h = Number(node.attrs.height);
  img.style.borderRadius = round >= 50 ? "50%" : w > 0 && h > 0 ? `${Math.round((Math.min(w, h) * round) / 10) / 10}px` : `${round}%`;
}

/** Attachment images with the stored URL re-pointed at whichever platform
 *  is rendering (desktop protocol vs same-origin web path). The address is
 *  rewritten where the attribute is rendered, so the resizable view — which
 *  builds its own element — gets it too.
 *
 *  This is the level-1 picture: what every released version knows. */
const Image1 = Image.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      src: {
        ...(parent as Record<string, object>).src,
        renderHTML: (attrs: { src?: string | null }) => (attrs.src ? { src: normalizeAttachmentSrc(attrs.src) } : {}),
      },
    };
  },
});

export const WfImageLevel1 = Image1.configure({ allowBase64: false });

/** The document's picture: the same, plus (schema level 2) where it sits
 *  on the line and a line of text under it, kept with it on the page. */
const Image2 = Image1.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => imageAlign(el.getAttribute("data-align")),
        renderHTML: (attrs: { align?: unknown }) => (imageAlign(attrs.align) ? { "data-align": imageAlign(attrs.align) as string } : {}),
      },
      caption: {
        default: null,
        parseHTML: (el: HTMLElement) => imageCaption(el.getAttribute("data-caption")),
        renderHTML: (attrs: { caption?: unknown }) => (imageCaption(attrs.caption) ? { "data-caption": imageCaption(attrs.caption) as string } : {}),
      },
      // An outline and rounded corners (schema level 3).
      bdr: {
        default: null,
        parseHTML: (el: HTMLElement) => encodeImageBorder(imageBorder(el.getAttribute("data-bdr"))),
        renderHTML: (attrs: { bdr?: unknown }) => (imageBorder(attrs.bdr) ? { "data-bdr": encodeImageBorder(imageBorder(attrs.bdr)) as string } : {}),
      },
      round: {
        default: null,
        parseHTML: (el: HTMLElement) => imageRound(Number(el.getAttribute("data-round"))),
        renderHTML: (attrs: { round?: unknown }) => (imageRound(attrs.round) ? { "data-round": String(imageRound(attrs.round)) } : {}),
      },
    };
  },

  addNodeView() {
    const resizable = this.parent?.() as NodeViewRenderer | null | undefined;
    return (props) => {
      const caption = document.createElement("div");
      caption.className = "wf-img-caption";
      caption.contentEditable = "false";
      if (resizable) {
        // The library's view (image, handles), with the caption under it.
        const view = resizable(props);
        const holder = view.dom as HTMLElement;
        holder.append(caption);
        // A handle to move it by, on the picture's corner while it is selected.
        const getPos = props.getPos;
        const handle = moveHandle(
          () => {
            try {
              return props.editor.view;
            } catch {
              return null;
            }
          },
          () => (typeof getPos === "function" ? getPos() : undefined),
        );
        (holder.querySelector("[data-resize-wrapper]") ?? holder).append(handle);
        dress(holder, caption, props.node);
        const update = view.update?.bind(view);
        view.update = (node, decorations, inner) => {
          const ok = update ? update(node, decorations, inner) : false;
          if (ok) dress(holder, caption, node);
          return ok;
        };
        return view;
      }
      // Read-only places: the picture, placed and captioned.
      const holder = document.createElement("div");
      holder.className = "wf-figure";
      const img = document.createElement("img");
      const show = (node: PmNode) => {
        const src = typeof node.attrs.src === "string" ? normalizeAttachmentSrc(node.attrs.src) : "";
        if (img.getAttribute("src") !== src) img.setAttribute("src", src);
        img.alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
        for (const key of ["width", "height"] as const) {
          const v = Number(node.attrs[key]);
          if (Number.isFinite(v) && v > 0) img.setAttribute(key, String(v));
          else img.removeAttribute(key);
        }
        dress(holder, caption, node);
      };
      holder.append(img, caption);
      show(props.node);
      return {
        dom: holder,
        update: (node) => {
          if (node.type.name !== "image") return false;
          show(node);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

export const WfImage = Image2.configure({ allowBase64: false });

/** The document's picture as it is edited: Alt and an arrow move the
 *  selected one a block up or down. */
const Image3 = Image2.extend({
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": () => movePicture(this.editor, -1),
      "Alt-ArrowDown": () => movePicture(this.editor, 1),
    };
  },
});

/** The same, with drag handles on its corners (documents). The size is the
 *  image's existing `width`/`height` attributes — nothing new to sync. */
export const WfResizableImage = Image3.configure({
  allowBase64: false,
  resize: {
    enabled: true,
    directions: ["top-left", "top-right", "bottom-left", "bottom-right"],
    minWidth: 32,
    minHeight: 32,
    alwaysPreserveAspectRatio: true,
  },
});

/** The picture that is selected (a click on one selects it), if any. */
export function selectedImage(editor: Editor): { node: PmNode; pos: number } | null {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && selection.node.type.name === "image" ? { node: selection.node, pos: selection.from } : null;
}

/** Place the selected picture, caption it, outline it, round its corners,
 *  size it, or say what it shows. */
export function setImageAttrs(
  editor: Editor,
  patch: { align?: ImageAlign | null; caption?: string | null; border?: Edge | null; round?: number | null; alt?: string | null; width?: number | null; height?: number | null },
): boolean {
  const at = selectedImage(editor);
  if (!at) return false;
  const next = { ...at.node.attrs };
  if ("align" in patch) next.align = imageAlign(patch.align);
  if ("caption" in patch) next.caption = imageCaption(patch.caption);
  if ("border" in patch) next.bdr = encodeImageBorder(patch.border ?? null);
  if ("round" in patch) next.round = imageRound(patch.round);
  if ("alt" in patch) next.alt = typeof patch.alt === "string" && patch.alt.trim() ? patch.alt.trim().slice(0, 500) : null;
  for (const key of ["width", "height"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    next[key] = typeof v === "number" && Number.isFinite(v) && v >= 8 ? Math.min(4000, Math.round(v)) : null;
  }
  const tr = editor.state.tr.setNodeMarkup(at.pos, undefined, next);
  editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at.pos)));
  return true;
}
