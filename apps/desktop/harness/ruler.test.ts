// The ruler over a Document's page: its sums (where marks go, how they
// settle), and the ruler itself on a stand-in page, dragging margins,
// indents and tab stops. A margin dragged is one step of Undo, and a
// change made in the settings panel isn't undone with it.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { DEFAULT_SETTINGS, readDocSettings, updateDocSettings } from "../src/apps/documents/docSettings";
import { docContentExtensions } from "../src/editor/schema/content";
import { Ruler, useRulerShown } from "../src/editor/ui/Ruler";
import { dragIndent, indentMarks, snapPt, ticks } from "../src/editor/ui/rulerGeometry";
import { fromUnit, toUnit, unitForLocales } from "../src/lib/units";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ the sums

check("inches where people measure in them, centimetres elsewhere", unitForLocales(["en-US"]) === "in" && unitForLocales(["en-GB"]) === "cm" && unitForLocales(["fr"]) === "cm" && unitForLocales([]) === "in");
check("points to a unit and back", toUnit(108, "in") === 1.5 && fromUnit(2.54, "cm") === 72 && toUnit(72, "cm") === 2.54);
check("a mark settles to a sixteenth of an inch", snapPt(73, "in") === 72 && snapPt(75, "in") === 76.5 && snapPt(75, "in", true) === 75);
check("or a quarter of a centimetre", Math.abs(snapPt(30, "cm") - 28.35) < 0.01);
{
  const t = ticks(612, 108, "in");
  const wholes = t.filter((x) => x.size === "whole");
  check("ticks: eighths, halves and wholes, numbered from the margin", t.length === 69 && wholes.map((x) => x.label ?? "").join(",") === ",,1,2,3,4,5,6,7" && wholes[1].pt === 108, wholes.map((x) => `${x.pt}:${x.label ?? ""}`).join(" "));
}
{
  const marks = indentMarks(108, 540, 36, 18, -18);
  check("a paragraph's marks from its indents", marks.first === 126 && marks.left === 144 && marks.right === 522);
  check("the first-line mark moves the first line alone", JSON.stringify(dragIndent("first", 180, 108, 540, { indL: 36, indR: 0, indF: 0 })) === JSON.stringify({ indL: 36, indR: 0, indF: 36 }));
  check("the left mark moves the rest and leaves the first line where it was", JSON.stringify(dragIndent("left", 180, 108, 540, { indL: 36, indR: 0, indF: 0 })) === JSON.stringify({ indL: 72, indR: 0, indF: -36 }));
  check("the right mark moves the end of the lines", dragIndent("right", 504, 108, 540, { indL: 0, indR: 0, indF: 0 }).indR === 36);
  check("no indent goes past the column's edge", dragIndent("left", 20, 108, 540, { indL: 0, indR: 0, indF: 0 }).indL === 0);
}

// ------------------------------------------------------------ on a stand-in page
//
// The paper is 8.5 in wide and drawn 816 px wide (a point is 4/3 px), 100
// px from the ruler's left. The paragraph's box is where its indents put it.

{
  Object.defineProperty(navigator, "languages", { value: ["en-US"], configurable: true });
  const ydoc = new Y.Doc();
  updateDocSettings(ydoc, { ml: 1.5, mr: 1 });
  const sheet = mountPoint();
  sheet.className = "wf-page";
  const editor = new Editor({
    element: sheet,
    extensions: [...docContentExtensions({ history: false }), Collaboration.configure({ document: ydoc })],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A paragraph to set in." }] }] },
  });
  const K = 4 / 3;
  const LEFT = 100;
  const rect = (left: number, w: number, top = 0, h = 20) => ({ left, right: left + w, top, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const proto = window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this === sheet) return rect(LEFT, 612 * K);
    if (this.classList.contains("wf-ruler")) return rect(0, 1000, 0, 26);
    if (this.tagName === "P") {
      const a = editor.state.doc.firstChild!.attrs;
      const s = readDocSettings(ydoc);
      const left = LEFT + (s.ml * 72 + (a.indL ?? 0)) * K;
      const right = LEFT + (612 - s.mr * 72 - (a.indR ?? 0)) * K;
      return rect(left, right - left);
    }
    return original.call(this);
  };
  const cs = window.getComputedStyle;
  const styled = (el: Element) => {
    const out = cs(el);
    if (el.tagName === "P") {
      const indF = (editor.state.doc.firstChild!.attrs.indF as number | null) ?? 0;
      return new Proxy(out, { get: (t, k) => (k === "textIndent" ? `${indF * K}px` : (t as unknown as Record<string | symbol, unknown>)[k]) });
    }
    return out;
  };
  (window as unknown as { getComputedStyle: typeof cs }).getComputedStyle = styled as typeof cs;
  (globalThis as unknown as { getComputedStyle: typeof cs }).getComputedStyle = styled as typeof cs;
  const host = mountPoint();
  const root = createRoot(host);
  const render = () => act(async () => root.render(createElement(Ruler, { editor, ydoc, settings: readDocSettings(ydoc), styleStops: () => null })));
  await render();
  await act(async () => wait(40));
  const x = (pt: number) => LEFT + pt * K;
  const fire = (el: Element, type: string, clientX: number, clientY = 10, alt = false) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, altKey: alt }));
  const dragBy = async (el: Element, from: number, to: number, toY = 10) => {
    // (Each in its own turn: the ruler draws between them, as on a screen.)
    await act(async () => {
      fire(el, "pointerdown", from);
    });
    await act(async () => {
      fire(el, "pointermove", to, toY);
    });
    await act(async () => {
      fire(el, "pointerup", to, toY);
    });
    await act(async () => wait(40));
    await render();
    await act(async () => wait(40));
  };
  const button = (sel: string) => host.querySelector(sel) as HTMLElement;
  check("the ruler shows the margins, the indents and the paper", !!button('[aria-label="Left margin"]') && !!button(".wf-ruler-indent.first") && !!button(".wf-ruler-indent.right") && host.querySelectorAll(".wf-ruler-tick").length > 60);
  check("the first-line mark is at the margin", Math.abs(parseFloat(button(".wf-ruler-indent.first").style.left) - 108 * K) < 0.5, button(".wf-ruler-indent.first").style.left);

  // Indents.
  editor.commands.setTextSelection(3);
  await dragBy(button(".wf-ruler-indent.first"), x(108), x(144));
  check("dragging the first-line mark sets the first line in", editor.state.doc.firstChild!.attrs.indF === 36, JSON.stringify(editor.state.doc.firstChild!.attrs.indF));
  await dragBy(button(".wf-ruler-indent.left"), x(108), x(126));
  check("dragging the left mark sets the rest in and keeps the first line", editor.state.doc.firstChild!.attrs.indL === 18 && editor.state.doc.firstChild!.attrs.indF === 18, JSON.stringify([editor.state.doc.firstChild!.attrs.indL, editor.state.doc.firstChild!.attrs.indF]));
  await dragBy(button(".wf-ruler-indent.right"), x(540), x(504));
  check("dragging the right mark sets the end in", editor.state.doc.firstChild!.attrs.indR === 36);

  // Tab stops: a click sets one, a drag moves it, down off the ruler takes it away.
  await dragBy(button(".wf-ruler-paper"), x(252), x(252));
  check("a click on the ruler sets a left stop there (from the margin)", editor.state.doc.firstChild!.attrs.tabs === "144:l", JSON.stringify(editor.state.doc.firstChild!.attrs.tabs));
  await dragBy(button(".wf-ruler-tab"), x(252), x(288));
  check("dragging a stop moves it", editor.state.doc.firstChild!.attrs.tabs === "180:l", JSON.stringify(editor.state.doc.firstChild!.attrs.tabs));
  await dragBy(button(".wf-ruler-tab"), x(288), x(288), 80);
  check("dragged down off the ruler it is gone", editor.state.doc.firstChild!.attrs.tabs === null, JSON.stringify(editor.state.doc.firstChild!.attrs.tabs));

  // Margins, and Undo.
  updateDocSettings(ydoc, { mt: 0.5 });
  await render();
  await dragBy(button('[aria-label="Left margin"]'), x(108), x(72));
  check("dragging the left margin sets it", readDocSettings(ydoc).ml === 1, String(readDocSettings(ydoc).ml));
  await act(async () => {
    editor.commands.undo();
  });
  check("one Undo puts the margin back", readDocSettings(ydoc).ml === 1.5, String(readDocSettings(ydoc).ml));
  check("and leaves what the settings panel set", readDocSettings(ydoc).mt === 0.5);
  await render();
  await dragBy(button('[aria-label="Right margin"]'), x(540), x(576));
  check("dragging the right margin sets it", readDocSettings(ydoc).mr === 0.5, String(readDocSettings(ydoc).mr));

  check("it is off until it is asked for", useRulerShown.getState().on === false);
  useRulerShown.getState().set(true);
  check("and remembered once it is", useRulerShown.getState().on && localStorage.getItem("wf-doc-ruler") === "on");

  await act(async () => root.unmount());
  proto.getBoundingClientRect = original;
  (window as unknown as { getComputedStyle: typeof cs }).getComputedStyle = cs;
  (globalThis as unknown as { getComputedStyle: typeof cs }).getComputedStyle = cs;
  editor.destroy();
}

void DEFAULT_SETTINGS;
finish();
