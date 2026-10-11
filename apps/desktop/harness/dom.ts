// A DOM for harnesses that mount a real editor (jsdom). Import after
// "./env" and before anything that touches `document`.

import { JSDOM } from "jsdom";

// A real origin, so storage and cookies work as they do in the app.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const g = globalThis as unknown as Record<string, unknown>;
const w = dom.window as unknown as Record<string, unknown>;
for (const key of [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Range",
  "Selection",
  "DOMParser",
  "XMLSerializer",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "KeyboardEvent",
  "MouseEvent",
  "Event",
  "CustomEvent",
  "InputEvent",
  "ClipboardEvent",
  "DragEvent",
  "CompositionEvent",
  "FocusEvent",
]) {
  if (w[key] !== undefined) {
    Object.defineProperty(g, key, { value: w[key], configurable: true, writable: true });
  }
}
g.window = dom.window;
g.getSelection = () => dom.window.getSelection();

// Layout doesn't exist in jsdom; ProseMirror only asks when scrolling.
const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
const proto = (dom.window as unknown as { Range: { prototype: Record<string, unknown> } }).Range.prototype;
proto.getClientRects = () => [];
proto.getBoundingClientRect = () => rect;
(dom.window.document as unknown as Record<string, unknown>).elementFromPoint = () => null;

/** A detached element to mount an editor in. */
export function mountPoint(): HTMLElement {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  return el as unknown as HTMLElement;
}
