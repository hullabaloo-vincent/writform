// The editor's commands by name: one list for the command palette (⌘K), the
// shortcut sheet (⌘/) and the keys the list binds. Held here: every row can
// be run, every key written down is a key that works, and running one from
// the palette leaves the selection alone and hands the text the focus back.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { bodyLook, DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { formatKeymap } from "../src/apps/documents/formats/FormatKeymap";
import { useDocZoom } from "../src/apps/documents/shell/zoom";
import { EDITOR_COMMANDS, keyCaps, keyLabel, keysOf, offered } from "../src/editor/commands/catalog";
import { CommandKeys } from "../src/editor/commands/CommandKeys";
import { canRun, runCommand, RUNNABLE, RUNNERS, type CommandCtx } from "../src/editor/commands/run";
import { useEditorCommands } from "../src/editor/commands/useEditorCommands";
import { RunShortcuts } from "../src/editor/format/run";
import { docContentExtensions } from "../src/editor/schema/content";
import { resolveStyles } from "../src/editor/styles/sheet";
import { setDocAlign } from "../src/editor/TextFormat";
import { CommandPalette } from "../src/platform/CommandPalette";
import { usePlatform } from "../src/platform/registry";
import { documentSections, shortcutSections } from "../src/platform/shortcuts";

const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;

const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const rich = { styles: resolveStyles(bodyLook(DEFAULT_SETTINGS), {}), level: 3 };
const calls: string[] = [];
let settings = { ...DEFAULT_SETTINGS };
const ctxOf = (more: Partial<CommandCtx> = {}): CommandCtx => ({
  format: "none",
  rich,
  editable: true,
  settings,
  patchSettings: (patch) => (settings = { ...settings, ...patch }),
  review: { mode: "edit", setMode: (m) => calls.push(`mode:${m}`), canSuggest: true, canResolve: true },
  shell: {
    find: (replace) => calls.push(replace ? "replace" : "find"),
    check: () => calls.push("check"),
    comments: () => calls.push("comments"),
    changes: () => calls.push("changes"),
    history: () => calls.push("history"),
    readAloud: () => calls.push("readAloud"),
    compareFile: () => calls.push("compare"),
    pageSetup: (section) => calls.push(`setup:${section ?? ""}`),
    preview: () => calls.push("preview"),
    print: () => calls.push("print"),
    toggleMarks: () => calls.push("marks"),
    togglePageView: () => calls.push("pageview"),
    toggleFocus: () => calls.push("focus"),
  },
  ...more,
});
let ctx = ctxOf();
const editorWith = (content: JSONContent[]): Editor =>
  new Editor({
    element: mountPoint(),
    extensions: [
      ...docContentExtensions({ textFormat: { shortcuts: true, alignShortcuts: false } }),
      formatKeymap("none"),
      RunShortcuts.configure({ shortcuts: true, context: () => rich }),
      CommandKeys.configure({ ctx: () => ctx }),
    ],
    content: { type: "doc", content },
  });

// ------------------------------------------------------------ the list

{
  const ids = EDITOR_COMMANDS.map((row) => row.id);
  check("no command is listed twice", new Set(ids).size === ids.length);
  const noRunner = RUNNABLE.filter((row) => !RUNNERS[row.id]).map((row) => row.id);
  check("every command that can be run has something to run", noRunner.length === 0, noRunner.join(" "));
  const noRow = Object.keys(RUNNERS).filter((id) => !RUNNABLE.some((row) => row.id === id));
  check("and nothing runs that is not in the list", noRow.length === 0, noRow.join(" "));
  check("the sheet's reminders are not commands", EDITOR_COMMANDS.some((row) => row.sheet) && EDITOR_COMMANDS.filter((row) => row.sheet).every((row) => !!row.keys && !RUNNERS[row.id]));
  check("a row says which kinds of document have it", offered(EDITOR_COMMANDS.find((r) => r.id === "doc.table")!, "none", 2) && !offered(EDITOR_COMMANDS.find((r) => r.id === "doc.table")!, "screenplay", 3) && !offered(EDITOR_COMMANDS.find((r) => r.id === "doc.table")!, "none", 1));
}

// ------------------------------------------------------------ keys as people read them

check("a key on a Mac, modifiers as a keyboard has them", JSON.stringify(keyCaps("Mod-Shift-l", true)) === JSON.stringify(["⇧", "⌘", "L"]) && keyLabel("Mod-Shift-l", true) === "⇧⌘L");
check("and elsewhere", JSON.stringify(keyCaps("Mod-Shift-l", false)) === JSON.stringify(["Ctrl", "Shift", "L"]) && keyLabel("Mod-Shift-l", false) === "Ctrl+Shift+L");
check("whatever order it was written in", keyLabel("Shift-Mod-z", false) === "Ctrl+Shift+Z" && keyLabel("Alt-Mod-f", true) === "⌥⌘F");
check("a hyphen is a key too", JSON.stringify(keyCaps("Mod--", false)) === JSON.stringify(["Ctrl", "-"]) && keyLabel("Mod-Shift--", true) === "⇧⌘-");
check("arrows and named keys read as themselves", keyLabel("Alt-ArrowUp", true) === "⌥↑" && keyLabel("F7", false) === "F7" && keyLabel("Shift-Enter", false) === "Shift+Enter");
check("a row with one key for a Mac and another elsewhere", keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.replace")!, true) === "Alt-Mod-f" && keysOf(EDITOR_COMMANDS.find((r) => r.id === "doc.replace")!, false) === "Ctrl-h");

// ------------------------------------------------------------ every key written down works

/** A key press, from the way ProseMirror writes the key (not on a Mac here: Mod is Ctrl). */
const CODES: Record<string, number> = { "=": 187, "-": 189, ".": 190, ",": 188, Enter: 13, Tab: 9, " ": 32 };
const SHIFTED: Record<string, string> = { "=": "+", "-": "_", ".": ">", ",": "<", "7": "&", "8": "*", "9": "(" };
const press = (e: Editor, pmKey: string): boolean => {
  const parts = pmKey.split(/-(?!$)/);
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  const shift = mods.has("Shift");
  const keyCode = CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const event = new KeyboardEvent("keydown", {
    key: shift && key.length === 1 ? (SHIFTED[key] ?? key.toUpperCase()) : key,
    keyCode,
    ctrlKey: mods.has("Mod") || mods.has("Ctrl"),
    shiftKey: shift,
    altKey: mods.has("Alt"),
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit);
  for (const plugin of e.state.plugins) {
    if (plugin.props.handleKeyDown?.call(plugin, e.view, event)) return true;
  }
  return false;
};

{
  const inText = RUNNABLE.filter((row) => row.keys && row.on !== "window" && offered(row, "none", 3));
  const dead: string[] = [];
  for (const row of inText) {
    const e = editorWith([p("One two three."), p("Four five six.")]);
    e.commands.setTextSelection({ from: 5, to: 8 });
    if (row.id === "doc.redo") {
      e.commands.insertContent("x");
      e.commands.undo();
    } else if (row.id === "doc.undo") {
      e.commands.insertContent("x");
    } else if (row.id === "doc.normal") {
      // (A key that would change nothing is passed on: start from a heading.)
      e.commands.toggleHeading({ level: 2 });
    } else if (row.id === "doc.align.left") {
      setDocAlign(e, "center");
    } else if (row.id === "doc.move.up") {
      // (From the second paragraph: the first has nowhere higher to go.)
      e.commands.setTextSelection(18);
    }
    if (!press(e, keysOf(row, false)!)) dead.push(`${row.id} (${keysOf(row, false)})`);
    e.destroy();
  }
  check(`every key the list gives for a command in the text is a key that works (${inText.length})`, dead.length === 0, dead.join(", "));

  // The same document from the key, from the command, and from neither.
  const sample = ["doc.bold", "doc.h2", "doc.bullets", "doc.align.center", "doc.strike", "doc.quote", "doc.checklist", "doc.pagebreak", "doc.superscript"];
  const differs: string[] = [];
  const inert: string[] = [];
  for (const id of sample) {
    const row = EDITOR_COMMANDS.find((r) => r.id === id)!;
    const a = editorWith([p("One two three."), p("Four five six.")]);
    const b = editorWith([p("One two three."), p("Four five six.")]);
    const before = JSON.stringify(a.getJSON());
    a.commands.setTextSelection({ from: 5, to: 8 });
    b.commands.setTextSelection({ from: 5, to: 8 });
    press(a, keysOf(row, false)!);
    runCommand(id, b, ctx);
    if (JSON.stringify(a.getJSON()) !== JSON.stringify(b.getJSON())) differs.push(id);
    if (JSON.stringify(b.getJSON()) === before) inert.push(id);
    a.destroy();
    b.destroy();
  }
  check("a key and its command by name make the same document", differs.length === 0, differs.join(" "));
  check("and each of them changes it", inert.length === 0, inert.join(" "));
}

// ------------------------------------------------------------ running them

{
  const e = editorWith([p("One two three.")]);
  e.commands.setTextSelection({ from: 5, to: 8 });
  check("a command for the room around the text is handed to it", runCommand("doc.find", e, ctx) && runCommand("doc.replace", e, ctx) && runCommand("doc.margins", e, ctx) && runCommand("doc.check", e, ctx) && calls.join(" ") === "find replace setup:margins check", calls.join(" "));
  calls.length = 0;
  check("a setting is switched", runCommand("doc.hyphenate", e, ctx) && settings.hyphenate !== DEFAULT_SETTINGS.hyphenate);
  check("the mode it is already in is not offered", !canRun("doc.mode.edit", e, ctx) && canRun("doc.mode.suggest", e, ctx) && !canRun("doc.mode.suggest", e, ctxOf({ review: { mode: "edit", setMode: () => {}, canSuggest: false, canResolve: false } })));
  check("with no change at the caret there is none to accept", !canRun("doc.change.accept", e, ctx));
  check("restart numbering waits for a numbered list", !canRun("doc.list.restart", e, ctx));
  const reader = ctxOf({ editable: false });
  check("someone who can only read can find and print, and change nothing", canRun("doc.find", e, reader) && canRun("doc.print", e, reader) && !canRun("doc.bold", e, reader) && !runCommand("doc.bold", e, reader) && !JSON.stringify(e.getJSON()).includes("bold"));
  check("a room that has no such thing does not offer it", !canRun("doc.readaloud", e, ctxOf({ shell: {} })) && !canRun("doc.marks", e, ctxOf({ shell: {} })));
  check("styles by name need the Document kind", !canRun("doc.style.title", e, ctxOf({ rich: null })) && runCommand("doc.style.title", e, ctx) && e.getJSON().content?.[0]?.attrs?.element === "title", JSON.stringify(e.getJSON().content?.[0]?.attrs));
  useDocZoom.getState().set(1);
  runCommand("doc.zoom.in", e, ctx);
  runCommand("doc.zoom.in", e, ctx);
  check("zoom steps from the size last asked for", useDocZoom.getState().z === 1.25, String(useDocZoom.getState().z));
  runCommand("doc.zoom.100", e, ctx);
  check("and goes back to 100%", useDocZoom.getState().z === 1);
  e.destroy();
}

// ------------------------------------------------------------ in the palette, while a document is open

{
  (window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  usePlatform.setState({ apps: { documents: { id: "documents", name: "Documents", offline: true } } } as never);
  const e = editorWith([p("One two three."), p("Four five six.")]);
  const Room = ({ editor, readonly }: { editor: Editor | null; readonly: boolean }) => {
    useEditorCommands(editor, ctxOf({ editable: !readonly }));
    return null;
  };
  const host = mountPoint();
  const root = createRoot(host);
  const paletteHost = mountPoint();
  const paletteRoot = createRoot(paletteHost);
  await act(async () => paletteRoot.render(createElement(CommandPalette)));
  check("with no document open the palette has none of them", !usePlatform.getState().commands["doc.bold"]);
  await act(async () => root.render(createElement(Room, { editor: e, readonly: false })));
  const listed = usePlatform.getState().commands;
  check("an open document puts its commands in the palette", RUNNABLE.every((row) => !!listed[row.id]) && listed["doc.bold"].appId === "documents");
  check("each with its key as people read it", listed["doc.bold"].keybinding === "Ctrl+B" && listed["doc.align.justify"].keybinding === "Ctrl+Shift+J" && listed["doc.table"].keybinding === undefined);

  const key = (k: string, more: KeyboardEventInit = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...more })));
  const rows = () => [...paletteHost.querySelectorAll("li")].map((li) => li.textContent ?? "");
  const type = async (text: string) =>
    act(async () => {
      const input = paletteHost.querySelector("input") as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")!.set!;
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  e.commands.setTextSelection({ from: 5, to: 8 });
  e.view.focus();
  await key("k", { ctrlKey: true });
  check("opened with nothing typed, the list is not crowded with them", !!paletteHost.querySelector("input") && !rows().some((r) => r.startsWith("Bold")) && rows().some((r) => r.startsWith("Keyboard shortcuts")), rows().join(" | "));
  await type("head 2");
  check("typing finds one by any of its words, with its key beside it", rows().length === 1 && rows()[0] === "Heading 2Ctrl+Alt+2", rows().join(" | "));
  await type("track");
  check("and by words that are not in its name", rows().some((r) => r.startsWith("Suggesting mode")), rows().join(" | "));
  await type("head 2");
  await act(async () => {
    const input = paletteHost.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  check("Enter runs it on the text", e.getJSON().content?.[0]?.type === "heading" && e.getJSON().content?.[0]?.attrs?.level === 2 && !paletteHost.querySelector("input"));
  check("the selection is where it was", e.state.selection.from === 5 && e.state.selection.to === 8, `${e.state.selection.from} ${e.state.selection.to}`);
  check("and the text has the focus again", document.activeElement === e.view.dom);

  await key("k", { ctrlKey: true });
  await type("bold");
  await key("Escape");
  await new Promise((resolve) => setTimeout(resolve, 5));
  check("Escape closes it, changes nothing and gives the focus back", !paletteHost.querySelector("input") && !JSON.stringify(e.getJSON()).includes('"bold"') && document.activeElement === e.view.dom);

  await act(async () => root.render(createElement(Room, { editor: e, readonly: true })));
  await key("k", { ctrlKey: true });
  await type("bold");
  check("a reader is not offered what changes the text", !rows().some((r) => r.startsWith("Bold")), rows().join(" | "));
  await type("find");
  check("but is offered Find", rows().some((r) => r.startsWith("Find")), rows().join(" | "));
  await key("Escape");

  await act(async () => root.unmount());
  check("closing the document takes its commands out again", !Object.keys(usePlatform.getState().commands).some((id) => id.startsWith("doc.")));
  await act(async () => paletteRoot.unmount());
  e.destroy();
}

// ------------------------------------------------------------ the shortcut sheet

{
  const sections = documentSections();
  const all = sections.flatMap((s) => s.rows);
  check("the sheet has the document's keys by group", sections.length >= 6 && sections.every((s) => s.title.startsWith("Documents: ") && s.rows.length > 0), sections.map((s) => `${s.title} ${s.rows.length}`).join(", "));
  check("every row has keys and says what they do", all.length >= 40 && all.every((r) => r.keys.length > 0 && r.keys.every((k) => k.length > 0) && r.what.length > 2), String(all.length));
  check("each is a command of the list, under its own name", all.every((r) => EDITOR_COMMANDS.some((row) => row.label === r.what)));
  const whole = shortcutSections();
  check("they sit in the sheet between Chat and Canvas", whole.findIndex((s) => s.title === "Chat") < whole.findIndex((s) => s.title.startsWith("Documents")) && whole.findIndex((s) => s.title === "Canvas") > whole.findIndex((s) => s.title.startsWith("Documents")));
}

finish();
