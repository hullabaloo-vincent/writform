/**
 * Cropping a picture in place. The whole picture is shown over where it
 * sits, turned as it is, with the part kept bright and eight handles on its
 * edges. Nothing changes until Done, which is one step to undo.
 *
 * The handles work on the picture as it is seen (turned): what they leave
 * is turned back into the crop of the upright picture, which is what the
 * document keeps (sanitize.ts `shownToCrop`).
 */

import type { Editor } from "@tiptap/core";

import { normalizeAttachmentSrc } from "../../lib/backend";
import { CROP_PAIR_MAX, CROP_SIDE_MAX, cropToShown, shownToCrop, viewOf, type Crop } from "../schema/sanitize";
import { cropPicture, selectedImage } from "./Image";

type Grip = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";
const GRIPS: Exclude<Grip, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The crop that dragging `grip` by (`dx`, `dy`) parts of the picture
 *  leaves, from `from` (all as seen: left, top, right, bottom). */
export function dragCrop(from: Crop, grip: Grip, dx: number, dy: number): Crop {
  let [l, t, r, b] = from;
  const clampSide = (v: number) => Math.min(CROP_SIDE_MAX, Math.max(0, v));
  if (grip === "move") {
    const mx = Math.min(r, Math.max(-l, dx));
    const my = Math.min(b, Math.max(-t, dy));
    return [l + mx, t + my, r - mx, b - my];
  }
  if (grip.includes("w")) l = clampSide(Math.min(l + dx, CROP_PAIR_MAX - r));
  if (grip.includes("e")) r = clampSide(Math.min(r - dx, CROP_PAIR_MAX - l));
  if (grip.includes("n")) t = clampSide(Math.min(t + dy, CROP_PAIR_MAX - b));
  if (grip.includes("s")) b = clampSide(Math.min(b - dy, CROP_PAIR_MAX - t));
  return [l, t, r, b];
}

/**
 * Crop the selected picture: shows the handles, and gives back a way to
 * close them (as Cancel does). Null when no picture is selected or it isn't
 * on the screen.
 */
export function startCrop(editor: Editor, onEnd?: () => void): (() => void) | null {
  const at = selectedImage(editor);
  if (!at) return null;
  const dom = editor.view.nodeDOM(at.pos);
  const img = dom instanceof HTMLElement ? dom.querySelector<HTMLImageElement>("img:not(.wf-img-ink-pic)") : null;
  if (!img) return null;
  let pos = at.pos;
  const view = viewOf(at.node.attrs);
  const rot = view?.rot ?? null;
  /** The crop as it was, and as it is now, both as seen. */
  const was: Crop = cropToShown(view?.crop ?? [0, 0, 0, 0], rot);
  let cur: Crop = [...was];

  const root = document.createElement("div");
  root.className = "wf-crop";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Crop the picture");
  // The whole picture, turned as it is.
  const whole = document.createElement("div");
  whole.className = "wf-crop-whole";
  const pic = document.createElement("img");
  pic.alt = "";
  pic.draggable = false;
  pic.src = typeof at.node.attrs.src === "string" ? normalizeAttachmentSrc(at.node.attrs.src) : "";
  whole.append(pic);
  const win = document.createElement("div");
  win.className = "wf-crop-window";
  win.dataset.grip = "move";
  for (const g of GRIPS) {
    const handle = document.createElement("span");
    handle.className = `wf-crop-grip ${g}`;
    handle.dataset.grip = g;
    win.append(handle);
  }
  root.append(whole, win);

  const bar = document.createElement("div");
  bar.className = "wf-crop-bar";
  const button = (label: string, cls: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", act);
    bar.append(b);
    return b;
  };

  let fw = 0;
  let fh = 0;
  const sideways = rot === 90 || rot === 270;
  const place = () => {
    const rect = img.getBoundingClientRect();
    // The whole picture, as seen, from the part of it shown now.
    fw = rect.width / Math.max(0.05, 1 - was[0] - was[2]);
    fh = rect.height / Math.max(0.05, 1 - was[1] - was[3]);
    const left = rect.left - was[0] * fw;
    const top = rect.top - was[1] * fh;
    Object.assign(root.style, { left: `${left}px`, top: `${top}px`, width: `${fw}px`, height: `${fh}px` });
    // Upright inside, turned to be seen.
    Object.assign(pic.style, {
      width: `${sideways ? fh : fw}px`,
      height: `${sideways ? fw : fh}px`,
      transform: `translate(-50%, -50%)${rot ? ` rotate(${rot}deg)` : ""}`,
    });
    const below = top + fh + 8;
    const room = below + 44 < window.innerHeight;
    Object.assign(bar.style, { left: `${Math.max(8, left)}px`, top: `${room ? below : Math.max(8, top - 44)}px` });
    show();
  };
  const show = () => {
    const [l, t, r, b] = cur;
    Object.assign(win.style, { left: `${l * 100}%`, top: `${t * 100}%`, width: `${(1 - l - r) * 100}%`, height: `${(1 - t - b) * 100}%` });
  };

  let drag: { grip: Grip; x: number; y: number; from: Crop; id: number } | null = null;
  const onDown = (e: PointerEvent) => {
    const grip = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-grip]")?.dataset.grip as Grip | undefined;
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    drag = { grip, x: e.clientX, y: e.clientY, from: [...cur], id: e.pointerId };
    root.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    cur = dragCrop(drag.from, drag.grip, (e.clientX - drag.x) / fw, (e.clientY - drag.y) / fh);
    show();
  };
  const onUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    root.releasePointerCapture?.(e.pointerId);
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onUp);

  // The picture moves with the text around it (a change by anyone).
  const follow = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
    if (!transaction.docChanged) return;
    const mapped = transaction.mapping.mapResult(pos);
    const node = editor.state.doc.nodeAt(mapped.pos);
    if (mapped.deleted || !node || node.type.name !== "image") close();
    else pos = mapped.pos;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      done();
    }
  };

  let open = true;
  function close() {
    if (!open) return;
    open = false;
    editor.off("transaction", follow);
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    bar.remove();
    onEnd?.();
  }
  function done() {
    const kept = shownToCrop(cur, rot);
    const same = kept.every((v, i) => Math.abs(v - (view?.crop ?? [0, 0, 0, 0])[i]) < 1e-4);
    if (!same) cropPicture(editor, kept.some((v) => v > 0) ? kept : null, pos);
    close();
    editor.view.focus();
  }

  button("Done", "wf-primary", done);
  button("Whole picture", "", () => {
    cur = [0, 0, 0, 0];
    show();
  });
  button("Cancel", "", close);

  document.body.append(root, bar);
  editor.on("transaction", follow);
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  document.addEventListener("keydown", onKey, true);
  place();
  return close;
}
