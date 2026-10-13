// The house style: the writer's own rules and the document's, how they
// are kept and put together, the writer's words as a check, and what is
// set aside (and when that lapses).

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";

import { applyDocMaps, DOC_MAPS, snapshotDocMaps } from "../src/apps/documents/docMaps";
import { Suggesting } from "../src/editor/review/Suggesting";
import { docContentExtensions } from "../src/editor/schema/content";
import { CHECKS } from "../src/proof/checks";
import { matchCase } from "../src/proof/engine/casing";
import { Reader } from "../src/proof/engine/run";
import { docRules, layerFromSnapshot, PROOF_MAP, readDocRules } from "../src/proof/rules/docRules";
import { decodeRulesFile, encodeRulesFile } from "../src/proof/rules/file";
import { useGlobalRules } from "../src/proof/rules/globalRules";
import { effective } from "../src/proof/rules/layer";
import { cleanLayer, emptyLayer, wordId, type Layer } from "../src/proof/rules/model";
import { envFor, ProofSession, type PlaceView } from "../src/proof/session";
import type { BlockInput, Issue, Scan } from "../src/proof/types";
import { RulesEditor } from "../src/proof/ui/RulesEditor";

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const EN = envFor("manuscript", "en-GB");
const layer = (more: Partial<Layer>): Layer => ({ ...emptyLayer(), ...more });
const words = (...entries: Layer["words"][string][]): Layer["words"] => Object.fromEntries(entries.map((e) => [wordId(e.find), e]));
const own = () => useGlobalRules.getState();
/** The same whatever order its keys were set in. */
const canon = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const resetOwn = () => own().load(emptyLayer(), true);

const block = (text: string, more: Partial<BlockInput> = {}): BlockInput => {
  const b = { text, role: "body", heading: null, element: null, list: null, cell: false, note: false, quoted: false, italic: [], highlight: [], link: [], ...more } as BlockInput;
  b.sig = [b.role, b.quoted].join("|");
  return b;
};
const scanOf = (texts: (string | BlockInput)[]): Scan => ({ blocks: texts.map((t) => (typeof t === "string" ? block(t) : t)), prev: new Int32Array(texts.length).fill(-1), list: new Int32Array(texts.length) });
const fixedText = (texts: string[], issue: Issue | undefined): string[] => {
  const out = [...texts];
  for (const p of [...(issue?.places ?? [])].sort((a, b) => b.block - a.block || b.start - a.start)) {
    const fix = p.fixes?.[""];
    if (fix && !("mark" in fix)) for (const e of fix.edits) out[p.block] = out[p.block].slice(0, e.start) + e.text + out[p.block].slice(e.end);
  }
  return out;
};

// ------------------------------------------------------------ as it is kept

{
  const hostile = cleanLayer({
    settings: { only: "yes", lang: "en-GB", made_up: 1 },
    on: { doubled: false, "bad key!": true, spaces: "no" },
    words: { a: { k: "prefer", find: "  per   cent ", use: "percent" }, b: { k: "prefer", find: "same", use: "same" }, c: { k: "steal", find: "x" }, d: { k: "look", find: "x".repeat(500), note: "n".repeat(900) }, e: "nonsense" },
    never: { "doubled:the": "soon" },
    places: { ok1: 3, "not a key!": 4 },
  });
  check("settings are kept only where they make sense", JSON.stringify(hostile.settings) === '{"lang":"en-gb"}');
  check("…and checks, and what is set aside", JSON.stringify(hostile.on) === '{"doubled":false}' && JSON.stringify(hostile.places) === '{"ok1":3}' && hostile.never["doubled:the"] === 0);
  const kept = Object.values(hostile.words);
  check("a word rule is tidied, cut to size, or left out", kept.length === 2 && kept[0].find === "per cent" && kept[1].find.length === 80 && (kept[1].note ?? "").length === 300);
  check("…and kept under the word it is about", wordId("Per  Cent") in hostile.words && wordId("per cent") === wordId("PER CENT"));

  const ydoc = new Y.Doc();
  const map = ydoc.getMap(PROOF_MAP);
  map.set("s.only", true);
  map.set("s.only2", true);
  map.set("on.doubled", false);
  map.set("w:zz", JSON.stringify({ k: "look", find: "very" }));
  map.set("w:bad", "{not json");
  map.set("w:nested", new Y.Map());
  map.set("x:doubled:the", 20000);
  map.set("i:abc123", 20000);
  map.set("something else", 1);
  const read = readDocRules(ydoc);
  check("a document's map is read the same careful way", read.settings.only === true && Object.keys(read.settings).length === 1 && read.on.doubled === false && Object.keys(read.words).length === 1 && read.never["doubled:the"] === 20000 && read.places.abc123 === 20000);
  check("…and what this build does not know is left where it is", map.has("something else") && map.has("s.only2"));
}

// ---------------------------------------------------------- put together

{
  const yours = layer({ on: { doubled: false }, words: words({ k: "prefer", find: "per cent", use: "percent" }, { k: "look", find: "very" }), never: { "spaces:double": 1 } });
  const plain = effective(EN, yours, emptyLayer());
  check("your own rules apply to a document that says nothing", !plain.on("doubled") && plain.on("spaces") && plain.words.length === 2 && plain.skipsIssue("spaces:double") === "yours");
  const doc = layer({ on: { doubled: true }, words: words({ k: "off", find: "very" }, { k: "prefer", find: "per cent", use: "per cent." }, { k: "allow", find: "Had Had" }), never: { "leftovers:bracket": 1 }, places: { k1: 1 } });
  const both = effective(EN, yours, doc);
  check("the document has the last word on a check", both.on("doubled"));
  check("…can switch one of your rules off here", !both.words.some((w) => w.find === "very"));
  check("…and replace one with its own", both.words.find((w) => w.kind === "prefer")?.use === "per cent." && both.words.find((w) => w.kind === "prefer")?.from === "document");
  check("what is set aside is the sum of both", both.skipsIssue("spaces:double") === "yours" && both.skipsIssue("leftovers:bracket") === "document" && both.skipsPlace("k1") && !both.skipsPlace("k2"));
  check("a never-flag word is matched in lowercase", both.words.find((w) => w.kind === "allow")?.find === "had had");
  const only = effective(EN, yours, { ...doc, settings: { only: true } });
  check("a document can ask that only its own rules count", only.on("doubled") && only.skipsIssue("spaces:double") === null && only.words.every((w) => w.from === "document"));
  check("a script leaves the speech check off unless told", !effective(envFor("screenplay", "en"), emptyLayer(), null).on("speechQuotes") && effective(envFor("screenplay", "en"), layer({ on: { speechQuotes: true } }), null).on("speechQuotes"));
  check("the text is read again only when a rule could change what is found", plain.stamp !== both.stamp && effective(EN, yours, layer({ never: { x: 1 }, places: { k: 1 } })).stamp === plain.stamp);
}

// ------------------------------------------------- two people, one document

{
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  docRules.word(a, { k: "prefer", find: "per cent", use: "percent" });
  docRules.word(b, { k: "look", find: "very" });
  docRules.word(b, { k: "prefer", find: "Per Cent", use: "percent" });
  docRules.on(a, "doubled", false);
  docRules.place(b, "abc123");
  sync();
  const ra = readDocRules(a);
  const rb = readDocRules(b);
  check("two people adding rules at once both keep theirs", canon(ra) === canon(rb) && Object.keys(ra.words).length === 2 && ra.on.doubled === false && "abc123" in ra.places);
  check("…and a rule for the same word is one rule", Object.values(ra.words).filter((w) => w.k === "prefer").length === 1);

  // A copy (publish, duplicate, combine) carries the rules.
  check("the rules are among what a copy carries", (DOC_MAPS as readonly string[]).includes("proof"));
  const copy = new Y.Doc();
  applyDocMaps(copy, snapshotDocMaps(a));
  check("a copy of the document has its rules", canon(readDocRules(copy)) === canon(ra));
  check("…read the same from a plain snapshot", canon(layerFromSnapshot(snapshotDocMaps(a).proof)) === canon(ra));

  const file = encodeRulesFile(ra, "House");
  const back = decodeRulesFile(file);
  check("rules saved to a file come back the same", back?.name === "House" && canon(back.layer.words) === canon(ra.words) && canon(back.layer.on) === canon(ra.on));
  check("…without the places, which are one document's", Object.keys(back?.layer.places ?? { x: 1 }).length === 0);
  check("a file that is not rules is refused", decodeRulesFile("{}") === null && decodeRulesFile("not json") === null && decodeRulesFile('{"writform-style":"1"}') === null);
  docRules.clearSkips(a);
  check("what is set aside can be brought back", Object.keys(readDocRules(a).places).length === 0 && Object.keys(readDocRules(a).words).length === 2);
}

// ------------------------------------------------------------ on the device

{
  resetOwn();
  own().word({ k: "prefer", find: "per cent", use: "percent" });
  own().on("doubled", false);
  own().never("spaces:double", true);
  own().word({ k: "off", find: "nothing" });
  const saved = JSON.parse(localStorage.getItem("wf-proof-rules") ?? "{}") as Record<string, unknown>;
  check("your rules are kept on the device", saved.v === 1 && Object.keys(saved.words as object).length === 1 && (saved.on as Record<string, boolean>).doubled === false && "spaces:double" in (saved.never as object));
  own().word(null, "PER CENT");
  own().on("doubled", null);
  own().never("spaces:double", false);
  check("…and taken away again", JSON.stringify(own().layer) === JSON.stringify(emptyLayer()));
}

// ------------------------------------------------------------- your words

{
  check("a replacement is written the way the word was", matchCase("colour", "color").text === "color" && matchCase("Colour", "color").text === "Color" && matchCase("COLOUR", "color").text === "COLOR");
  check("…and mixed capitals want a person's eye", matchCase("eBay", "ebay").sure === false && matchCase("Colour", "color").sure);

  const rules = effective(
    EN,
    layer({
      words: words(
        { k: "prefer", find: "per cent", use: "percent" },
        { k: "prefer", find: "wifi", use: "Wi-Fi" },
        { k: "prefer", find: "internet", use: "Internet" },
        { k: "prefer", find: "in order to", use: "to" },
        { k: "look", find: "in order", note: "Often padding." },
        { k: "look", find: "Very", cs: true },
        { k: "allow", find: "on on" },
      ),
    }),
    emptyLayer(),
  );
  const text = ["Ten per cent of them. Per cent of what? PER CENT.", "The wifi and the WIFI and the Wi-Fi.", "The internet, the Internet.", "He went in order to see. All in order.", "Very good, very good.", "Carry on on your own.", block("Fifty per cent, they said.", { role: "extract", quoted: true })];
  const reader = new Reader(EN, CHECKS);
  const issues = reader.readNow(scanOf(text), rules).analysis.issues;
  const by = (find: string, kind: "p" | "l") => issues.find((i) => i.id === `words:${kind}.${wordId(find)}`);
  const plain = text.filter((t): t is string => typeof t === "string");
  check("a preferred phrase is found whole, in any capitals", by("per cent", "p")?.places.length === 3);
  check("…and fixed in the capitals it was written in", fixedText(plain, by("per cent", "p"))[0] === "Ten percent of them. Percent of what? PERCENT.", fixedText(plain, by("per cent", "p"))[0]);
  check("a target with a capital is written exactly so", fixedText(plain, by("wifi", "p"))[1] === "The Wi-Fi and the Wi-Fi and the Wi-Fi.");
  check("a word already as preferred is no finding", by("internet", "p")?.places.length === 1 && fixedText(plain, by("internet", "p"))[2] === "The Internet, the Internet.");
  check("the longer rule is tried first", by("in order to", "p")?.places.length === 1 && by("in order", "l")?.places.length === 1);
  check("a word to look at has no fix, and its note is shown", !by("in order", "l")?.places[0].fixes && by("in order", "l")?.detail.startsWith("Often padding.") === true);
  check("capitals matter when the rule says so", by("Very", "l")?.places.length === 1);
  check("a never-flag phrase silences the check that would raise it", !issues.some((i) => i.id === "doubled:on"));
  check("someone else's words are left alone", !(by("per cent", "p")?.places ?? []).some((p) => p.block === 6));
  check("the title says what to write", by("per cent", "p")?.title === "“per cent” where you write “percent”" && by("per cent", "p")?.detail === "From your rules.");

  // A rule changed: the words are looked for again, nothing else is read.
  const fewer = effective(EN, layer({ words: words({ k: "look", find: "carry" }) }), emptyLayer());
  const again = reader.readNow(scanOf(text), fewer).analysis.issues;
  check("when a rule changes no paragraph is read afresh", reader.made === 0 && again.some((i) => i.id === `words:l.${wordId("carry")}`) && !again.some((i) => i.id.startsWith("words:p.")));
  check("…and with the never-flag rule gone, the finding is back", again.some((i) => i.id === "doubled:on"));
}

// ------------------------------------------- set aside, in a real document

const t = (text: string): JSONContent => ({ type: "text", text });
const p = (text: string): JSONContent => ({ type: "paragraph", content: [t(text)] });
const make = (ydoc: Y.Doc) => new Editor({ element: mountPoint(), extensions: [...docContentExtensions({ history: false }), Suggesting.configure({ author: () => "Ana" }), Collaboration.configure({ document: ydoc })] });
const viewsOf = (s: ProofSession, id: string): PlaceView[] => {
  const issue = s.issues().find((i) => i.id === id);
  return issue ? issue.places.map((place) => s.view(issue, place)) : [];
};
const ids = (s: ProofSession) => s.issues().map((i) => i.id).join();

{
  resetOwn();
  const ydoc = new Y.Doc();
  const e = make(ydoc);
  e.commands.setContent({ type: "doc", content: [p("Then it was the the end of a long day."), p("And so the the story goes on for ever."), p("Two  spaces here.")] });
  const s = new ProofSession(e, "none", "en-GB", { ydoc, canWrite: true });
  s.start();
  s.flush();
  check("(two places, and a stray space)", viewsOf(s, "doubled:the").length === 2 && ids(s) === "doubled:the,spaces:double");
  const first = viewsOf(s, "doubled:the")[0];
  s.skipPlace(first);
  check("a place set aside is written into the document", `i:${first.key}` in ydoc.getMap(PROOF_MAP).toJSON() && viewsOf(s, "doubled:the").length === 1);
  e.view.dispatch(e.state.tr.insert(0, e.schema.nodes.paragraph.create(null, e.schema.text("A new opening paragraph."))));
  s.flush();
  check("…and stays aside when the text moves", viewsOf(s, "doubled:the").length === 1 && viewsOf(s, "doubled:the")[0].before.includes("so"));

  // A co-writer's change makes every node anew: the place is still aside.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
  const e2 = make(other);
  e2.view.dispatch(e2.state.tr.insertText(" Indeed.", e2.state.doc.content.size - 1));
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(ydoc)), "remote");
  s.flush();
  check("…and when every node is made anew", viewsOf(s, "doubled:the").length === 1);
  const s2 = new ProofSession(e2, "none", "en-GB", { ydoc: other, canWrite: true });
  s2.start();
  s2.flush();
  check("a co-writer is not asked about it either", viewsOf(s2, "doubled:the").length === 1);

  // A copy made from the text and the maps alone keeps it.
  const copy = new Y.Doc();
  const e3 = make(copy);
  e3.commands.setContent(e.getJSON());
  applyDocMaps(copy, snapshotDocMaps(ydoc));
  const s3 = new ProofSession(e3, "none", "en-GB", { ydoc: copy, canWrite: true });
  s3.start();
  s3.flush();
  check("…nor is someone who opens a copy", viewsOf(s3, "doubled:the").length === 1);
  s3.stop();
  e3.destroy();

  // Its words change: it is a place to look at again.
  let at = -1;
  e.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes("end of a long")) at = pos + node.text.indexOf("end of a long");
  });
  e.view.dispatch(e.state.tr.insertText("close", at, at + 3));
  s.flush();
  check("when the words beside it change, it lapses", viewsOf(s, "doubled:the").length === 2 && e.getText().includes("the the close of a long day"));

  s.skipIssue("spaces:double", "document");
  check("a finding set aside for the document is written there", "x:spaces:double" in ydoc.getMap(PROOF_MAP).toJSON() && !ids(s).includes("spaces:double"));
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(other)), "remote");
  check("…and reaches a co-writer's open panel", !ids(s2).includes("spaces:double"), ids(s2));
  s.skipIssue("doubled:the", "yours");
  check("a finding set aside for good is in your own rules, not the document's", "doubled:the" in own().layer.never && !("x:doubled:the" in ydoc.getMap(PROOF_MAP).toJSON()) && ids(s) === "");
  check("…and so it is still raised for the co-writer… here it is the same device, so not", ids(s2) === "");
  own().never("doubled:the", false);
  check("bringing it back shows it again at once", ids(s).includes("doubled:the") && ids(s2).includes("doubled:the"));

  // A rule added by one writer is found by the other's open panel.
  const before = s2.readings;
  docRules.word(ydoc, { k: "look", find: "story" });
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(other)), "remote");
  check("a rule a co-writer adds is read for at once", s2.readings === before + 1 && ids(s2).includes(`words:l.${wordId("story")}`), ids(s2));
  s.stop();
  s2.stop();

  // Someone who may only read: nothing is written to the document.
  const reads = new ProofSession(e2, "none", "en-GB", { ydoc: other, canWrite: false });
  reads.start();
  reads.flush();
  const size = other.getMap(PROOF_MAP).size;
  reads.skipPlace(viewsOf(reads, "doubled:the")[0]);
  reads.skipIssue(`words:l.${wordId("story")}`, "document");
  check("a reader's skips are their own and for now", other.getMap(PROOF_MAP).size === size && viewsOf(reads, "doubled:the").length === 1 && !ids(reads).includes("words:l") && !reads.keepsInDocument);
  reads.stop();
  e.destroy();
  e2.destroy();
}

// ------------------------------------------------------------ the Rules tab

await (async () => {
  resetOwn();
  own().word({ k: "look", find: "very" });
  const ydoc = new Y.Doc();
  const host = mountPoint();
  const root = createRoot(host);
  const render = (scope: "document" | "yours", canWrite = true) => act(async () => root.render(createElement(RulesEditor, { scope, ydoc, canWrite, env: envFor("none", "en-GB"), title: "My Book" })));
  await render("document");
  const map = () => ydoc.getMap(PROOF_MAP).toJSON() as Record<string, unknown>;
  const tick = (label: string) => [...host.querySelectorAll("label.wf-proof-tick")].find((l) => l.textContent?.includes(label))?.querySelector("input") as HTMLInputElement;
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  check("every check is listed, on as it comes", CHECKS.every((c) => tick(c.label)?.checked === true));
  await act(async () => tick("Doubled words").click());
  check("unticking a check switches it off in the document", map()["on.doubled"] === false && !tick("Doubled words").checked);
  await act(async () => tick("Doubled words").click());
  check("…and ticking it again leaves nothing said", !("on.doubled" in map()));

  const fields = () => [...host.querySelectorAll(".wf-proof-add")].map((row) => [...row.querySelectorAll("input")] as HTMLInputElement[]);
  await type(fields()[0][0], "per cent");
  const add = () => [...host.querySelectorAll(".wf-proof-add button")] as HTMLButtonElement[];
  check("a rule needs both its words", add()[0].disabled);
  await type(fields()[0][1], "percent");
  await act(async () => add()[0].click());
  check("a rule added here is the document's", map()[`w:${wordId("per cent")}`] === '{"k":"prefer","find":"per cent","use":"percent"}' && host.querySelector(".wf-proof-words")?.textContent?.includes("per cent to percent") === true);
  check("your own rules are listed as applying here", tick("very")?.checked === true);
  await act(async () => tick("very").click());
  check("…and can be left out of this document", JSON.parse(String(map()[`w:${wordId("very")}`])).k === "off");
  await act(async () => tick("Use only this document’s rules").click());
  check("the document can ask for its own rules only", map()["s.only"] === true && !tick("very"));
  await act(async () => (host.querySelector('button[aria-label="Remove the rule for per cent"]') as HTMLElement).click());
  check("a rule can be removed", !(`w:${wordId("per cent")}` in map()));

  await render("document", false);
  check("someone who may only read sees the rules and cannot change them", tick("Doubled words").disabled && host.querySelectorAll(".wf-proof-add").length === 0 && host.textContent?.includes("not change them") === true);

  await render("yours");
  check("your own rules are their own page", host.querySelector(".wf-proof-words")?.textContent?.includes("very") === true && !tick("Use only this document’s rules"));
  await act(async () => tick("Stray spaces").click());
  check("…and a check switched off there is off for all your documents", own().layer.on.spaces === false && !("on.spaces" in map()));
  await act(async () => root.unmount());
  resetOwn();
})();

finish();
