/**
 * The house style in force for one person looking at one document: what
 * the app does unasked, then the writer's own rules, then the document's.
 * The document has the last word. It can also say that only its own rules
 * count, so that everyone who opens it sees the same findings.
 */

import { CHECKS, onByDefault } from "../checks";
import { key53 } from "../engine/hash";
import type { Env, Rules, WordRule } from "../types";
import { foldFind, type Layer } from "./model";

export interface Effective extends Rules {
  /** Only the document's rules count. */
  only: boolean;
  /** Where a finding was said not to be raised, if anywhere. */
  skipsIssue(id: string): "document" | "yours" | null;
  skipsPlace(key: string): boolean;
  /** The form chosen for a finding, and whose choice. */
  pick(id: string): { form: string; from: "document" | "yours" } | null;
  /** Whether any place is set aside (keys need working out only then). */
  hasPlaces: boolean;
  /** What must be the same for the text not to need reading again. */
  stamp: string;
}

export function effective(env: Env, yours: Layer, document: Layer | null): Effective {
  const only = document?.settings.only === true;
  const mine = only ? null : yours;
  const off = new Set<string>();
  for (const check of CHECKS) {
    const on = document?.on[check.id] ?? mine?.on[check.id] ?? onByDefault(check, env);
    if (!on) off.add(check.id);
  }

  const byId = new Map<string, WordRule>();
  for (const [id, entry] of Object.entries(mine?.words ?? {})) {
    if (entry.k !== "off") byId.set(id, { id, kind: entry.k, find: entry.k === "allow" ? foldFind(entry.find) : entry.find, use: entry.use ?? "", note: entry.note ?? "", cs: entry.cs === true, from: "yours" });
  }
  for (const [id, entry] of Object.entries(document?.words ?? {})) {
    if (entry.k === "off") byId.delete(id);
    else byId.set(id, { id, kind: entry.k, find: entry.k === "allow" ? foldFind(entry.find) : entry.find, use: entry.use ?? "", note: entry.note ?? "", cs: entry.cs === true, from: "document" });
  }
  const words = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const wordsStamp = words.length ? key53(JSON.stringify(words)) : "";

  const settings = { ...(mine?.settings ?? {}), ...(document?.settings ?? {}) };
  const said = Object.keys(settings)
    .sort()
    .map((name) => `${name}=${String(settings[name])}`)
    .join("&");

  return {
    on: (id) => !off.has(id),
    setting: (name) => settings[name],
    words,
    wordsStamp,
    only,
    skipsIssue: (id) => (document && id in document.never ? "document" : mine && id in mine.never ? "yours" : null),
    skipsPlace: (key) => !!document && key in document.places,
    pick(id) {
      const here = document?.picks[id];
      if (here) return { form: here, from: "document" };
      const own = mine?.picks[id];
      return own ? { form: own, from: "yours" } : null;
    },
    hasPlaces: !!document && Object.keys(document.places).length > 0,
    stamp: `${[...off].sort().join(",")}|${wordsStamp}|${said}`,
  };
}
