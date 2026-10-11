import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DisplayList } from "../engine/types";
import type { Book } from "../model/bookMap";
import { buildModel } from "../model/buildModel";

export interface PreviewState {
  dl: DisplayList | null;
  busy: boolean;
  message: string;
  error: string | null;
  retry: () => void;
}

/** Every face a layout uses, loaded before its pages show (no flash of a
 *  fallback font). */
async function fontsReady(dl: DisplayList) {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await Promise.all(
    dl.faces.map((f) =>
      document.fonts.load(`${f.cssStyle} ${f.fakeBold ? 400 : f.cssWeight} 16px ${f.cssFamily}`).catch(() => []),
    ),
  );
}

/** What a preview shows: a book's pages, or a document's. */
export interface PreviewSource {
  /** Lay the writing out as it is now. Null when a newer layout on the same
   *  channel overtook this one. */
  layout(editor: Editor, channel: string, onProgress: (message: string) => void): Promise<DisplayList | null>;
  /** What the layout depends on besides the text (the book's design, the
   *  page setup): a new value lays the pages out again. */
  key: unknown;
  paper: "cream" | "white";
  /** "book" or "document", for the words on screen. */
  noun: string;
}

/** A book manuscript, typeset as its paperback. */
export function bookSource(format: string, book: Book): PreviewSource {
  return {
    key: book,
    paper: book.print.paper,
    noun: "book",
    layout: async (editor, channel, onProgress) => {
      const model = buildModel(editor.getJSON(), format, book);
      const { typesetter } = await import("../engine/client");
      const dl = await typesetter().layout("paperback", model, onProgress, channel);
      // A book set in a catalog family: the page needs its files to draw it.
      if (dl?.faces.some((f) => f.family.startsWith("gf:"))) {
        const { showFamilies } = await import("../../fonts/store");
        await showFamilies(dl.faces.map((f) => f.family));
      }
      return dl;
    },
  };
}

/**
 * The pages laid out for the preview, from the writing as it is now.
 * Re-laid when the source's key changes; with `live`, also a moment after
 * the writing stops (the worker re-sets only what changed). The last good
 * layout stays up while a new one is made.
 */
export function usePreviewLayout(editor: Editor, source: PreviewSource, live: boolean, channel: string, idleMs = 800): PreviewState {
  const [state, setState] = useState<Omit<PreviewState, "retry">>({ dl: null, busy: true, message: `Setting the ${source.noun}…`, error: null });
  const sourceRef = useRef(source);
  const seq = useRef(0);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  const run = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const dl = await sourceRef.current.layout(
        editor,
        channel,
        (message) => {
          if (mine === seq.current) setState((s) => ({ ...s, message }));
        },
      );
      if (!dl || mine !== seq.current) return;
      await fontsReady(dl);
      if (mine !== seq.current) return;
      setState({ dl, busy: false, message: "", error: null });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [editor, channel]);

  const key = source.key;
  useEffect(() => {
    // The ref is updated by an effect declared above, so it's current here.
    void run();
  }, [run, key]);

  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), idleMs);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor, live, run, idleMs]);

  return { ...state, retry: () => void run() };
}

// ---------------------------------------------------------------- navigation

/** The pages shown together as a spread: page 1 (index 0) sits alone on
 *  the right; after it, each left-hand page with the right-hand page after. */
export function spreadOf(index: number, count: number): [number | null, number | null] {
  if (index <= 0) return [null, 0];
  const verso = index % 2 === 1 ? index : index - 1;
  return [verso, verso + 1 < count ? verso + 1 : null];
}

/** The same reading position in a new layout: the same section, the same
 *  distance into it. */
export function mapPosition(old: DisplayList, next: DisplayList, at: number): number {
  const page = old.pages[at];
  const s = page ? page.section : -1;
  if (s >= 0 && old.sections[s] && next.sections[s]) {
    const offset = at - old.sections[s].firstPage;
    const end = (next.sections[s + 1]?.firstPage ?? next.pages.length) - 1;
    return Math.max(0, Math.min(next.sections[s].firstPage + offset, end));
  }
  return Math.max(0, Math.min(at, next.pages.length - 1));
}

/** The page a manuscript block (top-level index) is set on. */
export function pageForBlock(dl: DisplayList, block: number): number {
  let best = 0;
  for (let i = 0; i < dl.pages.length; i += 1) {
    let min = Infinity;
    let max = -Infinity;
    for (const it of dl.pages[i].items) {
      if (it.t !== "text" || it.src === undefined || it.src < 0) continue;
      min = Math.min(min, it.src);
      max = Math.max(max, it.src);
    }
    if (min === Infinity) continue;
    if (min <= block && block <= max) return i;
    if (min <= block) best = i;
  }
  return best;
}

/** The section a page belongs to (the last one starting at or before it). */
export function sectionAt(dl: DisplayList, page: number): number {
  let found = -1;
  dl.sections.forEach((s, i) => {
    if (s.firstPage <= page) found = i;
  });
  return found;
}
