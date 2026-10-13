/**
 * A house style as a file, to carry rules from one device to another or
 * hand them to a co-writer. JSON, read back through the same cleaning as
 * everything else: a file is trusted no more than a stranger's document.
 */

import { cleanLayer, type Layer } from "./model";

export const RULES_FILE_EXT = "wfstyle";
const MARK = "writform-style";

export function encodeRulesFile(layer: Layer, name: string): string {
  return JSON.stringify({ [MARK]: 1, name: name.slice(0, 120), settings: layer.settings, on: layer.on, words: layer.words, picks: layer.picks, never: layer.never }, null, 2);
}

/** The rules in a file, or null when it is not one of ours. */
export function decodeRulesFile(text: string): { name: string; layer: Layer } | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || typeof raw[MARK] !== "number") return null;
    return { name: typeof raw.name === "string" ? raw.name.slice(0, 120) : "", layer: { ...cleanLayer(raw), places: {} } };
  } catch {
    return null;
  }
}
