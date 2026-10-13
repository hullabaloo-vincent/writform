/**
 * What a check is. Each reads a block on its own first (`local`: kept with
 * the block, so an edit elsewhere costs nothing) and then the document as
 * a whole (`reduce`), where it says what there is to look at.
 */

import type { BlockFacts } from "../engine/facts";
import type { BlockInput, Env, Form, GroupId, Issue, Place, Rules, Scan } from "../types";

export interface Ctx<F> {
  scan: Scan;
  facts: BlockFacts[];
  /** What `local` noted in each block (null: nothing). */
  local: (F | null)[];
  env: Env;
  rules: Rules;
  /** The block that follows each one straight on, or -1. */
  next: Int32Array;
}

export interface Check<F = unknown> {
  id: string;
  /** What it is called in the list of checks. */
  label: string;
  group: GroupId;
  /** Reads English only. */
  english?: boolean;
  /** Left out for these kinds of document unless switched on. */
  offIn?: string[];
  /** What its notes on a block depend on besides the block (the writer's
   *  word rules): notes made under another stamp are made again. */
  stamp?(rules: Rules): string;
  local?(block: BlockInput, facts: BlockFacts, env: Env, rules: Rules): F | null;
  reduce(ctx: Ctx<F>): Issue[];
}

export function issue(
  check: { id: string; group: GroupId },
  key: string,
  kind: Issue["kind"],
  title: string,
  detail: string,
  places: Place[],
  forms: Form[] = [],
): Issue {
  let preferred: string | null = null;
  if (forms.length > 1) {
    const top = [...forms].sort((a, b) => b.count - a.count);
    if (top[0].count > top[1].count) preferred = top[0].id;
  }
  return { id: `${check.id}:${key}`, check: check.id, key, group: check.group, kind, title, detail, forms, preferred, preferredFrom: preferred ? "majority" : null, places };
}

/**
 * A note made about one block that depends on something told from the
 * whole document (which words are names, say). It is kept with the block
 * under a stamp of that something, so a second look across the document
 * costs nothing for the blocks that have not changed, for as long as the
 * stamp holds.
 */
export function kept<T>(facts: BlockFacts, id: string, stamp: string, make: () => T): T {
  const had = facts.per.get(id);
  if (had && had.stamp === stamp) return had.note as T;
  const note = make();
  facts.per.set(id, { stamp, note });
  return note;
}

/** A stamp for a set of words. */
export const stampOf = (words: Iterable<string>): string => [...words].sort().join("\n");

/** A fix that changes characters at one spot. */
export const swap = (start: number, end: number, text: string) => ({ edits: [{ start, end, text }] });
