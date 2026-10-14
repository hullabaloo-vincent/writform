/**
 * The page's zoom, as code that measures has to know it.
 *
 * A zoomed page is laid out at its own size and drawn larger or smaller
 * (apps/documents/shell/ZoomFrame.tsx). What the browser reports of it is
 * then in two units: `getBoundingClientRect` and a pointer's `clientX` are
 * in SCREEN pixels, while `offsetWidth`, computed paddings and every size
 * written to a style are in the page's OWN pixels. Anything that reads the
 * one and writes the other divides by `scaleOf`.
 *
 * It is worked out from the element itself (what it measures over what it
 * was laid out as), so it is right however the scaling is done, and 1 for
 * a page that is not scaled or not laid out at all.
 */

/** Screen pixels to one of the element's own. */
export function scaleOf(el: HTMLElement): number {
  const laid = el.offsetWidth;
  if (!laid) return 1;
  const seen = el.getBoundingClientRect().width / laid;
  if (!(seen > 0) || !Number.isFinite(seen)) return 1;
  // The frame says what it asked for: where the two agree, that is the
  // figure (a laid-out width is a whole number, so the ratio alone is a
  // little out).
  const said = parseFloat(getComputedStyle(el).getPropertyValue("--wf-zoom"));
  if (said > 0 && Math.abs(seen / said - 1) < 0.01) return said;
  return Math.abs(seen - 1) < 0.01 ? 1 : seen;
}

export interface OwnBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * A reader of rectangles in `within`'s own pixels. (Every box read through
 * it is divided alike, so distances between them are true. Where they lie
 * on the screen is not: use the browser's own rectangle for that.)
 */
export function boxOf(within: HTMLElement): (el: Element) => OwnBox {
  const k = scaleOf(within);
  if (k === 1) return (el) => el.getBoundingClientRect();
  return (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top / k, bottom: r.bottom / k, left: r.left / k, right: r.right / k, width: r.width / k, height: r.height / k };
  };
}
