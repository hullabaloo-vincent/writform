/**
 * A place in the text, said without saying where: the words that matched
 * and the three words either side. That is the key a "skip this place" is
 * remembered under, so it survives the text moving, being copied, or every
 * node being rebuilt, and lapses when those words change.
 *
 * THE FOLD BELOW IS FROZEN. Changing how a window is written would make
 * every remembered skip lapse at once; a harness holds known keys.
 */

import { key53 } from "./hash";
import { firstAt } from "./quotes";
import { isWordy, OBJ, type Tokens } from "./tokens";

const VERSION = "1";
const CONTEXT = 3;

const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"' };

function foldText(text: string): string {
  let out = "";
  let space = false;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      space = out.length > 0;
      continue;
    }
    if (space) out += " ";
    space = false;
    out += QUOTES[ch] ?? ch.toLowerCase();
  }
  return out;
}

export function placeKey(check: string, key: string, text: string, tk: Tokens, start: number, end: number): string {
  const before: string[] = [];
  let i = firstAt(tk, start) - 1;
  // (A token the match begins inside is part of the match, not its context.)
  while (i >= 0 && tk.end[i] > start) i -= 1;
  for (; i >= 0 && before.length < CONTEXT; i -= 1) if (isWordy(tk.kind[i])) before.unshift(foldText(text.slice(tk.start[i], tk.end[i])));
  if (i < 0 && before.length < CONTEXT) before.unshift("^");
  const after: string[] = [];
  let j = firstAt(tk, end);
  for (; j < tk.n && after.length < CONTEXT; j += 1) if (isWordy(tk.kind[j])) after.push(foldText(text.slice(tk.start[j], tk.end[j])));
  if (j >= tk.n && after.length < CONTEXT) after.push("$");
  return key53([VERSION, check, key, before.join(" "), foldText(text.slice(start, end)), after.join(" ")].join("|"));
}

const SNIP = 44;
const flat = (text: string): string => text.replace(/\n/g, " ").split(OBJ).join(" ");

/** The words round a place, for showing it in a list. */
export function snippet(text: string, start: number, end: number): { before: string; match: string; after: string } {
  let a = Math.max(0, start - SNIP);
  if (a > 0) {
    const space = text.indexOf(" ", a);
    if (space !== -1 && space < start) a = space + 1;
  }
  let b = Math.min(text.length, end + SNIP);
  if (b < text.length) {
    const space = text.lastIndexOf(" ", b);
    if (space > end) b = space;
  }
  return { before: (a > 0 ? "…" : "") + flat(text.slice(a, start)), match: flat(text.slice(start, end)), after: flat(text.slice(end, b)) + (b < text.length ? "…" : "") };
}
