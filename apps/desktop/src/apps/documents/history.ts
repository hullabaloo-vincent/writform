/**
 * Document history shared between server and on-device documents.
 *
 * The block alignment below mirrors `change_stats` in the server's documents
 * route: a revision is compared block by block, and blocks that simply moved
 * are matched rather than counted as a delete plus an insert. Server
 * documents get their stats from the server; documents on this device are
 * their own historian, so the same walk runs here.
 *
 * Local revisions live in one JSON file per document (`localdoc_history_*`),
 * newest first, pruned so a long writing session can't grow it without
 * bound. Named drafts survive pruning until only drafts are left.
 */

import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";

import { backend } from "../../lib/backend";
import { countWords } from "../../lib/wordCount";

/**
 * When to cut an automatic revision. A revision should read like one unit of
 * work, so the primary trigger is a pause: half a minute without an edit ends
 * a burst. Two guards keep a writer who never pauses from producing a single
 * enormous revision — a burst large enough is cut on volume, and any unsaved
 * work is cut after five minutes regardless. The one-per-minute floor matches
 * the server's own auto-snapshot rate limit, so the client never sends a
 * revision only to have it dropped.
 */
const IDLE_MS = 30_000;
const MIN_GAP_MS = 60_000;
const MAX_AGE_MS = 5 * 60_000;
/** Edit events (roughly keystrokes) that make a burst worth cutting early. */
const BULK_EDITS = 120;
/** …or this much growth/shrinkage, which catches pastes and big deletions. */
const BULK_CHARS = 300;
const TICK_MS = 5_000;
/** Auto revisions kept per document before the oldest start falling off. */
const MAX_AUTO_VERSIONS = 40;
/** Byte budget for one document's history file (the command's ceiling is 16 MB). */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
/** Never prune below this many revisions, whatever the budget says. */
const ALWAYS_KEEP = 3;

export type LocalVersionKind = "auto" | "draft";

export interface LocalVersion {
  id: string;
  /** Set for drafts the writer named; auto revisions show their timestamp. */
  name: string | null;
  kind: LocalVersionKind;
  created_at: number;
  doc_json: string;
  changed_blocks: number;
  added_words: number;
  removed_words: number;
}

/** One top-level block reduced to the parts a reader would notice changing. */
export interface FlatBlock {
  type: string;
  element: string;
  text: string;
}

export interface AlignedBlock {
  oldBlock?: FlatBlock;
  newBlock?: FlatBlock;
  index: number;
}

export function flatten(raw: string | null): FlatBlock[] {
  if (!raw) return [];
  let doc: JSONContent;
  try {
    doc = JSON.parse(raw) as JSONContent;
  } catch {
    return [];
  }
  const read = (node: JSONContent): string =>
    `${node.text ?? ""}${(node.content ?? []).map(read).join("")}`;
  return (doc.content ?? []).map((node) => ({
    type: node.type ?? "paragraph",
    element: String(node.attrs?.element ?? ""),
    text: read(node),
  }));
}

function blockKey(block: FlatBlock): string {
  return JSON.stringify([block.type, block.element, block.text]);
}

function positionsFor(blocks: FlatBlock[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  blocks.forEach((block, index) => {
    const key = blockKey(block);
    const matches = positions.get(key) ?? [];
    matches.push(index);
    positions.set(key, matches);
  });
  return positions;
}

function nextPosition(
  positions: Map<string, number[]>,
  block: FlatBlock,
  from: number,
): number | undefined {
  return positions.get(blockKey(block))?.find((position) => position >= from);
}

export function alignChanges(oldBlocks: FlatBlock[], newBlocks: FlatBlock[]): AlignedBlock[] {
  const oldPositions = positionsFor(oldBlocks);
  const newPositions = positionsFor(newBlocks);
  const changes: AlignedBlock[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldBlocks.length && newIndex < newBlocks.length) {
    if (blockKey(oldBlocks[oldIndex]) === blockKey(newBlocks[newIndex])) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const insertedUntil = nextPosition(newPositions, oldBlocks[oldIndex], newIndex + 1);
    const deletedUntil = nextPosition(oldPositions, newBlocks[newIndex], oldIndex + 1);
    const preferInsert =
      insertedUntil !== undefined &&
      (deletedUntil === undefined || insertedUntil - newIndex <= deletedUntil - oldIndex);

    if (preferInsert) {
      while (newIndex < insertedUntil) {
        changes.push({ newBlock: newBlocks[newIndex], index: newIndex });
        newIndex += 1;
      }
    } else if (deletedUntil !== undefined) {
      while (oldIndex < deletedUntil) {
        changes.push({ oldBlock: oldBlocks[oldIndex], index: oldIndex });
        oldIndex += 1;
      }
    } else {
      changes.push({ oldBlock: oldBlocks[oldIndex], newBlock: newBlocks[newIndex], index: newIndex });
      oldIndex += 1;
      newIndex += 1;
    }
  }
  while (oldIndex < oldBlocks.length) {
    changes.push({ oldBlock: oldBlocks[oldIndex], index: oldIndex });
    oldIndex += 1;
  }
  while (newIndex < newBlocks.length) {
    changes.push({ newBlock: newBlocks[newIndex], index: newIndex });
    newIndex += 1;
  }
  return changes;
}

/** Blocks touched and words gained/lost between two saved revisions. */
export function changeStats(
  previous: string | null,
  current: string,
): { changed_blocks: number; added_words: number; removed_words: number } {
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const { oldBlock, newBlock } of alignChanges(flatten(previous), flatten(current))) {
    changed += 1;
    if (newBlock) added += countWords(newBlock.text);
    if (oldBlock) removed += countWords(oldBlock.text);
  }
  return { changed_blocks: changed, added_words: added, removed_words: removed };
}

/* --- documents on this device --- */

export async function readLocalHistory(docId: string): Promise<LocalVersion[]> {
  const raw = await backend.localdocHistoryRead(docId).catch(() => "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { versions?: LocalVersion[] };
    return Array.isArray(parsed.versions) ? parsed.versions : [];
  } catch {
    // A corrupt history file must never cost the writer their document.
    return [];
  }
}

/** Oldest auto revisions go first, then oldest drafts, never the newest few. */
function prune(versions: LocalVersion[]): LocalVersion[] {
  let autos = 0;
  let kept = versions.filter((v) => {
    if (v.kind !== "auto") return true;
    autos += 1;
    return autos <= MAX_AUTO_VERSIONS;
  });
  const size = () => kept.reduce((total, v) => total + v.doc_json.length + 200, 0);
  while (size() > MAX_HISTORY_BYTES && kept.length > ALWAYS_KEEP) {
    const oldestAuto = kept.reduce((at, v, i) => (v.kind === "auto" ? i : at), -1);
    const drop = oldestAuto >= 0 ? oldestAuto : kept.length - 1;
    kept = kept.filter((_, i) => i !== drop);
  }
  return kept;
}

/**
 * Record the current text as a revision. Auto revisions that changed nothing
 * are dropped rather than stored, so the Changes list stays a list of edits
 * instead of a list of minutes. Returns the revision, or null when skipped.
 */
export async function saveLocalVersion(
  docId: string,
  docJson: string,
  opts: { name?: string; kind?: LocalVersionKind } = {},
): Promise<LocalVersion | null> {
  const kind = opts.kind ?? "auto";
  const versions = await readLocalHistory(docId);
  const latest = versions[0] ?? null;
  if (kind === "auto" && latest?.doc_json === docJson) return null;

  const stats = changeStats(latest?.doc_json ?? null, docJson);
  if (kind === "auto" && stats.changed_blocks === 0) return null;

  const version: LocalVersion = {
    id: crypto.randomUUID(),
    name: opts.name?.trim() || null,
    kind,
    created_at: Date.now(),
    doc_json: docJson,
    ...stats,
  };
  const next = prune([version, ...versions]);
  await backend.localdocHistoryWrite(docId, JSON.stringify({ versions: next }));
  listeners.forEach((fn) => fn(docId));
  return version;
}

const listeners = new Set<(docId: string) => void>();

/** Fires after a local revision is stored, so an open panel stays current. */
export function onLocalHistoryChange(fn: (docId: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Cut revisions at the seams of the writing — see the constants above for the
 * policy — and one final revision when the document closes. `save` is called
 * with the document's TipTap JSON; server and on-device documents differ only
 * in where that goes.
 */
export function useAutoRevisions(
  editor: Editor | null,
  save: (docJson: string) => Promise<unknown>,
  enabled = true,
) {
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    if (!editor || !enabled) return;
    // Opening a document is not a change: the clock starts now, and nothing
    // is written until the writer actually edits something.
    let lastSaveAt = Date.now();
    let lastEditAt = 0;
    let baseline = editor.state.doc.content.size;
    let edits = 0;
    let dirty = false;

    const capture = () => {
      dirty = false;
      edits = 0;
      lastSaveAt = Date.now();
      baseline = editor.state.doc.content.size;
      void saveRef.current(JSON.stringify(editor.getJSON())).catch(() => {});
    };

    const onUpdate = () => {
      dirty = true;
      edits += 1;
      lastEditAt = Date.now();
    };

    const tick = () => {
      if (!dirty) return;
      const now = Date.now();
      if (now - lastSaveAt < MIN_GAP_MS) return;
      const paused = now - lastEditAt >= IDLE_MS;
      const bulky =
        edits >= BULK_EDITS || Math.abs(editor.state.doc.content.size - baseline) >= BULK_CHARS;
      if (paused || bulky || now - lastSaveAt >= MAX_AGE_MS) capture();
    };

    editor.on("update", onUpdate);
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      editor.off("update", onUpdate);
      if (!dirty) return;
      try {
        void saveRef.current(JSON.stringify(editor.getJSON())).catch(() => {});
      } catch {
        // editor already destroyed — the last cut revision stands
      }
    };
  }, [editor, enabled]);
}
