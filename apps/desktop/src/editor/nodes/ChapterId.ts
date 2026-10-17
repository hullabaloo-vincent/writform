import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

import { cyrb53 } from "../../proof/engine/hash";
import { UNTRACKED_META } from "../review/TrackMarks";

/**
 * A chapter's hidden id (level 5), on the heading that opens it: `cid`, 8
 * base36 characters. The story plan (src/plan) ties its cards and events
 * to a chapter by it, so they follow the chapter through a new title, a
 * move, publishing and copies. A heading has one only once something in
 * the plan is put in its chapter, so a document is raised to level 5 only
 * when its plan uses chapters.
 *
 * The attribute is in every editor's schema (the documents' content). The
 * guard, which keeps one heading per id, is in the two document editors.
 */

const CID = /^[0-9a-z]{8}$/;

/** A chapter id as stored, or null. */
export function chapterIdAttr(value: unknown): string | null {
  return typeof value === "string" && CID.test(value) ? value : null;
}

export const ChapterIdAttr = Extension.create({
  name: "chapterIdAttr",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          cid: {
            default: null,
            keepOnSplit: false,
            // Copy and paste inside the app goes through HTML.
            parseHTML: (el: HTMLElement) => chapterIdAttr(el.getAttribute("data-cid")),
            renderHTML: (attrs: Record<string, unknown>) => {
              const value = chapterIdAttr(attrs.cid);
              return value ? { "data-cid": value } : {};
            },
          },
        },
      },
    ];
  },
});

/** Every textblock holding a chapter id: id → their positions, in order. */
export function chapterIdHolders(doc: PmNode): Map<string, number[]> {
  const out = new Map<string, number[]>();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const cid = chapterIdAttr(node.attrs.cid);
    if (cid) {
      const list = out.get(cid);
      if (list) list.push(pos);
      else out.set(cid, [pos]);
    }
    return false;
  });
  return out;
}

/** Whether a step's slice carries a chapter id (a paste, a drop, a split
 *  of a heading that has one, a retype). Typing never does. */
function bringsChapterId(tr: Transaction): boolean {
  return tr.steps.some((step) => {
    const slice = (step as unknown as { slice?: { content: { descendants(f: (n: PmNode) => boolean | void): void } } }).slice;
    let found = false;
    slice?.content.descendants((node) => {
      if (found) return false;
      if (node.isTextblock) {
        found = chapterIdAttr(node.attrs.cid) !== null;
        return false;
      }
      return true;
    });
    return found;
  });
}

/** The holders to clear so each id is on one heading again. */
export function idsToClear(before: EditorState["doc"], after: EditorState["doc"], mapping: Mapping, known: (cid: string) => boolean): number[] {
  const was = chapterIdHolders(before);
  const clear: number[] = [];
  for (const [cid, at] of chapterIdHolders(after)) {
    const old = was.get(cid);
    if (!old) {
      // New to this document: a paste. From this document (a cut, then a
      // paste) the plan knows it and it stays. From elsewhere it goes.
      if (!known(cid)) clear.push(...at);
      else clear.push(...at.slice(1));
      continue;
    }
    if (at.length === 1) continue;
    // The heading that had it keeps it, unless that one is now empty and
    // another holds the words (Enter at the very start of a heading).
    const mapped = old.map((p) => mapping.mapResult(p, 1)).filter((r) => !r.deleted).map((r) => r.pos);
    let keep = at.find((p) => mapped.includes(p)) ?? at[0];
    if (after.nodeAt(keep)?.content.size === 0) {
      const full = at.find((p) => (after.nodeAt(p)?.content.size ?? 0) > 0);
      if (full !== undefined) keep = full;
    }
    clear.push(...at.filter((p) => p !== keep));
  }
  return clear;
}

export interface ChapterIdGuardOptions {
  /** Whether the story plan has a record of this id (a heading cut and
   *  pasted back keeps its id; one pasted from another document doesn't). */
  known: (cid: string) => boolean;
}

/** Keeps one heading per chapter id: a copied heading gives its id up, a
 *  split heading keeps it on the half with its words, and a heading pasted
 *  from another document arrives without one. */
export const ChapterIdGuard = Extension.create<ChapterIdGuardOptions>({
  name: "chapterIdGuard",

  addOptions() {
    return { known: () => false };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("wf-chapter-id-guard"),
        appendTransaction: (transactions, oldState, newState) => {
          // What arrives from Yjs was guarded where it was made.
          const local = transactions.filter((tr) => tr.docChanged && !tr.getMeta(ySyncPluginKey));
          if (!local.some(bringsChapterId)) return null;
          const mapping = new Mapping();
          for (const tr of transactions) mapping.appendMapping(tr.mapping);
          const clear = idsToClear(oldState.doc, newState.doc, mapping, (cid) => options.known(cid));
          if (!clear.length) return null;
          const tr = newState.tr;
          for (const pos of clear) tr.setNodeAttribute(pos, "cid", null);
          // (Not kept out of undo: the paste it belongs to stays undoable.)
          return tr.setMeta(UNTRACKED_META, true);
        },
      }),
    ];
  },
});

/** An id made from the heading's own place in the Yjs document, so two
 *  people giving the same heading an id at once give it the same one. */
function idFromYjs(state: EditorState, index: number): string | null {
  const sync = ySyncPluginKey.getState(state) as { type?: Y.XmlFragment } | undefined;
  const element = sync?.type?.get(index) as { _item?: { id: { client: number; clock: number } } | null } | undefined;
  const id = element?._item?.id;
  if (!id) return null;
  return cyrb53(`${id.client}:${id.clock}`).toString(36).padStart(8, "0").slice(-8);
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

export interface EnsureOptions {
  /** The level the document may hold now (the lower of the app's and its
   *  server's). Below 5 no id is written. */
  level: number;
  canWrite: boolean;
}

/**
 * The chapter id of the heading at `pos` (a top-level block), giving it one
 * first if it has none. Null when it can't have one here: below level 5,
 * for someone who may only read, or when the write was refused.
 *
 * The write is kept out of the writer's undo and is never a suggestion: it
 * changes nothing anyone sees. Undo of a deleted heading brings its id
 * back with it.
 */
export function ensureChapterId(editor: Editor, pos: number, options: EnsureOptions): string | null {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node || !node.isTextblock) return null;
  const has = chapterIdAttr(node.attrs.cid);
  if (has) return has;
  if (!options.canWrite || options.level < 5) return null;
  const index = state.doc.resolve(pos).index(0);
  const taken = chapterIdHolders(state.doc);
  let cid = idFromYjs(state, index);
  if (!cid || taken.has(cid)) cid = randomId();
  while (taken.has(cid)) cid = randomId();
  const tr = state.tr.setNodeAttribute(pos, "cid", cid).setMeta("addToHistory", false).setMeta(UNTRACKED_META, true);
  editor.view.dispatch(tr);
  // The schema guard refuses it when the document can't be raised.
  return chapterIdAttr(editor.state.doc.nodeAt(pos)?.attrs.cid) === cid ? cid : null;
}
