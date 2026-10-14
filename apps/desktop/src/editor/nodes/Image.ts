import Image from "@tiptap/extension-image";
import type { Editor, NodeViewRenderer } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";

import { normalizeAttachmentSrc } from "../../lib/backend";
import { moveHandle, movePicture } from "../format/movePicture";
import { showRev } from "../review/TrackMarks";
import { CAPTION_MAX, encodeCrop, encodeImageBorder, imageAlign, imageBorder, imageCaption, imageRot, imageRound, parseCrop, shownSize, viewOf, type Crop, type Edge, type ImageAlign, type PictureView, type QuarterTurn } from "../schema/sanitize";
import { scaleOf } from "../ui/scale";

// (How a picture's attributes are read lives with the other readers, where
// the page layout — which runs in a worker — can reach it.)
export { CAPTION_MAX, imageAlign, imageCaption, type ImageAlign };

/** How a picture sits and what's written under it, on the element that
 *  holds it. */
function dress(holder: HTMLElement, caption: HTMLElement, node: PmNode, sized = false): void {
  const align = imageAlign(node.attrs.align);
  if (align) holder.dataset.align = align;
  else delete holder.dataset.align;
  const text = imageCaption(node.attrs.caption);
  caption.textContent = text ?? "";
  caption.hidden = !text;
  showRev(holder, node.attrs.tc);
  const img = holder.querySelector<HTMLImageElement>("img:not(.wf-img-ink-pic)");
  if (!img) return;
  const w = Number(node.attrs.width);
  const h = Number(node.attrs.height);
  // Its size as the document says (the library sizes it only when it is
  // first drawn, and by its own handles): a change from elsewhere shows.
  if (sized && holder.dataset.resizeState !== "true") {
    img.style.width = w > 0 ? `${w}px` : "";
    img.style.height = w > 0 && h > 0 ? `${h}px` : "";
  }
  const view = viewOf(node.attrs);
  const ink = paintInk(img, node, view);
  frame(img, node);
  if (ink) frame(ink, node);
}

/**
 * A picture cropped or turned is drawn by a layer over it (its "ink"): the
 * `<img>` keeps the box the picture shows in, and is not seen. The layer
 * holds the whole picture, turned and placed so the box shows its kept
 * part. Every length is a share of the box, so it holds at any size.
 */
function paintInk(img: HTMLImageElement, node: PmNode, view: PictureView | null): HTMLElement | null {
  const parent = img.parentElement;
  let ink = parent?.querySelector<HTMLElement>(":scope > .wf-img-ink") ?? null;
  if (!view || !parent) {
    ink?.remove();
    img.classList.remove("wf-img-viewed");
    img.style.aspectRatio = "";
    return null;
  }
  if (!ink) {
    ink = document.createElement("span");
    ink.className = "wf-img-ink";
    ink.setAttribute("aria-hidden", "true");
    const region = document.createElement("span");
    region.className = "wf-img-ink-region";
    const pic = document.createElement("img");
    pic.className = "wf-img-ink-pic";
    pic.alt = "";
    pic.draggable = false;
    region.append(pic);
    ink.append(region);
    img.after(ink);
  }
  img.classList.add("wf-img-viewed");
  const w = Number(node.attrs.width);
  const h = Number(node.attrs.height);
  img.style.aspectRatio = w > 0 && h > 0 ? `${w} / ${h}` : "";
  const region = ink.firstElementChild as HTMLElement;
  const pic = region.firstElementChild as HTMLImageElement;
  const src = typeof node.attrs.src === "string" ? normalizeAttachmentSrc(node.attrs.src) : "";
  if (pic.getAttribute("src") !== src) pic.setAttribute("src", src);
  const sideways = view.rot === 90 || view.rot === 270;
  const pct = (v: number) => `${Math.round(v * 100000) / 1000}%`;
  // The kept part, upright: the box's size, or across it when turned.
  const across = sideways && w > 0 && h > 0;
  region.style.width = across ? pct(h / w) : "100%";
  region.style.height = across ? pct(w / h) : "100%";
  region.style.transform = `translate(-50%, -50%)${view.rot ? ` rotate(${view.rot}deg)` : ""}`;
  const [l, t, r, b] = view.crop ?? [0, 0, 0, 0];
  pic.style.left = pct(-l / (1 - l - r));
  pic.style.top = pct(-t / (1 - t - b));
  pic.style.width = pct(1 / (1 - l - r));
  pic.style.height = pct(1 / (1 - t - b));
  return ink;
}

/** A picture's outline and corners, on the picture itself (or the layer
 *  that draws it). */
function frame(el: HTMLElement, node: PmNode): void {
  const border = imageBorder(node.attrs.bdr);
  el.style.border = border ? `${border.w}pt solid ${border.color}` : "";
  // (Drawn inside the picture's own size: an outline doesn't move the text.)
  el.style.boxSizing = border ? "border-box" : "";
  const round = imageRound(node.attrs.round);
  if (!round) {
    el.style.borderRadius = "";
    return;
  }
  // A share of the shorter side, as paper has it. (Where the size isn't
  // known yet, a share of each side: the same thing for a square.)
  const w = Number(node.attrs.width);
  const h = Number(node.attrs.height);
  el.style.borderRadius = round >= 50 ? "50%" : w > 0 && h > 0 ? `${Math.round((Math.min(w, h) * round) / 10) / 10}px` : `${round}%`;
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
      // The part of it kept, and a quarter turn (schema level 4). Its width
      // and height are the box it shows in, cropped and turned.
      crop: {
        default: null,
        parseHTML: (el: HTMLElement) => encodeCrop(parseCrop(el.getAttribute("data-crop"))),
        renderHTML: (attrs: { crop?: unknown }) => (parseCrop(attrs.crop) ? { "data-crop": encodeCrop(parseCrop(attrs.crop)) as string } : {}),
      },
      rot: {
        default: null,
        parseHTML: (el: HTMLElement) => imageRot(Number(el.getAttribute("data-rot"))),
        renderHTML: (attrs: { rot?: unknown }) => (imageRot(attrs.rot) ? { "data-rot": String(imageRot(attrs.rot)) } : {}),
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
        // An extension made from this one inherits this very method AND
        // has it as its parent's (the library copies a parent's methods
        // into what extends it), so it runs once inside itself. What the
        // inner run dressed is done.
        const done = view as unknown as { wfDressed?: boolean };
        if (done.wfDressed) return view;
        done.wfDressed = true;
        const holder = view.dom as HTMLElement;
        holder.append(caption);
        // Its corner handles go by how far the pointer moved on the screen,
        // and size the picture in the page's own pixels: on a zoomed page
        // those differ. (The library keeps the method to itself: it is
        // looked for, and left alone if a later version has renamed it.)
        const sized = view as unknown as { handleResize?: (dx: number, dy: number) => void };
        const resize = sized.handleResize;
        if (typeof resize === "function") {
          sized.handleResize = (dx, dy) => {
            const k = scaleOf(holder);
            resize.call(view, dx / k, dy / k);
          };
        }
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
          if (ok) dress(holder, caption, node, true);
          return ok;
        };
        return view;
      }
      // Read-only places: the picture, placed and captioned.
      const holder = document.createElement("div");
      holder.className = "wf-figure";
      const box = document.createElement("div");
      box.className = "wf-img-box";
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
      box.append(img);
      holder.append(box, caption);
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

/** The size a picture shows at on the screen now, in the document's pixels
 *  (its own, where the document gives none). */
function boxNow(editor: Editor, pos: number, node: PmNode): { w: number; h: number } | null {
  const w = Number(node.attrs.width);
  const h = Number(node.attrs.height);
  if (w > 0 && h > 0) return { w, h };
  const dom = editor.view.nodeDOM(pos);
  const img = dom instanceof HTMLElement ? dom.querySelector<HTMLImageElement>("img:not(.wf-img-ink-pic)") : null;
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  // Its own size: the picture upright, cropped and turned as it is.
  const own = shownSize(img.naturalWidth, img.naturalHeight, viewOf(node.attrs));
  return w > 0 ? { w, h: (w * own.h) / own.w } : own;
}

/** Turn the selected picture a quarter: clockwise (1) or back (-1). Its box
 *  turns with it. */
export function turnPicture(editor: Editor, dir: 1 | -1): boolean {
  const at = selectedImage(editor);
  if (!at) return false;
  const now = imageRot(at.node.attrs.rot) ?? 0;
  const next = (((now + dir * 90) % 360) + 360) % 360;
  const box = boxNow(editor, at.pos, at.node);
  const attrs = { ...at.node.attrs, rot: imageRot(next), ...(box ? { width: Math.round(box.h), height: Math.round(box.w) } : {}) };
  const tr = editor.state.tr.setNodeMarkup(at.pos, undefined, attrs);
  editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at.pos)));
  return true;
}

/** Set the selected picture's crop (null: the whole of it), its box made to
 *  match at the scale it is shown at now. (`pos`: the picture there.) */
export function cropPicture(editor: Editor, crop: Crop | null, pos?: number): boolean {
  const node = pos === undefined ? null : editor.state.doc.nodeAt(pos);
  const at = node && node.type.name === "image" ? { node, pos: pos! } : selectedImage(editor);
  if (!at) return false;
  const was = viewOf(at.node.attrs);
  const box = boxNow(editor, at.pos, at.node);
  const attrs: Record<string, unknown> = { ...at.node.attrs, crop: encodeCrop(crop) };
  if (box) {
    // The whole picture as shown now, turned, then the part now kept.
    const before = shownSize(1, 1, was);
    const after = shownSize(1, 1, { ...(crop ? { crop } : {}), ...(was?.rot ? { rot: was.rot } : {}) });
    attrs.width = Math.max(8, Math.round((box.w * after.w) / before.w));
    attrs.height = Math.max(8, Math.round((box.h * after.h) / before.h));
  }
  const tr = editor.state.tr.setNodeMarkup(at.pos, undefined, attrs);
  editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at.pos)));
  return true;
}

/** Put another picture in the selected one's place: its width, caption,
 *  description and border stay, its height follows the new picture, and
 *  its crop and turn go (they were the old picture's). `size`: the new
 *  picture's own, as shown. */
export function replacePicture(editor: Editor, src: string, size: { w: number; h: number } | null): boolean {
  const at = selectedImage(editor);
  if (!at) return false;
  const box = boxNow(editor, at.pos, at.node);
  const width = box ? Math.round(box.w) : null;
  const height = width && size && size.w > 0 ? Math.max(8, Math.round((width * size.h) / size.w)) : null;
  const attrs = { ...at.node.attrs, src, crop: null, rot: null, width, height };
  const tr = editor.state.tr.setNodeMarkup(at.pos, undefined, attrs);
  editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at.pos)));
  return true;
}

/** What the Picture tab shows of the selected one's crop and turn. */
export function curPictureView(editor: Editor): { crop: Crop | null; rot: QuarterTurn | null } | null {
  const at = selectedImage(editor);
  return at ? { crop: parseCrop(at.node.attrs.crop), rot: imageRot(at.node.attrs.rot) } : null;
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
