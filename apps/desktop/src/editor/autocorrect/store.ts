import { create } from "zustand";

import { touchFirst } from "../ui/reveal";
import { CONTRACTIONS, LONE_I, pairs, TYPOS } from "./data/en";
import { LIBREOFFICE_EN, LIBREOFFICE_EN_GB } from "./data/enLibreOffice";
import { SYMBOLS } from "./data/symbols";
import { KINDS, type Kinds, type Lists } from "./engine";

/**
 * AutoCorrect as chosen on this device: whether it runs at all, which kinds
 * of change it makes, the writer's own entries, the built-in ones they
 * took out, and the two lists of exceptions. Changed in Settings ▸ Writing.
 */

const KEY = "wf-autocorrect";
const ENTRY_MAX = 500;
const FROM_MAX = 40;
const TO_MAX = 200;

export interface AutoCorrectChoices {
  off: boolean;
  kinds: Kinds;
  /** The writer's own: what is typed (lowercase) and what it becomes. */
  add: Record<string, string>;
  /** Built-in entries taken out (what is typed). */
  drop: string[];
  /** Shortenings a sentence does not end after. */
  noCapAfter: string[];
  /** Words left as typed whatever their capitals. */
  keepCaps: string[];
}

/** What a device starts with. A phone's keyboard already corrects words and
 *  starts sentences with a capital: there those two are left to it. */
export function defaultChoices(): AutoCorrectChoices {
  const phone = touchFirst();
  return {
    off: false,
    kinds: { list: !phone, capitals: !phone, twoCaps: true, capsLock: true, symbols: true, fractions: true, ordinals: true },
    add: {},
    drop: [],
    noCapAfter: [],
    keepCaps: [],
  };
}

const words = (list: unknown, max: number): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((w): w is string => typeof w === "string").map((w) => w.trim()).filter((w) => w && w.length <= FROM_MAX))].slice(0, max) : [];

/** Anything read from storage or a file, made safe to use. */
export function cleanChoices(raw: unknown): AutoCorrectChoices {
  const base = defaultChoices();
  if (!raw || typeof raw !== "object") return base;
  const said = raw as Record<string, unknown>;
  const kinds = { ...base.kinds };
  if (said.kinds && typeof said.kinds === "object") {
    for (const kind of KINDS) {
      const v = (said.kinds as Record<string, unknown>)[kind];
      if (typeof v === "boolean") kinds[kind] = v;
    }
  }
  const add: Record<string, string> = {};
  if (said.add && typeof said.add === "object") {
    for (const [from, to] of Object.entries(said.add as Record<string, unknown>).slice(0, ENTRY_MAX)) {
      const key = from.trim().toLowerCase();
      if (key && key.length <= FROM_MAX && !/\s/.test(key) && typeof to === "string" && to.trim() && to.length <= TO_MAX) add[key] = to.trim();
    }
  }
  return {
    off: said.off === true,
    kinds,
    add,
    drop: words(said.drop, ENTRY_MAX).map((w) => w.toLowerCase()),
    noCapAfter: words(said.noCapAfter, 200).map((w) => w.toLowerCase().replace(/\.$/, "")),
    keepCaps: words(said.keepCaps, 200),
  };
}

function load(): AutoCorrectChoices {
  try {
    return cleanChoices(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return defaultChoices();
  }
}

interface AutoCorrectState extends AutoCorrectChoices {
  setOff: (off: boolean) => void;
  setKind: (kind: keyof Kinds, on: boolean) => void;
  /** Add or change one of the writer's own entries. */
  put: (from: string, to: string) => boolean;
  /** Take an entry out (the writer's own, or a built-in one). */
  remove: (from: string) => void;
  /** Bring a built-in entry back. */
  restore: (from: string) => void;
  setExceptions: (which: "noCapAfter" | "keepCaps", list: string[]) => void;
  /** Back to the built-in list and the usual switches. */
  reset: () => void;
  /** Take on what a file holds. */
  adopt: (choices: AutoCorrectChoices) => void;
}

const choicesOf = (s: AutoCorrectChoices): AutoCorrectChoices => ({ off: s.off, kinds: s.kinds, add: s.add, drop: s.drop, noCapAfter: s.noCapAfter, keepCaps: s.keepCaps });

export const useAutoCorrect = create<AutoCorrectState>((set, get) => {
  const keep = (patch: Partial<AutoCorrectChoices>) => {
    set(patch);
    try {
      localStorage.setItem(KEY, JSON.stringify(choicesOf(get())));
    } catch {
      // A convenience only.
    }
  };
  return {
    ...load(),
    setOff: (off) => keep({ off }),
    setKind: (kind, on) => keep({ kinds: { ...get().kinds, [kind]: on } }),
    put: (from, to) => {
      const key = from.trim().toLowerCase();
      const value = to.trim();
      if (!key || /\s/.test(key) || key.length > FROM_MAX || !value || value.length > TO_MAX || key === value) return false;
      if (Object.keys(get().add).length >= ENTRY_MAX && !(key in get().add)) return false;
      keep({ add: { ...get().add, [key]: value }, drop: get().drop.filter((w) => w !== key) });
      return true;
    },
    remove: (from) => {
      const key = from.trim().toLowerCase();
      const add = { ...get().add };
      delete add[key];
      keep({ add, drop: builtIn().has(key) && !get().drop.includes(key) ? [...get().drop, key] : get().drop });
    },
    restore: (from) => keep({ drop: get().drop.filter((w) => w !== from.trim().toLowerCase()) }),
    setExceptions: (which, list) => keep({ [which]: cleanChoices({ [which]: list })[which] }),
    reset: () => keep(defaultChoices()),
    adopt: (choices) => keep(cleanChoices(choices)),
  };
});

/** Every built-in entry (what is typed, what it becomes): LibreOffice's
 *  English list, then the app's own (which has the last word where both
 *  have one). */
let BUILT_IN: Map<string, string> | null = null;
export function builtIn(): ReadonlyMap<string, string> {
  if (!BUILT_IN) BUILT_IN = new Map<string, string>([...pairs(LIBREOFFICE_EN), ...TYPOS, ...CONTRACTIONS, [LONE_I, "I"]]);
  return BUILT_IN;
}

/** The few that have another answer where English is spelled the British way. */
let BRITISH: Map<string, string> | null = null;
const british = (): ReadonlyMap<string, string> => (BRITISH ??= new Map(pairs(LIBREOFFICE_EN_GB)));
/** English as it is written outside North America. */
const isBritish = (lang: string | undefined): boolean => !!lang && /^en[-_](GB|AU|NZ|IE|ZA|IN|SG|HK)\b/i.test(lang);

let made: { from: AutoCorrectChoices["add"]; drop: string[]; noCapAfter: string[]; keepCaps: string[]; english: boolean; uk: boolean; lists: Lists } | null = null;

/**
 * The lists to correct by, for a text in this language. The built-in words
 * are English ones and apply to English text only. Symbols and the writer's
 * own entries apply whatever the language.
 */
export function listsFor(lang: string | undefined): Lists {
  const s = useAutoCorrect.getState();
  const english = !lang || /^en\b/i.test(lang);
  const uk = english && isBritish(lang);
  if (made && made.from === s.add && made.drop === s.drop && made.noCapAfter === s.noCapAfter && made.keepCaps === s.keepCaps && made.english === english && made.uk === uk) return made.lists;
  const all = new Map<string, string>();
  if (english) for (const [from, to] of builtIn()) if (!s.drop.includes(from)) all.set(from, (uk && british().get(from)) || to);
  for (const [from, to] of Object.entries(s.add)) all.set(from, to);
  const lists: Lists = { words: all, symbols: SYMBOLS, noCapAfter: new Set(s.noCapAfter), keepCaps: new Set(s.keepCaps) };
  made = { from: s.add, drop: s.drop, noCapAfter: s.noCapAfter, keepCaps: s.keepCaps, english, uk, lists };
  return lists;
}

/** The choices as a file (for "Export everything on this device"). */
export function encodeAutoCorrect(): string {
  return `${JSON.stringify({ "writform-autocorrect": 1, ...choicesOf(useAutoCorrect.getState()) }, null, 2)}\n`;
}

/** What such a file holds, or null when it is not one. */
export function decodeAutoCorrect(text: string): AutoCorrectChoices | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return raw && raw["writform-autocorrect"] === 1 ? cleanChoices(raw) : null;
  } catch {
    return null;
  }
}
