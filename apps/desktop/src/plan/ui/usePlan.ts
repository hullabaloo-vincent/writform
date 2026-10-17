import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";

import type { BookDesign } from "../../book/model/presets";
import { presetDesign } from "../../book/model/presets";
import { ensureChapterId } from "../../editor/nodes/ChapterId";
import { toast } from "../../platform/toast";
import type { Plan } from "../model";
import { onPlanChange, planOps, readPlan, type PlanOps } from "../planMap";
import { columnNoun, planColumns, staleTitles, type Columns, type PlanColumn } from "../resolve";

/** The plan as it is now, kept up with everyone's changes. */
export function usePlan(ydoc: Y.Doc | null): Plan {
  const [plan, setPlan] = useState<Plan>(() => readPlan(ydoc));
  useEffect(() => {
    if (!ydoc) return;
    setPlan(readPlan(ydoc));
    let frame = 0;
    // Several keys change in one go (a line and its cards): read once.
    const off = onPlanChange(ydoc, () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPlan(readPlan(ydoc)));
    });
    return () => {
      cancelAnimationFrame(frame);
      off();
    };
  }, [ydoc]);
  return plan;
}

type Design = Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">;

/** The text's chapters as columns, looked at again 300 ms after it changes
 *  (or at once, by `refresh`). */
export function usePlanColumns(editor: Editor | null, format: string, design: Design | undefined): [Columns | null, () => void] {
  const read = () => (editor && !editor.isDestroyed ? planColumns(editor.state.doc, format, design ?? presetDesign("classic")) : null);
  const [columns, setColumns] = useState<Columns | null>(read);
  useEffect(() => {
    if (!editor) return;
    setColumns(read());
    let timer = 0;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setColumns(read()), 300);
    };
    // (A heading given its id is a change too: the columns follow.)
    editor.on("update", onUpdate);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, format, design?.chapterNumber, design?.chapterLabel, design?.restartNumbersInParts]);
  return [columns, () => setColumns(read())];
}

/** Everything a plan screen works with. */
export interface PlanEnv {
  editor: Editor;
  ydoc: Y.Doc;
  format: string;
  plan: Plan;
  ops: PlanOps;
  columns: Columns | null;
  /** Look at the text's chapters again now. */
  refresh: () => void;
  /** "chapter", "scene" or "section". */
  noun: string;
  /** Changes are off: the person may only read. */
  readonly: boolean;
  /** Cards and events can be put in chapters (the document may be raised
   *  to level 5 here). */
  canLink: boolean;
  level: number;
}

export function usePlanEnv(editor: Editor, ydoc: Y.Doc, format: string, design: Design | undefined, readonly: boolean, level: number): PlanEnv {
  const plan = usePlan(ydoc);
  const [columns, refresh] = usePlanColumns(editor, format, design);
  const ops = useMemo(() => planOps(ydoc), [ydoc]);
  // A chapter renamed in the text: its name is remembered anew, for when
  // its heading is gone.
  useEffect(() => {
    if (readonly || !columns) return;
    for (const [cid, title] of staleTitles(columns, plan)) ops.noteChapter(cid, title);
  }, [columns, plan, ops, readonly]);
  return { editor, ydoc, format, plan, ops, columns, refresh, noun: columnNoun(format), readonly, canLink: level >= 5, level };
}

/** The chapter id of a column, giving its heading one first. Null (and a
 *  word why) when it can't have one here. */
export function chapterOf(env: PlanEnv, column: PlanColumn): string | null {
  if (env.readonly) return null;
  const cid = column.cid ?? ensureChapterId(env.editor, column.pos, { level: env.level, canWrite: !env.readonly });
  if (!cid) {
    toast(env.canLink ? `This ${env.noun} can’t be planned right now.` : `Cards can be put in ${env.noun}s once this server is updated.`, "info");
    return null;
  }
  env.ops.noteChapter(cid, column.title || column.name);
  if (!column.cid) env.refresh();
  return cid;
}

/** "1 card", "3 cards". */
export const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;
