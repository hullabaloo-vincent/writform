/**
 * Document history shared between server and on-device documents.
 *
 * The block alignment below mirrors `change_stats` in the server's documents
 * route: a revision is compared block by block, and blocks that simply moved
 * are matched rather than counted as a delete plus an insert. Server
 * documents get their stats from the server; documents on this device are
 * their own historian, so the same walk runs here.
 *
 * Local revisions (v2) live as one compressed file per version plus a small
 * index (`localdoc_hist_*`), newest first. Automatic revisions are pruned by
 * count and byte budget; drafts and named versions are never pruned, and the
 * newest few always survive. (v1 kept everything in one JSON file with a
 * 4 MB budget — a novel fit three versions, and drafts got evicted.)
 */

import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";

import { backend } from "../../lib/backend";
import { countWords } from "../../lib/wordCount";
import { compactDocString } from "./compactJson";

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
const MAX_AUTO_VERSIONS = 60;
/** Compressed byte budget for one document's automatic revisions. */
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
/** Never prune below this many revisions, whatever the budget says. */
const ALWAYS_KEEP = 3;

export type LocalVersionKind = "auto" | "draft";

/** One saved revision's index entry (the text itself is loaded on demand). */
export interface LocalVersionMeta {
  id: string;
  /** Set for drafts the writer named; auto revisions show their timestamp. */
  name: string | null;
  kind: LocalVersionKind;
  created_at: number;
  changed_blocks: number;
  added_words: number;
  removed_words: number;
  /** Compressed size on disk, for the budget. */
  bytes: number;
}

/** A revision with its text. */
export interface LocalVersion extends LocalVersionMeta {
  doc_json: string;
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

/** Writes per document are serialized: two auto revisions can't interleave
 *  their read-modify-write of the index. */
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(docId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(docId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  chains.set(docId, next);
  void next.finally(() => {
    if (chains.get(docId) === next) chains.delete(docId);
  });
  return next;
}

/** The newest revision's text per document, so the next auto revision can
 *  diff against it without decompressing it again. */
const latestText = new Map<string, { id: string; json: string }>();

/** Consecutive save failures per document — two in a row get surfaced. */
const failures = new Map<string, number>();

async function compress(json: string): Promise<Uint8Array> {
  const { deflateSync, strToU8 } = await import("fflate");
  return deflateSync(strToU8(json), { level: 6 });
}

async function decompress(bytes: Uint8Array): Promise<string> {
  const { inflateSync, strFromU8 } = await import("fflate");
  return strFromU8(inflateSync(bytes));
}

async function readIndex(docId: string): Promise<LocalVersionMeta[] | null> {
  const raw = await backend.localdocHistIndexRead(docId).catch(() => "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { versions?: LocalVersionMeta[] };
    return Array.isArray(parsed.versions) ? parsed.versions : [];
  } catch {
    // A corrupt index must never cost the writer their document.
    return [];
  }
}

async function writeIndex(docId: string, versions: LocalVersionMeta[]): Promise<void> {
  await backend.localdocHistIndexWrite(docId, JSON.stringify({ v: 2, versions }));
}

/** One-time move from the v1 single file to v2 (the old file is kept as
 *  `.v1.bak`, never deleted by the migration). */
async function migrateV1(docId: string): Promise<LocalVersionMeta[]> {
  const raw = await backend.localdocHistoryRead(docId).catch(() => "");
  let old: LocalVersion[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { versions?: LocalVersion[] };
      old = Array.isArray(parsed.versions) ? parsed.versions : [];
    } catch {
      old = [];
    }
  }
  const metas: LocalVersionMeta[] = [];
  for (const version of old) {
    const blob = await compress(version.doc_json);
    await backend.localdocHistBlobWrite(docId, version.id, blob);
    const { doc_json: _text, ...meta } = version;
    void _text;
    metas.push({ ...meta, bytes: blob.byteLength });
  }
  await writeIndex(docId, metas);
  if (raw) await backend.localdocHistoryRetire(docId).catch(() => {});
  return metas;
}

/** The document's revisions, newest first (index only). */
export async function readLocalHistory(docId: string): Promise<LocalVersionMeta[]> {
  const index = await readIndex(docId);
  if (index !== null) return index;
  return serialized(docId, async () => (await readIndex(docId)) ?? migrateV1(docId));
}

/** One revision's text, or null when it can't be read. */
export async function loadLocalVersion(docId: string, versionId: string): Promise<string | null> {
  const cached = latestText.get(docId);
  if (cached?.id === versionId) return cached.json;
  try {
    return await decompress(await backend.localdocHistBlobRead(docId, versionId));
  } catch {
    return null;
  }
}

/** Oldest auto revisions go first; drafts never; the newest few always stay. */
export function pruneVersions(versions: LocalVersionMeta[]): {
  kept: LocalVersionMeta[];
  dropped: LocalVersionMeta[];
} {
  const keep = new Set(versions.slice(0, ALWAYS_KEEP).map((v) => v.id));
  let autos = 0;
  let bytes = 0;
  const kept: LocalVersionMeta[] = [];
  const dropped: LocalVersionMeta[] = [];
  for (const v of versions) {
    if (v.kind !== "auto" || keep.has(v.id)) {
      kept.push(v);
      if (v.kind === "auto") {
        autos += 1;
        bytes += v.bytes;
      }
      continue;
    }
    if (autos + 1 > MAX_AUTO_VERSIONS || bytes + v.bytes > MAX_HISTORY_BYTES) {
      dropped.push(v);
    } else {
      kept.push(v);
      autos += 1;
      bytes += v.bytes;
    }
  }
  return { kept, dropped };
}

/** True when this document's history failed to save twice in a row. */
export function localHistoryTrouble(docId: string): boolean {
  return (failures.get(docId) ?? 0) >= 2;
}

/**
 * Record the current text as a revision. Auto revisions that changed nothing
 * are dropped rather than stored, so the Changes list stays a list of edits
 * instead of a list of minutes. Returns the revision, or null when skipped.
 */
export function saveLocalVersion(
  docId: string,
  docJson: string,
  opts: { name?: string; kind?: LocalVersionKind } = {},
): Promise<LocalVersionMeta | null> {
  return serialized(docId, async () => {
    try {
      const kind = opts.kind ?? "auto";
      const versions = await readLocalHistory(docId);
      const latest = versions[0] ?? null;
      const latestJson = latest ? await loadLocalVersion(docId, latest.id) : null;
      if (kind === "auto" && latestJson === docJson) return null;

      const stats = changeStats(latestJson, docJson);
      if (kind === "auto" && stats.changed_blocks === 0) return null;

      const id = crypto.randomUUID();
      const blob = await compress(docJson);
      await backend.localdocHistBlobWrite(docId, id, blob);
      const version: LocalVersionMeta = {
        id,
        name: opts.name?.trim() || null,
        kind,
        created_at: Date.now(),
        ...stats,
        bytes: blob.byteLength,
      };
      const { kept, dropped } = pruneVersions([version, ...versions]);
      await writeIndex(docId, kept);
      for (const old of dropped) {
        await backend.localdocHistBlobDelete(docId, old.id).catch(() => {});
      }
      latestText.set(docId, { id, json: docJson });
      failures.delete(docId);
      listeners.forEach((fn) => fn(docId));
      return version;
    } catch (e) {
      const count = (failures.get(docId) ?? 0) + 1;
      failures.set(docId, count);
      if (count === 2) {
        void import("../../platform/toast").then(({ toastError }) =>
          toastError("Couldn't save this document's history. Your text is safe; versions aren't being recorded."),
        );
        listeners.forEach((fn) => fn(docId));
      }
      throw e;
    }
  });
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
      void saveRef.current(compactDocString(editor.getJSON())).catch(() => {});
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
        void saveRef.current(compactDocString(editor.getJSON())).catch(() => {});
      } catch {
        // editor already destroyed — the last cut revision stands
      }
    };
  }, [editor, enabled]);
}
