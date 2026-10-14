// Makes src/editor/autocorrect/data/enLibreOffice.ts from LibreOffice's
// English autocorrect list: the slips of the fingers and misspellings its
// Writer sets right as you type. (The LibreOffice project, core repository,
// extras/source/autocorr/lang/en-US/DocumentList.xml and the en-GB one
// beside it. Mozilla Public License 2.0.) Run by hand when the list is to
// be renewed:
//
//   node tools/build-autocorrect.mjs /path/to/en-US.xml /path/to/en-GB.xml [/usr/share/dict/words]
//
// The output is committed. The app never fetches anything.
//
// The list is taken for one use, changing a word without asking, so only
// what is certain is kept:
//   - a single word typed, in plain letters (not the ":smile:" names for
//     signs, not the patterns for arrows and the like, which the app has
//     its own of, and not slips that run over two words)
//   - whose fix changes more than its capitals or its accents (whether
//     "cliche" wants its accent is the writer's choice, and the Check
//     panel's to raise)
//   - and which is NOT a word itself. The list has a few that are ("fora"
//     for "for a", "withe" for "with", "directer" for "director"). A word
//     is known as one from the dictionary file given (macOS and most Unix
//     systems have one at /usr/share/dict/words: Webster's Second, in the
//     public domain, used here only to look words up and not copied) and
//     from the app's own table of British and American spellings. A
//     contraction without its apostrophe ("dont") is kept whatever a
//     dictionary says.
//
// The British list differs from the American in a handful of answers
// ("lisense" is "licence" there). Those are written out apart.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [usPath, gbPath, wordsPath = "/usr/share/dict/words"] = process.argv.slice(2);
if (!usPath || !gbPath) {
  console.error("usage: node tools/build-autocorrect.mjs /path/to/en-US.xml /path/to/en-GB.xml [/path/to/words]");
  process.exit(1);
}
if (!existsSync(wordsPath)) {
  console.error(`No dictionary file at ${wordsPath}. Give one as the third argument: a plain list of words, one a line.`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
const read = (path) => {
  const out = new Map();
  const text = readFileSync(path, "utf8");
  for (const m of text.matchAll(/block-list:abbreviated-name="([^"]*)"\s+block-list:name="([^"]*)"/g)) out.set(unescape(m[1]), unescape(m[2]));
  return out;
};
const plain = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Words that are words.
const known = new Set(readFileSync(wordsPath, "utf8").split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter(Boolean));
const variants = readFileSync(resolve(here, "../src/proof/data/en/variants.ts"), "utf8");
for (const m of variants.matchAll(/~?([a-z'’-]+)\d{5}/g)) known.add(m[1]);
/** Old or rare words the dictionary lists that nobody types on purpose
 *  now: as slips they are certain. (Looked at one by one. "alway", "stroy",
 *  "withe", "fora" and "directer" are left as the words they are.) */
const SURELY_SLIPS = new Set(["untill", "hsi", "tath", "timne", "opposit"]);
/** A word, or the plural of one. (Not other endings: "becomeing" is
 *  "become" with an ending and is still no word.) */
const isWord = (w) => !SURELY_SLIPS.has(w) && (known.has(w) || (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && known.has(w.slice(0, -1))));

const us = read(usPath);
const gb = read(gbPath);
const kept = new Map();
const dropped = { names: 0, patterns: 0, severalWords: 0, notLetters: 0, capitalsOrAccents: 0, isAWord: [] };
for (const [typedRaw, becomes] of us) {
  if (/^:[^:]+:$/.test(typedRaw)) dropped.names += 1;
  else if (typedRaw.includes(".*")) dropped.patterns += 1;
  else if (/\s/.test(typedRaw)) dropped.severalWords += 1;
  else if (!/^[A-Za-z]+$/.test(typedRaw)) dropped.notLetters += 1;
  else {
    const typed = typedRaw.toLowerCase();
    if (plain(typed) === plain(becomes).toLowerCase()) dropped.capitalsOrAccents += 1;
    // (A contraction without its apostrophe is the one kind of slip kept
    // though some dictionary lists it.)
    else if (isWord(typed) && becomes.replace(/['’]/g, "").toLowerCase() !== typed) dropped.isAWord.push(`${typed} (for ${becomes})`);
    else kept.set(typed, becomes.replace(/'/g, "’"));
  }
}
const british = new Map();
for (const [typedRaw, becomes] of gb) {
  const typed = typedRaw.toLowerCase();
  if (kept.has(typed) && kept.get(typed) !== becomes.replace(/'/g, "’")) british.set(typed, becomes.replace(/'/g, "’"));
}

const pack = (map) => [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([typed, becomes]) => `${typed} ${becomes}`);
const lines = (rows) => {
  const out = [];
  let line = "";
  for (const row of rows) {
    if (line && line.length + row.length + 1 > 110) {
      out.push(line);
      line = "";
    }
    line += `${line ? "|" : ""}${row}`;
  }
  if (line) out.push(line);
  return out.map((l, i) => `  ${JSON.stringify(i < out.length - 1 ? `${l}|` : l)}`).join(" +\n");
};

const target = resolve(here, "../src/editor/autocorrect/data/enLibreOffice.ts");
writeFileSync(
  target,
  `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// GENERATED by tools/build-autocorrect.mjs. Do not edit by hand.
//
// Slips and misspellings and what was meant, from the English autocorrect
// list of LibreOffice (the LibreOffice project, core repository,
// extras/source/autocorr/lang/en-US and en-GB, DocumentList.xml), a
// selection of it: see the tool for what is kept and why. This file is a
// modified form of that list and is under the same licence, the Mozilla
// Public License 2.0, whatever the rest of the app is under.
//
// ${kept.size} entries. "typed becomes", lowercase. What follows the first
// space is the whole of what was meant.

export const LIBREOFFICE_EN =
${lines(pack(kept))};

/** The few with another answer in British English. */
export const LIBREOFFICE_EN_GB =
${lines(pack(british))};
`,
);
console.log(`kept ${kept.size} (British answers: ${british.size})`);
console.log(`left out: ${dropped.names} names for signs, ${dropped.patterns} patterns, ${dropped.severalWords} of several words, ${dropped.notLetters} not plain letters, ${dropped.capitalsOrAccents} that change only capitals or accents`);
console.log(`left out as words in their own right (${dropped.isAWord.length}): ${dropped.isAWord.join(", ")}`);
