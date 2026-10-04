import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { onBookChange, readBook, type Book } from "../../../book/model/bookMap";
import { bookFont } from "../../../book/fonts/registry";
import { blockOffsets } from "../../../book/model/structure";
import type { BookExportKind } from "../../../book/ui/ExportBookDialog";
import type { DocProvider, SyncState } from "../collab";
import type { ExportItem } from "./ExportMenu";
import type { SaveIndicator } from "./SyncStatus";

/**
 * A Manuscript's book outputs in the Export menu (both editors): the
 * print-ready paperback, a print-at-home booklet, the ebook, and the
 * submission manuscript as PDF or Word. All but the Word file open the
 * export dialog (preflight, then build).
 */
export function bookExportItems(open: (kind: BookExportKind) => void, word: () => Promise<unknown>): ExportItem[] {
  return [
    {
      label: "Paperback PDF (print-ready)…",
      title: "The book's interior for KDP or IngramSpark, typeset in the book design",
      separatorBefore: true,
      run: async () => open("paperback"),
    },
    {
      label: "Booklet PDF (print at home)…",
      title: "Two pages to a sheet in saddle-stitch order: print two-sided (flip on the short edge), fold, staple",
      run: async () => open("booklet"),
    },
    {
      label: "Ebook (EPUB)…",
      title: "For Kindle (through KDP), Apple Books, Kobo and Google Play",
      run: async () => open("epub"),
    },
    {
      label: "Submission manuscript (PDF)…",
      title: "Standard Manuscript Format for agents and editors: 12 pt, double-spaced, title page, running header",
      run: async () => open("submission-pdf"),
    },
    {
      label: "Submission manuscript (Word)…",
      title: "The same manuscript as a Word document, for agents who ask for .docx",
      run: word,
    },
  ];
}

/** Wide enough to keep the book preview docked beside the manuscript. */
export const canDockPreview = () => window.matchMedia("(min-width: 1100px)").matches;

/** Put the cursor in a top-level block (by index) and scroll to it — the
 *  export dialog's "Show" for a preflight warning. */
export function showBlock(editor: Editor, index: number) {
  const offsets = blockOffsets(editor.state.doc);
  const pos = offsets[Math.max(0, Math.min(index, offsets.length - 2))];
  if (pos === undefined) return;
  editor.chain().focus().setTextSelection(Math.min(pos + 1, editor.state.doc.content.size)).scrollIntoView().run();
}

/**
 * Which extensions' input rules run, per format. A book manuscript keeps
 * scene breaks (`---`, `***`), block quotes, bold/italic and smart
 * punctuation, and drops the Markdown list/heading/code rules — typing
 * "* * *" for a scene break must never start a bullet list.
 */
export function inputRulesFor(format: string): true | string[] {
  if (format === "manuscript") {
    return ["horizontalRule", "blockquote", "bold", "italic", "formatKeymap", "smartPunctuation"];
  }
  return true;
}

/** Paste rules per format: a manuscript keeps only bold/italic (no
 *  auto-links or Markdown conversion of pasted prose). */
export function pasteRulesFor(format: string): true | string[] {
  return format === "manuscript" ? ["bold", "italic"] : true;
}

/** The book's details and design (Y.Map "book"), live; `ref` is for editor
 *  extensions that read it at type time. */
export function useBook(doc: Y.Doc, fallbacks: { title?: string; author?: string }) {
  const { title, author } = fallbacks;
  const [book, setBook] = useState<Book>(() => readBook(doc, { title, author }));
  const ref = useRef(book);
  useEffect(() => {
    ref.current = book;
  }, [book]);
  useEffect(() => {
    const reread = () => setBook(readBook(doc, { title, author }));
    reread();
    return onBookChange(doc, reread);
  }, [doc, title, author]);
  return { book, ref };
}

/** CSS variables that style the manuscript view from the book design. */
export function manuscriptVars(book: Book): Record<string, string> {
  const ornament = book.design.sceneBreak === "blank" ? "* * *" : book.design.ornament || "⁂";
  return {
    "--wfb-font": bookFont(book.design.bodyFont).css,
    "--wfb-head-font": bookFont(book.design.headingFont).css,
    "--wfb-ornament": JSON.stringify(ornament),
  };
}

/**
 * Editor props shared by both document editors. A module constant on
 * purpose: TipTap compares `editorProps` by identity, and an inline object
 * made every parent render reconfigure and redraw the whole editor view.
 * WebViews default contenteditable spellcheck off — writers want the squiggle.
 */
export const EDITOR_PROPS = { attributes: { spellcheck: "true" } };

/** ⌘F / Ctrl+F opens find (with the selected words); ⌥⌘F / Ctrl+H opens
 *  find and replace. Pressed again while the bar is open, they refocus it. */
export function useFindShortcut(editor: Editor | null, open: (replace: boolean, prefill: string) => void) {
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const onKey = (e: KeyboardEvent) => {
      const f = e.code === "KeyF" || e.key.toLowerCase() === "f";
      const replace = mac ? e.metaKey && e.altKey && f : e.ctrlKey && !e.altKey && e.key.toLowerCase() === "h";
      const find = (e.metaKey || e.ctrlKey) && !e.altKey && f;
      if (!find && !replace) return;
      e.preventDefault();
      open(replace, selectedPhrase(editor));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, open]);
}

/** What opening find asks of the bar. `n` changes with every request. */
export interface FindRequest {
  n: number;
  replace: boolean;
  prefill: string;
}

/** The selected words, to search for (a short, single-line selection). */
export function selectedPhrase(editor: Editor | null): string {
  if (!editor) return "";
  const { from, to, empty } = editor.state.selection;
  if (empty) return "";
  const text = editor.state.doc.textBetween(from, to, "\n");
  return text.length <= 200 && !text.includes("\n") ? text : "";
}

/** The server document's save state, for the indicator. */
export function useServerSyncState(provider: DocProvider): SaveIndicator {
  const [state, setState] = useState<SyncState>(() => provider.getStatus());
  useEffect(() => {
    setState(provider.getStatus());
    return provider.subscribe(setState);
  }, [provider]);
  return serverIndicator(state);
}

export function serverIndicator(s: SyncState): SaveIndicator {
  switch (s.kind) {
    case "synced":
      return { kind: "synced" };
    case "pending":
      return { kind: "pending" };
    case "offline":
      return {
        kind: "offline",
        detail:
          s.reason === "auth"
            ? "Signed out — your changes are kept on this device and send when you sign back in."
            : s.reason === "scope"
              ? "Connected to a different server — your changes send when you're back on this one."
              : "Changes are kept on this device and sync when you reconnect.",
      };
    case "error":
      return { kind: "error", message: s.message };
  }
}
