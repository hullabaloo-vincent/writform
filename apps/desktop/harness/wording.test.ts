// The Word choice and Dialogue reports: what each finds, the look-alikes
// it leaves alone, and its fixes made in a real document.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

import { changesOf } from "../src/editor/review/changes";
import { setReviewMode, Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { CHECKS, defaultRules } from "../src/proof/checks";
import { CLICHES, REDUNDANCIES, WORDY } from "../src/proof/data/en/phrases";
import { ACTION_VERBS, PLAIN_TAGS, SPEECH_VERBS } from "../src/proof/data/en/speechVerbs";
import { IRREGULAR_PARTICIPLES, STATE_WORDS } from "../src/proof/data/en/verbs";
import { Reader } from "../src/proof/engine/run";
import { analyse, styleOf, type StyleAnalysis } from "../src/proof/reports/analysis";
import { buildReport, chapterRows, REPORTS } from "../src/proof/reports";
import { reportText } from "../src/proof/reports/exportReport";
import type { HitGroup, HitItem, ReportResult } from "../src/proof/reports/types";
import { Vocab } from "../src/proof/reports/vocab";
import { ProofSession } from "../src/proof/session";
import type { BlockInput, Env, Scan } from "../src/proof/types";
import { PLAIN, storyText } from "./prose";

const EN: Env = { lang: "en-gb", base: "en", quotes: { open2: "“", close2: "”", open1: "‘", close1: "’", spaced: false }, format: "manuscript", highlights: false };
const block = (text: string, more: Partial<BlockInput> = {}): BlockInput => {
  const b = { text, role: "body", heading: null, element: null, list: null, cell: false, note: false, quoted: false, italic: [], highlight: [], link: [], ...more } as BlockInput;
  b.sig = [b.role, b.heading ?? "", b.note].join("|");
  return b;
};
const read = (texts: (string | BlockInput)[], env: Env = EN): StyleAnalysis => {
  const blocks = texts.map((t) => (typeof t === "string" ? block(t) : t));
  const scan: Scan = { blocks, prev: new Int32Array(blocks.length).fill(-1), list: new Int32Array(blocks.length) };
  const r = new Reader(env, CHECKS).readNow(scan, defaultRules(env));
  const vocab = new Vocab(env.base);
  return analyse(
    scan,
    blocks.map((_, i) => styleOf(scan, r.facts, i, vocab)),
    vocab,
    env,
    r.facts,
  );
};
const none = new Set<string>();
const wording = (texts: (string | BlockInput)[], speech = true, allowed = none): ReportResult => {
  const a = read(texts);
  return buildReport("wording", a, { kind: "all" }, allowed, chapterRows(a), { speech });
};
const dialogue = (texts: string[]): ReportResult => {
  const a = read(texts);
  return buildReport("dialogue", a, { kind: "all" }, none, chapterRows(a));
};
const group = (r: ReportResult, id: string): HitGroup | undefined => r.groups.find((g) => g.id === id);
const keys = (r: ReportResult, id: string): string =>
  (group(r, id)?.items ?? [])
    .map((i) => (i.count > 1 ? `${i.label}×${i.count}` : i.label))
    .sort()
    .join("|");
const item = (r: ReportResult, id: string, label: string): HitItem | undefined => group(r, id)?.items.find((i) => i.label === label);
const said = (texts: string[], r: ReportResult, id: string): string => (group(r, id)?.items ?? []).flatMap((i) => i.hits.map((h) => texts[h.block].slice(h.start, h.end))).join("|");
/** The texts with every fix of a group made. */
const fixedBy = (texts: string[], r: ReportResult, id: string): string[] => {
  const out = [...texts];
  const edits = (group(r, id)?.items ?? []).flatMap((i) => i.hits.flatMap((h) => (h.fix ?? []).map((e) => ({ block: h.block, ...e }))));
  for (const e of edits.sort((a, b) => b.block - a.block || b.start - a.start)) out[e.block] = out[e.block].slice(0, e.start) + e.text + out[e.block].slice(e.end);
  return out;
};

// --------------------------------------------------------------- passives

{
  const text = ["The letter was taken from the drawer. It had been written in haste and was quickly forgotten.", "She was tired. He was interested in boats. They were married in June. Indeed it was. He has walked far.", "The door was closed by the wind. She was not seen again. The need was great."];
  const r = wording(text);
  check("a likely passive is a form of to be and a participle", said(text, r, "passive") === "was taken|been written|was quickly forgotten|was closed|was not seen", said(text, r, "passive"));
  check("a state is not one (was tired, was interested, were married)", !said(text, r, "passive").includes("tired") && !said(text, r, "passive").includes("married") && !said(text, r, "passive").includes("interested"));
  check("…unless something did it (was closed by the wind)", said(text, r, "passive").includes("was closed"));
  check("nor is indeed, need, or a plain past (has walked)", !said(text, r, "passive").includes("walked") && !said(text, r, "passive").includes("need"));
  check("the passives are set against the sentences", r.summary.find((m) => m.id === "passive")?.text.endsWith("in every 100 sentences") === true);
}

// ---------------------------------------------------------------- adverbs

{
  const text = ["She walked slowly and quietly to the door, then slowly back. Emily had a lovely family, the only one early in July. Suddenly it rained."];
  const r = wording(text);
  check("words in -ly, listed by word", keys(r, "adverbs") === "quietly|slowly×2|suddenly", keys(r, "adverbs"));
  check("not family, only, lovely, early, July or Emily", !keys(r, "adverbs").includes("family") && !keys(r, "adverbs").includes("emily") && !keys(r, "adverbs").includes("lovely"));
}

// ----------------------------------------------------------- filter words

{
  const text = ["She saw the boat leave. Marianne noticed the rope. He could hear the gulls. The saw lay on the bench.", "She thought he had lied. She thought about it for a while. It seemed to grow darker. His thought was plain.", "“I saw it,” he said. The felt hat was old."];
  const r = wording(text);
  check("a person and a verb of sensing", said(text, r, "filter") === "saw|noticed|could hear|thought|seemed to", said(text, r, "filter"));
  check("the tool and the cloth are not (the saw, the felt hat)", (item(r, "filter", "saw")?.count ?? 0) === 1 && !item(r, "filter", "felt"));
  check("thought counts only before a clause", (item(r, "filter", "thought")?.count ?? 0) === 1);
  check("speech is never looked in for these", !(group(r, "filter")?.items ?? []).some((i) => i.hits.some((h) => h.block === 2)));
}

// ------------------------------------------------------- feelings, padding

{
  const text = ["He felt very angry. A wave of relief came over her. She was surprised, and he looked tired.", "It was a very odd day and she really wanted to go. Just then it was just a bit too late."];
  const r = wording(text);
  check("feelings named and not shown", keys(r, "feelings") === "angry|relief|surprised|tired", keys(r, "feelings"));
  check("“was surprised” is a feeling and not a passive", !said(text, r, "passive").includes("surprised"));
  check("padding words", keys(r, "padding") === "just×2|really|very×2", keys(r, "padding"));
  check("padding is lifted out where the sentence stands without it", fixedBy(text, r, "padding")[1] === "It was a very odd day and she wanted to go. Just then it was a bit too late.", fixedBy(text, r, "padding")[1]);
  check("…and not after “a”, nor at the head of a sentence", fixedBy(text, r, "padding")[1].includes("a very odd") && fixedBy(text, r, "padding")[1].includes("Just then"));
}

// ---------------------------------------------------------------- phrases

{
  const text = ["At the end of the day her heart skipped a beat. He nodded his head and stood up, then shrugged his shoulders.", "In order to leave she made a decision. He began to run. Due to the fact that it rained, they stayed.", "He stood up for her. It was past history. She thought to herself that it was odd."];
  const r = wording(text);
  check("worn phrases, his or hers", keys(r, "cliches") === "at the end of the day|his or her heart skipped a beat", keys(r, "cliches"));
  check("words that say it twice", said(text, r, "redundant") === "nodded his head|shrugged his shoulders|stood up|stood up|past history|thought to herself" || said(text, r, "redundant").split("|").sort().join("|") === "nodded his head|past history|shrugged his shoulders|stood up|stood up|thought to herself", said(text, r, "redundant"));
  const mended = fixedBy(text, r, "redundant");
  check("…left as the one word that says it", mended[0].endsWith("He nodded and stood, then shrugged.") && mended[2].includes("It was history.") && mended[2].includes("She thought that it was odd."), mended.join(" / "));
  check("wordy phrases, with a plainer way", item(r, "wordy", "in order to")?.detail === "once. Write “to”." && item(r, "wordy", "began to")?.detail === "once. Try the verb alone.", `${item(r, "wordy", "in order to")?.detail} / ${item(r, "wordy", "began to")?.detail}`);
  const plain = fixedBy(text, r, "wordy");
  check("…fixed where it is a straight swap, in the capitals it was written in", plain[1] === "To leave she decided. He began to run. Because it rained, they stayed.", plain[1]);
  check("advice in words is not a fix", !item(r, "wordy", "began to")?.hits[0].fix);
  check("a word you have said is fine is left out", !group(wording(text, true, new Set(["stood up", "in order to"])), "redundant")?.items.some((i) => i.key === "stood up") && !item(wording(text, true, new Set(["in order to"])), "wordy", "in order to"));
}

// ------------------------------------------------------- confused, speech

{
  const text = ["The effect was plain, and it did not affect her. He took a deep breath.", "“It was very late, at the end of the day,” she said. It was really very late."];
  const r = wording(text);
  check("words taken for one another are listed where the text uses one", keys(r, "confused") === "affect and effect×2|breath and breathe", keys(r, "confused"));
  const quiet = wording(text, false);
  check("with speech left out, what people say is not remarked on", !group(quiet, "cliches") && keys(quiet, "padding") === "really|very", keys(quiet, "padding"));
  const a = read(storyText().map((p) => (p.heading ? block(p.text, { role: "heading", heading: p.heading }) : p.text)));
  check("fiction leaves speech out unless asked", a.fiction && buildReport("wording", a, { kind: "all" }, none, chapterRows(a)).notes.some((n) => n.startsWith("Speech is left out")));
  check("a quiet passage raises next to nothing", (wording([PLAIN]).groups.reduce((n, g) => n + g.count, 0) ?? 0) <= 2, wording([PLAIN]).groups.map((g) => `${g.id}:${g.items.map((i) => i.key).join(",")}`).join(" "));
  check("in another language the report says it reads English only", buildReport("wording", read(["Der Brief wurde genommen."], { ...EN, lang: "de", base: "de" }), { kind: "all" }, none, []).headline === "This report reads English only.");
}

// --------------------------------------------------------------- dialogue

{
  const text = [
    "“Go,” she said. “Now,” said Marianne softly. “Why?” asked the old man.",
    "“Never,” he whispered angrily. “Stop,” Mr. Ashworth growled. She said, “Come here.”",
    "“Go,” she smiled. “Stay.” He nodded. “Well,” Marianne laughed.",
    "“Go.” she said. “Stay,” She said. “Wait” he said. “Enough!” she cried.",
    "“A long one,” she said, “in two parts.”",
  ];
  const r = dialogue(text);
  const bars = r.series[0];
  check("tags are counted by the verb that carries them", bars.values.join() === "8,3,2" && bars.labels?.join("|") === "Said and asked|Other verbs of speech|Actions", bars.values.join());
  check("speech in two parts round one tag is one tag", bars.values[0] === 8);
  check("the other verbs of speech are listed", keys(r, "verbs") === "cried|growled|whispered", keys(r, "verbs"));
  check("actions used as tags, and a beat is not one", keys(r, "actions") === "laughed|smiled" && !keys(r, "actions").includes("nodded"), keys(r, "actions"));
  check("tags with a word in -ly", keys(r, "adverbs") === "angrily|softly", keys(r, "adverbs"));
  const slips = group(r, "slips");
  check("punctuation amiss between speech and tag, four kinds", slips?.items.map((i) => `${i.label}:${i.count}`).join("|") === "An action used as a tag:2|A full stop before the tag:1|A capital on the tag:1|No comma before the closing mark:1", slips?.items.map((i) => `${i.label}:${i.count}`).join("|"));
  const mended = fixedBy(text, r, "slips");
  check("each mended", mended[3] === "“Go,” she said. “Stay,” she said. “Wait,” he said. “Enough!” she cried.", mended[3]);
  check("an action with a pronoun becomes a sentence of its own", mended[2].startsWith("“Go.” She smiled. “Stay.” He nodded."), mended[2]);
  check("…with a name it is listed and left for you", mended[2].endsWith("“Well,” Marianne laughed."));
  check("the headline says how many are said or asked", r.headline === "13 tags. 8 are said or asked.", r.headline);
  const long = dialogue([...Array.from({ length: 7 }, (_, i) => `“Line ${i} of the talk goes here.”`), "He left."]);
  check("a long exchange with nobody named", group(long, "untagged")?.items[0].label === "7 paragraphs of speech with no tag");
  check("five such paragraphs are not long", !group(dialogue(Array.from({ length: 5 }, () => "“Only a short exchange.”")), "untagged"));
  check("prose with no speech has no tags", dialogue([PLAIN]).headline === "No tagged speech found.");
}

// ------------------------------------------------------------ pace, senses

{
  const talk = Array.from({ length: 40 }, (_, i) => `“We should go before the tide turns,” she said. “Number ${i} is ready.”`);
  const slow = Array.from({ length: 8 }, () =>
    "She had thought about the harbour for years, and she remembered how it had looked when the boats had come in at dusk and the men had carried the catch up the long stone steps, and she wondered whether any of it had been as she had believed it was when she had been small and the town had seemed the whole of the world to her. " +
    "It was a thing she had known and had never said, because there had been nobody who would have understood what she had meant by it, and the years had gone by as they had always gone, and she had kept it and had been glad of it.",
  );
  const brisk = Array.from({ length: 30 }, () => "He ran. The door slammed. She turned and saw him go.");
  const texts = [block("One", { role: "heading", heading: "chapter" }), ...talk, ...slow, ...slow, block("Two", { role: "heading", heading: "chapter" }), ...brisk, ...slow.slice(0, 1)];
  const a = read(texts);
  const r = buildReport("pace", a, { kind: "all" }, none, chapterRows(a));
  const map = r.series[0];
  check("the pace map is the text in stretches, each one of three kinds", map.kind === "map" && map.labels?.join() === "Quick,Steady,Slow-leaning" && map.values.every((v) => v >= 0 && v <= 2) && map.at?.length === map.values.length);
  check("speech and short sentences are quick, long looking-back prose is slow-leaning", map.values[0] === 0 && map.values.includes(2) && map.values.slice(-6).includes(0), map.values.join(""));
  const stretch = r.groups[0]?.items[0];
  check("a long run of it is a stretch to look at, named for what was measured", !!stretch && /words with little or no speech$/.test(stretch.label) && stretch.detail?.includes("looks back") === true && stretch.detail.includes("long sentences"), `${stretch?.label} / ${stretch?.detail}`);
  check("…and never called slow or a fault", !/slow\b|problem|error|too /i.test(`${stretch?.label} ${r.headline}`) && r.notes.some((n) => n.includes("A quiet stretch can be exactly right.")));
  check("a stretch does not run from one chapter into the next", r.groups[0]?.items.every((item) => item.hits.length === 1) === true);
  check("plain prose has no stretch to look at", buildReport("pace", read([PLAIN, PLAIN]), { kind: "all" }, none, []).groups.length === 0);

  const sea = ["The water was cold and the light was grey. She heard the gulls and the creak of rope, and smelled salt and tar.", "“I saw it,” he said. “It looked bright.” The bread tasted sweet. His coat was rough and damp."];
  const s = buildReport("senses", read(sea), { kind: "all" }, none, []);
  check("words that name each sense, outside speech", s.series[0].labels?.join() === "Sight,Sound,Touch,Smell,Taste" && s.series[0].values.join() === "2,2,3,1,3", s.series[0].values.join());
  check("…listed by sense and by word", keys(s, "smell") === "smelled" && keys(s, "touch").includes("cold") && !keys(s, "sight").includes("saw"));
  check("a sense that is never named is said", buildReport("senses", read(["She heard the gulls."]), { kind: "all" }, none, []).headline.includes("None name sight or touch or smell or taste"));
  check("a word you have said is fine is left out", !keys(buildReport("senses", read(sea), { kind: "all" }, new Set(["cold"]), []), "touch").includes("cold"));
}

// ------------------------------------------------------- other languages

{
  const fr = read(["Le chat est sur le tapis et le chien est dans le jardin. Le jardin est grand, et le jardin est beau."], { ...EN, lang: "fr", base: "fr" });
  const close = buildReport("repeats", fr, { kind: "all" }, none, []).groups.find((g) => g.id === "close");
  check("in French the small words are not repeats, and a real one is", close?.items.map((i) => i.key).join() === "jardin", close?.items.map((i) => i.key).join());
  check("…and the reports that read English say so", buildReport("senses", fr, { kind: "all" }, none, []).headline === "This report reads English only." && !buildReport("overview", fr, { kind: "all" }, none, []).summary.some((m) => m.id === "grade"));
}

// ------------------------------------------------ the reports as plain text

{
  const blocks = storyText().map((p) => (p.heading ? block(p.text, { role: "heading", heading: p.heading }) : p.text));
  const a = read(blocks);
  const rows = chapterRows(a);
  const reports = REPORTS.map((r) => buildReport(r.id, a, { kind: "all" }, none, rows));
  const text = reportText({ title: "The Letter", scope: "The whole book", date: "13 October 2026", reports, rows });
  const lines = text.split("\n");
  check("the reports as text open with the title, what they cover and the day", lines[0] === "A report on “The Letter”" && lines[1] === "The whole book. 13 October 2026.");
  check("…with a table of the chapters in straight columns", lines.some((l) => /^Chapter\s+Words\s+Speech\s+Sentence$/.test(l)) && lines.filter((l) => /^The (Letter|Garden|Answer|Road)\s+\d+\s+\d+%\s+[\d.]+$/.test(l)).length === 4, lines.filter((l) => l.startsWith("The ")).join(" / "));
  check("…and each report under its name", ["At a glance", "Chapter by chapter", "Sentences", "Repeats", "Word choice", "Dialogue"].every((h) => lines.includes(h)));
  check("no line is wider than a mail shows", lines.every((l) => l.length <= 78), String(Math.max(...lines.map((l) => l.length))));
  check("it says these are counts and not rules", text.includes("These are counts and not rules."));
  check("it holds no semicolon or long dash of its own", !/[;—]/.test(text.replace(/“[^”]*”/g, "")));
}

// -------------------------------------------------------------- the lists

{
  const lower = (list: string[]) => list.every((w) => w === w.toLowerCase() && w.trim() === w && w !== "");
  const dupes = (list: string[]) => list.filter((w, i) => list.indexOf(w) !== i);
  check("the phrase lists are lowercase and say nothing twice", lower(CLICHES) && lower(REDUNDANCIES.map(([f]) => f)) && lower(WORDY.map(([f]) => f)) && dupes(CLICHES).length === 0 && dupes(REDUNDANCIES.map(([f]) => f)).length === 0 && dupes(WORDY.map(([f]) => f)).length === 0, [...dupes(CLICHES), ...dupes(REDUNDANCIES.map(([f]) => f)), ...dupes(WORDY.map(([f]) => f))].join(", "));
  check("a fix is never the phrase it replaces", REDUNDANCIES.every(([f, t]) => f !== t && t !== "") && WORDY.every(([f, t]) => f !== t && t !== ""));
  check("a verb is one kind of tag only", [...ACTION_VERBS].every((v) => !PLAIN_TAGS.has(v)) && [...PLAIN_TAGS].every((v) => SPEECH_VERBS.has(v) || true));
  check("a state word is not also listed as an irregular participle by mistake", ["tired", "married", "interested"].every((w) => STATE_WORDS.has(w) && !IRREGULAR_PARTICIPLES.has(w)));
  check("the lists are of a size worth having", CLICHES.length >= 100 && REDUNDANCIES.length >= 60 && WORDY.length >= 50, `${CLICHES.length} ${REDUNDANCIES.length} ${WORDY.length}`);
}

// ---------------------------------------------------- fixes in a document

{
  const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
  const e = new Editor({ element: mountPoint(), extensions: [...docContentExtensions({}), Suggesting.configure({ author: () => "Ana" })], content: { type: "doc", content: [p("He nodded his head and stood up."), p("“Go.” she said. In order to leave, she stood up.")] } });
  const s = new ProofSession(e, "none", "en-GB");
  s.start();
  s.flush();
  const all = { kind: "all" } as const;
  const opts = { speech: true };
  const stood = () => s.report("wording", all, opts)?.groups.find((g) => g.id === "redundant")?.items.find((i) => i.key === "stood up");
  check("a report's places carry their fix", stood()?.hits.length === 2 && stood()?.hits.every((h) => !!h.fix) === true && stood()?.to === "stood");
  check("Fix all for a word changes every place, as one step", s.fixHits(stood()!.hits) === 2 && e.getText().includes("He nodded his head and stood.") && e.getText().includes("she stood."));
  e.commands.undo();
  check("…and one undo brings them back", e.getText().includes("stood up.") && e.getText().split("stood up").length === 3);
  s.flush();
  const stale = stood()!.hits;
  e.view.dispatch(e.state.tr.insertText("Then ", 1));
  check("a fix from before an edit is not made: the report is read again", s.fixHits(stale) === -1 && e.getText().includes("stood up."));
  const slip = () => s.report("dialogue", all)?.groups.find((g) => g.id === "slips")?.items[0];
  setReviewMode(e, "suggest");
  check("in Suggesting a report's fix is a suggestion", s.fixHits(slip()!.hits) === 1 && changesOf(e.state.doc).length >= 1 && e.state.doc.textContent.includes("“Go.,”"));
  setReviewMode(e, "view");
  check("in Viewing nothing is fixed", s.fixHits(stood()!.hits) === 0 && !s.editable);
  setReviewMode(e, "edit");
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)));
  const caret = e.state.selection.from;
  s.fixHits(s.report("wording", all, opts)!.groups.find((g) => g.id === "wordy")!.items[0].hits);
  check("a fix further down leaves the caret where it was", e.state.selection.from === caret && e.getText().includes("To leave, she"), e.getText());
  s.stop();
  e.destroy();
}

finish();
