// The Document format's toolbar, kept small: the everyday controls in the
// row, the rest one click away under a named "More" — and the selection
// menu, with the handful of things most often done to selected words.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { bodyLook, DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { docContentExtensions } from "../src/editor/schema/content";
import { resolveStyles } from "../src/editor/styles/sheet";
import { Flyout } from "../src/editor/ui/Flyout";
import { Ribbon } from "../src/editor/ui/Ribbon";
import { placeOver, placeUnder } from "../src/editor/ui/bubblePlace";
import { SelectionBubble } from "../src/editor/ui/SelectionBubble";
import { useSelectionMenu } from "../src/editor/ui/selectionMenu";
import { withKeys } from "../src/editor/commands/catalog";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const win = window as unknown as Record<string, unknown>;
let coarse = false;
win.matchMedia = (query: string) => ({ matches: query.includes("coarse") ? coarse : false, addEventListener() {}, removeEventListener() {} });
// (jsdom lays nothing out: say the toolbar is wide, so no group is folded
// away for lack of room — that is not what is being tested.)
Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 2400 });

const t = (text: string, ...marks: string[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const format = { styles: resolveStyles(bodyLook(DEFAULT_SETTINGS), {}), level: 2 };
const select = (editor: Editor, from: number, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
const press = (el: Element) => {
  // As a pointer does it: down (which is what closes menus clicked outside of), then the click.
  el.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  el.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
};
const marksAt = (editor: Editor, pos: number) => (editor.state.doc.nodeAt(pos)?.marks ?? []).map((m) => m.type.name);

// ------------------------------------------------------------ the ribbon

{
  const editor = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions(),
    content: { type: "doc", content: [para(t("Plain words to format.")), { type: "bulletList", content: [{ type: "listItem", content: [para(t("An item"))] }] }] },
  });
  const host = mountPoint();
  const root = createRoot(host);
  let marksShown = false;
  const opened: string[] = [];
  const draw = () =>
    act(async () =>
      root.render(
        createElement(Ribbon, {
          editor,
          settings: DEFAULT_SETTINGS,
          onPatchSettings: () => {},
          actions: {
            find: () => opened.push("find"),
            comments: () => opened.push("comments"),
            history: () => opened.push("history"),
            pageSetup: (section?: string) => opened.push(`setup:${section}`),
            preview: () => opened.push("preview"),
            print: () => opened.push("print"),
            readAloud: () => opened.push("read"),
            compareFile: () => opened.push("compare"),
          },
          showMarks: marksShown,
          onToggleMarks: () => {
            marksShown = !marksShown;
          },
          format,
        }),
      ),
    );
  await draw();
  /** The controls in the row itself (not the hidden copy it measures). */
  const row = () => [...host.querySelectorAll(".wf-ribbon-row > .wf-ribbon-group")].flatMap((group) => [...group.querySelectorAll("button, select")]) as HTMLElement[];
  const named = (name: string) => row().find((el) => (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").startsWith(name));
  const panels = () => [...document.querySelectorAll(".wf-flyout")] as HTMLElement[];
  // (An item's words, without the tick before them or the hint after.)
  const wordsOf = (b: Element) => (b.querySelector(".wf-flyout-text, .wf-flyout-label")?.textContent ?? b.textContent ?? "").trim();
  const item = (text: string) => panels().flatMap((p) => [...p.querySelectorAll("button")]).find((b) => wordsOf(b).startsWith(text)) as HTMLButtonElement | undefined;
  const tab = async (name: string) => act(async () => void press([...host.querySelectorAll(".wf-ribbon-tabs button")].find((b) => b.textContent === name)!));

  await act(async () => (editor.view.dom as HTMLElement).focus());
  await act(async () => select(editor, 1, 6));

  const homeCount = row().length;
  check("Home is a short row: the everyday controls only", homeCount <= 20, `${homeCount} controls`);
  check("…bold, italic, underline, colour, highlight, lists, alignment and spacing among them", ["Bold", "Italic", "Underline", "Text color", "Highlight", "Bulleted list", "Numbered list", "Alignment", "Line and paragraph spacing", "Undo"].every((n) => !!named(n)), ["Bold", "Italic", "Underline", "Text color", "Highlight", "Bulleted list", "Numbered list", "Alignment", "Line and paragraph spacing", "Undo"].filter((n) => !named(n)).join());
  check("…and the occasional ones are not in the row", ["Strikethrough", "Subscript", "Superscript", "Inline code", "Change case", "Clear formatting", "Sort", "Show paragraph marks", "Shading", "Borders", "Format painter", "Larger", "Smaller", "Justify"].every((n) => !named(n)));

  // More text formatting: everything that left the row is here, and works.
  await act(async () => void press(named("More text formatting")!));
  check("“More text formatting” holds them", ["Strikethrough", "Subscript", "Superscript", "Inline code", "Larger", "Smaller", "UPPERCASE", "Copy formatting", "Clear formatting"].every((n) => !!item(n)), ["Strikethrough", "Subscript", "Superscript", "Inline code", "Larger", "Smaller", "UPPERCASE", "Copy formatting", "Clear formatting"].filter((n) => !item(n)).join());
  await act(async () => void press(item("Strikethrough")!));
  check("…one click applies it to the selection, and the menu goes", marksAt(editor, 2).includes("strike") && panels().length === 0);
  check("…and “More” is lit while something in it is on", named("More text formatting")?.classList.contains("active") === true);
  await act(async () => void press(named("More text formatting")!));
  await act(async () => void press(item("UPPERCASE")!));
  check("change of case is there too", editor.state.doc.firstChild?.textContent.startsWith("PLAIN") === true);

  // A list's own options appear when the caret is in one.
  check("a list's style menu isn't shown outside a list", !named("Bullet style") && !named("Numbering"));
  let inItem = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "An item") inItem = pos + 2;
  });
  await act(async () => select(editor, inItem));
  check("…and is, in one", !!named("Bullet style"));
  await act(async () => select(editor, 1, 6));

  // Alignment is one menu.
  await act(async () => void press(named("Alignment")!));
  check("alignment is one menu with the four choices", ["Left", "Center", "Right", "Justified"].every((n) => !!item(n)));
  await act(async () => void press(item("Center")!));
  check("…and choosing one sets it", editor.state.doc.firstChild?.attrs.align === "center" && panels().length === 0);

  // More paragraph formatting — with a menu that opens from inside it.
  await act(async () => void press(named("More paragraph formatting")!));
  check("“More paragraph formatting” has shading, borders, sorting and the marks", ["Shading", "Borders", "Sort A to Z", "Show paragraph marks"].every((n) => !!item(n)));
  await act(async () => void press(item("Borders")!));
  check("a menu opens from inside the menu, and the first stays open under it", panels().length === 2 && !!item("No border"));
  const box = panels()[1].querySelectorAll("button")[1] as HTMLButtonElement;
  await act(async () => void press(box));
  check("…and a choice made in the inner one takes effect (the click isn't lost to the outer one closing)", typeof editor.state.doc.firstChild?.attrs.bdr === "string" && panels().length >= 1, String(editor.state.doc.firstChild?.attrs.bdr));
  await act(async () => void press(item("Show paragraph marks")!));
  check("showing paragraph marks is a tick in that menu", marksShown && panels().length === 0);
  // A click elsewhere still closes a menu.
  await act(async () => void press(named("More paragraph formatting")!));
  await act(async () => void document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  check("a click anywhere else closes a menu, as before", panels().length === 0);

  // Insert, Layout, Review.
  await tab("Insert");
  const labels = () => row().map((el) => el.textContent?.trim()).filter(Boolean);
  check("Insert names what it inserts", ["Page break", "Table", "Link", "Footnote", "Endnote", "Contents", "Symbol", "More"].every((n) => labels().includes(n)), labels().join(" | "));
  check("…in a short row", row().length <= 9, `${row().length} controls`);
  await act(async () => void press(named("More to insert")!));
  check("…with the rest under More", ["Quote", "Code block", "Divider line", "Line break", "Today", "Column break", "Section break"].every((n) => !!item(n)));
  await act(async () => void press(item("Quote")!));
  check("…where they work as they did", editor.isActive("blockquote") && panels().length === 0);

  await tab("Layout");
  check("Layout: margins, paper, orientation, columns, sections, headers — and a More", ["Margins", "Portrait", "Landscape", "Columns", "Header & footer", "More"].every((n) => labels().includes(n)) && !labels().includes("Hyphenation"), labels().join(" | "));

  await tab("Review");
  check("Review: comments, find, preview, print and a More — nothing to accept when nothing is suggested", ["Comments", "Find", "Preview", "Print", "More"].every((n) => labels().includes(n)) && !labels().includes("Accept") && !labels().includes("Reject"), labels().join(" | "));
  await act(async () => void press(named("More for reviewing")!));
  await act(async () => void press(item("Version history")!));
  check("…history, comparing and reading aloud are under More", opened.includes("history") && panels().length === 0);

  await act(async () => root.unmount());
  editor.destroy();
}

{
  // With suggestions waiting, Review offers to decide them.
  const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions(), content: { type: "doc", content: [para(t("Words."))] } });
  const host = mountPoint();
  const root = createRoot(host);
  const review = (items: unknown[]) => ({ mode: "edit", setMode: () => {}, canSuggest: true, canResolve: true, items });
  const draw = (items: unknown[]) =>
    act(async () => root.render(createElement(Ribbon, { editor, settings: DEFAULT_SETTINGS, onPatchSettings: () => {}, actions: {}, showMarks: false, onToggleMarks: () => {}, format, review: review(items) as never })));
  await draw([]);
  await act(async () => void press([...host.querySelectorAll(".wf-ribbon-tabs button")].find((b) => b.textContent === "Review")!));
  const labels = () => [...host.querySelectorAll(".wf-ribbon-row > .wf-ribbon-group button")].map((b) => b.textContent?.trim());
  check("no suggestions: the mode can be chosen, nothing asks to be accepted", !!host.querySelector(".wf-ribbon-row select.wf-ribbon-mode") && !labels().includes("Accept"));
  await draw([{ id: "x" }]);
  check("a suggestion waiting: Accept and Reject appear", labels().includes("Accept") && labels().includes("Reject"));
  await act(async () => root.unmount());
  editor.destroy();
}

// ------------------------------------------------------------ the selection menu

{
  const editor = new Editor({ element: mountPoint(), extensions: docContentExtensions({ linkPopup: true }), content: { type: "doc", content: [para(t("Select some of these words."))] } });
  const root = createRoot(mountPoint());
  const comments: number[] = [];
  const draw = (withFormat = true) => act(async () => root.render(createElement(SelectionBubble, { editor, format: withFormat ? format : null, onComment: () => comments.push(1) })));
  await draw();
  const bubble = () => document.querySelector(".wf-selection-bubble") as HTMLElement | null;
  const button = (name: string) => [...(bubble()?.querySelectorAll("button") ?? [])].find((b) => (b.getAttribute("aria-label") ?? "").startsWith(name)) as HTMLButtonElement | undefined;
  const dom = editor.view.dom as HTMLElement;
  const move = (from: number, to = from) => act(async () => select(editor, from, to));

  check("no selection, no menu", bubble() === null);
  await act(async () => dom.focus());
  await move(4);
  check("a caret alone doesn't bring it up", bubble() === null);
  await move(8, 12);
  check("selected words do: bold, italic, underline, colour, highlight, link, comment, clear", ["Bold", "Italic", "Underline", "Text color", "Highlight", "Link", "Comment on this", "Clear formatting"].every((n) => !!button(n)), ["Bold", "Italic", "Underline", "Text color", "Highlight", "Link", "Comment on this", "Clear formatting"].filter((n) => !button(n)).join());
  check("…and one button more, to choose what it holds", (bubble()?.querySelectorAll("button").length ?? 0) === 9 && !!button("Customize this menu"));

  await act(async () => void press(button("Bold")!));
  check("a button formats the selection and leaves it selected, the menu still there", marksAt(editor, 9).includes("bold") && !editor.state.selection.empty && bubble() !== null && button("Bold")?.classList.contains("active") === true);
  await act(async () => void press(button("Underline")!));
  check("…so a second thing can be done straight away", marksAt(editor, 9).includes("underline"));

  // Colour and highlight: the same menus as the ribbon's.
  await act(async () => void press(button("Highlight")!));
  const swatch = document.querySelector(".wf-flyout .wf-color-swatch") as HTMLButtonElement | null;
  check("highlight opens its colours", !!swatch);
  await act(async () => void press(swatch!));
  check("…and one click highlights", marksAt(editor, 9).includes("highlight") && bubble() !== null);

  await act(async () => void press(button("Comment on this")!));
  check("Comment hands over to the comments panel", comments.length === 1);

  await act(async () => void press(button("Clear formatting")!));
  check("Clear formatting takes it all off again", marksAt(editor, 9).length === 0);

  // While the mouse is still dragging the selection out, it waits.
  await act(async () => void dom.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 })));
  await move(8, 20);
  check("it waits while the selection is still being dragged", bubble() === null);
  await act(async () => void window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true })));
  check("…and appears when the mouse is let go", bubble() !== null);

  await act(async () => void dom.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  check("Escape puts it away", bubble() === null);
  await move(1, 7);
  check("…until something else is selected", bubble() !== null);
  await move(3);
  check("the selection collapses: it goes", bubble() === null);

  // A manuscript or a script: emphasis, a link and a comment — no colours.
  await draw(false);
  await move(8, 12);
  check("outside the Document format it is the three emphasis buttons, link and comment", !!button("Bold") && !button("Text color") && !button("Clear formatting") && (bubble()?.querySelectorAll("button").length ?? 0) === 6);
  await draw();

  // A finger's selection has the system's own menu: this one stays away.
  coarse = true;
  await move(1, 7);
  check("on a touch screen the system's own selection menu is left alone", bubble() === null);
  coarse = false;
  await move(2, 7);
  check("(…and back with a mouse)", bubble() !== null);

  // Its own choice of tools.
  const panelItem = (text: string) => [...document.querySelectorAll(".wf-flyout button")].find((b) => (b.querySelector(".wf-flyout-text")?.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  await act(async () => void press(button("Customize this menu")!));
  check("its last button lists every tool it could hold, the shown ones ticked", !!panelItem("Strikethrough") && panelItem("Bold")?.getAttribute("aria-checked") === "true" && panelItem("Strikethrough")?.getAttribute("aria-checked") === "false");
  await act(async () => void press(panelItem("Strikethrough")!));
  await act(async () => void press(panelItem("Underline")!));
  check("ticking adds a tool, unticking takes one away — at once, the list still open", !!button("Strikethrough") && !button("Underline") && !!panelItem("Bold"));
  check("…kept in the menu's own order", [...bubble()!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")).join("|").startsWith(`${withKeys("Bold", "Mod-b")}|${withKeys("Italic", "Mod-i")}|Strikethrough|Text color`));
  check("…and remembered on this device", (JSON.parse(localStorage.getItem("wf-selection-menu") ?? "{}") as { tools?: string[] }).tools?.includes("strike") === true);
  await act(async () => void press(panelItem("Back to the usual set")!));
  check("“Back to the usual set” undoes the tinkering", !button("Strikethrough") && !!button("Underline"));
  await act(async () => void press(panelItem("Don’t show this menu")!));
  check("it can be switched off altogether", bubble() === null && useSelectionMenu.getState().off);
  await act(async () => useSelectionMenu.getState().setOff(false));
  await move(2, 9);
  check("…and back on (from Settings)", bubble() !== null);

  await act(async () => editor.setEditable(false));
  await move(8, 12);
  check("a document that can't be edited has nothing to offer a selection", bubble() === null);

  await act(async () => root.unmount());
  editor.destroy();
}

// ------------------------------------------------------------ where the floating panels go

{
  // The page's text shows between y = 150 (under the toolbar) and y = 700.
  const page = { top: 150, bottom: 700, left: 0, right: 1000 };
  const size = { width: 300, height: 40 };
  const over = (top: number, bottom: number, middle = 500) => placeOver({ top, bottom, middle }, size, page);
  check("the selection menu sits above the selection, centred on it", over(400, 420)?.top === 400 - 40 - 8 && over(400, 420)?.left === 350);
  check("…below it when the top of the page is in the way", over(160, 180)?.top === 180 + 8);
  check("…and follows it as the page scrolls", over(300, 320)?.top === 252 && over(250, 270)?.top === 202);
  check("scrolled up out of view, it is gone — not left floating over the toolbar", over(100, 140) === null && over(-400, -380) === null);
  check("…and the same scrolled off the bottom", over(720, 740) === null);
  check("a selection still partly in view keeps it, on the page", over(120, 170)?.top === 178 && (over(680, 760)?.top ?? 0) < 700);
  check("everything selected (it fills the view): at the head of the page, not off it", over(0, 2000)?.top === 158);
  check("it never hangs off the side of the window", over(400, 420, 10)?.left === 8 && over(400, 420, 995)?.left === 1000 - 300 - 8);

  const under = (top: number, bottom: number, left = 500) => placeUnder({ top, bottom, left }, size, page);
  check("the link panel sits under its line", under(400, 420)?.top === 428);
  check("…above it at the foot of the page", under(670, 690)?.top === 670 - 40 - 8);
  check("…and is gone once its link has scrolled out of view", under(100, 140) === null && under(710, 730) === null);
}

// ------------------------------------------------- a menu near the foot

{
  // A panel 200 high, in a window 700 high (jsdom lays nothing out).
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("wf-flyout") ? 200 : 0;
    },
  });
  const host = mountPoint();
  const root = createRoot(host);
  await act(async () => root.render(createElement(Flyout, { title: "Set aside", label: "Set aside", children: () => createElement("button", { type: "button" }, "Just for now") })));
  const button = host.querySelector(".wf-flyout-button") as HTMLElement;
  const at = (top: number) => {
    button.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 100, right: 220, width: 120, height: 30, x: 100, y: top, toJSON: () => ({}) }) as DOMRect;
  };
  const panel = () => document.body.querySelector(".wf-flyout") as HTMLElement | null;
  const opened = async (top: number) => {
    at(top);
    await act(async () => press(button));
    const el = panel();
    const place = el ? { top: parseFloat(el.style.top), max: parseFloat(el.style.maxHeight) } : null;
    await act(async () => press(button));
    return place;
  };
  const high = await opened(100);
  check("a menu opens below its button when there is room", high?.top === 136 && high.max === 700 - 136 - 8, JSON.stringify(high));
  const low = await opened(620);
  check("near the foot of the window it opens above its button instead", !!low && low.top === 620 - 6 - 200 && low.top + 200 <= 620, JSON.stringify(low));
  const tight = await opened(150);
  check("and below again where above has less room", tight?.top === 186, JSON.stringify(tight));
  await act(async () => root.unmount());
}

finish();
