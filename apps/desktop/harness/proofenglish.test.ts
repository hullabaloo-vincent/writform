// The checks that read English: words spelled two ways, accents, slips,
// hyphens, dashes and numbers. For each, what it finds, what it fixes,
// and the look-alikes it leaves alone.

import { check, finish } from "./env";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CHECKS } from "../src/proof/checks";
import { inWords } from "../src/proof/checks/numbers";
import { loadVariants } from "../src/proof/checks/spelling";
import { VARIANTS } from "../src/proof/data/en/variants";
import { VARIANTS_NOTICE } from "../src/proof/data/en/variantsNotice";
import { Reader } from "../src/proof/engine/run";
import { effective } from "../src/proof/rules/layer";
import { emptyLayer, wordId, type Layer } from "../src/proof/rules/model";
import type { BlockInput, Env, Issue, Scan } from "../src/proof/types";
import { PLAIN, storyText } from "./prose";

loadVariants(VARIANTS);

const EN: Env = { lang: "en-gb", base: "en", quotes: { open2: "“", close2: "”", open1: "‘", close1: "’", spaced: false }, format: "manuscript", highlights: false };
const block = (text: string, more: Partial<BlockInput> = {}): BlockInput => {
  const b = { text, role: "body", heading: null, element: null, list: null, cell: false, note: false, quoted: false, italic: [], highlight: [], link: [], ...more } as BlockInput;
  b.sig = [b.role, b.heading ?? "", b.cell, b.quoted].join("|");
  return b;
};
const scanOf = (blocks: (string | BlockInput)[]): Scan => {
  const list = blocks.map((b) => (typeof b === "string" ? block(b) : b));
  return { blocks: list, prev: new Int32Array(list.length).fill(-1), list: new Int32Array(list.length) };
};
const style = (settings: Layer["settings"] = {}, more: Partial<Layer> = {}) => effective(EN, { ...emptyLayer(), settings, ...more }, emptyLayer());
const read = (blocks: (string | BlockInput)[], rules = style(), env: Env = EN): Issue[] => new Reader(env, CHECKS).readNow(scanOf(blocks), rules).analysis.issues;
const found = (issues: Issue[], id: string): Issue | undefined => issues.find((i) => i.id === id);
const ids = (issues: Issue[], check: string): string => issues.filter((i) => i.check === check).map((i) => i.key).join("|");
const texts = (issue: Issue | undefined, blocks: string[]): string => (issue?.places ?? []).map((p) => blocks[p.block].slice(p.start, p.end)).join("|");
const forms = (issue: Issue | undefined): string => (issue?.forms ?? []).map((f) => `${f.id}${f.count}`).join();
/** The text with an issue's places changed to a form. */
const fixed = (blocks: string[], issue: Issue | undefined, form = ""): string[] => {
  const out = [...blocks];
  for (const p of [...(issue?.places ?? [])].sort((a, b) => b.block - a.block || b.start - a.start)) {
    const fix = p.fixes?.[form];
    if (!fix || "mark" in fix) continue;
    for (const e of [...fix.edits].sort((a, b) => b.start - a.start)) out[p.block] = out[p.block].slice(0, e.start) + e.text + out[p.block].slice(e.end);
  }
  return out;
};

// ------------------------------------------------------- the table itself

{
  const rows = VARIANTS.trim().split("\n");
  const has = (word: string) => new RegExp(`(?:^|[;/])${word}\\d{5}`, "m").test(VARIANTS);
  check("the table of spellings has the common pairs", has("colour") && has("color") && has("organise") && has("organize") && has("grey") && has("gray") && has("centre") && has("travelling") && has("judgement"));
  check("…and not the spellings that are also other words", !has("check") && !has("tire") && !has("story") && !has("program") && !has("practice") && !has("license") && !has("draft") && !has("mum"));
  check("…though the half of such a pair that is certain is kept one way", /~tire\d{5}\/tyre\d{5}/.test(VARIANTS) && /~check\d{5}\/cheque\d{5}/.test(VARIANTS));
  check("it is a modest size", rows.length > 2000 && VARIANTS.length < 300_000, `${rows.length} families, ${VARIANTS.length} characters`);
  const file = readFileSync(resolve(process.cwd(), "src/proof/data/en/variants.ts"), "utf8");
  check("it carries its makers' notices, and says it is changed", file.includes("Copyright 2000-2019 by Kevin Atkinson") && file.includes("Copyright 2016 by Benjamin Titze") && file.includes("Geoff Kuenning") && file.includes("modified") && file.includes("GENERATED"));
  check("the notice the app shows is the licence's own", VARIANTS_NOTICE.startsWith("Copyright 2000-2019 by Kevin Atkinson") && VARIANTS_NOTICE.includes("Permission to use, copy, modify, distribute and sell") && VARIANTS_NOTICE.includes("Geoff Kuenning"));
  const notices = readFileSync(resolve(process.cwd(), "../../docs/notices.md"), "utf8");
  check("…and it is in the repository's notices", notices.includes("Copyright 2000-2019 by Kevin Atkinson") && notices.includes("modified version"));
}

// -------------------------------------------------------------- spelling

{
  const text = ["The colour of the harbour was grey. She organised the papers.", "Its color had faded, and the center of the town was gray.", "He realized it late. The Labour Party met at Pearl Harbor.", "A cheque for the tyre. She will check the tire and tire of it."];
  const issues = read(text);
  const v = found(issues, "spelling:variety");
  check("American and British spellings in one text", forms(v) === "us3,uk6", forms(v));
  check("…each named for what it is", texts(v, text) === "colour|harbour|grey|organised|color|center|gray|cheque|tyre", texts(v, text));
  check("a name is not weighed (the Labour Party, Pearl Harbor)", !texts(v, text).includes("Labour") && !texts(v, text).includes("Harbor"));
  check("a spelling that is also another word is left alone (check, tire)", !texts(v, text).split("|").includes("check") && !texts(v, text).split("|").includes("tire"));
  check("-ize is not American: British uses it too", !texts(v, text).includes("realized"));
  check("the commoner one is taken to be meant", v?.preferred === "uk");
  const uk = fixed(text, v, "uk");
  check("made British", uk[1] === "Its colour had faded, and the centre of the town was grey.", uk[1]);
  const us = fixed(text, v, "us");
  check("made American, in the capitals each was written in", us[0] === "The color of the harbor was gray. She organized the papers." && us[3].startsWith("A check for the tire."), `${us[0]} / ${us[3]}`);
  check("no word is reported twice", !issues.some((i) => i.id.startsWith("spelling:w.")), ids(issues, "spelling"));

  const british = read(text, style({ variety: "uk" }));
  const ruled = found(british, "spelling:variety");
  check("with British asked for, every spelling it does not use", ruled?.kind === "rule" && texts(ruled, text) === "color|center|gray|realized", texts(ruled, text));
  check("…and their fix", fixed(text, ruled)[2].startsWith("He realised it late."));
  check("British with -ize keeps realized", texts(found(read(text, style({ variety: "uk-ize" })), "spelling:variety"), text) === "organised|color|center|gray");
  check("American asked for", texts(found(read(text, style({ variety: "us" })), "spelling:variety"), text) === "colour|harbour|grey|organised|cheque|tyre");
  check("a text all in one English says nothing", !found(read(["The colour of the harbour was grey.", "She organised the centre."]), "spelling:variety") && ids(read(["The colour of the harbour was grey."]), "spelling") === "");

  const ize = ["She organised it and he recognised her.", "They realized it and apologized."];
  const z = found(read(ize), "spelling:ize");
  check("within British, -ise and -ize are each a style", forms(z) === "ize2,ise2" && fixed(ize, z, "ise")[1] === "They realised it and apologised.", forms(z));
  const both = ["Her judgement was sound.", "His judgment was not. The traveller focussed. They focused."];
  const j = read(both);
  check("a word spelled two ways within one English", !!found(j, "spelling:w.judgment") && forms(found(j, "spelling:w.judgment")) === "01,11" && !!found(j, "spelling:w.focused"), ids(j, "spelling"));
  check("…fixed either way", fixed(both, found(j, "spelling:w.judgment"), "1")[1].startsWith("His judgement was not.") && fixed(both, found(j, "spelling:w.judgment"), "0")[0] === "Her judgment was sound.");
  check("a possessive keeps its ending", fixed(["The colour's depth.", "The color faded. It was gray. The center held."], found(read(["The colour's depth.", "The color faded. It was gray. The center held."]), "spelling:variety"), "us")[0] === "The color's depth.");
  check("someone else's words are not respelled", !found(read([block("The colour of honour.", { role: "extract", quoted: true }), "The color of the center was gray."]), "spelling:variety"));
  check("a word you have said never to flag is left out", !found(read(both, style({}, { words: { [wordId("judgement")]: { k: "allow", find: "judgement" } } })), "spelling:w.judgment"));
  check("in another language nothing is respelled, and it says so", read(text, style(), { ...EN, lang: "de", base: "de" }).every((i) => i.check !== "spelling") && new Reader({ ...EN, lang: "de", base: "de" }, CHECKS).readNow(scanOf(text), style()).analysis.unread.includes("spelling"));
}

// --------------------------------------------------------------- accents

{
  const text = ["They met at the café. It was a naïve hope.", "The cafe was shut. A naive hope, and a rosé with a rose.", "Her résumé was long. To resume, then."];
  const issues = read(text);
  check("a word with its accent in some places and without in others", ids(issues, "accents") === "cafe|naive", ids(issues, "accents"));
  check("…fixed either way, capitals kept", fixed(text, found(issues, "accents:cafe"), "accent")[1].startsWith("The café was shut.") && fixed(text, found(issues, "accents:cafe"), "plain")[0].startsWith("They met at the cafe."));
  check("two different words are not a pair (rosé and rose, résumé and resume)", !found(issues, "accents:rose") && !found(issues, "accents:resume"));
  check("a word always written one way says nothing", ids(read(["A café. Another café."]), "accents") === "");
}

// ----------------------------------------------------------------- slips

{
  const text = ["He could of gone. It was a sneak peak, per say.", "“I could of told you,” she said. Its a pity, and your welcome.", "More then enough. Then they left, and then it rained.", "Of course he could, of all people. It's own way? Its own way."];
  const issues = read(text);
  check("slips a spelling checker passes", ids(issues, "slips") === "could of|sneak peak|per say|its a|your welcome|more then|it's own", ids(issues, "slips"));
  check("how people talk is left alone inside quote marks", found(issues, "slips:could of")?.places.length === 1);
  check("…and fixed outside them", fixed(text, found(issues, "slips:could of"))[0].startsWith("He could have gone.") && fixed(text, found(issues, "slips:its a"))[1].includes("It's a pity"));
  check("the right use of the same words is not a slip", (found(issues, "slips:more then")?.places.length ?? 0) === 1 && !found(issues, "slips:of course"));
  check("300 right uses of their and there raise nothing", read([Array.from({ length: 150 }, () => "Their house was there, over there by their gate.").join(" ")]).every((i) => i.check !== "slips"));
}

// --------------------------------------------------------------- hyphens

{
  const text = ["It was a short-term plan, and a long term problem.", "In the short term nothing changed. A short term loan would help.", "The long-term view was plain. They would co-operate, and then cooperate again.", "To follow up was hard. The follow-up came late, and the follow up was worse."];
  const issues = read(text);
  check("a phrase hyphenated before a word in some places and not in others", !!found(issues, "hyphens:short term:before") && forms(found(issues, "hyphens:short term:before")) === "hyphen1,open1", ids(issues, "hyphens"));
  check("“in the short term” is not weighed against “a short-term plan”", texts(found(issues, "hyphens:short term:before"), text) === "short-term|short term" && found(issues, "hyphens:short term:before")?.places[1].block === 1 && !found(issues, "hyphens:short term:after"));
  check("…and the fix changes only the joiner", fixed(text, found(issues, "hyphens:short term:before"), "hyphen")[1] === "In the short term nothing changed. A short-term loan would help." && fixed(text, found(issues, "hyphens:long term:before"), "open")[2].startsWith("The long term view"));
  check("a word hyphenated in some places and closed in others", forms(found(issues, "hyphens:w.cooperate")) === "hyphen1,closed1" && fixed(text, found(issues, "hyphens:w.cooperate"), "closed")[2].includes("would cooperate, and then cooperate") && fixed(text, found(issues, "hyphens:w.cooperate"), "hyphen")[2].includes("then co-operate again"));
  check("a verb of two words is not the thing named after it", texts(found(issues, "hyphens:follow up:after"), text) === "follow-up|follow up" && !texts(found(issues, "hyphens:follow up:after"), text).startsWith("follow up"), texts(found(issues, "hyphens:follow up:after"), text));
  const quiet = read(["He had to re-cover the chair and recover his nerve. Jean-Luc met Jean Luc. A b-b-but, and twenty-one, and a well-known man who was well known."]);
  check("left alone: two different words, names, a stammer, a number", !ids(quiet, "hyphens").includes("recover") && !ids(quiet, "hyphens").includes("jean") && !ids(quiet, "hyphens").includes("b b"), ids(quiet, "hyphens"));
  check("…and a phrase before its word against the same phrase after it", ids(quiet, "hyphens") === "", ids(quiet, "hyphens"));
}

// ---------------------------------------------------------------- dashes

{
  const text = ["From 1990-95 and then 1996–99. Call 555-0199-22 on 2026-10-13.", "He stopped—then went on. She waited — and left. It was late – too late. Wait - no. And--then.", "“I never—” She stopped. A well-known man."];
  const issues = read(text);
  check("a range with a hyphen and a range with a dash", forms(found(issues, "dashes:range")) === "en1,hyphen1" && fixed(text, found(issues, "dashes:range"), "en")[0].startsWith("From 1990–95 and then 1996–99."));
  check("a phone number and a date are not ranges", !texts(found(issues, "dashes:range"), text).includes("0199") && found(issues, "dashes:range")?.places.length === 2);
  const br = found(issues, "dashes:break");
  check("the dash in a sentence, drawn five ways", forms(br) === "em1,em-spaced1,en-spaced1,hyphen1,double1", forms(br));
  check("…made one way", fixed(text, br, "em")[1] === "He stopped—then went on. She waited—and left. It was late—too late. Wait—no. And—then.", fixed(text, br, "em")[1]);
  check("…or another", fixed(text, br, "en-spaced")[1].startsWith("He stopped – then went on. She waited – and left."));
  check("a dash that cuts speech off, and a hyphen in a word, are not counted", br?.places.every((p) => p.block === 1) === true);
  check("a script's INT. HOUSE - DAY is not a sentence", !found(read([block("INT. HOUSE - DAY", { role: "caps" }), "He stopped—then went on."]), "dashes:break"));
}

// --------------------------------------------------------------- numbers

{
  check("a number in words", inWords(7) === "seven" && inWords(15) === "fifteen" && inWords(40) === "forty" && inWords(21) === "twenty-one" && inWords(99) === "ninety-nine");
  const text = ["She had three cats and 4 dogs. He was twenty-one, she was thirty five.", "On page 3 of chapter 12, in Room 9, at 3:30 on 5 May. It cost $5 and weighed 5 kg, about 20%.", "There were 7 of them and 250 more. Nine came back. One did not.", "1. First. He lived at 12 Main Street. Apollo 11 flew. They scored 3-2."];
  const issues = read(text);
  const small = found(issues, "numbers:small");
  check("numbers under ten as words and as figures", forms(small) === "words2,figures1" && texts(small, text) === "three|4|Nine", `${forms(small)} ${texts(small, text)}`);
  check("…made words", fixed(text, small, "words")[0].startsWith("She had three cats and four dogs."));
  check("…made figures", fixed(text, small, "figures")[0].startsWith("She had 3 cats and 4 dogs.") && fixed(text, small, "figures")[2].includes("9 came back"));
  check("“one” is never counted", !texts(small, text).includes("One"));
  check("a label, a time, a date, money, a measure and a share are not numbers in a sentence", !texts(small, text).includes("3|") || texts(small, text) === "three|4|Nine");
  check("a figure beside a figure of 100 or more is left with it", !texts(small, text).includes("7"));
  check("a list's number, an address, a name and a score are left alone", small?.places.every((p) => p.block !== 3) === true);
  const comp = found(issues, "numbers:compound");
  check("twenty-one and thirty five", forms(comp) === "hyphen1,open1" && fixed(text, comp, "hyphen")[0].endsWith("she was thirty-five."));
  check("twenty one-dollar bills is twenty of them", !found(read(["He had twenty one-dollar bills and was twenty-one."]), "numbers:compound"));
  check("a text that keeps to words says nothing", ids(read(["She had three cats and four dogs. He was twenty-one."]), "numbers") === "");
  const tens = ["He was thirty and she was 40.", "They waited for 15 days. Fifteen came."];
  check("ten to ninety-nine are weighed apart from the small numbers", forms(found(read(tens), "numbers:tens")) === "words2,figures1" && !found(read(tens), "numbers:small"), forms(found(read(tens), "numbers:tens")));
  check("a figure made a word at the head of a sentence takes its capital", fixed(["9 came back. She had three."], found(read(["9 came back. She had three."]), "numbers:small"), "words")[0] === "Nine came back. She had three.");
}

// ---------------------------------------------------- quiet where it should be

{
  const clean = [PLAIN, ...storyText().filter((p) => !p.heading).map((p) => p.text)];
  const issues = read(clean);
  const noisy = issues.filter((i) => ["spelling", "accents", "slips", "hyphens", "dashes", "numbers"].includes(i.check));
  check("plain, careful prose raises none of these", noisy.length === 0, noisy.map((i) => `${i.id}:${i.places.length}`).join(" "));
}

// ------------------------------------------------- a choice that is kept

{
  const text = ["Her judgement was sound.", "His judgment was not, and their judgment was worse."];
  const id = "spelling:w.judgment";
  const free = found(read(text), id);
  check("left to itself the commoner form is taken", free?.preferred === "0" && free.preferredFrom === "majority");
  const kept = effective(EN, { ...emptyLayer(), picks: { [id]: "1" } }, emptyLayer());
  check("a choice kept in the rules is there to be used", kept.pick(id)?.form === "1" && kept.pick(id)?.from === "yours" && effective(EN, { ...emptyLayer(), picks: { [id]: "1" } }, { ...emptyLayer(), picks: { [id]: "0" } }).pick(id)?.from === "document");
}

finish();
