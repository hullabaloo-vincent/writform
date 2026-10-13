// The checks of capitals, names, italics, the serial comma, lists and
// abbreviations: what each finds, and the look-alikes it leaves alone.

import { check, finish } from "./env";

import { Node as PmNode } from "@tiptap/pm/model";

import { findInDoc, replacementFor } from "../src/apps/documents/find/findInDoc";
import { contentSchema } from "../src/editor/schema/content";
import { CHECKS } from "../src/proof/checks";
import { alike, distance } from "../src/proof/checks/names";
import { Reader } from "../src/proof/engine/run";
import { abbreviationsText, changesText, notesText, termsText } from "../src/proof/handover";
import { effective } from "../src/proof/rules/layer";
import { emptyLayer, type Layer } from "../src/proof/rules/model";
import type { BlockInput, Env, Issue, Scan } from "../src/proof/types";
import { PLAIN, storyText } from "./prose";

const EN: Env = { lang: "en-gb", base: "en", quotes: { open2: "“", close2: "”", open1: "‘", close1: "’", spaced: false }, format: "none", highlights: false };
const block = (text: string, more: Partial<BlockInput> = {}): BlockInput => {
  const b = { text, role: "body", heading: null, element: null, list: null, cell: false, note: false, quoted: false, italic: [], highlight: [], link: [], ...more } as BlockInput;
  b.sig = [b.role, b.heading ?? "", b.list ? "l" : "", b.italic.join(",")].join("|");
  return b;
};
const scanOf = (blocks: (string | BlockInput)[], lists: number[] = []): Scan => {
  const all = blocks.map((b) => (typeof b === "string" ? block(b) : b));
  return { blocks: all, prev: new Int32Array(all.length).fill(-1), list: Int32Array.from(all.map((_, i) => lists[i] ?? 0)) };
};
const style = (settings: Layer["settings"] = {}, on: Layer["on"] = {}, env: Env = EN) => effective(env, { ...emptyLayer(), settings, on }, emptyLayer());
const read = (blocks: (string | BlockInput)[], rules = style(), env: Env = EN, lists: number[] = []): Issue[] => new Reader(env, CHECKS).readNow(scanOf(blocks, lists), rules).analysis.issues;
const found = (issues: Issue[], id: string): Issue | undefined => issues.find((i) => i.id === id);
const ids = (issues: Issue[], check: string): string => issues.filter((i) => i.check === check).map((i) => i.key).join("|");
const forms = (issue: Issue | undefined): string => (issue?.forms ?? []).map((f) => `${f.id}${f.count}`).join();
const textOf = (blocks: (string | BlockInput)[], b: number) => {
  const x = blocks[b];
  return typeof x === "string" ? x : x.text;
};
const texts = (issue: Issue | undefined, blocks: (string | BlockInput)[]): string => (issue?.places ?? []).map((p) => textOf(blocks, p.block).slice(p.start, p.end)).join("|");
const fixed = (blocks: string[], issue: Issue | undefined, form = ""): string[] => {
  const out = [...blocks];
  for (const p of [...(issue?.places ?? [])].sort((a, b) => b.block - a.block || b.start - a.start)) {
    const fix = p.fixes?.[form];
    if (!fix || "mark" in fix) continue;
    for (const e of [...fix.edits].sort((a, b) => b.start - a.start)) out[p.block] = out[p.block].slice(0, e.start) + e.text + out[p.block].slice(e.end);
  }
  return out;
};

// ---------------------------------------------------------------- capitals

{
  const text = ["They met the President at noon. Later the president left.", "My mum was there. “Yes, Mum,” I said. Mum said so. President Lincoln spoke, and the President listened.", "Will came in May. He will rose early. The Internet was down, and the internet stayed down."];
  const issues = read(text);
  check("a word with a capital in some places and without in others", forms(found(issues, "caps:president:D")) === "capital2,lower1", `${ids(issues, "caps")} ${forms(found(issues, "caps:president:D"))}`);
  check("President Lincoln is a name and no evidence", !texts(found(issues, "caps:president:D"), text).includes("Lincoln") && found(issues, "caps:president:D")?.places.length === 3);
  check("my mum and “Yes, Mum,” are each right: not weighed against each other", !ids(issues, "caps").includes("mum"));
  check("a word that is also a name is never weighed (Will, May, rose)", !ids(issues, "caps").includes("will") && !ids(issues, "caps").includes("may") && !ids(issues, "caps").includes("rose"));
  check("(the Internet and the internet)", forms(found(issues, "caps:internet:D")) === "capital1,lower1", ids(issues, "caps"));
  check("the fix changes one letter", fixed(text, found(issues, "caps:internet:D"), "lower")[2].includes("The internet was down") && fixed(text, found(issues, "caps:president:D"), "capital")[0].endsWith("Later the President left."));
  check("the first word of a sentence says nothing", !ids(read(["The harbour was calm. Harbour lights shone on the harbour."]), "caps"));
}

// ---------------------------------------------------------------- headings

{
  const h = (text: string, kind = "chapter") => block(text, { role: "heading", heading: kind });
  const text = [h("The Long Road Home"), "Text.", h("A letter from the harbour"), "Text.", h("The Quiet Garden Wall"), "Text.", h("Epilogue"), h("Notes on the Text", "h2"), h("ON THE ROAD")];
  const issues = read(text);
  check("headings of one kind capitalised in more than one way", forms(found(issues, "headings:chapter")) === "title2,sentence1,upper1", forms(found(issues, "headings:chapter")));
  check("a heading of one word says nothing, and another kind is its own", found(issues, "headings:chapter")?.places.length === 4 && !found(issues, "headings:h2"));
  check("headings all one way say nothing", !ids(read([h("The Long Road Home"), h("The Quiet Garden Wall")]), "headings"));
  check("a name in a sentence-case heading does not make it a title", !ids(read([h("A letter from Marianne to her father"), h("The road north to the harbour")]), "headings"));
}

// ------------------------------------------------------------------- names

{
  check("how far two words are apart", distance("katherine", "katharine", 3) === 1 && distance("jon", "john", 3) === 1 && distance("marianne", "thaddeus", 3) > 3 && distance("ab", "ba", 3) === 1);
  check("names near enough to be one name", alike("katherine", "kathryn") && alike("katherine", "katharine") && alike("jon", "john") && alike("ann", "anne") && alike("catherine", "katherine") && alike("stephen", "steven") === false);
  check("…and names that are not", !alike("marie", "thaddeus") && !alike("anna", "ella") && !alike("tom", "tim") && !alike("marianne", "marianne"));
  const one = ["When Katherine came in, nobody spoke.", "They asked Katherine to sit. Later Katherine left.", "It was Kathryn who had the letter, and Kathryn's hand shook."];
  const issues = read(one);
  const pair = found(issues, "names:katherine|kathryn");
  check("a name spelled two ways", forms(pair) === "katherine3,kathryn2" && pair?.detail.startsWith("Katherine 3 times, Kathryn twice.") === true, `${ids(issues, "names")} ${forms(pair)}`);
  check("…made one, the possessive kept", fixed(one, pair, "katherine")[2] === "It was Katherine who had the letter, and Katherine's hand shook.");
  const two = ["Marie and Maria sat down together.", "Then Marie spoke and Maria listened.", "Maria left before Marie did."];
  check("two names that keep turning up together are two people", !ids(read(two), "names"));
  check("an ordinary word is not a name", !ids(read(["The harbour was calm.", "A harbor of sorts, they said, near the Harbour Inn."]), "names").includes("harbour"));
  check("a name at the head of a sentence is still one of its uses", texts(pair, one).split("|").length === 5);
}

// ------------------------------------------------------------------ italics

{
  const it = (text: string, phrase: string) => {
    const at = text.indexOf(phrase);
    return block(text, { italic: [at, at + phrase.length] });
  };
  const text = [it("She sailed on the Marianne at dawn.", "Marianne"), it("The Marianne was an old boat.", "Marianne"), "Nobody trusted the Marianne in a gale.", it("He did say so.", "did"), it("They read The Times daily.", "The Times"), "A copy of The Times lay there."];
  const issues = read(text);
  check("a name in italic in some places and plain in others", forms(found(issues, "italics:Marianne")) === "italic2,plain1" && forms(found(issues, "italics:The Times")) === "italic1,plain1", ids(issues, "italics"));
  check("a word of stress is not weighed", !ids(issues, "italics").includes("did"));
  check("the fix is a change of formatting", JSON.stringify(found(issues, "italics:Marianne")?.places[2].fixes?.italic) === JSON.stringify({ mark: "italic", add: true, start: 19, end: 27 }));
  const mostly = [it("The Marianne sank.", "Marianne"), ...Array.from({ length: 6 }, () => "Marianne was her mother's name too.")];
  check("a name mostly plain is not a slip in italic", !ids(read(mostly), "italics"));
}

// --------------------------------------------------------------- the comma

{
  const text = ["She bought apples, pears, and plums.", "He packed rope, nets and floats. They saw gulls, terns, crows and a heron.", "It rained, and he left. “No,” she said, and went out. He came, however, and stayed.", "A red, white and blue flag."];
  const issues = read(text);
  const c = found(issues, "serialComma:list");
  check("lists with the comma and without", forms(c) === "with1,without3", `${forms(c)} ${texts(c, text)}`);
  check("“, and he left” begins a clause and is not a list", !(c?.places ?? []).some((p) => p.block === 2));
  check("the fix puts one comma in, or takes one out", fixed(text, c, "with")[1] === "He packed rope, nets, and floats. They saw gulls, terns, crows, and a heron." && fixed(text, c, "without")[0] === "She bought apples, pears and plums.", fixed(text, c, "with")[1]);
  check("each is for a person's eye, so Fix all leaves them", c?.places.every((p) => p.review) === true);
  check("a text that keeps to one way says nothing", !ids(read(["Apples, pears, and plums. Rope, nets, and floats."]), "serialComma"));
  const always = read(["He packed rope, nets and floats."], style({ serialComma: "always" }));
  check("with the comma asked for, a list without it is found though there is only the one", found(always, "serialComma:list")?.preferred === "with" && found(always, "serialComma:list")?.places.length === 1);
  check("not weighed in a script or a poem", !ids(read(text, style({}, {}, { ...EN, format: "screenplay" }), { ...EN, format: "screenplay" }), "serialComma"));
}

// ------------------------------------------------------------------- lists

{
  const li = (text: string) => block(text, { list: { kind: "bullet", depth: 1, part: "middle" } });
  const a = [li("Bring the rope."), li("Mend the nets"), li("Check the floats."), "A paragraph between.", li("First, the tide;"), li("second, the wind;"), li("third, the light.")];
  const issues = read(a, style(), EN, [1, 1, 1, 0, 2, 2, 2]);
  const end = issues.find((i) => i.id.startsWith("lists:end."));
  check("items of one list ending differently", forms(end) === "stop2,bare1" && end?.places.every((p) => p.block < 3) === true, forms(end));
  check("…mended either way", fixed(a.map((b) => (typeof b === "string" ? b : b.text)), end, "stop")[1] === "Mend the nets." && fixed(a.map((b) => (typeof b === "string" ? b : b.text)), end, "bare")[0] === "Bring the rope");
  check("a list that runs on as one sentence is as it should be", issues.filter((i) => i.id.startsWith("lists:end.")).length === 1);
  const caps = [li("Rope"), li("nets"), li("Floats")];
  const cap = read(caps, style(), EN, [1, 1, 1]).find((i) => i.id.startsWith("lists:cap."));
  check("items beginning differently", forms(cap) === "capital2,lower1" && fixed(caps.map((b) => b.text), cap, "capital")[1] === "Nets");
  check("lists are weighed one at a time, never against each other", !read([li("One."), li("Two."), li("Three."), li("four"), li("five"), li("six")], style(), EN, [1, 1, 1, 2, 2, 2]).some((i) => i.check === "lists"));
  check("a list of whole paragraphs is not weighed", !read([li("One sentence. And another."), li("Two"), li("Three.")], style(), EN, [1, 1, 1]).some((i) => i.check === "lists"));
}

// ----------------------------------------------------------- abbreviations

{
  const text = ["NASA sent it up, and Nasa brought it down. The U.S. agreed, and so did the US.", "In Chapter IV the KING SHOUTED LOUDLY. It was OK."];
  const issues = read(text);
  check("an abbreviation written two ways", forms(found(issues, "abbrForms:NASA")) === "capitals1,word1" && forms(found(issues, "abbrForms:US")) === "dotted1,capitals1", ids(issues, "abbrForms"));
  check("…made one", fixed(text, found(issues, "abbrForms:NASA"), "capitals")[0].startsWith("NASA sent it up, and NASA brought it down.") && fixed(text, found(issues, "abbrForms:US"), "capitals")[0].endsWith("The US agreed, and so did the US."));
  check("a Roman number and shouting are not abbreviations", !ids(issues, "abbrForms").includes("IV") && !ids(issues, "abbrForms").includes("KING"));

  const paper = ["The LIDAR unit was new. Light Detection and Ranging (LIDAR) maps the ground.", "Later, Light Detection and Ranging (LIDAR) was used again. The GPS failed.", "A Ground Station Link (GSL) was built. The XYZ was odd. A Laser Imaging Device (LIDAR) is not it."];
  const found2 = read(paper);
  check("used before it is explained", ids(found2, "abbreviations").includes("early") && found(found2, "abbreviations:early")?.places[0].block === 0);
  check("given two meanings", !!found(found2, "abbreviations:twoWays"));
  check("never explained, but not the well-known ones", texts(found(found2, "abbreviations:never"), paper) === "XYZ");
  check("explained and then not used", texts(found(found2, "abbreviations:unused"), paper) === "GSL");
  check("in a novel only “written two ways” runs unless asked", !ids(read(paper, style({}, {}, { ...EN, format: "manuscript" }), { ...EN, format: "manuscript" }), "abbreviations") && ids(read(paper, style({}, { abbreviations: true }, { ...EN, format: "manuscript" }), { ...EN, format: "manuscript" }), "abbreviations") !== "");
}

// ------------------------------------------------------------ to hand over

{
  const text = ["When Katherine met Thaddeus at the harbour, Katherine spoke first.", "Light Rail Transit (LRT) ran east. The LRT was late and the XYZ was odd.", "Thaddeus wrote per cent, and so did Katherine."];
  const scan = scanOf(text);
  const rules = effective(EN, { ...emptyLayer(), settings: { variety: "uk", serialComma: "always" }, words: { a: { k: "prefer", find: "per cent", use: "percent", note: "House style" }, b: { k: "allow", find: "harbour" } } }, emptyLayer());
  const made = new Reader(EN, CHECKS).readNow(scan, rules);
  const abbr = abbreviationsText(made);
  check("a table of abbreviations, a tab between the columns", abbr.includes("LRT\tLight Rail Transit") && abbr.includes("Used and not explained:\nXYZ"), JSON.stringify(abbr));
  const terms = termsText(made, rules, "The Letter");
  check("names and terms: the spelling, the choices and the names with their counts", terms.startsWith("Names and terms in “The Letter”") && terms.includes("Spelling: British") && terms.includes("percent\t(not per cent)\tHouse style") && terms.includes("Katherine\t3") && terms.includes("Thaddeus\t1"), JSON.stringify(terms));
  check("…and the comma, when one is asked for", terms.includes("The comma before “and” in a list: always"));
  check("what was changed, added up by finding", changesText([{ what: "“the the”", places: 2 }, { what: "Two spaces in a row", places: 1 }, { what: "“the the”", places: 3 }]).includes("“the the”\t5 places") && changesText([]).startsWith("Nothing has been changed"));
  const notes = notesText([{ about: "the  harbour", resolved: false, said: [{ who: "Ana", text: "Which harbour?" }, { who: "", text: "The old one." }] }, { about: null, resolved: false, said: [{ who: "Bo", text: "Lovely." }] }, { about: "gone", resolved: true, said: [] }]);
  check("every open comment in one piece", notes.startsWith("Comments (2)") && notes.includes("1. On “the harbour”\n   Ana: Which harbour?\n   The old one.") && notes.includes("2. On the whole text\n   Bo: Lovely.") && !notes.includes("gone"), JSON.stringify(notes));
  check("none of it holds a semicolon or a long dash of its own", ![abbr, terms, notes].some((t) => /[;—]/.test(t)));
}

// ------------------------------------------------------- find by pattern

{
  const doc = PmNode.fromJSON(contentSchema(), { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "On 3 May and 14 June they met. Colour and color." }] }, { type: "paragraph", content: [{ type: "text", text: "Mr Ashworth and Mr Penhallow." }] }] });
  const said = (m: { from: number; to: number }) => doc.textBetween(m.from, m.to);
  const dates = findInDoc(doc, "(\\d+) (May|June)", { pattern: true });
  check("a pattern finds what it describes", dates.matches.map(said).join("|") === "3 May|14 June" && !dates.bad);
  check("…and the replacement can use what its brackets found", replacementFor(dates.matches[1], "$2 $1", "(\\d+) (May|June)", { pattern: true }) === "June 14");
  check("capitals are ignored unless asked for", findInDoc(doc, "colou?r", { pattern: true }).matches.length === 2 && findInDoc(doc, "colou?r", { pattern: true, caseSensitive: true }).matches.length === 1);
  check("a pattern is matched in each paragraph on its own", findInDoc(doc, "Mr \\w+", { pattern: true }).matches.map(said).join("|") === "Mr Ashworth|Mr Penhallow");
  check("a pattern that cannot be read finds nothing and says so", findInDoc(doc, "(unclosed", { pattern: true }).bad === true && findInDoc(doc, "(unclosed", { pattern: true }).matches.length === 0);
  check("a pattern that matches nothing at all does not hang", findInDoc(doc, "x*", { pattern: true }).matches.length === 0);
  check("without the option the same words are plain text", findInDoc(doc, "colou?r", {}).matches.length === 0 && findInDoc(doc, "color", {}).matches.length === 1);
}

// ---------------------------------------------------- quiet where it should be

{
  const clean = [PLAIN, ...storyText().map((p) => (p.heading ? block(p.text, { role: "heading", heading: p.heading }) : p.text))];
  const issues = read(clean, style({}, {}, { ...EN, format: "manuscript" }), { ...EN, format: "manuscript" });
  const noisy = issues.filter((i) => ["caps", "headings", "names", "italics", "serialComma", "lists", "abbrForms", "abbreviations"].includes(i.check));
  check("plain, careful prose raises none of these", noisy.length === 0, noisy.map((i) => `${i.id}:${i.places.length}`).join(" "));
}

finish();
