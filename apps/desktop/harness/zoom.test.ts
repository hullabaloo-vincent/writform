// The page at another size while writing: the figures, and that everything
// which measures a zoomed page (the page view, a column being dragged, a
// picture's handles, a note's box) reads it in the page's own pixels.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, ResizableNodeView, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";

import { DEFAULT_SETTINGS, pageSpecFor } from "../src/apps/documents/docSettings";
import { ZoomFrame } from "../src/apps/documents/shell/ZoomFrame";
import { clampZoom, fitZoom, stepZoom, useDocZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS, zoomLabel } from "../src/apps/documents/shell/zoom";
import { openNotes } from "../src/editor/nodes/Footnote";
import { Paginate, reflowPagination, type PageLayoutResult } from "../src/editor/Paginate";
import { docContentExtensions } from "../src/editor/schema/content";
import { boxOf, scaleOf } from "../src/editor/ui/scale";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
// (jsdom lays nothing out: the observers only have to exist.)
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
/** Say an element was laid out this wide and is drawn `k` times that. */
const drawn = (el: HTMLElement, laid: number, k: number, top = 0, height = 100) => {
  Object.defineProperty(el, "offsetWidth", { value: laid, configurable: true });
  el.getBoundingClientRect = () => rect(0, top * k, laid * k, height * k);
};
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

// ------------------------------------------------------------ the figures

check("sizes are held between the least and the most", clampZoom(0.1) === ZOOM_MIN && clampZoom(9) === ZOOM_MAX && clampZoom(1.234) === 1.23 && clampZoom(Number.NaN) === 1);
check("the named sizes run from the least to the most with 100% among them", ZOOM_STEPS[0] === ZOOM_MIN && ZOOM_STEPS[ZOOM_STEPS.length - 1] === ZOOM_MAX && ZOOM_STEPS.includes(1));
check("a step up or down goes to the next named size", stepZoom(1, 1) === 1.1 && stepZoom(1, -1) === 0.9 && stepZoom(1.3, 1) === 1.5 && stepZoom(1.3, -1) === 1.25);
check("and stops at the ends", stepZoom(ZOOM_MAX, 1) === ZOOM_MAX && stepZoom(ZOOM_MIN, -1) === ZOOM_MIN);
check("it is said as a percentage", zoomLabel(1.25) === "125%" && zoomLabel(0.5) === "50%");

{
  const letter = { w: 816, h: 1056 };
  check("page width: the paper's width fills the window's", fitZoom("width", { w: 1224, h: 500 }, letter) === 1.5);
  check("whole page: the lesser of the two fits", fitZoom("page", { w: 1224, h: 528 }, letter) === 0.5 && fitZoom("page", { w: 408, h: 5000 }, letter) === 0.5);
  check("a narrow window makes the page smaller than the least offered by number", fitZoom("width", { w: 326.4, h: 500 }, letter) === 0.4);
  check("but never larger than the most", fitZoom("width", { w: 9000, h: 500 }, letter) === ZOOM_MAX);
  check("a window not laid out yet fits nothing", fitZoom("width", { w: 0, h: 0 }, letter) === 1);
}

{
  const zoom = useDocZoom.getState();
  zoom.set(1.5);
  check("a size chosen is kept on the device", JSON.parse(localStorage.getItem("wf-doc-zoom") ?? "{}").z === 1.5 && useDocZoom.getState().mode === "percent");
  zoom.fit("width");
  check("fitting is kept too, with the size to go back to", JSON.parse(localStorage.getItem("wf-doc-zoom") ?? "{}").mode === "width" && useDocZoom.getState().z === 1.5);
  zoom.set(7);
  check("a size out of range is brought in", useDocZoom.getState().z === ZOOM_MAX);
  zoom.set(1);
}

// ------------------------------------------------------------ measuring a zoomed page

{
  const el = mountPoint();
  check("an element not laid out counts as unscaled", scaleOf(el) === 1);
  drawn(el, 800, 1);
  check("one drawn at its own size is at 1", scaleOf(el) === 1);
  drawn(el, 800, 1.5);
  check("one drawn half as large again is at 1.5", scaleOf(el) === 1.5);
  drawn(el, 817, 0.5);
  Object.defineProperty(el, "offsetWidth", { value: 817, configurable: true });
  el.getBoundingClientRect = () => rect(0, 0, 408.4, 50);
  el.style.setProperty("--wf-zoom", "0.5");
  check("where the frame says what it asked for, that is the figure exactly", scaleOf(el) === 0.5, String(scaleOf(el)));
  el.style.setProperty("--wf-zoom", "2");
  check("unless what is seen disagrees with it", Math.abs(scaleOf(el) - 408.4 / 817) < 1e-9);
  el.style.removeProperty("--wf-zoom");
  drawn(el, 800, 1.004);
  check("a hair's difference is rounding, not zoom", scaleOf(el) === 1);

  const inner = mountPoint();
  drawn(el, 800, 2);
  inner.getBoundingClientRect = () => rect(40, 300, 200, 60);
  const box = boxOf(el)(inner);
  check("a box read through a zoomed page is in the page's own pixels", box.top === 150 && box.height === 30 && box.left === 20 && box.width === 100 && box.bottom === 180 && box.right === 120);
  drawn(el, 800, 1);
  check("and the browser's own on a page at 100%", boxOf(el)(inner).top === 300);
}

// The simple page view on a sheet that is laid out (a stand-in: each
// paragraph has a height, and whatever it was pushed down by on top), at
// 100% and again drawn at 150%.
async function paged(k: number): Promise<{ pushes: number[]; gaps: number[]; pages: number; fill: number }> {
  const host = mountPoint();
  host.className = "wf-page";
  let seen: PageLayoutResult | null = null;
  const editor = new Editor({
    element: host,
    extensions: [...docContentExtensions(), Paginate.configure({ getSpec: () => pageSpecFor("none", DEFAULT_SETTINGS), getMap: () => null, onLayout: (r) => (seen = r) })],
    content: { type: "doc", content: Array.from({ length: 14 }, (_, i) => p(`Paragraph ${i + 1}.`)) },
  });
  const dom = editor.view.dom as HTMLElement;
  dom.style.padding = "96px";
  const HEIGHT = 700;
  const blocks = () => [...dom.children].filter((el) => el.tagName === "P") as HTMLElement[];
  const pushOf = (el: HTMLElement) => parseFloat(el.style.paddingTop) || 0;
  const layout = () => {
    const els = blocks();
    let y = 96;
    els.forEach((el) => {
      const top = y;
      const height = HEIGHT + pushOf(el);
      el.getBoundingClientRect = () => rect(0, top * k, 600 * k, height * k);
      y += height;
    });
    const total = y + 96;
    Object.defineProperty(dom, "offsetWidth", { value: 800, configurable: true });
    dom.getBoundingClientRect = () => rect(0, 0, 800 * k, total * k);
    host.getBoundingClientRect = () => rect(0, 0, 800 * k, total * k);
  };
  // (Every pass reads the sheet as it then is: lay it out again before each.)
  for (let round = 0; round < 6; round += 1) {
    layout();
    reflowPagination(editor);
    await wait(40);
  }
  const out = {
    pushes: blocks().map(pushOf),
    gaps: [...host.querySelectorAll<HTMLElement>(".wf-page-gap, .wf-page-guide")].map((el) => parseFloat(el.style.top)),
    pages: (seen as PageLayoutResult | null)?.pages ?? 0,
    fill: parseFloat(host.style.getPropertyValue("--wfd-fill")) || 0,
  };
  editor.destroy();
  return out;
}

{
  const plain = await paged(1);
  const zoomed = await paged(1.5);
  const small = await paged(0.75);
  check("the stand-in sheet has several pages", plain.pages >= 3 && plain.pushes.some((n) => n > 0) && plain.gaps.length === plain.pages - 1, JSON.stringify(plain));
  check("page view pushes the same paragraphs by the same amounts at 150%", JSON.stringify(zoomed.pushes) === JSON.stringify(plain.pushes), `${JSON.stringify(zoomed.pushes)} / ${JSON.stringify(plain.pushes)}`);
  check("and draws its gaps in the same places", JSON.stringify(zoomed.gaps) === JSON.stringify(plain.gaps) && zoomed.pages === plain.pages && zoomed.fill === plain.fill, `${JSON.stringify(zoomed.gaps)} / ${JSON.stringify(plain.gaps)}`);
  check("at 75% too", JSON.stringify(small) === JSON.stringify(plain), JSON.stringify(small));
}

// ------------------------------------------------------------ a column dragged

{
  const cell = (text: string): JSONContent => ({ type: "tableCell", content: [p(text)] });
  const editor = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions(),
    content: { type: "doc", content: [{ type: "table", attrs: { cols: "120 120" }, content: [{ type: "tableRow", content: [cell("One"), cell("Two")] }] }] },
  });
  const wrap = (editor.view.dom as HTMLElement).querySelector("table")!.closest(".tableWrapper, .wf-table, div") as HTMLElement;
  const holder = editor.view.nodeDOM(0) as HTMLElement;
  holder.setPointerCapture = () => {};
  holder.releasePointerCapture = () => {};
  const first = holder.querySelector("td") as HTMLElement;
  first.getBoundingClientRect = () => rect(0, 0, 320, 40);
  const fire = (type: string, x: number, target: HTMLElement) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    Object.defineProperty(e, "pointerId", { value: 1 });
    target.dispatchEvent(e);
  };
  const colsAfter = (k: number, by: number): string => {
    editor.commands.setContent({ type: "doc", content: [{ type: "table", attrs: { cols: "120 120" }, content: [{ type: "tableRow", content: [cell("One"), cell("Two")] }] }] });
    const dom = editor.view.nodeDOM(0) as HTMLElement;
    dom.setPointerCapture = () => {};
    dom.releasePointerCapture = () => {};
    drawn(dom, 400, k);
    const td = dom.querySelector("td") as HTMLElement;
    td.getBoundingClientRect = () => rect(0, 0, 160 * k, 40);
    fire("pointermove", 160 * k - 1, td);
    fire("pointerdown", 160 * k - 1, td);
    fire("pointermove", 160 * k - 1 + by, td);
    fire("pointerup", 160 * k - 1 + by, td);
    return String(editor.getJSON().content?.[0]?.attrs?.cols ?? "");
  };
  void wrap;
  check("a column dragged 60 px at 100% widens by 45 pt", colsAfter(1, 60) === "165 120", colsAfter(1, 60));
  check("the same drag on a page at 200% widens it by half that", colsAfter(2, 60) === "142.5 120", colsAfter(2, 60));
  check("and at 50% by twice it", colsAfter(0.5, 60) === "210 120", colsAfter(0.5, 60));
  editor.destroy();
}

// ------------------------------------------------------------ a picture's handles

{
  check("the library's resize view still has the method that is wrapped", typeof (ResizableNodeView.prototype as unknown as Record<string, unknown>).handleResize === "function");
  const editor = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions({ resizeImages: true }),
    content: { type: "doc", content: [{ type: "image", attrs: { src: "/api/v1/attachments/1", width: 200, height: 100 } }, p("After.")] },
  });
  const holder = editor.view.nodeDOM(0) as HTMLElement & { pmViewDesc?: { spec?: Record<string, unknown> } };
  const view = holder.pmViewDesc?.spec as (Record<string, unknown> & { handleResize?: (dx: number, dy: number) => void }) | undefined;
  check("a picture's own view has it wrapped", !!view && Object.prototype.hasOwnProperty.call(view, "handleResize"));
  check("a picture has one caption and one handle to move it by", holder.querySelectorAll(".wf-img-caption").length === 1 && holder.querySelectorAll(".wf-img-move").length === 1);
  // What the library is handed: the pointer's travel in the page's pixels.
  const got: number[][] = [];
  const proto = ResizableNodeView.prototype as unknown as { handleResize: (dx: number, dy: number) => void };
  const real = proto.handleResize;
  const fresh = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions({ resizeImages: true }),
    content: { type: "doc", content: [p("Before.")] },
  });
  proto.handleResize = function (dx: number, dy: number) {
    got.push([dx, dy]);
  };
  fresh.commands.setContent({ type: "doc", content: [{ type: "image", attrs: { src: "/api/v1/attachments/1", width: 200, height: 100 } }, p("After.")] });
  const dom = fresh.view.nodeDOM(0) as HTMLElement & { pmViewDesc?: { spec?: { handleResize?: (dx: number, dy: number) => void } } };
  drawn(dom, 400, 2);
  dom.pmViewDesc?.spec?.handleResize?.(60, 30);
  drawn(dom, 400, 1);
  dom.pmViewDesc?.spec?.handleResize?.(60, 30);
  proto.handleResize = real;
  check("a handle dragged 60 px on a page at 200% sizes the picture by 30", JSON.stringify(got) === JSON.stringify([[30, 15], [60, 30]]), JSON.stringify(got));
  editor.destroy();
  fresh.destroy();
}

// ------------------------------------------------------------ a note's box

{
  const editor = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions(),
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A claim" }, { type: "footnote", content: [{ type: "text", text: "Its source." }] }, { type: "text", text: " and more." }] }] },
  });
  const boxes = () => [...document.body.children].filter((el) => el.classList.contains("wf-fn-pop")) as HTMLElement[];
  const before = boxes().length;
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "footnote") at = pos;
  });
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
  const sup = (editor.view.dom as HTMLElement).querySelector("sup.wf-fn") as HTMLElement;
  const box = boxes().pop();
  check("a note opens in a box on the window itself", boxes().length === before + 1 && !!box && box.parentElement === document.body && !sup.contains(box));
  const inner = openNotes.get(sup);
  inner?.dispatch(inner.state.tr.insertText(" Twice."));
  check("what is typed there is in the document", editor.state.doc.textContent.includes("Its source. Twice."), editor.state.doc.textContent);
  sup.getBoundingClientRect = () => rect(300, 200, 8, 12);
  window.dispatchEvent(new Event("resize"));
  check("it is placed by its number, on the screen", box?.style.left === "300px" && box?.style.top === "218px", `${box?.style.left} ${box?.style.top}`);
  const done = [...(box?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Done");
  done?.click();
  check("Done takes the box away again and leaves the caret after the note", boxes().length === before && editor.state.selection.from === at + editor.state.doc.nodeAt(at)!.nodeSize, `${editor.state.selection.from}`);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
  editor.destroy();
  check("closing the document takes an open box with it", boxes().length === before);
}

// ------------------------------------------------------------ the frame

{
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = mountPoint();
  const scroller = createRef<HTMLElement>();
  const root = createRoot(host);
  const show = async () =>
    act(async () => {
      root.render(createElement("div", { ref: scroller as never, className: "wf-doc-scroll" }, createElement(ZoomFrame, { scroller, paper: { w: 8.5, h: 11 }, children: createElement("div", { className: "wf-page" }) })));
    });
  const zoom = useDocZoom.getState();
  zoom.set(1);
  await show();
  const outer = () => host.querySelector(".wf-zoom-box") as HTMLElement;
  const inner = () => host.querySelector(".wf-zoom") as HTMLElement;
  check("at 100% the frame is two plain boxes", !!outer() && !outer().classList.contains("on") && !inner().getAttribute("style") && !!inner().querySelector(".wf-page"));

  Object.defineProperty(inner(), "offsetWidth", { value: 816, configurable: true });
  Object.defineProperty(inner(), "offsetHeight", { value: 2000, configurable: true });
  await act(async () => zoom.set(1.5));
  check("at 150% the page is drawn scaled from its corner", outer().classList.contains("on") && inner().style.transform === "scale(1.5)" && inner().style.getPropertyValue("--wf-zoom") === "1.5");
  check("and the box around it takes the room that needs", outer().style.width === "1224px" && outer().style.height === "3000px", `${outer().style.width} ${outer().style.height}`);
  check("the size it is at is told to the control", useDocZoom.getState().shown === 1.5);

  // The wheel with Ctrl held, and without.
  const wheel = (init: WheelEventInit) => {
    const e = new (window as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    scroller.current!.dispatchEvent(e);
    return e.defaultPrevented;
  };
  let stopped = false;
  await act(async () => {
    stopped = wheel({ deltaY: 100 });
  });
  check("the wheel alone scrolls as ever", !stopped && useDocZoom.getState().z === 1.5);
  await act(async () => {
    stopped = wheel({ deltaY: -100, ctrlKey: true });
  });
  check("with Ctrl held a notch goes to the next size up, and the window does not zoom itself", stopped && useDocZoom.getState().z === 2);
  await act(async () => {
    wheel({ deltaY: 100, metaKey: true });
    wheel({ deltaY: 100, metaKey: true });
  });
  check("and with ⌘ a notch down each time", useDocZoom.getState().z === 1.25, String(useDocZoom.getState().z));
  await act(async () => {
    for (let i = 0; i < 10; i += 1) wheel({ deltaY: -2, ctrlKey: true });
  });
  check("a pinch's many small steps add up", Math.abs(useDocZoom.getState().z - 1.25 * Math.exp(0.2)) < 0.011, String(useDocZoom.getState().z));

  await act(async () => zoom.set(1));
  check("back at 100% the boxes are plain again", !outer().classList.contains("on") && !outer().style.width && !inner().style.transform);

  // Fitted to the window.
  Object.defineProperty(scroller.current!, "clientWidth", { value: 1288, configurable: true });
  Object.defineProperty(scroller.current!, "clientHeight", { value: 584, configurable: true });
  scroller.current!.style.padding = "40px 32px 72px";
  await act(async () => zoom.fit("width"));
  check("page width: the paper fills the window between its paddings", useDocZoom.getState().shown === 1.5 && inner().style.transform === "scale(1.5)", String(useDocZoom.getState().shown));
  await act(async () => zoom.fit("page"));
  check("whole page: all of it under the top padding", useDocZoom.getState().shown === 0.5, String(useDocZoom.getState().shown));
  await act(async () => zoom.set(1));
  await act(async () => root.unmount());
}

finish();
