/**
 * The editor's page view, as printed: asks the layout engine where the
 * pages of the document fall — the same layout the preview, the printer
 * and the PDF use — a moment after the writing stops, and hands the answer
 * to the paginator (editor/Paginate.ts), which marks those places on the
 * sheet. If the engine can't say (its fonts won't load, a worker dies) the
 * paginator goes back to its simple view by itself.
 */

import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef, type MutableRefObject } from "react";

import { reflowPagination, type PageMapFor } from "../editor/Paginate";
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
    let seq = 0;
    // Until the first answer nothing is marked (not the simple view, only
    // to change a moment later).
    if (!into.current) {
      into.current = "pending";
      reflowPagination(editor);
    }
    const run = async () => {
      timer = null;
      if (!alive || editor.isDestroyed) return;
      const doc = editor.state.doc;
      seq += 1;
      const mine = seq;
      try {
        const { docPageMap } = await import("./exportDoc");
        const map = await docPageMap(sourceRef.current(editor.getJSON()), channel.current);
        if (!alive || mine !== seq || !map || editor.isDestroyed) return;
        failures = 0;
        // The text has moved on: the edit that moved it asked again.
        if (editor.state.doc !== doc) return;
        into.current = { ...map, doc };
        reflowPagination(editor);
      } catch (e) {
        failures += 1;
        console.warn("[page view] the layout couldn't be made; showing the simple view", e);
        // Still trying: keep what is shown. Given up: the simple view.
        if (failures >= 3) drop();
        else schedule(1500);
      }
    };
    const schedule = (wait: number) => {
      if (timer) clearTimeout(timer);
      // (Not asked for ever: a document the engine can't set stays simple.)
      if (failures >= 3) return;
      timer = setTimeout(() => void run(), wait);
    };
    schedule(0);
    const onUpdate = () => schedule(350);
    editor.on("update", onUpdate);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      editor.off("update", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `into` is a ref; the source is read through one
  }, [editor, enabled, keyJson]);
}
