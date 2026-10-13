// Makes src/proof/data/en/variants.ts from VarCon, the table of American,
// British, Canadian and Australian spellings kept by the SCOWL project
// (github.com/en-wl/wordlist, varcon/varcon.txt). Run by hand when the
// table is to be renewed:
//
//   node tools/build-varcon.mjs /path/to/varcon.txt
//
// The output is committed. The app never fetches anything.
//
// What is kept: words up to SCOWL level 70, a row for each word that is
// spelled more than one way. What is left out: possessives (worked out as
// needed), and any row VarCon marks as true of one sense only (check and
// cheque, tire and tyre), since a table cannot tell which sense is meant.
// Of those, one half is often still certain: "tyre" is always the wheel
// and always British. Such a row is kept one way: its certain spelling is
// looked up, and the other (written with a ~) is only what it would be
// changed to.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("usage: node tools/build-varcon.mjs /path/to/varcon.txt");
  process.exit(1);
}
const MAX_LEVEL = 70;
const VARIETIES = ["A", "B", "Z", "C", "D"];
/** How a spelling stands in a variety: 2 the usual one, 1 also used, 0 not used. */
const RANK = { "": 2, ".": 2, v: 1, V: 0, "-": 0, x: 0 };

/** Noted by VarCon for a sense too rare in prose to matter (the gray is a
 *  unit of radiation). */
const KEEP = new Set(["gray", "grays", "grey", "greys"]);
/** British spellings that are never another word, though the American
 *  spelling they answer to is (tire, check, story). Only these are kept
 *  one way: chosen by hand, a few at a time. */
const CERTAIN = ["tyre", "cheque", "storey", "programme", "metre", "kerb", "draught", "licence", "practis"];

const lines = readFileSync(source, "utf8").split("\n");
const clusters = [];
let cluster = null;
const doubtful = new Set();
/** Rows true of one sense only, by cluster. */
const sensed = [];
for (const raw of lines) {
  const line = raw.trimEnd();
  if (line.startsWith("##")) continue;
  if (line.startsWith("#")) {
    const level = Number(/\(level (\d+)\)/.exec(line)?.[1] ?? 99);
    cluster = { head: line.replace(/^#\s*/, "").split(" ")[0], level, rows: [] };
    clusters.push(cluster);
    continue;
  }
  if (!line || !cluster) continue;
  const [body, note] = line.split(" | ");
  const parts = body.split(" / ").map((part) => {
    const at = part.indexOf(": ");
    return { tags: part.slice(0, at).trim().split(/\s+/), word: part.slice(at + 2).trim() };
  });
  // True of one sense only (or told apart by a note): not for a table,
  // unless the sense is one prose never meets.
  const rare = note !== undefined && parts.every((part) => KEEP.has(part.word));
  if (rare && parts.length < 2) continue;
  const noted = note !== undefined && !rare;
  if (noted) for (const part of parts) doubtful.add(part.word);
  if ((parts.length < 2 && !noted) || parts.some((part) => !/^[a-z][a-z'-]*$/.test(part.word) || part.word.endsWith("'s") || part.word.endsWith("'"))) continue;
  const row = parts.map((part) => {
    const rank = {};
    for (const tag of part.tags) {
      const variety = tag[0];
      if (VARIETIES.includes(variety)) rank[variety] = Math.max(rank[variety] ?? 0, RANK[tag.slice(1)] ?? 0);
    }
    return { word: part.word, rank, tagged: new Set(part.tags.map((tag) => tag[0])) };
  });
  // What VarCon leaves unsaid: British -ise spellings stand for Oxford and
  // Australian use, Oxford for Canadian, unless the row says otherwise.
  const says = (variety) => row.some((alt) => alt.tagged.has(variety));
  const hasZ = says("Z");
  const hasC = says("C");
  const hasD = says("D");
  for (const alt of row) {
    if (!hasZ && alt.rank.B !== undefined) alt.rank.Z = alt.rank.B;
    if (!hasC && alt.rank.Z !== undefined) alt.rank.C = alt.rank.Z;
    if (!hasD && alt.rank.B !== undefined) alt.rank.D = alt.rank.B;
  }
  const made = row.map((alt) => ({ word: alt.word, code: VARIETIES.map((variety) => alt.rank[variety] ?? 0).join("") }));
  if (noted) sensed.push({ cluster, row: made });
  else cluster.rows.push(made);
}
// (A word noted alone, "A B: check | verify", is in no row but is doubtful.)

// A spelling in two rows could be either word: both rows go.
const seen = new Map();
for (const c of clusters) for (const row of c.rows) for (const alt of row) seen.set(alt.word, (seen.get(alt.word) ?? 0) + 1);
// Of the rows true of one sense: a spelling that belongs to one variety in
// every row it is in, and is paired with the same word each time.
const pairs = new Map();
const everyUse = new Map();
for (const { row } of sensed) for (const alt of row) everyUse.set(alt.word, [...(everyUse.get(alt.word) ?? []), alt.code]);
const oneWay = new Map();
for (const { cluster: c, row } of sensed) {
  if (row.length !== 2 || c.level > MAX_LEVEL) continue;
  row.forEach((alt, i) => {
    const other = row[1 - i];
    const codes = everyUse.get(alt.word) ?? [];
    const american = codes.every((code) => code[0] === "2" && code[1] === "0" && code[2] === "0");
    const british = codes.every((code) => code[0] === "0" && (code[1] === "2" || code[2] === "2"));
    if (!british || american || seen.has(alt.word) || !CERTAIN.some((stem) => alt.word.startsWith(stem))) return;
    const was = pairs.get(alt.word);
    if (was && was !== other.word) pairs.set(alt.word, "");
    else pairs.set(alt.word, other.word);
    oneWay.set(alt.word, { head: c, text: `~${other.word}${other.code}/${alt.word}${alt.code}` });
  });
}

const out = [];
let rows = 0;
const extra = new Map();
for (const [word, { head, text }] of oneWay) {
  if (!pairs.get(word)) continue;
  extra.set(head, [...(extra.get(head) ?? []), text]);
}
for (const c of clusters) {
  if (c.level > MAX_LEVEL) continue;
  const kept = c.rows.filter((row) => row.every((alt) => !doubtful.has(alt.word) && seen.get(alt.word) === 1) && new Set(row.map((alt) => alt.word)).size === row.length);
  const all = [...kept.map((row) => row.map((alt) => alt.word + alt.code).join("/")), ...(extra.get(c) ?? [])];
  if (!all.length) continue;
  rows += all.length;
  out.push(all.join(";"));
}

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../src/proof/data/en/variants.ts");
const text = `// GENERATED by tools/build-varcon.mjs. Do not edit by hand.
//
// A table of English words that are spelled more than one way, and which
// spelling each variety of English uses. Derived (and so modified) from
// VarCon, part of the SCOWL project: github.com/en-wl/wordlist.
//
// Copyright 2000-2019 by Kevin Atkinson
//
// Permission to use, copy, modify, distribute and sell this array, the
// associated software, and its documentation for any purpose is hereby
// granted without fee, provided that the above copyright notice appears
// in all copies and that both that copyright notice and this permission
// notice appear in supporting documentation. Kevin Atkinson makes no
// representations about the suitability of this array for any
// purpose. It is provided "as is" without express or implied warranty.
//
// Copyright 2016 by Benjamin Titze
//
// Permission to use, copy, modify, distribute and sell this array, the
// associated software, and its documentation for any purpose is hereby
// granted without fee, provided that the above copyright notice appears
// in all copies and that both that copyright notice and this permission
// notice appear in supporting documentation. Benjamin Titze makes no
// representations about the suitability of this array for any
// purpose. It is provided "as is" without express or implied warranty.
//
// The original word lists come from the Ispell distribution, Copyright
// 1993 Geoff Kuenning, used under its licence (see docs/notices.md).
//
// One line a word family. Its rows (one a word form) are parted by ";",
// the spellings of a row by "/". Each spelling ends in five digits: how it
// stands in American, British, British with -ize, Canadian and Australian
// English (2 the usual spelling, 1 also used, 0 not used). A spelling
// that begins "~" is also another word (tire): it is never looked up, and
// is only what the other spelling of its row would be changed to.

export const VARIANTS = \`
${out.join("\n")}
\`;
`;
writeFileSync(target, text);
console.log(`${out.length} families, ${rows} rows, ${(text.length / 1024).toFixed(0)} KB -> ${target}`);
