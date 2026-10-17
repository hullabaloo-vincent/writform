/**
 * What each command in ./catalog.ts does. One entry per row that can be
 * run: the same functions the ribbon's buttons call, so the palette, a key
 * and a button can never drift apart.
 */

import type { Editor } from "@tiptap/core";

import type { DocSettings, SetupSection } from "../../apps/documents/docSettings";
import { stepZoom, useDocZoom } from "../../apps/documents/shell/zoom";
import { chapterAt, chapterFocus, focusChapterAt, showEverything } from "../ChapterFocus";
import { editPlaces, goBackToEdit } from "../EditPlaces";
import { changeCase, clearFormatting, insertDate, insertSpecial, setListStart, type CaseKind } from "../format/commands";
import type { FormatContext } from "../format/effective";
import { growSelection, shrinkSelection } from "../format/grow";
import { canMoveBlocks, moveBlocks } from "../format/movePicture";
import { stepIndent, toggleColumnBreak } from "../format/ParaFormat";
import { stepRunSize, toggleScript } from "../format/run";
import { toggleWordMark } from "../format/wordMark";
import { insertNote } from "../nodes/Footnote";
import { toggleChecklist } from "../nodes/TaskList";
import { insertToc } from "../nodes/Toc";
import { resolveInEditor, selectedChanges, stepChange, type ReviewMode } from "../review/Suggesting";
import { applyStyle } from "../styles/apply";
import { insertTable } from "../tables/Table";
import { insertPageBreak, setDocAlign } from "../TextFormat";
import { useDarkPaper } from "../ui/darkPaper";
import { useRulerShown } from "../ui/Ruler";
import { EDITOR_COMMANDS } from "./catalog";

/** What the room around the text can do. Each editor gives what it has. */
export interface ShellActions {
  find?: (replace: boolean) => void;
  check?: () => void;
  comments?: () => void;
  changes?: () => void;
  history?: () => void;
  readAloud?: () => void;
  compareFile?: () => void;
  pageSetup?: (section?: SetupSection) => void;
  preview?: () => void;
  print?: () => void;
  toggleMarks?: () => void;
  togglePageView?: () => void;
  toggleFocus?: () => void;
  goTo?: () => void;
  /** The story plan, open at one of its tabs. */
  plan?: (tab?: "board" | "cast" | "timeline") => void;
  /** The plan for the chapter at the caret, beside the text. */
  planPanel?: () => void;
}

/** The document a command is run in, as it is at that moment. */
export interface CommandCtx {
  /** The kind of document. */
  format: string;
  /** The Document kind's styles and the level of formatting it may hold. */
  rich: FormatContext | null;
  /** The text can be changed (not a reader, not Viewing). */
  editable: boolean;
  /** The language the text is written in (where its sentences end). */
  lang?: string;
  settings?: DocSettings;
  patchSettings?: (patch: Partial<DocSettings>) => void;
  review?: { mode: ReviewMode; setMode: (mode: ReviewMode) => void; canSuggest: boolean; canResolve: boolean };
  shell: ShellActions;
}

export interface Runner {
  /** Whether it can be done now (when absent: whenever the text can be changed). */
  enabled?: (editor: Editor, ctx: CommandCtx) => boolean;
  run: (editor: Editor, ctx: CommandCtx) => unknown;
  /** It opens something of its own: the text is not given the focus back. */
  leaves?: boolean;
}

const edit = (run: (editor: Editor, ctx: CommandCtx) => unknown): Runner => ({ run });
/** Something the room does, whether or not the text can be changed. */
const shell = (pick: (s: ShellActions) => (() => void) | undefined): Runner => ({
  enabled: (_e, ctx) => !!pick(ctx.shell),
  run: (_e, ctx) => pick(ctx.shell)?.(),
  leaves: true,
});
const styled = (id: string): Runner => ({
  enabled: (_e, ctx) => ctx.editable && !!ctx.rich,
  run: (editor, ctx) => (ctx.rich ? applyStyle(editor, id, ctx.rich.styles) : false),
});
const cased = (kind: CaseKind): Runner => edit((editor) => changeCase(editor, kind));
const heading = (level: 1 | 2 | 3 | 4 | 5 | 6): Runner => edit((editor) => editor.chain().focus().toggleHeading({ level }).run());
const setting = (key: "hyphenate" | "lineNumbers"): Runner => ({
  enabled: (_e, ctx) => ctx.editable && !!ctx.settings && !!ctx.patchSettings,
  run: (_e, ctx) => ctx.settings && ctx.patchSettings?.({ [key]: !ctx.settings[key] }),
});
const mode = (to: ReviewMode): Runner => ({
  enabled: (_e, ctx) => !!ctx.review && ctx.review.mode !== to && (to !== "suggest" || ctx.review.canSuggest),
  run: (_e, ctx) => ctx.review?.setMode(to),
});
const resolve = (verdict: "accept" | "reject"): Runner => ({
  enabled: (editor, ctx) => !!ctx.review?.canResolve && selectedChanges(editor).length > 0,
  run: (editor) => {
    if (resolveInEditor(editor, selectedChanges(editor), verdict)) stepChange(editor, 1);
  },
});
const zoom = (to: (now: number) => void): Runner => ({
  enabled: () => true,
  run: () => {
    const state = useDocZoom.getState();
    to(state.mode === "percent" ? state.z : state.shown);
  },
});
/** The list item the caret is in, if it is in one. */
const itemAt = (editor: Editor): "taskItem" | "listItem" | null => (editor.isActive("taskItem") ? "taskItem" : editor.isActive("listItem") ? "listItem" : null);

export const RUNNERS: Readonly<Record<string, Runner>> = {
  "doc.bold": edit((e) => toggleWordMark(e, "bold")),
  "doc.italic": edit((e) => toggleWordMark(e, "italic")),
  "doc.underline": edit((e) => toggleWordMark(e, "underline")),
  "doc.strike": edit((e) => e.chain().focus().toggleStrike().run()),
  "doc.code": edit((e) => e.chain().focus().toggleCode().run()),
  "doc.subscript": edit((e) => toggleScript(e, "sub")),
  "doc.superscript": edit((e) => toggleScript(e, "super")),
  "doc.larger": { enabled: (_e, ctx) => ctx.editable && !!ctx.rich, run: (e, ctx) => ctx.rich && stepRunSize(e, 1, ctx.rich) },
  "doc.smaller": { enabled: (_e, ctx) => ctx.editable && !!ctx.rich, run: (e, ctx) => ctx.rich && stepRunSize(e, -1, ctx.rich) },
  "doc.clear": edit((e) => clearFormatting(e)),
  "doc.here": shell((s) => s.pageSetup && (() => s.pageSetup?.("here"))),
  "doc.case.sentence": cased("sentence"),
  "doc.case.lower": cased("lower"),
  "doc.case.upper": cased("upper"),
  "doc.case.title": cased("title"),
  "doc.case.toggle": cased("toggle"),

  "doc.normal": edit((e) => e.chain().focus().setParagraph().run()),
  "doc.h1": heading(1),
  "doc.h2": heading(2),
  "doc.h3": heading(3),
  "doc.h4": heading(4),
  "doc.h5": heading(5),
  "doc.h6": heading(6),
  "doc.style.title": styled("title"),
  "doc.style.subtitle": styled("subtitle"),
  "doc.style.caption": styled("caption"),
  "doc.quote": edit((e) => e.chain().focus().toggleBlockquote().run()),
  "doc.codeblock": edit((e) => e.chain().focus().toggleCodeBlock().run()),
  "doc.align.left": edit((e) => setDocAlign(e, "left")),
  "doc.align.center": edit((e) => setDocAlign(e, "center")),
  "doc.align.right": edit((e) => setDocAlign(e, "right")),
  "doc.align.justify": edit((e) => setDocAlign(e, "justify")),
  "doc.indent.more": edit((e) => {
    const item = itemAt(e);
    return item ? e.chain().focus().sinkListItem(item).run() : stepIndent(e, 1);
  }),
  "doc.indent.less": edit((e) => {
    const item = itemAt(e);
    return item ? e.chain().focus().liftListItem(item).run() : stepIndent(e, -1);
  }),

  "doc.bullets": edit((e) => e.chain().focus().toggleBulletList().run()),
  "doc.numbers": edit((e) => e.chain().focus().toggleOrderedList().run()),
  "doc.checklist": edit((e) => toggleChecklist(e)),
  "doc.list.restart": { enabled: (e, ctx) => ctx.editable && e.isActive("orderedList"), run: (e) => setListStart(e, "restart") },
  "doc.list.continue": { enabled: (e, ctx) => ctx.editable && e.isActive("orderedList"), run: (e) => setListStart(e, "continue") },

  "doc.move.up": { enabled: (e, ctx) => ctx.editable && canMoveBlocks(e, -1), run: (e) => moveBlocks(e, -1) },
  "doc.move.down": { enabled: (e, ctx) => ctx.editable && canMoveBlocks(e, 1), run: (e) => moveBlocks(e, 1) },

  "doc.table": edit((e) => insertTable(e, 3, 3)),
  "doc.pagebreak": edit((e) => insertPageBreak(e)),
  "doc.columnbreak": edit((e) => toggleColumnBreak(e)),
  "doc.footnote": { run: (e) => insertNote(e, "foot"), leaves: true },
  "doc.endnote": { run: (e) => insertNote(e, "end"), leaves: true },
  "doc.toc": edit((e) => insertToc(e)),
  "doc.divider": edit((e) => e.chain().focus().setHorizontalRule().run()),
  "doc.linebreak": edit((e) => e.chain().focus().setHardBreak().run()),
  "doc.date": edit((e) => insertDate(e)),
  "doc.nbsp": edit((e) => insertSpecial(e, "nbsp")),
  "doc.nbhyphen": edit((e) => insertSpecial(e, "nbhyphen")),
  "doc.softhyphen": edit((e) => insertSpecial(e, "softhyphen")),

  "doc.pagesetup": shell((s) => s.pageSetup && (() => s.pageSetup?.("paper"))),
  "doc.margins": shell((s) => s.pageSetup && (() => s.pageSetup?.("margins"))),
  "doc.headers": shell((s) => s.pageSetup && (() => s.pageSetup?.("header"))),
  "doc.hyphenate": setting("hyphenate"),
  "doc.linenumbers": setting("lineNumbers"),
  "doc.preview": shell((s) => s.preview),
  "doc.print": shell((s) => s.print),
  "doc.marks": { enabled: (_e, ctx) => !!ctx.shell.toggleMarks, run: (_e, ctx) => ctx.shell.toggleMarks?.() },
  "doc.pageview": { enabled: (_e, ctx) => !!ctx.shell.togglePageView, run: (_e, ctx) => ctx.shell.togglePageView?.() },
  "doc.focus": { enabled: (_e, ctx) => !!ctx.shell.toggleFocus, run: (_e, ctx) => ctx.shell.toggleFocus?.() },
  "doc.chapter.only": { enabled: (e) => !!chapterAt(e) && chapterAt(e)?.from !== chapterFocus(e.state)?.from, run: (e) => focusChapterAt(e) },
  "doc.chapter.all": { enabled: (e) => !!chapterFocus(e.state), run: (e) => showEverything(e) },
  "doc.paper": { enabled: () => true, run: () => useDarkPaper.getState().set(!useDarkPaper.getState().dark) },
  "doc.ruler": { enabled: () => true, run: () => useRulerShown.getState().set(!useRulerShown.getState().on) },
  "doc.zoom.in": zoom((now) => useDocZoom.getState().set(stepZoom(now, 1))),
  "doc.zoom.out": zoom((now) => useDocZoom.getState().set(stepZoom(now, -1))),
  "doc.zoom.100": zoom(() => useDocZoom.getState().set(1)),
  "doc.zoom.width": zoom(() => useDocZoom.getState().fit("width")),
  "doc.zoom.page": zoom(() => useDocZoom.getState().fit("page")),

  "doc.check": shell((s) => s.check),
  "doc.comments": shell((s) => s.comments),
  "doc.changes": shell((s) => s.changes),
  "doc.mode.edit": mode("edit"),
  "doc.mode.suggest": mode("suggest"),
  "doc.mode.view": mode("view"),
  "doc.change.next": { enabled: () => true, run: (e) => stepChange(e, 1) },
  "doc.change.previous": { enabled: () => true, run: (e) => stepChange(e, -1) },
  "doc.change.accept": resolve("accept"),
  "doc.change.reject": resolve("reject"),
  "doc.history": shell((s) => s.history),
  "doc.readaloud": shell((s) => s.readAloud),
  "doc.compare": shell((s) => s.compareFile),

  "doc.find": shell((s) => s.find && (() => s.find?.(false))),
  "doc.replace": shell((s) => s.find && (() => s.find?.(true))),
  "doc.goto": shell((s) => s.goTo),
  "doc.plan": shell((s) => s.plan && (() => s.plan?.("board"))),
  "doc.plan.panel": shell((s) => s.planPanel),
  "doc.plan.cast": shell((s) => s.plan && (() => s.plan?.("cast"))),
  "doc.plan.timeline": shell((s) => s.plan && (() => s.plan?.("timeline"))),
  "doc.goback": { enabled: (e) => editPlaces(e).length > 0, run: (e) => goBackToEdit(e) },
  "doc.grow": { enabled: () => true, run: (e, ctx) => growSelection(e, ctx.lang) },
  "doc.shrink": { enabled: () => true, run: (e) => shrinkSelection(e) },
  "doc.undo": edit((e) => e.chain().focus().undo().run()),
  "doc.redo": edit((e) => e.chain().focus().redo().run()),
};

/** Can this be done in this document now? */
export function canRun(id: string, editor: Editor, ctx: CommandCtx): boolean {
  const runner = RUNNERS[id];
  if (!runner) return false;
  return runner.enabled ? runner.enabled(editor, ctx) : ctx.editable;
}

/** Do it, and (unless it opened something of its own) hand the text the
 *  focus back with its selection as it was. */
export function runCommand(id: string, editor: Editor, ctx: CommandCtx): boolean {
  const runner = RUNNERS[id];
  if (!runner || editor.isDestroyed || !canRun(id, editor, ctx)) return false;
  runner.run(editor, ctx);
  if (!runner.leaves && !editor.isDestroyed) editor.view.focus();
  return true;
}

/** The rows that are commands to run (the rest are the sheet's reminders). */
export const RUNNABLE = EDITOR_COMMANDS.filter((row) => !row.sheet);
