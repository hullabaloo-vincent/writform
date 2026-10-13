/**
 * The house style, as it is kept. A `Layer` is one place's say: the
 * document's (in its own map, shared with everyone who writes it) or the
 * writer's (on this device, for every document). `layer.ts` puts them
 * together.
 *
 * Everything read from either place passes through here first: a value
 * that makes no sense is left out, never trusted.
 */

import { key53 } from "../engine/hash";

export type Primitive = string | number | boolean;

export interface WordEntry {
  /** prefer: write `use` for `find`. look: point `find` out. allow: never
   *  flag `find`. off (a document's only): this rule of the writer's own is
   *  not wanted here. */
  k: "prefer" | "look" | "allow" | "off";
  find: string;
  use?: string;
  note?: string;
  /** Capitals must match. */
  cs?: boolean;
}

export interface Layer {
  settings: Record<string, Primitive>;
  /** Checks switched on or off (absent: as it comes). */
  on: Record<string, boolean>;
  words: Record<string, WordEntry>;
  /** The form chosen where the text does a thing two ways, by finding. */
  picks: Record<string, string>;
  /** Findings not to be raised, by their id, with the day it was said. */
  never: Record<string, number>;
  /** Places set aside (a document's only), by their key, with the day. */
  places: Record<string, number>;
}

export const emptyLayer = (): Layer => ({ settings: {}, on: {}, words: {}, picks: {}, never: {}, places: {} });

export const WORD_MAX = 500;
export const PLACE_MAX = 2000;
export const NEVER_MAX = 2000;
const FIND_MAX = 80;
const NOTE_MAX = 300;
const ID_MAX = 200;

export const today = (): number => Math.floor(Date.now() / 86_400_000);

const tidy = (text: unknown, max: number): string => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A word or phrase as it is matched and told apart: lowercase, with the
 *  apostrophe a keyboard types. */
export const foldFind = (find: string): string => find.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Two people who add a rule for the same word land on the same entry. */
export const wordId = (find: string): string => key53(foldFind(find));

export function cleanWord(raw: unknown): WordEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const k = v.k;
  if (k !== "prefer" && k !== "look" && k !== "allow" && k !== "off") return null;
  const find = tidy(v.find, FIND_MAX);
  if (!find) return null;
  const entry: WordEntry = { k, find };
  if (k === "prefer") {
    const use = tidy(v.use, FIND_MAX);
    if (!use || use === find) return null;
    entry.use = use;
  }
  const note = tidy(v.note, NOTE_MAX);
  if (note && k !== "off" && k !== "allow") entry.note = note;
  if (v.cs === true && k !== "off") entry.cs = true;
  return entry;
}

/** The settings this build knows, and what each may hold. */
const SETTINGS: Record<string, (value: unknown) => Primitive | undefined> = {
  /** Use only the document's rules (not also each writer's own). */
  only: (v) => (typeof v === "boolean" ? v : undefined),
  /** The language the text is written in, when not the app's guess. */
  lang: (v) => (typeof v === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(v) ? v.toLowerCase() : undefined),
  /** The comma before "and" in a list. Unsaid: either, so long as it is one. */
  serialComma: (v) => (v === "always" || v === "never" ? v : undefined),
  /** Which English to spell in. Unsaid: any, so long as it is one. */
  variety: (v) => (typeof v === "string" && VARIETIES.includes(v) ? v : undefined),
};

/** The kinds of English a document can ask to be spelled in. */
export const VARIETIES = ["us", "uk", "uk-ize", "ca", "au"];

export function cleanSetting(name: string, value: unknown): Primitive | undefined {
  return SETTINGS[name]?.(value);
}

const idLike = (key: string): boolean => key.length > 0 && key.length <= ID_MAX;
const day = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/** A layer from anything shaped like one (a file, saved settings). */
export function cleanLayer(raw: unknown): Layer {
  const out = emptyLayer();
  if (!raw || typeof raw !== "object") return out;
  const v = raw as Record<string, unknown>;
  const each = (part: unknown, fn: (key: string, value: unknown) => void) => {
    if (part && typeof part === "object") for (const [key, value] of Object.entries(part as Record<string, unknown>)) fn(key, value);
  };
  each(v.settings, (name, value) => {
    const clean = cleanSetting(name, value);
    if (clean !== undefined) out.settings[name] = clean;
  });
  each(v.on, (check, value) => {
    if (typeof value === "boolean" && /^[A-Za-z.]{1,40}$/.test(check)) out.on[check] = value;
  });
  let words = 0;
  each(v.words, (_, value) => {
    const entry = cleanWord(value);
    if (entry && words < WORD_MAX) {
      out.words[wordId(entry.find)] = entry;
      words += 1;
    }
  });
  each(v.picks, (id, value) => {
    if (idLike(id) && typeof value === "string" && value.length <= 40) out.picks[id] = value;
  });
  each(v.never, (id, value) => {
    if (idLike(id) && Object.keys(out.never).length < NEVER_MAX) out.never[id] = day(value);
  });
  each(v.places, (key, value) => {
    if (/^[a-z0-9]{1,16}$/.test(key) && Object.keys(out.places).length < PLACE_MAX) out.places[key] = day(value);
  });
  return out;
}
