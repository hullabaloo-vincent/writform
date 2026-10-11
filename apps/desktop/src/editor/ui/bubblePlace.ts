/**
 * Where a small panel that belongs to a place in the text goes on screen —
 * the selection menu over selected words, the link panel under a caret.
 *
 * Such a panel is fixed to the window but is about text inside a scrolling
 * page: it must follow the text as it scrolls, and be gone once the text it
 * is about has left the visible part of the page (not float on over the
 * toolbar). So every placement is made against the box the text shows in.
 */

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The part of the window an editor's text shows in: its nearest scrolling
 *  ancestor's box, held to the window (minus anything riding on the
 *  keyboard). */
export function textWindow(dom: HTMLElement): Box {
  const vv = window.visualViewport;
  const strip = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--wf-kbdock-h")) || 0;
  const view: Box = {
    top: 0,
    left: 0,
    right: document.documentElement.clientWidth || window.innerWidth,
    bottom: (vv ? vv.height + vv.offsetTop : window.innerHeight) - strip,
  };
  for (let el = dom.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const r = el.getBoundingClientRect();
    // (Something not laid out has no box to hold to.)
    if (r.height <= 0) break;
    return { top: Math.max(view.top, r.top), bottom: Math.min(view.bottom, r.bottom), left: view.left, right: view.right };
  }
  return view;
}

const GAP = 8;
const clampLeft = (left: number, width: number, within: Box) => Math.max(within.left + GAP, Math.min(left, within.right - width - GAP));

/**
 * Over a stretch of text (from the top of its first line to the bottom of
 * its last), centred on `middle`: above it, below it when there's no room
 * above — and nowhere (null) once none of it is in view.
 */
export function placeOver(text: { top: number; bottom: number; middle: number }, size: { width: number; height: number }, within: Box): { left: number; top: number } | null {
  if (text.bottom <= within.top || text.top >= within.bottom) return null;
  const left = clampLeft(text.middle - size.width / 2, size.width, within);
  const above = text.top - size.height - GAP;
  if (above >= within.top) return { left, top: above };
  const below = text.bottom + GAP;
  if (below + size.height <= within.bottom) return { left, top: below };
  // The text fills the view (everything selected): at the head of it.
  return { left, top: within.top + GAP };
}

/** Under a caret (its line's top and bottom, its x): below the line, above
 *  when there's no room below — and nowhere once the caret is out of view. */
export function placeUnder(caret: { top: number; bottom: number; left: number }, size: { width: number; height: number }, within: Box): { left: number; top: number } | null {
  if (caret.bottom <= within.top || caret.top >= within.bottom) return null;
  const left = clampLeft(caret.left - 24, size.width, within);
  const below = caret.bottom + GAP;
  if (below + size.height <= within.bottom) return { left, top: below };
  const above = caret.top - size.height - GAP;
  return { left, top: Math.max(within.top + GAP, above) };
}
