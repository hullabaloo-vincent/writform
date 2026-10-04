/**
 * Per-document data that lives beside the text in the document's own Y.Doc:
 * page settings (`settings`) and the book's details and design (`book`).
 * Every path that rebuilds a document from its text alone — publishing an
 * on-device document, duplicating, combining — must carry these along too,
 * or the copy silently loses its layout.
 *
 * Values are primitives or plain JSON by contract (no nested Y types), so a
 * plain-object snapshot is a faithful copy.
 */

import * as Y from "yjs";

export const DOC_MAPS = ["settings", "book"] as const;

export type DocMapsSnapshot = Partial<Record<(typeof DOC_MAPS)[number], Record<string, unknown>>>;

/** Plain copy of the document's maps (absent/empty maps are skipped). */
export function snapshotDocMaps(doc: Y.Doc): DocMapsSnapshot {
  const out: DocMapsSnapshot = {};
  for (const name of DOC_MAPS) {
    if (!doc.share.has(name)) continue;
    const json = doc.getMap(name).toJSON() as Record<string, unknown>;
    if (Object.keys(json).length > 0) out[name] = json;
  }
  return out;
}

/** Write a snapshot into `doc` in one transaction. */
export function applyDocMaps(doc: Y.Doc, maps: DocMapsSnapshot): void {
  doc.transact(() => {
    for (const name of DOC_MAPS) {
      const values = maps[name];
      if (!values) continue;
      const map = doc.getMap(name);
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) map.set(key, value);
      }
    }
  });
}

/** A standalone Yjs update that creates the snapshot's maps — appended after
 *  the text seed when a document is built on the server. Null when empty. */
export function docMapsUpdate(maps: DocMapsSnapshot): Uint8Array | null {
  if (Object.keys(maps).length === 0) return null;
  const doc = new Y.Doc();
  try {
    applyDocMaps(doc, maps);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
