/**
 * A document's own house style, where it is kept: `Y.Map("proof")`, beside
 * the text and not in it. Everyone who writes the document shares it, it
 * travels with every copy (see apps/documents/docMaps.ts), and nothing
 * about the text's schema changes: an older app simply never looks here.
 *
 * One small value a key, so two people changing different things at once
 * both keep their change:
 *
 *   s.<name>          a setting
 *   on.<check>        a check switched on or off here
 *   w:<id>            a word rule, as JSON
 *   p:<finding>       the form chosen for a thing done two ways
 *   x:<finding>       a finding not to be raised in this document (the day)
 *   i:<key>           one place set aside (the day)
 */

import * as Y from "yjs";

import { cleanSetting, cleanWord, emptyLayer, PLACE_MAX, today, WORD_MAX, wordId, type Layer, type Primitive, type WordEntry } from "./model";

export const PROOF_MAP = "proof";

/** The layer a plain copy of the map holds (also how the live map is read). */
export function layerFromSnapshot(snapshot: Record<string, unknown> | undefined): Layer {
  const out = emptyLayer();
  let words = 0;
  let places = 0;
  for (const [key, value] of Object.entries(snapshot ?? {})) {
    if (key.length > 240) continue;
    if (key.startsWith("s.")) {
      const clean = cleanSetting(key.slice(2), value);
      if (clean !== undefined) out.settings[key.slice(2)] = clean;
    } else if (key.startsWith("on.")) {
      if (typeof value === "boolean") out.on[key.slice(3)] = value;
    } else if (key.startsWith("w:")) {
      if (typeof value !== "string" || value.length > 2000 || words >= WORD_MAX) continue;
      try {
        const entry = cleanWord(JSON.parse(value));
        // (Kept under the word it is about, whatever key it came in on.)
        if (entry) {
          out.words[wordId(entry.find)] = entry;
          words += 1;
        }
      } catch {
        // an entry this build can't read is a rule it doesn't have
      }
    } else if (key.startsWith("p:")) {
      if (typeof value === "string" && value.length <= 40) out.picks[key.slice(2)] = value;
    } else if (key.startsWith("x:")) {
      out.never[key.slice(2)] = typeof value === "number" ? value : 0;
    } else if (key.startsWith("i:")) {
      if (places < PLACE_MAX) {
        out.places[key.slice(2)] = typeof value === "number" ? value : 0;
        places += 1;
      }
    }
  }
  return out;
}

export function readDocRules(doc: Y.Doc): Layer {
  return layerFromSnapshot(doc.getMap(PROOF_MAP).toJSON() as Record<string, unknown>);
}

export function onDocRulesChange(doc: Y.Doc, fn: () => void): () => void {
  const map = doc.getMap(PROOF_MAP);
  map.observe(fn);
  return () => map.unobserve(fn);
}

const put = (doc: Y.Doc, key: string, value: Primitive | null) => {
  const map = doc.getMap(PROOF_MAP);
  if (value === null) {
    if (map.has(key)) map.delete(key);
  } else if (map.get(key) !== value) map.set(key, value);
};

/** Change one thing about the document's rules (null: back to unsaid). */
export const docRules = {
  setting: (doc: Y.Doc, name: string, value: Primitive | null) => put(doc, `s.${name}`, value === null ? null : (cleanSetting(name, value) ?? null)),
  on: (doc: Y.Doc, check: string, value: boolean | null) => put(doc, `on.${check}`, value),
  word(doc: Y.Doc, entry: WordEntry | null, find?: string): void {
    const clean = entry ? cleanWord(entry) : null;
    const id = clean ? wordId(clean.find) : find ? wordId(find) : null;
    if (!id) return;
    if (clean && !doc.getMap(PROOF_MAP).has(`w:${id}`) && Object.keys(readDocRules(doc).words).length >= WORD_MAX) return;
    put(doc, `w:${id}`, clean ? JSON.stringify(clean) : null);
  },
  pick: (doc: Y.Doc, finding: string, form: string | null) => put(doc, `p:${finding}`, form),
  never: (doc: Y.Doc, finding: string, on: boolean) => put(doc, `x:${finding}`, on ? today() : null),
  /** Set one place aside. Past the most that are kept, the oldest go. */
  place(doc: Y.Doc, key: string, on = true): void {
    const map = doc.getMap(PROOF_MAP);
    doc.transact(() => {
      put(doc, `i:${key}`, on ? today() : null);
      if (!on) return;
      const kept = [...map.entries()].filter(([k]) => k.startsWith("i:"));
      if (kept.length <= PLACE_MAX) return;
      kept.sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0));
      for (const [k] of kept.slice(0, kept.length - PLACE_MAX)) map.delete(k);
    });
  },
  /** Forget every place and finding set aside in this document. */
  clearSkips(doc: Y.Doc): void {
    const map = doc.getMap(PROOF_MAP);
    doc.transact(() => {
      for (const key of [...map.keys()]) if (key.startsWith("i:") || key.startsWith("x:")) map.delete(key);
    });
  },
  /** Put a whole layer in (a rules file, "copy my rules into this
   *  document"). `replace` first takes out what is there. */
  load(doc: Y.Doc, layer: Layer, replace: boolean): void {
    const map = doc.getMap(PROOF_MAP);
    doc.transact(() => {
      if (replace) for (const key of [...map.keys()]) map.delete(key);
      for (const [name, value] of Object.entries(layer.settings)) docRules.setting(doc, name, value);
      for (const [check, value] of Object.entries(layer.on)) docRules.on(doc, check, value);
      for (const entry of Object.values(layer.words)) docRules.word(doc, entry);
      for (const [finding, form] of Object.entries(layer.picks)) docRules.pick(doc, finding, form);
      for (const finding of Object.keys(layer.never)) docRules.never(doc, finding, true);
    });
  },
};
