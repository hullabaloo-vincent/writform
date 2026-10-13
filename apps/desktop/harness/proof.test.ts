// The checker's engine on plain text: how a paragraph is cut into words,
// which quote marks open and close, where sentences begin, and what each
// of the first checks finds and (as much to the point) leaves alone.

import { check, finish } from "./env";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { Node as PmNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

import { contentSchema } from "../src/editor/schema/content";
import { extract } from "../src/proof/extract";
import { manuscript } from "./manuscript";

import { CHECKS, defaultRules } from "../src/proof/checks";
import { cyrb53 } from "../src/proof/engine/hash";
import { placeKey } from "../src/proof/engine/place";
import { readQuotes } from "../src/proof/engine/quotes";
import { Reader } from "../src/proof/engine/run";
import { markSentences } from "../src/proof/engine/sentences";
import { ALNUM, F_CAP, F_JOINED, F_START, F_UNSURE, F_UPPER, NUMBER, OBJECT, PUNCT, tokenize, WORD } from "../src/proof/engine/tokens";
import type { BlockInput, Env, Issue, Scan } from "../src/proof/types";

const EN: Env = { lang: "en-gb", base: "en", quotes: { open2: "“", close2: "”", open1: "‘", close1: "’", spaced: false }, format: "manuscript", highlights: false };
const DE: Env = { ...EN, lang: "de", base: "de", quotes: { open2: "„", close2: "“", open1: "‚", close1: "‘", spaced: false } };
const FR: Env = { ...EN, lang: "fr", base: "fr", quotes: { open2: "«", close2: "»", open1: "‹", close1: "›", spaced: true } };

const block = (text: string, more: Partial<BlockInput> = {}): BlockInput => {
  const b = { text, role: "body", heading: null, element: null, list: null, cell: false, note: false, quoted: false, italic: [], highlight: [], link: [], ...more } as BlockInput;
  b.sig = [b.role, b.heading ?? "", b.element ?? "", b.cell, b.note, b.quoted, b.italic.join(","), b.highlight.join(",")].join("|");
  return b;
};
/** Paragraphs one after another in one container. */
const scanOf = (blocks: (string | BlockInput)[]): Scan => {
  const list = blocks.map((b) => (typeof b === "string" ? block(b) : b));
  return { blocks: list, prev: Int32Array.from(list.map((b, i) => (i > 0 && b.role !== "heading" && list[i - 1].role !== "heading" ? i - 1 : -1))), list: new Int32Array(list.length) };
};
const read = (blocks: (string | BlockInput)[], env: Env = EN): Issue[] => new Reader(env, CHECKS).readNow(scanOf(blocks), defaultRules(env)).analysis.issues;
const found = (issues: Issue[], id: string): Issue | undefined => issues.find((i) => i.id === id);
const texts = (issues: Issue[], id: string, blocks: (string | BlockInput)[]): string[] =>
  (found(issues, id)?.places ?? []).map((p) => {
    const b = blocks[p.block];
    return (typeof b === "string" ? b : b.text).slice(p.start, p.end);
  });
/** The text with an issue's fixes made (every place, or the places of one form). */
const fixed = (blocks: string[], issues: Issue[], id: string, form = ""): string[] => {
  const out = [...blocks];
  const places = [...(found(issues, id)?.places ?? [])].sort((a, b) => b.block - a.block || b.start - a.start);
  for (const p of places) {
    const fix = p.fixes?.[form];
    if (!fix || "mark" in fix) continue;
    for (const e of [...fix.edits].sort((a, b) => b.start - a.start)) out[p.block] = out[p.block].slice(0, e.start) + e.text + out[p.block].slice(e.end);
  }
  return out;
};

// ------------------------------------------------------------------ tokens

{
  const text = "Don’t stop—the well-known 3.5 kg, 1,000 of them, on the 10th at A4.";
  const tk = tokenize(text);
  const words = [...Array(tk.n).keys()].filter((i) => tk.kind[i] === WORD).map((i) => text.slice(tk.start[i], tk.end[i]));
  check("a word keeps the apostrophe inside it", words[0] === "Don’t");
  check("a hyphenated word is two words and a joined hyphen", words.includes("well") && words.includes("known") && [...Array(tk.n).keys()].some((i) => tk.kind[i] === PUNCT && text[tk.start[i]] === "-" && tk.flag[i] & F_JOINED));
  const numbers = [...Array(tk.n).keys()].filter((i) => tk.kind[i] === NUMBER).map((i) => text.slice(tk.start[i], tk.end[i]));
  check("a number keeps its point and its comma", numbers.join(" ") === "3.5 1,000", numbers.join(" "));
  const mixed = [...Array(tk.n).keys()].filter((i) => tk.kind[i] === ALNUM).map((i) => text.slice(tk.start[i], tk.end[i]));
  check("letters with digits are their own kind", mixed.join(" ") === "10th A4", mixed.join(" "));
  check("a dash between words is not joined", [...Array(tk.n).keys()].some((i) => text[tk.start[i]] === "—" && !(tk.flag[i] & F_JOINED)));
  check("every character is in exactly one token", [...Array(tk.n).keys()].every((i) => (i === 0 ? tk.start[i] === 0 : tk.start[i] === tk.end[i - 1])) && tk.end[tk.n - 1] === text.length);
}
{
  const text = "See https://example.com/a.b?c=1, or write to me@example.org. NASA said so.";
  const tk = tokenize(text);
  const objects = [...Array(tk.n).keys()].filter((i) => tk.kind[i] === OBJECT).map((i) => text.slice(tk.start[i], tk.end[i]));
  check("an address is one thing, without the stop that ends the sentence", objects.join(" ") === "https://example.com/a.b?c=1 me@example.org", objects.join(" "));
  const nasa = [...Array(tk.n).keys()].find((i) => text.slice(tk.start[i], tk.end[i]) === "NASA") as number;
  check("capitals are noted", (tk.flag[nasa] & F_UPPER) !== 0 && (tk.flag[nasa] & F_CAP) !== 0);
}

// ------------------------------------------------------------------ quotes

const roles = (text: string, env: Env = EN) => readQuotes(text, env.quotes, env.base === "en").marks.map((m) => m.role[0]).join("");
{
  check("curly marks open and close", roles("“Go,” she said. “Now.”") === "ococ");
  check("straight marks are told by what stands beside them", roles('"Go," she said. "Now."') === "ococ");
  check("an apostrophe inside a word is no quote mark", roles("Don’t. It's the dog’s.") === "aaa");
  check("a quotation inside speech", roles("“He said ‘no’ to me,” she said.") === "oocc", roles("“He said ‘no’ to me,” she said."));
  check("…in straight marks", roles("\"He said 'no' to me,\" she said.") === "oocc", roles("\"He said 'no' to me,\" she said."));
  check("’tis and ’em are apostrophes", roles("“’Tis late. Tell ’em,” he said.") === "oaac" || roles("“’Tis late. Tell ’em,” he said.") === "ooac", roles("“’Tis late. Tell ’em,” he said."));
  check("a year cut short is an apostrophe", roles("Back in the ’90s it rained.") === "a");
  check("feet and inches are neither", roles("He was 6' 2\" tall.") === "pp", roles("He was 6' 2\" tall."));
  check("…but a number can end a quotation", roles('"Turn to chapter 6" was all it said.') === "oc");
  check("a possessive after an s, with single marks for speech", roles("‘Where are the dogs’ bowls?’ she asked.") === "oac", roles("‘Where are the dogs’ bowls?’ she asked."));
  check("in German “ closes", roles("„Komm“, sagte sie.", DE) === "oc");
  check("…and English marks in a German text still pair", roles("“Komm”, sagte sie.", DE) === "oc", roles("“Komm”, sagte sie.", DE));
  check("guillemets pointing inward (German books)", roles("»Komm«, sagte sie.", DE) === "oc", roles("»Komm«, sagte sie.", DE));
  check("French guillemets", roles("« Viens », dit-elle.", FR) === "oc", roles("« Viens », dit-elle.", FR));
  const q = readQuotes("“It ran on and on.", EN.quotes, true);
  check("a paragraph that ends inside a quotation says so", q.open.length === 1 && q.opens === 2 && q.spans[0].close === -1);
  const s = readQuotes("That was all.” He left.", EN.quotes, true);
  check("a closing mark with nothing open is stray", s.stray.length === 1 && s.opens === 0);
}

// --------------------------------------------------------------- sentences

const starts = (text: string): string => {
  const tk = tokenize(text);
  const q = readQuotes(text, EN.quotes, true);
  markSentences(text, tk, q);
  return [...Array(tk.n).keys()]
    .filter((i) => tk.flag[i] & (F_START | F_UNSURE))
    .map((i) => text.slice(tk.start[i], tk.end[i]) + (tk.flag[i] & F_UNSURE ? "?" : ""))
    .join(" ");
};
{
  check("after a full stop, a question mark, an exclamation mark", starts("It rained. Was it late? Yes! They ran.") === "It Was Yes They", starts("It rained. Was it late? Yes! They ran."));
  check("not after Mr. or an initial: those are left in doubt", starts("Then Mr. Ashworth met J. K. Rowling. Nobody spoke.") === "Then K? Rowling? Nobody", starts("Then Mr. Ashworth met J. K. Rowling. Nobody spoke."));
  check("a lowercase word after a stop is no new sentence", starts("He ate apples, pears etc. and left. Good.") === "He Good", starts("He ate apples, pears etc. and left. Good."));
  check("a tag after speech is not a sentence", starts("“Stop!” she said. “Now.”") === "Stop Now", starts("“Stop!” she said. “Now.”"));
  check("speech opens one even after a comma", starts("She said, “Come here.”") === "She Come");
  check("no sentence ends inside a.m. or a file name", starts("Open notes.txt at 9 a.m. today.") === "Open", starts("Open notes.txt at 9 a.m. today."));
  check("after a colon, in case", starts("Three things: Apples and pears.") === "Three Apples");
  check("a line break begins again", starts("Roses are red\nViolets are blue") === "Roses Violets");
}

// -------------------------------------------------------------- place keys

{
  check("the hash is the one it has always been", cyrb53("a") === 7929297801672961 && cyrb53("short term") === cyrb53("short term") && cyrb53("") === 3338908027751811, `${cyrb53("a")} ${cyrb53("")}`);
  const a = "Then it was the the end of a long day.";
  const b = "Well. And then it was the the end of a long day, he thought.";
  const c = "Then it was the the start of a long day.";
  const key = (text: string, at: number) => placeKey("doubled", "the", text, tokenize(text), at, at + 7);
  check("a place is known by its words and their neighbours", key(a, a.indexOf("the the")) === key(b, b.indexOf("the the")));
  check("…so it lapses when a neighbour changes", key(a, a.indexOf("the the")) !== key(c, c.indexOf("the the")));
  check("…and curly or straight marks make no difference", placeKey("x", "k", "“Don’t,” he said", tokenize("“Don’t,” he said"), 1, 6) === placeKey("x", "k", "\"Don't,\" he said", tokenize("\"Don't,\" he said"), 1, 6));
  check("the keys are the ones they have always been", key(a, a.indexOf("the the")) === "9g01d26yqy", key(a, a.indexOf("the the")));
}

// ----------------------------------------------------------- doubled words

{
  const text = ["It was the the end. She had had enough of that that day.", "“No no,” he said. “It is is true, bye bye.”", "They saw Duran Duran. The the band played.", "Very very late, and so on on."];
  const issues = read(text);
  check("the the is found", texts(issues, "doubled:the", text).join("|") === "the the|The the", texts(issues, "doubled:the", text).join("|"));
  check("had had and that that are left alone", !found(issues, "doubled:had") && !found(issues, "doubled:that"));
  check("in speech only the small words count", !!found(issues, "doubled:is") && !found(issues, "doubled:no") && !found(issues, "doubled:bye"));
  check("a name said twice is a name", !found(issues, "doubled:duran"));
  check("on on is found", !!found(issues, "doubled:on"));
  check("the fix takes one of them away", fixed(text, issues, "doubled:the")[0].startsWith("It was the end.") && fixed(text, issues, "doubled:the")[2].endsWith("The band played."));
  check("three in a row are two places that do not overlap", texts(read(["the the the end"]), "doubled:the", ["the the the end"]).length === 2 && fixed(["the the the end"], read(["the the the end"]), "doubled:the")[0] === "the end");
}

// ------------------------------------------------------------ stray spaces

{
  const text = ["Two  spaces here , and here .", "A trailing space ", "Inside ( brackets ) and word,word.", "An ellipsis ... is fine, so is notes .txt and a smiley :) here.", "What ?! Really ?"];
  const issues = read(text);
  check("two spaces", texts(issues, "spaces:double", text).length === 1);
  check("a space before a comma and a full stop", texts(issues, "spaces:before", text).length === 4, String(texts(issues, "spaces:before", text).length));
  check("a space at the end", texts(issues, "spaces:end", text).length === 1);
  check("spaces inside brackets", texts(issues, "spaces:inside", text).length === 2);
  check("no space after a comma", (found(issues, "spaces:missing")?.places.length ?? 0) === 1);
  const all = ["double", "before", "end", "inside", "missing"].reduce((t, id) => fixed(t, read(t), `spaces:${id}`), text);
  check("the fixes tidy them", all[0] === "Two spaces here, and here." && all[1] === "A trailing space" && all[2] === "Inside (brackets) and word, word." && all[4] === "What?! Really?", JSON.stringify(all));
  check("an ellipsis, a file ending and a smiley are left alone", all[3] === text[3]);
  check("French spacing before ! and ? is right in French", !found(read(["Quoi ? Non !"], FR), "spaces:before") && !!found(read(["Quoi , non"], FR), "spaces:before"));
  check("a poem's spacing is its own", !found(read([block("so   much   depends", { role: "verse" })]), "spaces:double"));
  check("a clean paragraph says nothing", read(["It was late. She went home, and that was that."]).length === 0);
}

// ----------------------------------------------- opened and never closed

{
  const speech = ["“It began years ago,” she said. “We were young.", "“Nobody knew what would come of it.", "“And then it ended.”", "He nodded."];
  check("a speech over three paragraphs closes only the last", !found(read(speech), "openPairs:quote.open"));
  const broken = ["“It began years ago, she said.", "He nodded."];
  check("a paragraph left open is found", texts(read(broken), "openPairs:quote.open", broken).join("") === "“");
  const heading = ["“It began years ago.", block("Chapter Two", { role: "heading", heading: "chapter" }), "“And then it ended.”"];
  check("…and a heading ends the run", (found(read(heading), "openPairs:quote.open")?.places.length ?? 0) === 1);
  check("a closing mark with nothing open", (found(read(["That was all.” He left."]), "openPairs:quote.close")?.places.length ?? 0) === 1);
  const br = ["He left (it was late and never said why.", "a) first, b) second, and 1) third.", "A smile :) and a frown :-( and done.", "Too many) here."];
  const issues = read(br);
  check("a bracket left open", texts(issues, "openPairs:bracket.open", br).join("") === "(");
  check("a closing bracket with nothing open", (found(issues, "openPairs:bracket.close")?.places ?? []).every((p) => p.block === 3) && found(issues, "openPairs:bracket.close")?.places.length === 1);
  check("list labels and smileys are left alone", !(found(issues, "openPairs:bracket.close")?.places ?? []).some((p) => p.block === 1 || p.block === 2));
  check("an apostrophe is never an open quote", !found(read(["The dogs’ bowls and the ’90s and ’tis so."]), "openPairs:quote.open"));
  const single = ["‘It began years ago,’ she said. ‘We were young.’", "‘Nobody knew, he said.", "He nodded."];
  check("single marks are weighed where they are how speech is written", (found(read(single), "openPairs:quote.open")?.places.length ?? 0) === 1);
  check("…and nowhere else", !found(read(["“Go,” she said.", "It was called ‘the Beast and nobody asked."]), "openPairs:quote.open"));
}

// ------------------------------------------------------ straight and curly

{
  const text = ["“Go,” she said. “Don’t wait.”", "\"Stay,\" he said. It's 6' 2\" tall."];
  const issues = read(text);
  const dbl = found(issues, "quoteShape:double");
  check("straight and curly marks both used", !!dbl && dbl.forms.map((f) => `${f.id}${f.count}`).join() === "curly4,straight2", dbl?.forms.map((f) => `${f.id}${f.count}`).join());
  check("the commoner kind is taken to be meant", dbl?.preferred === "curly" && dbl.preferredFrom === "majority");
  check("made curly, each mark faces the right way", fixed(text, issues, "quoteShape:double", "curly")[1] === "“Stay,” he said. It's 6' 2\" tall.", fixed(text, issues, "quoteShape:double", "curly")[1]);
  check("made straight", fixed(text, issues, "quoteShape:double", "straight")[0] === "\"Go,\" she said. \"Don’t wait.\"");
  check("apostrophes are weighed apart, and inches are not counted", found(issues, "quoteShape:single")?.forms.map((f) => `${f.id}${f.count}`).join() === "curly1,straight1");
  check("…and made curly", fixed(text, issues, "quoteShape:single", "curly")[1].includes("It’s 6' 2\""));
  check("one kind throughout says nothing", !read(["“Go,” she said. “Don’t.”"]).length);
  check("an even split names no winner", found(read(["“Go,” she said.", '"Stay," he said.']), "quoteShape:double")?.preferred === null);
}

// ------------------------------------------------- double or single speech

{
  const text = ["“It’s late,” she said. “He called it ‘the Beast’ once.”", "‘I know,’ he said.", "It was what they called ‘progress’.", "‘The dogs’ bowls are empty,’ she said."];
  const issues = read(text);
  const sp = found(issues, "speechQuotes:speech");
  check("speech marked both ways", sp?.forms.map((f) => `${f.id}${f.count}`).join() === "double2,single2", sp?.forms.map((f) => `${f.id}${f.count}`).join());
  check("a word or two in marks is not speech", !(sp?.places ?? []).some((p) => p.block === 2));
  const single = fixed(text, issues, "speechQuotes:speech", "single");
  check("made single, the quotation inside turns the other way", single[0] === "‘It’s late,’ she said. ‘He called it “the Beast” once.’", single[0]);
  check("made double", fixed(text, issues, "speechQuotes:speech", "double")[1] === "“I know,” he said.");
  check("no fix where an apostrophe could be a mark", !sp?.places.find((p) => p.block === 3)?.fixes);
  check("not weighed in a script", !found(read(text, { ...EN, format: "screenplay" }), "speechQuotes:speech"));
}

// --------------------------------------------------------------- leftovers

{
  const text = ["The ship was called TK and sailed on XXX. See TODO below ???", "She said [check the date] and “I [sic] saw it [he] said” and left [12].", "It was [CHAPTER BREAK] here. Lorem ipsum dolor.", block("Marked for later", { highlight: [0, 6] })];
  const env = { ...EN, format: "none", highlights: true };
  const issues = read(text, env);
  check("TK, XXX, TODO and ???", texts(issues, "leftovers:placeholder", text).join("|") === "TK|XXX|TODO|???|Lorem ipsum", texts(issues, "leftovers:placeholder", text).join("|"));
  check("notes in square brackets", texts(issues, "leftovers:bracket", text).join("|") === "[check the date]|[CHAPTER BREAK]", texts(issues, "leftovers:bracket", text).join("|"));
  check("highlighting, where it can be seen", texts(issues, "leftovers:highlight", text).join("") === "Marked" && !found(read(text, EN), "leftovers:highlight"));
  check("taking the highlight off is a change of formatting", JSON.stringify(found(issues, "leftovers:highlight")?.places[0].fixes?.[""]) === JSON.stringify({ mark: "highlight", add: false, start: 0, end: 6 }));
}

// ------------------------------------------------------- reading and cost

{
  const reader = new Reader(EN, CHECKS);
  const rules = defaultRules(EN);
  const paras = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} was the the same as the rest, more or less.`);
  reader.readNow(scanOf(paras), rules);
  check("a first reading reads every block", reader.made === 400);
  const edited = [...paras];
  edited[200] = "Paragraph 200 was changed.";
  const again = reader.readNow(scanOf(edited), rules);
  check("after one edit only that block is read again, though every block is a new object", reader.made === 1, String(reader.made));
  check("…and its finding is gone", found(again.analysis.issues, "doubled:the")?.places.length === 399);
  const job = reader.read(scanOf(paras.map((p) => `${p} More.`)), rules);
  let turns = 0;
  while (!job.step(0)) turns += 1;
  check("a reading can be done in turns", turns > 1 && job.progress() === 1 && !!job.result());
  check("checks with nothing to say are named", again.analysis.quiet.includes("openPairs") && !again.analysis.quiet.includes("doubled"));
}

// ------------------------------------------------------- a whole book

{
  const schema = contentSchema();
  const book = PmNode.fromJSON(schema, manuscript({ chapters: 115 }));
  const reader = new Reader(EN, CHECKS);
  const rules = defaultRules(EN);
  const timed = (doc: PmNode) => {
    const t0 = performance.now();
    const read = reader.readNow(extract(doc, "manuscript").scan, rules);
    return { ms: performance.now() - t0, read };
  };
  const cold = timed(book);
  check(`a book of ${cold.read.analysis.words.toLocaleString("en-US")} words is read in under a second (${Math.round(cold.ms)} ms)`, cold.read.analysis.words > 100_000 && cold.ms < 1000);
  // One paragraph typed in: every other node is the same object as before.
  // (The best of three: a pause to collect garbage is not the checker's time.)
  let typed = book;
  let warm = { ms: Infinity, read: cold.read };
  let again = 0;
  for (let k = 0; k < 3; k += 1) {
    // (An ordinary word. A new name would have every paragraph asked about it once.)
    typed = new Transform(typed).insert(typed.content.size - 3, schema.text(" more")).doc;
    const one = timed(typed);
    again = Math.max(again, reader.made);
    warm = one.ms < warm.ms ? one : { ms: warm.ms, read: one.read };
  }
  check(`after one edit, in under 60 ms (${Math.round(warm.ms)} ms, ${again} read again)`, warm.ms < 60 && again === 1);
  // An undo or a co-writer's change: the same words, every node made anew.
  const anew = PmNode.fromJSON(schema, typed.toJSON());
  const replaced = timed(anew);
  check(`after every node is made anew, in under 150 ms (${Math.round(replaced.ms)} ms, ${reader.made} read again)`, replaced.ms < 150 && reader.made === 0);
  check("…with the same findings", JSON.stringify(replaced.read.analysis.issues.map((i) => [i.id, i.places.length])) === JSON.stringify(warm.read.analysis.issues.map((i) => [i.id, i.places.length])));
}

// ----------------------------------------------- what the engine may use

{
  const root = resolve(process.cwd(), "src/proof");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : /\.tsx?$/.test(name) ? [join(dir, name)] : []));
  const all = walk(root);
  const pure = all.filter((f) => /^(engine|checks|data|reports)\//.test(relative(root, f)) || relative(root, f) === "types.ts");
  const outside: string[] = [];
  for (const file of pure) {
    for (const m of readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)) {
      const to = m[1].startsWith(".") ? relative(root, resolve(file, "..", m[1])) : m[1];
      if (!/^(engine|checks|data|reports)(\/|$)|^types$/.test(to)) outside.push(`${relative(root, file)} -> ${m[1]}`);
    }
  }
  check("the engine, the checks, the reports and the word lists import nothing but each other", pure.length > 30 && outside.length === 0, outside.join(", "));
  // The app runs on Safari 15.
  const TOO_NEW = ["(?<=", "(?<!", ".at(", "findLast", "toSorted", "structuredClone", "Object.hasOwn", "replaceAll("];
  const used = all.flatMap((file) => TOO_NEW.filter((what) => readFileSync(file, "utf8").includes(what)).map((what) => `${relative(root, file)}: ${what}`));
  check("nothing in the checker needs a newer browser than Safari 15", used.length === 0, used.join(", "));
}

finish();
