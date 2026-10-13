/**
 * Making a fix in the document. Every change goes through an ordinary
 * transaction, so in Suggesting mode it becomes a tracked suggestion with
 * nothing more said here (see editor/review/Suggesting.ts). Changes of
 * formatting are not tracked there, and are made directly.
 */

import type { Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

import { endOf, posOf, solid, type BlockPos } from "./extract";
import type { Fix } from "./types";

export const PROOF_META = "wfProof";

export interface Target {
  place: BlockPos;
  fix: Fix;
}

/** Whether a fix can be made here: every stretch it changes must be one
 *  unbroken stretch of text. */
export function fixable(place: BlockPos, fix: Fix): boolean {
  if ("mark" in fix) return posOf(place, fix.start) !== null && endOf(place, fix.end) !== null;
  return fix.edits.every((e) => solid(place, e.start, e.end));
}

/** Put the fixes into `tr`. The last in the document goes first, so the
 *  positions of the ones before it hold. Returns how many were made. */
export function applyFixes(tr: Transaction, schema: Schema, targets: Target[]): number {
  const edits: { from: number; to: number; text: string }[] = [];
  let made = 0;
  for (const { place, fix } of targets) {
    if (!fixable(place, fix)) continue;
    made += 1;
    if ("mark" in fix) {
      const type = schema.marks[fix.mark];
      const from = posOf(place, fix.start) as number;
      const to = endOf(place, fix.end) as number;
      if (!type) continue;
      if (fix.add) tr.addMark(from, to, type.create());
      else tr.removeMark(from, to, type);
      continue;
    }
    for (const e of fix.edits) {
      const from = posOf(place, e.start) as number;
      edits.push({ from, to: e.end > e.start ? (endOf(place, e.end) as number) : from, text: e.text });
    }
  }
  edits.sort((a, b) => b.from - a.from || b.to - a.to);
  let floor = Infinity;
  for (const e of edits) {
    // (Two fixes can never want the same letters: the later one is left.)
    if (e.to > floor) continue;
    if (e.text) tr.insertText(e.text, e.from, e.to);
    else if (e.to > e.from) tr.delete(e.from, e.to);
    floor = e.from;
  }
  if (made) tr.setMeta(PROOF_META, made);
  return made;
}
