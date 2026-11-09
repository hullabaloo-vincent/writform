// The side panels beside the text: the edge between them is dragged to
// make a panel wider or narrower (kept on this device, per kind of panel),
// and the outline's header keeps its buttons inside the panel however
// narrow it is. (GitHub issue 23: on a 13 inch laptop the outline's buttons
// ran off the panel's edge.)

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { readFileSync } from "node:fs";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";

import { PanelResizer } from "../src/apps/documents/shell/PanelResizer";
import { CHECK_WIDE, loadPanelWidths, PANEL_MIN, setPanelWidth, TEXT_KEEPS, usePanelWidths } from "../src/apps/documents/shell/panelWidth";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const css = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

// ------------------------------------------------------------ the outline's header

{
  const source = readFileSync(new URL("../../src/apps/documents/OutlinePanel.tsx", import.meta.url), "utf8");
  const head = source.slice(source.indexOf("<header"), source.indexOf("</header>"));
  check("the outline's buttons are kept together in the header", /className="wf-doc-outline-actions"/.test(head) && (head.match(/<button/g) ?? []).length === 3 && head.indexOf("wf-doc-outline-actions") < head.indexOf("<button"));
  check("…and nothing pushes them out of line any more", !/wf-statusbar-spacer/.test(head));
  check("the header wraps, so they take a line of their own when the panel is narrow", /flex-wrap:\s*wrap/.test(rule(".wf-doc-outline-head")));
  check("…and they wrap among themselves in a narrower one", /flex-wrap:\s*wrap/.test(rule(".wf-doc-outline-actions")) && /min-width:\s*0/.test(rule(".wf-doc-outline-actions")));
  check("the word count is never broken over two lines", /white-space:\s*nowrap/.test(rule(".wf-doc-outline-total")));
}

// ------------------------------------------------------------ the stylesheet

check("a panel given a width takes it, on anything wider than a phone", /width:\s*var\(--wf-panel-w\)/.test(rule(".wf-doc-body.wf-panel-sized > .wf-panel-resizer + .wf-doc-panel")));
check("…and leaves the text its room", rule(".wf-doc-body.wf-panel-sized > .wf-panel-resizer + .wf-doc-panel").includes(`calc(100% - ${TEXT_KEEPS}px)`));
check("the edge is hidden while no panel follows it", /display:\s*none/.test(rule(".wf-panel-resizer:last-child")));
check("the Check panel's wider look no longer sets a width of its own", !/\.wf-doc-panel\.wf-proof\.wide \{\s*width:\s*min/.test(css));

// ------------------------------------------------------------ dragging the edge

localStorage.removeItem("wf-panel-widths");
setPanelWidth("outline", null);
setPanelWidth("feedback", null);

const host = mountPoint();
const root = createRoot(host);
let panel = "outline";
let withPanel = true;
const render = () =>
  act(() =>
    root.render(
      createElement(
        "div",
        { className: "wf-doc-body" },
        createElement("div", { className: "wf-doc-scroll" }),
        withPanel ? createElement(Fragment, null, createElement(PanelResizer, { panel }), createElement("aside", { className: "wf-doc-panel" })) : null,
      ),
    ),
  );
await render();
const body = host.querySelector<HTMLElement>(".wf-doc-body")!;
const edge = () => host.querySelector<HTMLElement>(".wf-panel-resizer")!;
const aside = () => host.querySelector<HTMLElement>("aside")!;
// A window 1,200 wide, the panel drawn at whatever the body says (300 when
// it says nothing).
Object.defineProperty(body, "clientWidth", { configurable: true, get: () => 1200 });
const drawn = () => {
  const w = body.classList.contains("wf-panel-sized") ? parseFloat(body.style.getPropertyValue("--wf-panel-w")) : 300;
  return { left: 1200 - w, top: 0, right: 1200, bottom: 800, width: w, height: 800, x: 1200 - w, y: 0, toJSON() {} };
};
const watchPanel = () => Object.defineProperty(aside(), "getBoundingClientRect", { configurable: true, value: drawn });
watchPanel();
const shown = () => (body.classList.contains("wf-panel-sized") ? parseFloat(body.style.getPropertyValue("--wf-panel-w")) : null);
const fire = async (target: EventTarget, type: string, x: number) => {
  await act(async () => {
    const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 400 });
    Object.defineProperty(ev, "pointerType", { value: "mouse" });
    target.dispatchEvent(ev);
  });
};
const key = async (k: string, shift = false) => {
  await act(async () => {
    edge().dispatchEvent(new window.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  });
};

check("a panel nobody has dragged is as the stylesheet makes it", shown() === null && edge().getAttribute("role") === "separator");

await fire(edge(), "pointerdown", 900);
check("pressing the edge marks it as being dragged", edge().classList.contains("dragging") && document.documentElement.classList.contains("wf-resizing"));
await fire(window, "pointermove", 800);
check("dragging it left widens the panel as the pointer goes", shown() === 400);
check("…without keeping anything until it is let go", usePanelWidths.getState().widths.outline === undefined);
await fire(window, "pointerup", 800);
check("let go: the width is kept for this kind of panel", usePanelWidths.getState().widths.outline === 400 && JSON.parse(localStorage.getItem("wf-panel-widths") ?? "{}").outline === 400);
check("…and the dragging look ends", !edge().classList.contains("dragging") && !document.documentElement.classList.contains("wf-resizing"));

await fire(edge(), "pointerdown", 800);
await fire(window, "pointermove", -2000);
check("never so wide that the text loses its room", shown() === 1200 - TEXT_KEEPS);
await fire(window, "pointermove", 1190);
check("…nor narrower than its header needs", shown() === PANEL_MIN);
await act(async () => {
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});
check("Escape while dragging puts it back as it was", shown() === 400 && usePanelWidths.getState().widths.outline === 400);
await fire(window, "pointermove", 500);
check("…and the pointer no longer moves it", shown() === 400);

await fire(edge(), "pointerdown", 800);
await fire(window, "pointerup", 800);
check("a press without a drag changes nothing", shown() === 400 && usePanelWidths.getState().widths.outline === 400);

// The keys.
await key("ArrowLeft");
check("the left arrow widens it a little", usePanelWidths.getState().widths.outline === 416 && shown() === 416);
await key("ArrowRight", true);
check("…the right arrow with Shift narrows it more", usePanelWidths.getState().widths.outline === 352);
await key("Home");
check("Home makes it as narrow as it goes", usePanelWidths.getState().widths.outline === PANEL_MIN);
await key("End");
check("End as wide as the window lets it", usePanelWidths.getState().widths.outline === 1200 - TEXT_KEEPS);

// Each kind of panel has its own.
await act(async () => setPanelWidth("outline", 420));
panel = "feedback";
await render();
watchPanel();
check("another kind of panel keeps its own width (here none)", shown() === null);
await fire(edge(), "pointerdown", 900);
await fire(window, "pointermove", 860);
await fire(window, "pointerup", 860);
check("…dragged, it is kept for that kind alone", usePanelWidths.getState().widths.feedback === 340 && usePanelWidths.getState().widths.outline === 420);
panel = "outline";
await render();
check("back to the outline: its own width again", shown() === 420);

await act(async () => {
  edge().dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
});
check("a double click puts the panel back as it was made", shown() === null && usePanelWidths.getState().widths.outline === undefined && JSON.parse(localStorage.getItem("wf-panel-widths") ?? "{}").outline === undefined);

await act(async () => setPanelWidth("outline", 380));
await render();
withPanel = false;
await render();
check("with the panel closed the body says nothing of a width", shown() === null && !body.style.getPropertyValue("--wf-panel-w"));
await act(async () => root.unmount());

// ------------------------------------------------------------ what is kept

localStorage.setItem("wf-panel-widths", JSON.stringify({ outline: 5000, plan: 10, "x y": 400, check: "wide", feedback: 333 }));
const read = loadPanelWidths();
check("widths read back are held between the least and the most", read.outline === 960 && read.plan === PANEL_MIN && read.feedback === 333);
check("…and anything else in the store is passed over", !("x y" in read) && read.check === undefined);
localStorage.setItem("wf-panel-widths", "{not json");
check("an unreadable store is as new", Object.keys(loadPanelWidths()).length === 0);
localStorage.removeItem("wf-panel-widths");
localStorage.setItem("wf-proof-wide", "on");
check("the Check panel made wider before this keeps its width", loadPanelWidths().check === CHECK_WIDE);
setPanelWidth("check", null);
check("…and the old switch is let go of once widths are kept", localStorage.getItem("wf-proof-wide") === null);

finish();
