// The story plan's data: order keys, what is read and refused, limits read
// the same way by everyone, two people's changes meeting, and an undo that
// leaves other people's changes alone.

import { check, finish } from "./env";

import * as Y from "yjs";

import { packSource, unpackSource } from "../src/apps/documents/sourceCopy";
import { DOC_SCHEMA_LEVEL } from "../src/editor/schema/levels";
import { newId } from "../src/plan/ids";
import { decodeCard, decodeEntry, encodeCard, encodeEntry, LIMITS, planFromSnapshot } from "../src/plan/model";
import { between, byOrder, spread } from "../src/plan/order";
import { PLAN_MAP, planOps, readPlan } from "../src/plan/planMap";

// ------------------------------------------------------------ order keys

{
  // Random inserts: the keys always sort the way things were placed.
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const list: string[] = [];
  let ok = true;
  let longest = 0;
  for (let i = 0; i < 10000; i += 1) {
    const at = rand(list.length + 1);
    const key = between(at > 0 ? list[at - 1] : null, at < list.length ? list[at] : null);
    if ((at > 0 && !(list[at - 1] < key)) || (at < list.length && !(key < list[at])) || key.endsWith("0")) ok = false;
    list.splice(at, 0, key);
    longest = Math.max(longest, key.length);
  }
  check("10,000 random inserts: every key sorts where it was put, none ends in 0", ok);
  check("…and they stay short", longest <= 12, String(longest));
  let end: string | null = null;
  let grew = 0;
  for (let i = 0; i < 300; i += 1) {
    end = between(end, null);
    grew = end.length;
  }
  check("300 put at the end, one after another", grew <= 60, String(grew));
  const keys = spread(1200);
  check("a list spread out again: in order, all different, short", keys.every((k, i) => i === 0 || keys[i - 1] < k) && new Set(keys).size === 1200 && keys.every((k) => k.length <= 2 && !k.endsWith("0")));
  check("two keys alike sort by id", [{ order: "V", id: "b" }, { order: "V", id: "a" }].sort(byOrder)[0].id === "a");
  check("asked for a key between two equal ones, it gives one after them", between("V", "V") > "V");
}

// ------------------------------------------------------------ what is read

{
  const id = newId();
  check("ids are 8 base36 characters", /^[0-9a-z]{8}$/.test(id) && newId() !== id);
  check("a card without an order is refused", decodeCard(id, { t: "x" }) === null);
  const card = decodeCard(id, { t: "  The fall \u0007", n: "Line one\nLine two", l: "nope", ch: "abcdefgh", o: "V", p: ["abcdefgh", "abcdefgh", 3], done: true, future: { kept: 1 } })!;
  check("a card is cleaned as it is read", card.title === "The fall" && card.text === "Line one\nLine two" && card.line === null && card.chapter === "abcdefgh" && card.cast.join() === "abcdefgh" && card.done);
  check("…and what this build doesn't know is kept when it is written back", JSON.parse(encodeCard(card)).future?.kept === 1);
  check("a long title is cut", decodeCard(id, { t: "x".repeat(500), o: "V" })!.title.length === 200);
  const entry = decodeEntry(id, { n: "Anna", a: ["Anna", "Annie", "", "Ana"], k: "dragon", o: "V" })!;
  check("an entry: its own name isn't another name, an unknown kind is a person", entry.aka.join() === "Annie,Ana" && entry.kind === "person");
  check("an entry without a name is refused", decodeEntry(id, { n: "  ", o: "V" }) === null);
  check("…and a place stays a place", decodeEntry(id, JSON.parse(encodeEntry({ ...entry, kind: "place" })))!.kind === "place");

  const snapshot: Record<string, unknown> = {
    [`l:${"aaaaaaaa"}`]: JSON.stringify({ n: "Main plot", o: "V" }),
    [`k:${"bbbbbbbb"}`]: JSON.stringify({ t: "A", l: "aaaaaaaa", o: "V" }),
    [`k:${"cccccccc"}`]: JSON.stringify({ t: "B", l: "zzzzzzzz", o: "W" }),
    "k:not an id": JSON.stringify({ t: "C", o: "X" }),
    "k:dddddddd": "{not json",
    "k:eeeeeeee": 42,
    "s.unknown": true,
  };
  const plan = planFromSnapshot(snapshot);
  check("junk is left out, a card's missing line is no line", plan.cards.map((c) => `${c.title}:${c.line}`).join() === "A:aaaaaaaa,B:null" && Object.keys(plan.settings).length === 0);
}
{
  // Limits, read the same way whatever order the keys came in.
  const snap: Record<string, unknown> = {};
  for (let i = 0; i < 5000; i += 1) snap[`k:${i.toString(36).padStart(8, "0")}`] = JSON.stringify({ t: `Card ${i}`, o: "V" });
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(snap).reverse()) reversed[key] = snap[key];
  const a = planFromSnapshot(snap);
  const b = planFromSnapshot(reversed);
  check("past the limit, the same cards are read by everyone", a.cards.length === LIMITS.cards && a.cards.map((c) => c.id).join() === b.cards.map((c) => c.id).join());
}

// ------------------------------------------------------------ writing, together

{
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };
  const opsA = planOps(a);
  const opsB = planOps(b);
  const line = opsA.addLine("Main plot")!;
  const one = opsA.addCard({ title: "One", line: line.id, chapter: null })!;
  const two = opsA.addCard({ title: "Two", line: line.id, chapter: null })!;
  sync();
  check("cards are added in order", readPlan(b).cards.map((c) => c.title).join() === "One,Two");
  // Two people change two cards at once: both changes stand.
  const cardA = readPlan(a).cards.find((c) => c.id === one.id)!;
  const cardB = readPlan(b).cards.find((c) => c.id === two.id)!;
  opsA.updateCard({ ...cardA, title: "One, changed" });
  opsB.updateCard({ ...cardB, text: "Notes on two" });
  sync();
  const both = readPlan(a);
  check("two people changing two cards at once both keep their change", both.cards.find((c) => c.id === one.id)?.title === "One, changed" && both.cards.find((c) => c.id === two.id)?.text === "Notes on two");
  check("…and both documents agree", JSON.stringify(readPlan(a)) === JSON.stringify(readPlan(b)));
  // Moving a card before another.
  opsA.moveCard(two.id, { line: line.id, chapter: null }, one.id);
  check("a card moved before another", readPlan(a).cards.map((c) => c.id).join() === `${two.id},${one.id}`);
  // Undo leaves someone else's change alone.
  const undoA = opsA.updateCard({ ...readPlan(a).cards.find((c) => c.id === one.id)!, title: "Mine" });
  sync();
  opsB.updateCard({ ...readPlan(b).cards.find((c) => c.id === one.id)!, title: "Theirs" });
  sync();
  undoA();
  check("an undo leaves alone what someone has changed since", readPlan(a).cards.find((c) => c.id === one.id)?.title === "Theirs");
  // Deleting a line and its cards, then undoing it.
  const undoLine = opsA.removeLine(line.id, false);
  check("a line deleted with its cards", readPlan(a).lines.length === 0 && readPlan(a).cards.length === 0);
  undoLine();
  check("…and its undo brings them all back", readPlan(a).lines.length === 1 && readPlan(a).cards.length === 2);
  opsA.removeLine(line.id, true);
  check("a line deleted keeping its cards: they have no line", readPlan(a).cards.every((c) => c.line === null) && readPlan(a).cards.length === 2);
  // An entry taken off the cards that name it.
  const anna = opsA.addEntry({ name: "Anna" })!;
  opsA.updateCard({ ...readPlan(a).cards[0], cast: [anna.id] });
  const undoAnna = opsA.removeEntry(anna.id);
  check("an entry deleted is taken off its cards", readPlan(a).cast.length === 0 && readPlan(a).cards[0].cast.length === 0);
  undoAnna();
  check("…and put back on them by its undo", readPlan(a).cards[0].cast.join() === anna.id);
  // Chapters: remembered, then forgotten when nothing is in them.
  opsA.noteChapter("abcdefgh", "The fall");
  opsA.noteChapter("hgfedcba", "The rise");
  opsA.updateCard({ ...readPlan(a).cards[0], chapter: "abcdefgh" });
  opsA.prune();
  check("a chapter's title is kept while something is in it", readPlan(a).chapters.abcdefgh?.title === "The fall" && !readPlan(a).chapters.hgfedcba);
  // Limits on writing.
  const big = new Y.Doc();
  const map = big.getMap(PLAN_MAP);
  big.transact(() => {
    for (let i = 0; i < LIMITS.lines; i += 1) map.set(`l:${i.toString(36).padStart(8, "0")}`, JSON.stringify({ n: `Line ${i}`, o: "V" }));
  });
  check("no more lines than the limit", planOps(big).addLine("One more") === null);
}

// ------------------------------------------------------------ the copy inside a PDF

{
  const proof: Record<string, unknown> = {};
  for (let i = 0; i < 6000; i += 1) proof[`i:${i}`] = 20000;
  const plan: Record<string, unknown> = { "l:aaaaaaaa": JSON.stringify({ n: "Main plot", o: "V" }), "k:bbbbbbbb": JSON.stringify({ t: "A", l: "aaaaaaaa", o: "V" }) };
  const packed = await packSource({ title: "A book", format: "manuscript", content: { type: "doc", content: [{ type: "paragraph" }] }, maps: { plan, proof } }, async () => null);
  const copy = unpackSource(packed.bytes, DOC_SCHEMA_LEVEL);
  check("a PDF's copy of its document keeps the plan when Check's places fill it", Object.keys(copy.maps.plan ?? {}).length === 2 && planFromSnapshot(copy.maps.plan).cards.length === 1);
}

finish();
