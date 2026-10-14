/**
 * The editor's page view, as printed: asks the layout engine where the
 * pages of the document fall — the same layout the preview, the printer
 * and the PDF use — and hands the answer to the paginator
 * (editor/Paginate.ts), which marks those places on the sheet. If the
 * engine can't say (its fonts won't load, a worker dies) the paginator
 * goes back to its simple view by itself.
 *
 * It asks as the writing goes, not only once it stops: a line typed onto a
 * full page should be on the next one before the eye looks for it. How
 * soon depends on what asking costs (see `pace`): at once, near enough,
 * for a letter or a chapter; for a whole novel, in the pauses.
 */

import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, type MutableRefObject } from "react";

import { reflowPagination, type PageMapFor } from "../editor/Paginate";
import { refreshNoteNumbers } from "../editor/nodes/NoteNumbers";
import type { DocSource } from "./exportDoc";

const PREF_KEY = "wf-doc-pageview";

/** Whether page view shows the pages as printed (the default) or the
 *  simple, block-by-block approximation. A choice per device. */
export function exactPageView(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "simple";
  } catch {
    return true;
  }
}

export function setExactPageView(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, "simple");
  } catch {
    // A convenience only.
  }
}

let channels = 0;

/**
 * How long to leave between a change and asking the engine, given what the
 * last answer took (`cost`, ms on the clock): `quiet` after the latest
 * change, and no longer than `longest` after the first one still
 * unanswered.
 *
 * Part of a request is made on the page (`main`, ms: the document is read
 * and turned into the engine's terms there, before the engine's own thread
 * takes over). Where that holds the page up for longer than a frame — a
 * whole novel — it is never put between two keystrokes: such a document is
 * asked about in the pauses of the writing only.
 */
export function pace(cost: number, main = 0): { quiet: number; longest: number } {
  return {
    quiet: Math.min(350, Math.max(40, cost * 2)),
    longest: main > 16 ? Infinity : Math.min(2400, Math.max(160, cost * 8)),
  };
}

/**
 * Keep `into` holding the page map of the editor's document while
 * `enabled`. `source` says what to lay out for the document's JSON (its
 * page setup, its styles; a script turned into its format's pages); `key`
 * is whatever else the pages depend on.
 */
export function usePageMap(
  editor: Editor | null,
  enabled: boolean,
  source: (doc: JSONContent) => DocSource,
  key: unknown,
  into: MutableRefObject<PageMapFor | "pending" | null>,
): void {
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  });
  const channel = useRef("");
  if (!channel.current) {
    channels += 1;
    channel.current = `doc-pages-${channels}`;
  }
  const keyJson = JSON.stringify(key);

  useEffect(() => {
    const drop = () => {
      if (!into.current) return;
      into.current = null;
      if (editor && !editor.isDestroyed) reflowPagination(editor);
    };
    if (!editor || !enabled) {
      drop();
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    /** One question at a time: the engine sets one text, then the next. */
    let busy = false;
    /** The text changed while it worked (ask again, for what is there now). */
    let again = false;
    /** When the oldest change still unanswered was made. */
    let waitingSince = 0;
    /** What the last answer took: in all, and of that on the page. */
    let cost = 0;
    let main = 0;
    // Until the first answer nothing is marked (not the simple view, only
    // to change a moment later).
    if (!into.current) {
      into.current = "pending";
      reflowPagination(editor);
    }
    const run = async () => {
      timer = null;
      if (!alive || editor.isDestroyed) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      again = false;
      waitingSince = 0;
      let doc = editor.state.doc;
      const began = performance.now();
      let retry = 0;
      try {
        const { docPageMap } = await import("./exportDoc");
        if (!alive || editor.isDestroyed) return;
        // (The text as it is now: the first time, the engine's own code
        // was being fetched meanwhile.)
        doc = editor.state.doc;
        const read = performance.now();
        const source = sourceRef.current(editor.getJSON());
        const timing = { model: 0 };
        const prepared = performance.now() - read;
        const map = await docPageMap(source, channel.current, timing);
        if (!alive || editor.isDestroyed) return;
        cost = performance.now() - began;
        main = prepared + timing.model;
        failures = 0;
        // The text has moved on meanwhile: this answer is for one that is
        // gone, and the next is asked for below.
        if (map && editor.state.doc === doc) {
          const before = into.current && into.current !== "pending" ? into.current.notes : undefined;
          into.current = { ...map, doc };
          reflowPagination(editor);
          // (Footnotes numbered on each page show the numbers they print with.)
          if (JSON.stringify(before ?? null) !== JSON.stringify(map.notes ?? null)) refreshNoteNumbers(editor);
        }
      } catch (e) {
        if (!alive) return;
        failures += 1;
        console.warn("[page view] the layout couldn't be made; showing the simple view", e);
        // Still trying: keep what is shown. Given up: the simple view.
        if (failures >= 3) drop();
        else retry = 1500;
      } finally {
        busy = false;
      }
      if (retry) schedule(retry);
      else if (again || editor.state.doc !== doc) soon();
    };
    const schedule = (wait: number) => {
      if (timer) clearTimeout(timer);
      // (Not asked for ever: a document the engine can't set stays simple.)
      if (failures >= 3) return;
      timer = setTimeout(() => void run(), wait);
    };
    /** A moment after the latest change — and, while the writing goes on
     *  without a pause, every so often all the same. */
    const soon = () => {
      const now = performance.now();
      if (!waitingSince) waitingSince = now;
      const { quiet, longest } = pace(cost, main);
      schedule(Math.max(0, Math.min(quiet, waitingSince + longest - now)));
    };
    schedule(0);
    const onUpdate = () => soon();
    editor.on("update", onUpdate);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      editor.off("update", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `into` is a ref; the source is read through one
  }, [editor, enabled, keyJson]);
}
