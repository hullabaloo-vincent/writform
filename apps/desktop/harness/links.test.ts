// Links in a document: what the caret being "on a link" means, changing
// where one goes and what it says, and the small panel that shows a link's
// destination beside it (so a click in the text never follows one by
// accident).

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { canOpenHref, describeHref, linkAtSelection, unlinkAt, updateLink } from "../src/editor/format/commands";
import { finalJson } from "../src/editor/review/final";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { LinkBubble } from "../src/editor/ui/LinkBubble";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const HREF = "https://example.com/forth";
const link = (href: string, extra: Record<string, unknown> = {}) => ({ type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer nofollow", class: null, title: null, ...extra } });
const t = (text: string, ...marks: { type: string; attrs?: Record<string, unknown> }[]): JSONContent => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
// "See the Forth Bridge today." — the link is "Forth Bridge", its second word bold.
const content = (): JSONContent => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [t("See the "), t("Forth ", link(HREF)), t("Bridge", link(HREF), { type: "bold" }), t(" today.")] },
    { type: "paragraph", content: [t("No links here.")] },
  ],
});
const make = (extra: Parameters<typeof docContentExtensions>[0] = { linkPopup: true }, more: never[] = []) =>
  new Editor({ element: mountPoint(), extensions: [...docContentExtensions(extra), ...more], content: content() });
const caret = (editor: Editor, from: number, to = from) => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
const linksIn = (editor: Editor): { text: string; href: string; bold: boolean; rel: unknown }[] => {
  const out: { text: string; href: string; bold: boolean; rel: unknown }[] = [];
  editor.state.doc.descendants((node) => {
    const mark = node.marks.find((m) => m.type.name === "link");
    if (node.isText && mark) out.push({ text: node.text ?? "", href: mark.attrs.href as string, bold: node.marks.some((m) => m.type.name === "bold"), rel: mark.attrs.rel });
  });
  return out;
};
const FROM = 9; // after "See the "
const TO = 21; // after "Forth Bridge"

// ------------------------------------------------------------ being on a link

{
  const e = make();
  caret(e, 13);
  const here = linkAtSelection(e.state);
  check("the caret in a link: the whole link, its address and its words", here?.from === FROM && here.to === TO && here.href === HREF && here.text === "Forth Bridge" && here.plain);
  caret(e, FROM);
  check("…at its first letter", linkAtSelection(e.state)?.from === FROM);
  caret(e, TO);
  check("…and just after its last", linkAtSelection(e.state)?.to === TO);
  caret(e, TO + 1);
  check("a letter past it is not on it", linkAtSelection(e.state) === null);
  caret(e, 3);
  check("nor is the text before it", linkAtSelection(e.state) === null);
  caret(e, 11, 18);
  check("a selection inside the link is on it", linkAtSelection(e.state)?.to === TO);
  caret(e, 11, TO + 4);
  check("one that runs past it is about the text, not the link", linkAtSelection(e.state) === null);
  caret(e, 4, 14);
  check("…in either direction", linkAtSelection(e.state) === null);
  e.destroy();
}

// ------------------------------------------------------------ changing one

{
  const e = make();
  caret(e, 13);
  updateLink(e, linkAtSelection(e.state)!, "https://example.org/new", null);
  const after = linksIn(e);
  check("a new address goes on the whole link", after.length === 2 && after.every((l) => l.href === "https://example.org/new"));
  check("…and nothing else about it changes: its words, their formatting, how it opens", after.map((l) => l.text).join("") === "Forth Bridge" && after[1].bold && !after[0].bold && after[0].rel === "noopener noreferrer nofollow");
  check("the caret is left just after the link", e.state.selection.from === TO && e.state.selection.empty);

  updateLink(e, linkAtSelection(e.state)!, "https://example.org/new", "Forth Bridge");
  check("the same words given back change nothing (the bold stays)", linksIn(e).length === 2 && linksIn(e)[1].bold);

  updateLink(e, linkAtSelection(e.state)!, "mailto:ada@example.com", "the bridge");
  const renamed = linksIn(e);
  check("new words replace the old, as one link with the new address", renamed.length === 1 && renamed[0].text === "the bridge" && renamed[0].href === "mailto:ada@example.com" && e.state.doc.firstChild?.textContent === "See the the bridge today.");
  check("…and the caret follows the new length", e.state.selection.from === FROM + "the bridge".length);

  updateLink(e, linkAtSelection(e.state)!, "mailto:ada@example.com", "   ");
  check("blank words are no words: the text is left alone", linksIn(e)[0].text === "the bridge");

  unlinkAt(e, linkAtSelection(e.state)!);
  check("removing a link keeps its words", linksIn(e).length === 0 && e.state.doc.firstChild?.textContent === "See the the bridge today.");
  e.destroy();
}

{
  // A link around something that isn't text (a note): its words can't be retyped in a field.
  const e = new Editor({
    element: mountPoint(),
    extensions: docContentExtensions({ linkPopup: true }),
    content: { type: "doc", content: [{ type: "paragraph", content: [t("Read "), t("this", link(HREF)), { type: "footnote", marks: [link(HREF)], content: [t("a note")] }, t(" now.")] }] },
  });
  caret(e, 8);
  const here = linkAtSelection(e.state);
  if (here && !here.plain) {
    updateLink(e, here, "https://example.org/x", "other words");
    check("a link holding more than text keeps what it holds; only the address changes", e.state.doc.firstChild?.textContent.includes("this") === true && linksIn(e).every((l) => l.href === "https://example.org/x"));
  } else {
    // (The note doesn't take the mark in this schema: then the link is its text alone.)
    check("a link is its marked text", here?.text === "this");
  }
  e.destroy();
}

check("an address is said the way a reader would", describeHref("https://example.com/forth/") === "example.com/forth" && describeHref("mailto:ada@example.com") === "Email ada@example.com" && describeHref("tel:+15550100") === "Call +15550100");
check("only pages, emails and numbers are followed — never something that runs", canOpenHref("https://a.b") && canOpenHref("mailto:a@b.c") && canOpenHref("tel:1") && !canOpenHref("javascript:alert(1)") && !canOpenHref("file:///etc/passwd") && !canOpenHref(""));

{
  const optionOf = (e: Editor) => (e.extensionManager.extensions.find((x) => x.name === "link")?.options as { openOnClick?: unknown } | undefined)?.openOnClick;
  const editors = make();
  const previews = make({});
  check("in the editors a click on a link places the caret; elsewhere links behave as they did", optionOf(editors) === false && optionOf(previews) === true);
  editors.destroy();
  previews.destroy();
}

{
  // Suggesting: new words for a link are a suggestion like any other typing.
  const e = make({ linkPopup: true }, [Suggesting.configure({ author: () => "Ada" }) as never]);
  setReviewMode(e, "suggest");
  caret(e, 13);
  let threw = false;
  try {
    updateLink(e, linkAtSelection(e.state)!, "https://example.org/s", "the bridge");
  } catch {
    threw = true;
  }
  const accepted = finalJson(e.getJSON());
  const text = JSON.stringify(accepted);
  const asAsked = !threw && text.includes("the bridge") && !text.includes("Forth") && text.includes("https://example.org/s");
  check("while suggesting, a link's new words are a suggestion — accepted, they read as asked", asAsked, asAsked ? "" : text.slice(0, 300));
  check("…and the old words are still there to go back to", e.state.doc.firstChild?.textContent.includes("Forth") === true);
  e.destroy();
}

// ------------------------------------------------------------ the panel beside a link

{
  const opened: string[] = [];
  (window as unknown as Record<string, unknown>).open = (url: string) => void opened.push(url);
  const e = make();
  const root = createRoot(mountPoint());
  await act(async () => root.render(createElement(LinkBubble, { editor: e })));
  const panel = () => document.querySelector(".wf-link-bubble") as HTMLElement | null;
  const button = (label: string) => panel()?.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const dom = e.view.dom as HTMLElement;
  const move = (from: number, to = from) => act(async () => caret(e, from, to));
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));

  check("nothing is shown until the caret is on a link", panel() === null);
  await act(async () => dom.focus());
  await move(3);
  check("…in ordinary text, still nothing", panel() === null);
  await move(13);
  check("the caret on a link: the panel says where it goes", panel()?.textContent?.includes("example.com/forth") === true);
  check("…with Copy, Edit and Remove beside it", !!button("Copy the link") && !!button("Edit the link and its text") && !!button("Remove the link"));
  check("…and the full address for anyone who asks (a tooltip)", (panel()?.querySelector(".wf-link-where") as HTMLElement | null)?.title === `Open ${HREF}`);

  await act(async () => void click(panel()!.querySelector(".wf-link-where")!));
  check("its destination is a button that opens it", opened.join() === HREF);

  await move(TO + 3);
  check("the caret leaves the link: the panel goes", panel() === null);
  await move(11, 18);
  check("words selected inside a link are the selection menu's business, not this panel's", panel() === null);
  await move(13);

  // Escape puts it away for this link; another visit brings it back.
  await act(async () => void dom.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  check("Escape puts it away", panel() === null);
  await move(14);
  check("…and it stays away while the caret is still on that link", panel() === null);
  await move(3);
  await move(13);
  check("…until the caret comes back to it", panel() !== null);

  // A plain click in the text is for placing the caret; ⌘/Ctrl-click follows.
  const anchor = dom.querySelector("a[href]")!;
  opened.length = 0;
  click(anchor);
  check("a click on a link in the text doesn't follow it", opened.length === 0);
  click(anchor, { metaKey: true });
  click(anchor, { ctrlKey: true });
  check("⌘-click and Ctrl-click do", opened.length === 2 && opened.every((u) => u === HREF));

  // Edit: the words and the address, in one small form.
  await act(async () => void click(button("Edit the link and its text")!));
  const fields = () => [...(panel()?.querySelectorAll("input") ?? [])] as HTMLInputElement[];
  check("Edit opens a form with the link's words and its address", fields().length === 2 && fields()[0].value === "Forth Bridge" && fields()[1].value === HREF);
  await act(async () => fields()[0].focus());
  await new Promise((resolve) => setTimeout(resolve, 5));
  check("typing in the form keeps the panel (the text has lost focus to it)", panel() !== null && fields().length === 2);
  await act(async () => {
    type(fields()[0], "the old bridge");
    type(fields()[1], "not an address");
  });
  await act(async () => void panel()!.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  check("an address that isn't one is refused, and said so", linksIn(e)[0].href === HREF && panel()?.textContent?.includes("doesn’t look like") === true);
  await act(async () => type(fields()[1], "example.org/old"));
  await act(async () => void panel()!.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  const saved = linksIn(e);
  check("Save changes both, completing the address (https://)", saved.length === 1 && saved[0].text === "the old bridge" && saved[0].href === "https://example.org/old");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(async () => {});
  check("…and the panel is back to saying where it goes", panel()?.textContent?.includes("example.org/old") === true && fields().length === 0);

  // Cancel leaves everything as it was.
  await act(async () => void click(button("Edit the link and its text")!));
  await act(async () => type(fields()[0], "changed my mind"));
  await act(async () => void click([...panel()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!));
  check("Cancel changes nothing", linksIn(e)[0].text === "the old bridge" && fields().length === 0);

  // Remove.
  await act(async () => dom.focus());
  await move(13);
  await act(async () => void click(button("Remove the link")!));
  check("Remove takes the link off and keeps the words", linksIn(e).length === 0 && e.state.doc.firstChild?.textContent === "See the the old bridge today." && panel() === null);

  // Where nothing can be edited, a link is only somewhere to go.
  await act(async () => {
    e.commands.setContent(content());
    e.setEditable(false);
  });
  opened.length = 0;
  click(dom.querySelector("a[href]")!);
  check("a document that can't be edited: a click follows the link, and no panel", opened.join() === HREF && panel() === null);
  await act(async () => {
    e.setEditable(true);
    e.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [t("bad", link("javascript:alert(1)"))] }] });
  });
  opened.length = 0;
  const bad = dom.querySelector("a[href]");
  if (bad) click(bad, { metaKey: true });
  check("an address that would run something is never followed", opened.length === 0);

  await act(async () => root.unmount());
  e.destroy();
}

finish();
