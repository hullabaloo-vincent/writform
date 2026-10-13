/**
 * What an editor hands to an author, or keeps for the next book in a
 * series: a table of the abbreviations, the names and the spellings
 * chosen (a copy editor's "style sheet"), what was changed in this
 * sitting, and every comment in one piece. Each is plain text, to paste
 * into a message or a document. The table's columns are parted by a tab,
 * which a word processor turns into a table.
 */

import { abbreviationTable } from "./checks/abbreviations";
import { namesOf } from "./checks/names";
import type { Read } from "./engine/run";
import type { Effective } from "./rules/layer";

/** A comment thread, as either kind of document keeps it. */
export interface Note {
  /** The words it is about, if it is about any. */
  about: string | null;
  resolved: boolean;
  said: { who: string; text: string }[];
}

const VARIETY: Record<string, string> = { us: "American", uk: "British", "uk-ize": "British with -ize", ca: "Canadian", au: "Australian" };

export function abbreviationsText(read: Read): string {
  const { defined, bare } = abbreviationTable(read.scan, read.facts);
  if (!defined.length && !bare.length) return "No abbreviations were found.\n";
  const lines = ["Abbreviations", ""];
  for (const [abbr, long] of defined) lines.push(`${abbr}\t${long}`);
  if (bare.length) lines.push("", "Used and not explained:", bare.join(", "));
  return `${lines.join("\n")}\n`;
}

export function termsText(read: Read, rules: Effective, title: string): string {
  const lines = [`Names and terms in “${title}”`, ""];
  const variety = rules.setting("variety");
  lines.push(`Spelling: ${typeof variety === "string" ? VARIETY[variety] : "no one English is asked for"}`);
  const comma = rules.setting("serialComma");
  if (comma === "always" || comma === "never") lines.push(`The comma before “and” in a list: ${comma === "always" ? "always" : "never"}`);
  const prefer = rules.words.filter((w) => w.kind === "prefer");
  if (prefer.length) {
    lines.push("", "Written one way:");
    for (const w of prefer) lines.push(`${w.use}\t(not ${w.find})${w.note ? `\t${w.note}` : ""}`);
  }
  const allow = rules.words.filter((w) => w.kind === "allow");
  if (allow.length) lines.push("", "Left as written:", allow.map((w) => w.find).join(", "));
  const names = namesOf(read.scan, read.facts);
  if (names.length) {
    lines.push("", "Names, and how often each is used:");
    for (const [name, n] of names.slice(0, 400)) lines.push(`${name}\t${n.toLocaleString("en-US")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function changesText(log: { what: string; places: number }[]): string {
  if (!log.length) return "Nothing has been changed from the Check panel in this sitting.\n";
  const lines = ["Changed from the Check panel", ""];
  const by = new Map<string, number>();
  for (const entry of log) by.set(entry.what, (by.get(entry.what) ?? 0) + entry.places);
  for (const [what, places] of by) lines.push(`${what}\t${places.toLocaleString("en-US")} ${places === 1 ? "place" : "places"}`);
  return `${lines.join("\n")}\n`;
}

export function notesText(notes: Note[]): string {
  const open = notes.filter((n) => !n.resolved);
  if (!open.length) return "There are no open comments.\n";
  const lines = [`Comments (${open.length})`, ""];
  open.forEach((note, i) => {
    lines.push(`${i + 1}. ${note.about ? `On “${note.about.replace(/\s+/g, " ").trim()}”` : "On the whole text"}`);
    for (const said of note.said) lines.push(`   ${said.who ? `${said.who}: ` : ""}${said.text.replace(/\s+/g, " ").trim()}`);
    lines.push("");
  });
  return `${lines.join("\n")}`;
}
