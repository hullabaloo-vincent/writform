/**
 * Everything the document editor can be asked to do by name: one list, read
 * by the command palette (⌘K), by the shortcut sheet (⌘/), and by the keys
 * this list itself binds. The ribbon keeps its own buttons and calls the
 * same functions (see ./run.ts for what each one does).
 *
 * Data only, and nothing imported: the app's shell reads it for the sheet
 * without pulling the editor in.
 *
 * Keys are written as ProseMirror writes them ("Mod-Shift-l": Mod is ⌘ on a
 * Mac and Ctrl elsewhere). A row's keys are the ones that REALLY do it
 * today. Unless the row says `bind`, they are bound where they always were
 * (the editor's own extensions, or a listener on the window) and are noted
 * here for the palette and the sheet. A harness holds the two in step.
 */

export type CommandGroup = "Text" | "Paragraph" | "Lists" | "Insert" | "Page and view" | "Review" | "Find and undo" | "While typing";

export interface CommandKeys {
  mac: string;
  other: string;
}

export interface EditorCommand {
  id: string;
  label: string;
  group: CommandGroup;
  /** More words to find it by. */
  keywords?: string;
  /** One string when it is the same everywhere. */
  keys?: string | CommandKeys;
  /** The kinds of document that have it (every kind when absent). */
  formats?: readonly string[];
  /** The least level of formatting the document must be able to hold. */
  level?: number;
  /** This list binds the key (./CommandKeys.ts). */
  bind?: boolean;
  /** Where the key is listened for when not in the text itself. */
  on?: "window";
  /** For the shortcut sheet only: how typing behaves, not a thing to run. */
  sheet?: boolean;
}

const DOC = ["none"] as const;
const PROSE = ["none", "manuscript"] as const;
/** The kinds of document with a story plan (src/plan). */
const PLANNED = ["none", "manuscript", "screenplay", "stageplay"] as const;

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  // ---- Text
  { id: "doc.bold", label: "Bold", group: "Text", keys: "Mod-b" },
  { id: "doc.italic", label: "Italic", group: "Text", keys: "Mod-i" },
  { id: "doc.underline", label: "Underline", group: "Text", keys: "Mod-u" },
  { id: "doc.strike", label: "Strikethrough", group: "Text", keywords: "strike through cross out", keys: "Mod-Shift-s" },
  { id: "doc.code", label: "Inline code", group: "Text", keywords: "monospace", keys: "Mod-e", formats: DOC },
  { id: "doc.subscript", label: "Subscript", group: "Text", keywords: "lowered small", keys: "Mod-=", formats: DOC, level: 2 },
  { id: "doc.superscript", label: "Superscript", group: "Text", keywords: "raised small", keys: "Mod-Shift-=", formats: DOC, level: 2 },
  { id: "doc.larger", label: "Larger text", group: "Text", keywords: "bigger size grow font", keys: "Mod-Shift-.", formats: DOC },
  { id: "doc.smaller", label: "Smaller text", group: "Text", keywords: "size shrink font", keys: "Mod-Shift-,", formats: DOC },
  { id: "doc.clear", label: "Clear formatting", group: "Text", keywords: "plain remove reset", formats: DOC },
  { id: "doc.here", label: "Formatting here", group: "Text", keywords: "what formatting style inspector reveal why does it look", formats: DOC },
  { id: "doc.case.sentence", label: "Sentence case", group: "Text", keywords: "change case capitals" },
  { id: "doc.case.lower", label: "Lowercase", group: "Text", keywords: "change case small letters" },
  { id: "doc.case.upper", label: "Uppercase", group: "Text", keywords: "change case capitals all caps" },
  { id: "doc.case.title", label: "Capitalize each word", group: "Text", keywords: "change case title" },
  { id: "doc.case.toggle", label: "Toggle case", group: "Text", keywords: "change case swap invert" },
  { id: "doc.link", label: "Link", group: "Text", keys: "Mod-Shift-k", formats: DOC, on: "window", sheet: true },

  // ---- Paragraph
  { id: "doc.normal", label: "Normal text", group: "Paragraph", keywords: "paragraph body style", keys: "Mod-Alt-0", formats: DOC },
  { id: "doc.h1", label: "Heading 1", group: "Paragraph", keywords: "title style", keys: "Mod-Alt-1", formats: DOC },
  { id: "doc.h2", label: "Heading 2", group: "Paragraph", keywords: "style", keys: "Mod-Alt-2", formats: DOC },
  { id: "doc.h3", label: "Heading 3", group: "Paragraph", keywords: "style", keys: "Mod-Alt-3", formats: DOC },
  { id: "doc.h4", label: "Heading 4", group: "Paragraph", keywords: "style", keys: "Mod-Alt-4", formats: DOC },
  { id: "doc.h5", label: "Heading 5", group: "Paragraph", keywords: "style", keys: "Mod-Alt-5", formats: DOC },
  { id: "doc.h6", label: "Heading 6", group: "Paragraph", keywords: "style", keys: "Mod-Alt-6", formats: DOC },
  { id: "doc.style.title", label: "Title style", group: "Paragraph", formats: DOC },
  { id: "doc.style.subtitle", label: "Subtitle style", group: "Paragraph", formats: DOC },
  { id: "doc.style.caption", label: "Caption style", group: "Paragraph", formats: DOC },
  { id: "doc.quote", label: "Block quote", group: "Paragraph", keywords: "quotation indent", keys: "Mod-Shift-b", formats: PROSE },
  { id: "doc.codeblock", label: "Code block", group: "Paragraph", keywords: "monospace program", keys: "Mod-Alt-c", formats: DOC },
  { id: "doc.align.left", label: "Align left", group: "Paragraph", keys: "Mod-Shift-l", formats: PROSE },
  { id: "doc.align.center", label: "Center", group: "Paragraph", keywords: "center align middle", keys: "Mod-Shift-e", formats: PROSE },
  { id: "doc.align.right", label: "Align right", group: "Paragraph", keys: "Mod-Shift-r", formats: PROSE },
  { id: "doc.align.justify", label: "Justify", group: "Paragraph", keywords: "align both edges", keys: "Mod-Shift-j", formats: DOC },
  { id: "doc.indent.more", label: "Indent more", group: "Paragraph", keywords: "increase indent right", formats: DOC },
  { id: "doc.indent.less", label: "Indent less", group: "Paragraph", keywords: "decrease indent outdent left", formats: DOC },
  { id: "doc.move.up", label: "Move the paragraph up", group: "Paragraph", keywords: "move line block list item earlier", keys: { mac: "Ctrl-Shift-ArrowUp", other: "Alt-Shift-ArrowUp" }, bind: true },
  { id: "doc.move.down", label: "Move the paragraph down", group: "Paragraph", keywords: "move line block list item later", keys: { mac: "Ctrl-Shift-ArrowDown", other: "Alt-Shift-ArrowDown" }, bind: true },

  // ---- Lists
  { id: "doc.bullets", label: "Bulleted list", group: "Lists", keywords: "bullet points", keys: "Mod-Shift-8", formats: DOC },
  { id: "doc.numbers", label: "Numbered list", group: "Lists", keywords: "numbering ordered", keys: "Mod-Shift-7", formats: DOC },
  { id: "doc.checklist", label: "Checklist", group: "Lists", keywords: "tasks to do tick boxes", keys: "Mod-Shift-9", formats: DOC, level: 2 },
  { id: "doc.list.restart", label: "Restart numbering at 1", group: "Lists", formats: DOC },
  { id: "doc.list.continue", label: "Continue the list before", group: "Lists", keywords: "numbering carry on", formats: DOC },

  // ---- Insert
  { id: "doc.table", label: "Insert a table", group: "Insert", keywords: "grid rows columns", formats: DOC, level: 2 },
  { id: "doc.pagebreak", label: "Page break", group: "Insert", keywords: "new page", keys: "Mod-Enter", formats: PROSE },
  { id: "doc.columnbreak", label: "Column break", group: "Insert", keywords: "next column", formats: DOC, level: 2 },
  { id: "doc.footnote", label: "Footnote", group: "Insert", keywords: "note reference", formats: DOC, level: 2 },
  { id: "doc.endnote", label: "Endnote", group: "Insert", keywords: "note reference", formats: DOC, level: 2 },
  { id: "doc.toc", label: "Table of contents", group: "Insert", keywords: "contents headings", formats: DOC, level: 2 },
  { id: "doc.divider", label: "Divider", group: "Insert", keywords: "horizontal rule line scene break", formats: PROSE },
  { id: "doc.linebreak", label: "Line break", group: "Insert", keywords: "new line same paragraph", keys: "Shift-Enter" },
  { id: "doc.date", label: "Today's date", group: "Insert", formats: DOC },
  // (On a Mac, Option with the space bar types a no-break space anyway: bound here too, so it is the same everywhere.)
  { id: "doc.nbsp", label: "No-break space", group: "Insert", keywords: "non-breaking nonbreaking hard space keep together", keys: { mac: "Alt-Space", other: "Mod-Shift-Space" }, bind: true },
  { id: "doc.nbhyphen", label: "No-break hyphen", group: "Insert", keywords: "non-breaking nonbreaking hard hyphen keep together", keys: "Mod-Shift--", bind: true },
  { id: "doc.softhyphen", label: "Optional hyphen", group: "Insert", keywords: "soft discretionary hyphen break here", keys: "Mod--", bind: true },

  // ---- Page and view
  { id: "doc.pagesetup", label: "Page setup", group: "Page and view", keywords: "paper size orientation columns", formats: DOC },
  { id: "doc.margins", label: "Margins", group: "Page and view", keywords: "page setup custom", formats: DOC },
  { id: "doc.headers", label: "Headers and footers", group: "Page and view", keywords: "page numbers running head", formats: DOC },
  { id: "doc.hyphenate", label: "Hyphenate words at line ends", group: "Page and view", keywords: "hyphenation", formats: DOC },
  { id: "doc.linenumbers", label: "Number the lines", group: "Page and view", keywords: "line numbers", formats: DOC },
  { id: "doc.preview", label: "Preview the printed pages", group: "Page and view", keywords: "print preview" },
  { id: "doc.print", label: "Print", group: "Page and view", keys: "Mod-p", on: "window" },
  { id: "doc.marks", label: "Show formatting marks", group: "Page and view", keywords: "paragraph marks pilcrow hidden characters spaces tabs line breaks", formats: DOC },
  { id: "doc.pageview", label: "Page view", group: "Page and view", keywords: "pages breaks sheets" },
  { id: "doc.focus", label: "Focus mode", group: "Page and view", keywords: "distraction free full screen" },
  { id: "doc.chapter.only", label: "Show only this chapter", group: "Page and view", keywords: "one chapter section focus hide the rest outline" },
  { id: "doc.chapter.all", label: "Show the whole text", group: "Page and view", keywords: "every chapter everything all sections" },
  { id: "doc.plan", label: "Story plan", group: "Page and view", keywords: "plot lines board cards beats planning outline", keys: "Alt-Mod-p", formats: PLANNED, bind: true },
  { id: "doc.plan.panel", label: "Plan for this chapter", group: "Page and view", keywords: "beats cards scene section side panel", formats: PLANNED },
  { id: "doc.plan.cast", label: "Cast and world", group: "Page and view", keywords: "characters people places things story bible names", formats: PLANNED },
  { id: "doc.plan.timeline", label: "Story timeline", group: "Page and view", keywords: "events chronology flashback story order", formats: PLANNED },
  { id: "doc.paper", label: "Dark paper", group: "Page and view", keywords: "night mode dark page light" },
  { id: "doc.ruler", label: "Show the ruler", group: "Page and view", keywords: "margins indents tab stops", formats: DOC },
  { id: "doc.zoom.in", label: "Zoom in", group: "Page and view", keywords: "larger page magnify" },
  { id: "doc.zoom.out", label: "Zoom out", group: "Page and view", keywords: "smaller page" },
  { id: "doc.zoom.100", label: "Zoom to 100%", group: "Page and view", keywords: "actual size reset" },
  { id: "doc.zoom.width", label: "Zoom to the page width", group: "Page and view", keywords: "fit window" },
  { id: "doc.zoom.page", label: "Zoom to the whole page", group: "Page and view", keywords: "fit window" },

  // ---- Review
  { id: "doc.check", label: "Check the document", group: "Review", keywords: "proofread consistency spelling style reports", keys: "F7", on: "window" },
  { id: "doc.comments", label: "Comments", group: "Review", keywords: "feedback notes threads" },
  { id: "doc.changes", label: "Suggested changes", group: "Review", keywords: "tracked changes suggestions list" },
  { id: "doc.mode.edit", label: "Editing mode", group: "Review", keywords: "stop suggesting write directly" },
  { id: "doc.mode.suggest", label: "Suggesting mode", group: "Review", keywords: "track changes suggest" },
  { id: "doc.mode.view", label: "Viewing mode", group: "Review", keywords: "read only final" },
  { id: "doc.change.next", label: "Next change", group: "Review", keywords: "suggestion" },
  { id: "doc.change.previous", label: "Previous change", group: "Review", keywords: "suggestion" },
  { id: "doc.change.accept", label: "Accept this change", group: "Review", keywords: "suggestion" },
  { id: "doc.change.reject", label: "Reject this change", group: "Review", keywords: "suggestion" },
  { id: "doc.history", label: "Version history", group: "Review", keywords: "versions drafts restore" },
  { id: "doc.readaloud", label: "Read aloud", group: "Review", keywords: "listen speak voice" },
  { id: "doc.compare", label: "Compare with a Word file", group: "Review", keywords: "differences docx" },

  // ---- Find and undo
  { id: "doc.find", label: "Find", group: "Find and undo", keywords: "search", keys: "Mod-f", on: "window" },
  { id: "doc.replace", label: "Find and replace", group: "Find and undo", keywords: "search swap", keys: { mac: "Alt-Mod-f", other: "Ctrl-h" }, on: "window" },
  { id: "doc.goto", label: "Go to a page or a heading", group: "Find and undo", keywords: "jump page number heading navigate", keys: "Alt-Mod-g", bind: true },
  { id: "doc.goback", label: "Back to where I last wrote", group: "Find and undo", keywords: "last edit place return previous change", keys: "Shift-F5", bind: true },
  { id: "doc.grow", label: "Select more", group: "Find and undo", keywords: "grow extend expand selection word sentence paragraph", keys: { mac: "Alt-Mod-ArrowUp", other: "F8" }, bind: true },
  { id: "doc.shrink", label: "Select less", group: "Find and undo", keywords: "shrink selection back", keys: { mac: "Alt-Mod-ArrowDown", other: "Shift-F8" }, bind: true },
  { id: "doc.undo", label: "Undo", group: "Find and undo", keys: "Mod-z" },
  { id: "doc.redo", label: "Redo", group: "Find and undo", keys: "Shift-Mod-z" },

  // ---- While typing (the sheet's reminders)
  { id: "doc.typing.tab", label: "In a list, move the item in a level", group: "While typing", keys: "Tab", sheet: true },
  { id: "doc.typing.untab", label: "In a list, move the item out a level", group: "While typing", keys: "Shift-Tab", sheet: true },
  { id: "doc.typing.cell", label: "In a table, go to the next cell", group: "While typing", keys: "Tab", formats: DOC, sheet: true },
  { id: "doc.typing.picture.up", label: "Move the selected picture up", group: "While typing", keys: "Alt-ArrowUp", formats: DOC, sheet: true },
  { id: "doc.typing.picture.down", label: "Move the selected picture down", group: "While typing", keys: "Alt-ArrowDown", formats: DOC, sheet: true },
  { id: "doc.typing.elements", label: "In a script, choose the element", group: "While typing", keys: "Mod-1", formats: ["screenplay", "stageplay", "poetry", "manuscript"], sheet: true },
];

/** Is this a Mac (or an iPhone or iPad with a keyboard)? */
export function isMacLike(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The key a row is pressed with here, as ProseMirror writes it. */
export function keysOf(row: Pick<EditorCommand, "keys">, mac = isMacLike()): string | null {
  if (!row.keys) return null;
  return typeof row.keys === "string" ? row.keys : mac ? row.keys.mac : row.keys.other;
}

const MAC_NAMES: Record<string, string> = { Mod: "⌘", Cmd: "⌘", Meta: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" };
const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", " ": "Space", Space: "Space" };

/**
 * A key as people read it, one part to a key cap: "Mod-Shift-l" is ⌘ ⇧ L on
 * a Mac and Ctrl Shift L elsewhere. (Modifiers come in the order a keyboard
 * has them, whatever order the binding was written in.)
 */
export function keyCaps(pmKey: string, mac = isMacLike()): string[] {
  // (The key itself may be "-": it is whatever follows the last modifier.)
  const parts = pmKey.split(/-(?!$)/);
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  const order = mac ? ["Ctrl", "Alt", "Shift", "Mod", "Cmd", "Meta"] : ["Mod", "Ctrl", "Alt", "Shift"];
  const caps: string[] = [];
  for (const mod of order) {
    if (!mods.has(mod)) continue;
    const name = mac ? MAC_NAMES[mod] : mod === "Mod" ? "Ctrl" : mod;
    if (!caps.includes(name)) caps.push(name);
  }
  caps.push(key === "Enter" ? (mac ? "↩" : "Enter") : (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)));
  return caps;
}

/** The same in one piece, for a menu: "⌘⇧L" or "Ctrl+Shift+L". */
export function keyLabel(pmKey: string, mac = isMacLike()): string {
  return keyCaps(pmKey, mac).join(mac ? "" : "+");
}

/** A name with the keys that do it, for a button's title: "Bold (⌘B)" on
 *  a Mac, "Bold (Ctrl+B)" on Windows and Linux. Never a symbol written out
 *  by hand: a Linux user reads ⌘ as nothing at all. */
export function withKeys(name: string, ...pmKeys: string[]): string {
  return `${name} (${pmKeys.map((key) => keyLabel(key)).join(", ")})`;
}

/** The command key's name here: ⌘ on a Mac, Ctrl elsewhere ("Ctrl-click"). */
export function modName(mac = isMacLike()): string {
  return mac ? "⌘" : "Ctrl";
}

/** Does a document of this kind and level have this command? */
export function offered(row: EditorCommand, format: string, level: number): boolean {
  if (row.formats && !row.formats.includes(format)) return false;
  return !row.level || level >= row.level;
}
