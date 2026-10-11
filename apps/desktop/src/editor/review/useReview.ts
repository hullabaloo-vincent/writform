import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { changesOf, changeText, changeThing, groupChanges, type ChangeGroup } from "./changes";
import { setReviewMode, type ReviewMode } from "./Suggesting";

/** One entry of the list of changes, with the words to show for it. */
export interface ReviewItem extends ChangeGroup {
  /** "Added", "Deleted" or "Replaced". */
  verb: string;
  /** The words it is about — or, when `thing`, what it is ("a picture"). */
  text: string;
  thing: boolean;
  /** For a replacement: what the words become. */
  becomes?: string;
}

export interface ReviewState {
  mode: ReviewMode;
  setMode: (mode: ReviewMode) => void;
  /** Whether Suggesting is on offer here (the document can hold tracked
   *  changes, and this person can write in it). */
  canSuggest: boolean;
  /** Whether this person can accept and reject. */
  canResolve: boolean;
  items: ReviewItem[];
}

const storeKey = (key: string) => `wf-review:${key}`;

function describe(editor: Editor): ReviewItem[] {
  const doc = editor.state.doc;
  return groupChanges(changesOf(doc)).map((group) => {
    const [first, second] = group.changes;
    if (group.kind === "replace") {
      return { ...group, verb: "Replaced", text: changeText(doc, first), thing: false, becomes: changeText(doc, second) };
    }
    const verb = group.kind === "ins" ? "Added" : "Deleted";
    const words = first.pieces.some((piece) => piece.what === "text");
    return words ? { ...group, verb, text: changeText(doc, first), thing: false } : { ...group, verb, text: changeThing(first), thing: true };
  });
}

/**
 * A document's review state for one person: the mode they are in (their
 * own; remembered per document on this device when it is Suggesting) and
 * the list of changes, kept current as the text changes.
 */
export function useReview(editor: Editor | null, opts: { storeKey: string; canSuggest: boolean; readonly: boolean }): ReviewState {
  const { canSuggest, readonly } = opts;
  const [wanted, setWanted] = useState<ReviewMode>(() => {
    try {
      return localStorage.getItem(storeKey(opts.storeKey)) === "suggest" ? "suggest" : "edit";
    } catch {
      return "edit";
    }
  });
  // Suggesting needs somewhere to put suggestions.
  const mode: ReviewMode = wanted === "suggest" && (!canSuggest || readonly) ? "edit" : wanted;

  useEffect(() => {
    if (editor && !editor.isDestroyed) setReviewMode(editor, mode, !readonly);
  }, [editor, mode, readonly]);

  const key = opts.storeKey;
  const setMode = useCallback(
    (next: ReviewMode) => {
      setWanted(next);
      try {
        // Suggesting is worth remembering: forgetting it would turn the
        // next session's suggestions into edits. Viewing isn't.
        if (next === "suggest") localStorage.setItem(storeKey(key), "suggest");
        else if (next === "edit") localStorage.removeItem(storeKey(key));
      } catch {
        // A convenience only.
      }
    },
    [key],
  );

  const [items, setItems] = useState<ReviewItem[]>([]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      if (!editor.isDestroyed) setItems(describe(editor));
    };
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 200);
    };
    read();
    editor.on("update", onUpdate);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", onUpdate);
    };
  }, [editor]);

  return useMemo(
    () => ({ mode, setMode, canSuggest: canSuggest && !readonly, canResolve: !readonly, items }),
    [mode, setMode, canSuggest, readonly, items],
  );
}
