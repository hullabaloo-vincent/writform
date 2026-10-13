/**
 * The writer's own house style: rules that apply to every document they
 * open on this device. Kept in the browser's storage here, and carried to
 * another device as a rules file (see file.ts).
 */

import { create } from "zustand";

import { cleanLayer, cleanSetting, cleanWord, emptyLayer, NEVER_MAX, today, WORD_MAX, wordId, type Layer, type Primitive, type WordEntry } from "./model";

const KEY = "wf-proof-rules";

function load(): Layer {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    // (Places are a document's: a device has none.)
    return { ...cleanLayer(saved), places: {} };
  } catch {
    return emptyLayer();
  }
}

function save(layer: Layer): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, settings: layer.settings, on: layer.on, words: layer.words, picks: layer.picks, never: layer.never }));
  } catch {
    // Storage full or switched off: the rules last for this sitting.
  }
}

interface GlobalRules {
  layer: Layer;
  setting: (name: string, value: Primitive | null) => void;
  on: (check: string, value: boolean | null) => void;
  word: (entry: WordEntry | null, find?: string) => void;
  pick: (finding: string, form: string | null) => void;
  never: (finding: string, on: boolean) => void;
  load: (layer: Layer, replace: boolean) => void;
}

const without = <T,>(map: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...map };
  delete next[key];
  return next;
};

export const useGlobalRules = create<GlobalRules>((set, get) => {
  const change = (fn: (layer: Layer) => Layer) => {
    const layer = fn(get().layer);
    set({ layer });
    save(layer);
  };
  return {
    layer: load(),
    setting: (name, value) =>
      change((l) => {
        const clean = value === null ? undefined : cleanSetting(name, value);
        return { ...l, settings: clean === undefined ? without(l.settings, name) : { ...l.settings, [name]: clean } };
      }),
    on: (check, value) => change((l) => ({ ...l, on: value === null ? without(l.on, check) : { ...l.on, [check]: value } })),
    word: (entry, find) =>
      change((l) => {
        const clean = entry ? cleanWord(entry) : null;
        const id = clean ? wordId(clean.find) : find ? wordId(find) : null;
        if (!id) return l;
        // (A device has no rule to switch off: "off" is a document's word.)
        if (!clean || clean.k === "off") return { ...l, words: without(l.words, id) };
        if (!(id in l.words) && Object.keys(l.words).length >= WORD_MAX) return l;
        return { ...l, words: { ...l.words, [id]: clean } };
      }),
    pick: (finding, form) => change((l) => ({ ...l, picks: form === null ? without(l.picks, finding) : { ...l.picks, [finding]: form } })),
    never: (finding, on) =>
      change((l) => {
        if (!on) return { ...l, never: without(l.never, finding) };
        if (!(finding in l.never) && Object.keys(l.never).length >= NEVER_MAX) return l;
        return { ...l, never: { ...l.never, [finding]: today() } };
      }),
    load: (layer, replace) =>
      change((l) => {
        const from = cleanLayer(layer);
        const base = replace ? emptyLayer() : l;
        return { settings: { ...base.settings, ...from.settings }, on: { ...base.on, ...from.on }, words: { ...base.words, ...from.words }, picks: { ...base.picks, ...from.picks }, never: { ...base.never, ...from.never }, places: {} };
      }),
  };
});

/** The writer's rules as they are this instant (outside React). */
export const globalRules = (): Layer => useGlobalRules.getState().layer;
