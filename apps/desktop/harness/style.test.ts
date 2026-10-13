// The reports' engine on plain text: a paragraph's sentences and words,
// what is told from the whole (names, chapters, words that come again too
// soon), and each report's numbers, charts and lists.

import { check, finish } from "./env";

import { Node as PmNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

import { contentSchema } from "../src/editor/schema/content";
import { CHECKS, defaultRules } from "../src/proof/checks";
import { readQuotes } from "../src/proof/engine/quotes";
import { Reader } from "../src/proof/engine/run";
import { tokenize } from "../src/proof/engine/tokens";
import { extract } from "../src/proof/extract";
import { analyse, styleOf, type StyleAnalysis } from "../src/proof/reports/analysis";
import { readingGrade } from "../src/proof/reports/build/overview";
import { buildReport, chapterRows, reportsFor } from "../src/proof/reports";
import { sentenceSpans } from "../src/proof/reports/sentences";
import { stem } from "../src/proof/reports/stem";
import { syllables } from "../src/proof/reports/syllables";
import type { HitGroup, ReportResult, Scope } from "../src/proof/reports/types";
import { Vocab } from "../src/proof/reports/vocab";
import type { BlockInput, Env, Scan } from "../src/proof/types";
import { manuscript } from "./manuscript";
import { PLAIN, storyText } from "./prose";

const EN: Env = { lang: "en-gb", base: "en", quotes: { open2: "“", close2: "”", open1: "‘", close1: "’", spaced: false }, format: "manuscript", highlights: false };
const block = (text: string, more: Partial<BlockInput> = {}): BlockInput => {
  const b = { text, role: "body", heading: null, element: null, list: null, cell: false, note: false, quoted: false, italic: [], highlight: [], link: [], ...more } as BlockInput;
  b.sig = [b.role, b.heading ?? "", b.cell, b.note, b.quoted, b.list ? "l" : ""].join("|");
  return b;
};
const scanOf = (blocks: BlockInput[]): Scan => ({ blocks, prev: new Int32Array(blocks.length).fill(-1), list: new Int32Array(blocks.length) });
const read = (blocks: BlockInput[], env: Env = EN): StyleAnalysis => {
  const scan = scanOf(blocks);
  const r = new Reader(env, CHECKS).readNow(scan, defaultRules(env));
  const vocab = new Vocab(env.base === "en");
  return analyse(
    scan,
    scan.blocks.map((_, i) => styleOf(scan, r.facts, i, vocab)),
    vocab,
    env,
  );
};
const paras = (...texts: string[]): BlockInput[] => texts.map((t) => block(t));
const story = (): BlockInput[] => storyText().map((p) => block(p.text, p.heading ? { role: "heading", heading: p.heading } : {}));
const ALL: Scope = { kind: "all" };
const none = new Set<string>();
const report = (a: StyleAnalysis, id: Parameters<typeof buildReport>[0], scope: Scope = ALL, allowed = none): ReportResult => buildReport(id, a, scope, allowed, chapterRows(a));
const group = (r: ReportResult, id: string): HitGroup | undefined => r.groups.find((g) => g.id === id);
const measure = (r: ReportResult, id: string) => r.summary.find((m) => m.id === id);
const textOf = (a: StyleAnalysis, hit: { block: number; start: number; end: number }) => a.scan.blocks[hit.block].text.slice(hit.start, hit.end);

// ----------------------------------------------------------------- words

{
  const same = (...words: string[]) => new Set(words.map(stem)).size === 1;
  check("a word and its forms share a stem", same("door", "doors", "door's") && same("walk", "walked", "walking", "walks") && same("quick", "quickly") && same("happy", "happily") && same("smile", "smiled", "smiling") && same("try", "tried", "tries") && same("stop", "stopped", "stopping") && same("box", "boxes"));
  check("…and different words do not", !same("door", "doom") && !same("this", "thi") && !same("glass", "glas", "gla"));
  const table: [string, number][] = [
    ["the", 1], ["harbour", 2], ["morning", 2], ["letter", 2], ["garden", 2], ["walked", 1], ["wanted", 2], ["table", 2], ["little", 2], ["make", 1], ["makes", 1], ["boxes", 2], ["places", 2], ["watches", 2],
    ["beautiful", 3], ["family", 3], ["remember", 3], ["suddenly", 3], ["afterwards", 3], ["understanding", 4], ["conversation", 4], ["nevertheless", 4], ["immediately", 5], ["possibility", 5],
    ["extraordinary", 5], ["usual", 3], ["actually", 4], ["nation", 2], ["period", 3], ["media", 3], ["theory", 3], ["curious", 3], ["serious", 3], ["quiet", 2], ["people", 2], ["fire", 1], ["hour", 1],
    ["played", 1], ["tried", 1], ["agree", 2], ["coffee", 2], ["tree", 1], ["apple", 2], ["clothes", 1], ["goes", 1], ["houses", 2], ["names", 1], ["times", 1], ["special", 2], ["delicious", 3],
    ["window", 2], ["silence", 2], ["lantern", 2], ["whisper", 2], ["shoulder", 2], ["evening", 2], ["beneath", 2], ["against", 2], ["between", 2], ["although", 2], ["perhaps", 2], ["considerable", 4],
    ["particularly", 5], ["circumstances", 4], ["acquaintance", 3], ["disappointment", 4], ["neighbourhood", 3], ["river", 2], ["water", 2], ["number", 2], ["could", 1], ["would", 1], ["their", 1], ["about", 2],
  ];
  const right = table.filter(([word, n]) => syllables(word) === n).length;
  const wrong = table.filter(([word, n]) => syllables(word) !== n).map(([word, n]) => `${word} ${syllables(word)}≠${n}`);
  check(`syllables are counted right for nine words in ten (${right} of ${table.length})`, right / table.length >= 0.9, wrong.join(", "));
  // "The cat sat on the mat." 6 words, 1 sentence, 6 syllables.
  check("the reading grade is the published formula", Math.abs(readingGrade(6, 1, 6) - Math.max(0, 0.39 * 6 + 11.8 - 15.59)) < 1e-9 && Math.abs(readingGrade(100, 5, 150) - (0.39 * 20 + 11.8 * 1.5 - 15.59)) < 1e-9);
}

// ------------------------------------------------------------- sentences

const lens = (text: string): string => {
  const tk = tokenize(text);
  const spans = sentenceSpans(text, tk, readQuotes(text, EN.quotes, true));
  const out: number[] = [];
  for (let s = 0; s < spans.length; s += 2) {
    let n = 0;
    for (let i = spans[s]; i < spans[s + 1]; i += 1) if (tk.kind[i] >= 1 && tk.kind[i] <= 3) n += 1;
    out.push(n);
  }
  return out.join();
};
{
  check("a full stop, a question mark and an exclamation mark end a sentence", lens("It rained. Was it late? Yes! They ran home.") === "2,3,1,3");
  check("Mr. and an initial do not", lens("Then Mr. Ashworth met J. K. Rowling at noon. Nobody spoke.") === "9,2", lens("Then Mr. Ashworth met J. K. Rowling at noon. Nobody spoke."));
  check("speech and its tag are one sentence", lens("“Stop!” she said. “Now.”") === "3,1", lens("“Stop!” she said. “Now.”"));
  check("…with a name in the tag too", lens("“Stop!” Marianne said. He stopped.") === "3,2", lens("“Stop!” Marianne said. He stopped."));
  check("…but a new sentence after speech is its own", lens("“Stop!” He ran to the door and locked it.") === "1,8", lens("“Stop!” He ran to the door and locked it."));
  check("a tag before speech is part of it", lens("She said, “Come here.”") === "4");
  check("a decimal and a file name end nothing", lens("It cost 3.50 in all. Open notes.txt now.") === "5,4", lens("It cost 3.50 in all. Open notes.txt now."));
  check("an ellipsis that runs on ends nothing", lens("He waited… and waited. Then he left.") === "4,3", lens("He waited… and waited. Then he left."));
  check("a sentence with no stop is still one", lens("And then nothing") === "3");
}

// ------------------------------------------------------- the whole, read

{
  const a = read(story());
  check("chapters are found by their headings", a.chapters.map((c) => c.name).join() === "The Letter,The Garden,The Answer,The Road");
  check("…and every block knows its chapter", a.chapterOf[0] === 0 && a.chapterOf[1] === 0 && a.chapterOf[a.scan.blocks.length - 1] === 3);
  const id = (word: string) => a.vocab.has(word);
  check("a word capitalised in mid-sentence is a name", a.name[id("marianne")] === 1 && a.name[id("ashworth")] === 1 && !a.name[id("letter")] && !a.name[id("she")]);
  check("words are counted, headings left out", a.total.words === a.rolls.reduce((n, r) => n + r.words, 0) && a.uses[id("letter")] === 5 && a.style[0].kind === 0, String(a.uses[id("letter")]));
  check("speech is the words inside quote marks", a.rolls[0].speech === 13, String(a.rolls[0].speech));
  check("this reads as fiction", a.fiction);
  const flat = read(paras(PLAIN, PLAIN.replace("Marianne", "Cecily")), { ...EN, format: "none" });
  check("a document with no headings is one chapter, and not fiction", flat.chapters.length === 1 && !flat.fiction);
  const doc = read([block("Before"), block("One", { role: "heading", heading: "h1" }), block("Text."), block("Sub", { role: "heading", heading: "h2" }), block("More."), block("Two", { role: "heading", heading: "h1" }), block("End.")], { ...EN, format: "none" });
  check("a Document's chapters are its highest heading used twice", doc.chapters.map((c) => c.name).join() === "Before the first chapter,One,Two");
}

// ------------------------------------------------------------- overview

{
  const a = read(story());
  const r = report(a, "overview");
  check("the overview counts words, sentences and paragraphs", measure(r, "words")?.value === a.total.words && measure(r, "sentences")?.value === a.total.sentences && measure(r, "paragraphs")?.value === 15, `${measure(r, "paragraphs")?.value}`);
  check("fiction is given no outside range for its sentences", measure(r, "sentence")?.guide === undefined && r.notes.some((n) => n.includes("Compare your chapters")));
  check("the headline is one plain line", /^\d+ words in \d+ sentences\.$/.test(r.headline), r.headline);
  const plain = report(read(paras(PLAIN, PLAIN), { ...EN, format: "none" }), "overview");
  const guide = measure(plain, "sentence")?.guide;
  check("writing that explains is set beside a published guide", !!guide && guide.lo === 15 && guide.hi === 20 && guide.source.includes("Plain English Campaign") && guide.state === (measure(plain, "sentence")!.value > 20 ? "above" : measure(plain, "sentence")!.value < 15 ? "below" : "in"));
  const one = report(a, "overview", { kind: "chapter", index: 1 });
  check("a report can cover one chapter", measure(one, "words")?.value === a.rolls[1].words && a.rolls[1].words < a.total.words);
  check("…or a run of paragraphs", measure(report(a, "overview", { kind: "blocks", from: 1, to: 2 }), "words")?.value === a.style[1].n);
  check("an empty text says so", report(read(paras("")), "overview").headline === "Nothing to count yet.");
}

// ------------------------------------------------------------ sentences

{
  const a = read(story());
  const r = report(a, "sentences");
  const starts = group(r, "start");
  check("sentences in a row that open with the same word", starts?.items.map((i) => i.label).join(" / ") === "She begins 4 sentences in a row / He begins 3 sentences in a row", starts?.items.map((i) => i.label).join(" / "));
  check("…each pointing at those first words", starts?.items[0].hits.map((hit) => textOf(a, hit)).join() === "She,She,She,She");
  check("runs of very short sentences are not claimed where there are four", !group(r, "short"));
  const long = group(r, "long");
  check("a long sentence is listed with its length", long?.items.length === 1 && long.items[0].label === "57 words" && textOf(a, long.items[0].hits[0]).startsWith("Every bed was ruled"), long?.items.map((i) => i.label).join());
  const strip = r.series.find((s) => s.id === "lengths");
  check("the chart has a bar a sentence, speech drawn lighter", strip?.values.length === a.total.sentences && strip.per === 1 && strip.light?.some((l) => l) === true && strip.at?.length === strip.values.length);
  const hist = r.series.find((s) => s.id === "histogram");
  check("the histogram's bars add up to the sentences", hist?.values.reduce((n, v) => n + v, 0) === a.total.sentences && hist?.labels?.length === 7);
  const openers = r.series.find((s) => s.id === "openers");
  check("how sentences begin is counted outside speech", !!openers && openers.labels?.[0] === "A name" && openers.values[1] >= 7 && openers.values.reduce((n, v) => n + v, 0) < a.total.sentences);
  check("the headline says the average and the spread", /^Sentences average [\d.]+ words and mostly run from \d+ to \d+\.$/.test(r.headline), r.headline);

  const paraRun = read(paras("The door opened slowly inward.", "The room beyond was dark and cold.", "The floor creaked under his careful weight.", "He waited."));
  check("paragraphs in a row that open with the same word", group(report(paraRun, "sentences"), "paragraphs")?.items[0].label === "The begins 3 paragraphs in a row");
  const even = read(paras("He walked along the narrow road alone. She waited beside the broken stone wall. They met where the two paths crossed. Nobody spoke about the letter that day. The wind came cold across the field. Then it rained."));
  check("five sentences all of a length", group(report(even, "sentences"), "even")?.items[0].label === "5 sentences in a row of 7 words", group(report(even, "sentences"), "even")?.items[0]?.label);
  const short = read(paras("He ran. She ran. They fell. It hurt. Nobody came. Then the long evening began and went on without them."));
  check("five very short sentences in a row", group(report(short, "sentences"), "short")?.items[0].label === "5 short sentences in a row");
  const spoken = read(paras("“She ran.” “She fell.” “She cried.” “She left.”", "She said, “No.” She said, “Never.”"));
  check("speech is left out of the patterns", !group(report(spoken, "sentences"), "start"));
  const broken = read([block("She came in."), block("She sat down."), block("A Heading", { role: "heading", heading: "chapter" }), block("She stood up.")]);
  check("a heading ends a run", !group(report(broken, "sentences"), "start"));
  const big = read(paras(Array.from({ length: 30 }, () => "The gulls argued over the quay again.").join(" ")));
  check("a long paragraph is listed", group(report(big, "sentences"), "paragraph")?.items[0].label === "210 words");
  const many = read(paras(Array.from({ length: 500 }, (_, i) => `Sentence number ${i} is here now.`).join(" ")));
  const wide = report(many, "sentences").series.find((s) => s.id === "lengths");
  check("a long text is drawn in no more than 120 bars", wide!.values.length <= 120 && wide!.per === 5 && wide!.label.includes("5 sentences a bar"));
}

// -------------------------------------------------------------- repeats

{
  const a = read(story());
  const r = report(a, "repeats");
  const close = group(r, "close");
  const item = (g: HitGroup | undefined, key: string) => g?.items.find((i) => i.key === key);
  check("the same word again within a few lines", item(close, "rope")?.count === 3 && item(close, "lantern")?.count === 3 && item(close, "rope")?.detail?.startsWith("3 times in") === true, close?.items.map((i) => `${i.key}:${i.count}`).join());
  check("…pointing at each use", item(close, "rope")?.hits.map((hit) => textOf(a, hit)).join() === "rope,rope,rope");
  check("a name is never a repeat, nor a small word", !item(close, "marianne") && !item(close, "ashworth") && !item(close, "that") && !item(close, "she"));
  check("a repeat does not cross from one chapter to the next", !close?.items.some((i) => new Set(i.hits.map((hit) => a.chapterOf[hit.block])).size > 1));
  const far = read(paras(`The lantern stood by the door. ${Array.from({ length: 8 }, () => "Nobody came and nothing was said for an hour.").join(" ")} A second light was lit.`, "The door stayed shut."));
  check("a word used again a long way on is not one", !item(group(report(far, "repeats"), "close"), "door") && !item(group(report(far, "repeats"), "close"), "light"));
  const forms = read(paras("She smiled at him and he smiled back, and the smiling went on."));
  check("forms of one word are the same word", item(group(report(forms, "repeats"), "close"), "smiled")?.count === 3);

  const phrases = group(r, "phrases");
  check("a phrase said again and again", item(phrases, "at the end of the day")?.count === 3 && phrases?.items.length === 1, phrases?.items.map((i) => `${i.key}:${i.count}`).join());
  check("…and not the shorter phrases inside it, nor its tail run on a word", !item(phrases, "end of the day") && !item(phrases, "end of the day he"));
  check("a phrase never crosses a comma or a full stop", !phrases?.items.some((i) => /[.,]/.test(i.key)));
  const most = group(r, "most");
  check("the words used most leave out names and small words", most!.items[0].count >= most!.items[1].count && !most!.items.some((i) => ["the", "she", "marianne", "said"].includes(i.key)) && !!item(most, "letter"), most?.items.slice(0, 6).map((i) => `${i.key}:${i.count}`).join());
  check("…with how often", item(most, "letter")?.detail?.includes("once every") === true);
  check("a word you have said is fine is left out everywhere", !item(group(report(a, "repeats", ALL, new Set(["rope", "letter"])), "close"), "rope") && !item(group(report(a, "repeats", ALL, new Set(["rope", "letter"])), "most"), "letter") && !item(group(report(a, "repeats", ALL, new Set(["at the end of the day"])), "phrases"), "at the end of the day"));
  const scoped = report(a, "repeats", { kind: "chapter", index: 2 });
  check("one chapter's repeats are its own", !!item(group(scoped, "close"), "lantern") && !item(group(scoped, "close"), "rope"));
  check("a quiet passage has nothing close by", !group(report(read(paras(PLAIN)), "repeats"), "close"), group(report(read(paras(PLAIN)), "repeats"), "close")?.items.map((i) => i.key).join());

  // A word one chapter leans on.
  const lean = (word: string) => Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? `The ${word} was mentioned once more in passing.` : "Nothing else of any note happened on that particular morning.")).join(" ");
  const book = read([block("One", { role: "heading", heading: "chapter" }), block(lean("lighthouse")), block("Two", { role: "heading", heading: "chapter" }), block(lean("orchard")), block("Three", { role: "heading", heading: "chapter" }), block(lean("orchard"))]);
  const spikes = group(report(book, "repeats"), "spikes");
  check("a word one chapter leans on", spikes?.items.some((i) => i.label === "lighthouse in One" && i.detail === "6 times here, nowhere else") === true && !spikes?.items.some((i) => i.key === "orchard"), spikes?.items.map((i) => `${i.label}|${i.detail}`).join(" / "));
}

// -------------------------------------------------------- chapter table

{
  const para = (sentences: number, said = 0) => Array.from({ length: sentences }, (_, i) => (i < said ? "“We should go before the weather turns,” she said quietly." : "The boats went out at first light and came back by noon.")).join(" ");
  const chapter = (name: string, ...text: string[]) => [block(name, { role: "heading", heading: "chapter" }), ...text.map((t) => block(t))];
  const book = read([
    ...chapter("One", para(30, 10), para(30, 10)),
    ...chapter("Two", para(30, 9), para(30, 11)),
    ...chapter("Three", para(30, 10), para(28, 10)),
    ...chapter("Four", para(32, 10), para(30, 9)),
    ...chapter("Five", para(30, 10), para(30, 10), para(30, 10), para(30, 10), para(30, 10), para(30, 10), para(30, 10), para(30, 10)),
    ...chapter("Six", para(30, 0), para(30, 0)),
    ...chapter("Seven", "A very short chapter."),
  ]);
  const rows = chapterRows(book);
  const row = (name: string) => rows.find((r) => r.name === name)!;
  check("a row a chapter, with its numbers", rows.length === 7 && row("One").words === book.rolls[0].words && Math.round(row("One").speech * 100) > 20 && row("One").sentence > 9);
  check("a chapter far longer than the rest is marked", row("Five").marks.some((m) => m.column === "words" && m.text.includes("far more")), JSON.stringify(row("Five").marks));
  check("a chapter with no speech where the rest have plenty is marked", row("Six").marks.some((m) => m.column === "speech" && m.text.startsWith("0% inside quote marks")), JSON.stringify(row("Six").marks));
  check("chapters like the others are not", row("One").marks.length === 0 && row("Two").marks.length === 0);
  check("a chapter too short to judge is not", row("Seven").marks.length === 0);
  check("the table's line says how many stand apart", report(book, "chapters").headline === "7 chapters. 2 stand apart from the rest.", report(book, "chapters").headline);
  check("with few chapters nothing is marked", chapterRows(read(story())).every((r) => r.marks.length === 0));
}

// ------------------------------------------------------ what is read

{
  check("reports are for prose", reportsFor("manuscript") && reportsFor("none") && !reportsFor("poetry") && !reportsFor("screenplay"));
  const a = read([block("A Heading", { role: "heading", heading: "chapter" }), block("A line of verse here", { role: "verse" }), block("A note down below.", { note: true }), block("An item in a list.", { list: { kind: "bullet", depth: 1, part: "only" } }), block("Old words from an old book.", { role: "extract", quoted: true }), block("Plain prose at last.")]);
  check("headings, verse and notes are not read", a.style[0].kind === 0 && a.style[1].kind === 0 && a.style[2].kind === 0);
  check("a list item's words count and its sentences do not", a.style[3].kind === 1 && a.style[3].n === 5 && a.style[3].sWords.length === 0);
  check("someone else's words are voice, like speech", a.style[4].speech === a.style[4].n && a.total.sentences === 1);
}

// --------------------------------------------------------- a whole book

{
  const schema = contentSchema();
  const pm = PmNode.fromJSON(schema, manuscript({ chapters: 115 }));
  const reader = new Reader(EN, CHECKS);
  const vocab = new Vocab(true);
  const timed = (doc: PmNode) => {
    const { scan } = extract(doc, "manuscript");
    const r = reader.readNow(scan, defaultRules(EN));
    const t0 = performance.now();
    const a = analyse(
      scan,
      scan.blocks.map((_, i) => styleOf(scan, r.facts, i, vocab)),
      vocab,
      EN,
    );
    return { a, ms: performance.now() - t0 };
  };
  const cold = timed(pm);
  check(`a book of ${cold.a.total.words.toLocaleString("en-US")} words is read for its style in under 600 ms (${Math.round(cold.ms)} ms)`, cold.a.total.words > 100_000 && cold.ms < 600);
  const best = (fn: () => void) => Math.min(...[0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }));
  const rows = chapterRows(cold.a);
  const first = best(() => void buildReport("sentences", cold.a, ALL, none, rows));
  check(`a report opens in under 60 ms (${Math.round(first)} ms)`, first < 60);
  const phrasesMs = best(() => void buildReport("repeats", cold.a, ALL, none, rows));
  check(`the repeats, phrases and all, in under 400 ms (${Math.round(phrasesMs)} ms)`, phrasesMs < 400);
  let typed = pm;
  let warm = Infinity;
  for (let k = 0; k < 3; k += 1) {
    typed = new Transform(typed).insert(typed.content.size - 3, schema.text(" More")).doc;
    warm = Math.min(warm, timed(typed).ms);
  }
  check(`after one edit the whole is told again in under 60 ms (${Math.round(warm)} ms)`, warm < 60);
  check("a 100,000-word book has many chapters and they are all rows", chapterRows(cold.a).length > 100);
}

finish();
