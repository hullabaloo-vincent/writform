// The document schema gate, client side: the frozen vocabulary tables, the
// level detector (JSON, Yjs content, Yjs transactions, editor steps),
// down-conversion, the editor guard — and the regression that justifies all
// of it: an editor bound to vocabulary it doesn't know destroys it.
//
// Level 2 is real (run formatting, paragraph indents, checklists). What no
// build knows yet is played by a synthetic level 3: a mark, a block
// container, an inline node with content, and a paragraph attribute.

import { check, finish } from "./env";
import { mountPoint } from "./dom";

import { Editor, Extension, getSchema, Mark, Node, type Extensions, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import * as Y from "yjs";

import { docContentExtensions } from "../src/editor/schema/content";
import { downlevelJson } from "../src/editor/schema/downlevel";
import { SchemaGuard } from "../src/editor/schema/guard";
import { LEVEL1_EXTENSIONS } from "../src/editor/schema/level1";
import { DOC_SCHEMA_LEVEL, levels, levelsFor, UNKNOWN_LEVEL, VOCAB, type Vocab } from "../src/editor/schema/levels";

// ---------------------------------------------------------------- the tables

const vocabOf = (extensions: Extensions): Vocab => {
  const schema = getSchema(extensions);
  const table = (types: Record<string, { spec: { attrs?: object } }>) =>
    Object.fromEntries(
      Object.entries(types)
        .map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {}).sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return { nodes: table(schema.nodes), marks: table(schema.marks) };
};
const sorted = (v: Vocab): Vocab => ({
  nodes: Object.fromEntries(Object.entries(v.nodes).map(([k, a]) => [k, [...a].sort()] as const).sort(([a], [b]) => a.localeCompare(b))),
  marks: Object.fromEntries(Object.entries(v.marks).map(([k, a]) => [k, [...a].sort()] as const).sort(([a], [b]) => a.localeCompare(b))),
});

check(
  "level 1 is exactly the released schema (a TipTap upgrade that adds an attribute shows up here)",
  JSON.stringify(vocabOf(LEVEL1_EXTENSIONS)) === JSON.stringify(sorted(VOCAB[1])),
  JSON.stringify(vocabOf(LEVEL1_EXTENSIONS)),
);
check("the build's level is the newest table", DOC_SCHEMA_LEVEL === Math.max(...Object.keys(VOCAB).map(Number)));
{
  // Everything the document editors can write must be in the tables, or the
  // sync engine would see its own content as unknown.
  const content = vocabOf(docContentExtensions());
  const missing: string[] = [];
  for (const [name, attrs] of Object.entries(content.nodes)) {
    if (!levels.knowsNode(name, DOC_SCHEMA_LEVEL)) missing.push(name);
    for (const a of attrs) if (!levels.knowsNodeAttr(name, a, DOC_SCHEMA_LEVEL)) missing.push(`${name}.${a}`);
  }
  for (const [name, attrs] of Object.entries(content.marks)) {
    if (!levels.knowsMark(name, DOC_SCHEMA_LEVEL)) missing.push(name);
    for (const a of attrs) if (!levels.knowsMarkAttr(name, a, DOC_SCHEMA_LEVEL)) missing.push(`${name}.${a}`);
  }
  check("the tables cover everything the document editors can write", missing.length === 0, missing.join(", "));
}

// ---------------------------------------------------------------- levels 2 and 3, and a synthetic level after them

/** Two levels' tables as one. */
const merged = (a: Vocab, b: Vocab): Vocab => {
  const out: Vocab = { nodes: {}, marks: {} };
  for (const kind of ["nodes", "marks"] as const) {
    for (const src of [a, b]) for (const [name, attrs] of Object.entries(src[kind])) out[kind][name] = [...new Set([...(out[kind][name] ?? []), ...attrs])];
  }
  return out;
};

{
  // Levels 2 and 3 together are exactly what the document schema has beyond level 1.
  const all = vocabOf(docContentExtensions());
  const old = vocabOf(LEVEL1_EXTENSIONS);
  const beyond: Vocab = { nodes: {}, marks: {} };
  for (const kind of ["nodes", "marks"] as const) {
    for (const [name, attrs] of Object.entries(all[kind])) {
      const added = old[kind][name] ? attrs.filter((a) => !old[kind][name].includes(a)) : [...attrs];
      if (!old[kind][name] || added.length) beyond[kind][name] = added;
    }
  }
  check(
    "levels 2 and 3 together are exactly what the document schema adds to level 1",
    JSON.stringify(sorted(beyond)) === JSON.stringify(sorted(merged(VOCAB[2], VOCAB[3]))),
    JSON.stringify(sorted(beyond)),
  );
  // Level 2 shipped in 1.1.0: it is what it was then, for good.
  const SHIPPED_2 =
    '{"nodes":{"bulletList":["marker"],"codeBlock":["tc"],"footnote":["kind","tc"],"hardBreak":["tc"],"heading":["bdr","colBreak","indF","indL","indR","keepLines","keepNext","lineAt","lineRule","sect","shade","tc"],"horizontalRule":["tc"],"image":["align","caption","tc"],"paragraph":["bdr","colBreak","indF","indL","indR","keepLines","keepNext","lineAt","lineRule","sect","shade","tc"],"table":["cols","head","lines","tc"],"tableCell":["bg","colspan","rowspan"],"tableRow":[],"taskItem":["checked"],"taskList":[],"toc":["depth","tc"]},"marks":{"deletion":["a","t"],"fontFamily":["f"],"fontSize":["pt"],"highlight":["c"],"insertion":["a","t"],"textColor":["c"],"vscript":["v"]}}';
  check("level 2 is frozen as it shipped", JSON.stringify(sorted(VOCAB[2])) === SHIPPED_2, JSON.stringify(sorted(VOCAB[2])));
  check("level 3 is a cell's own lines and a picture's outline and corners", JSON.stringify(sorted(VOCAB[3])) === '{"nodes":{"image":["bdr","round"],"tableCell":["bdr"]},"marks":{}}', JSON.stringify(sorted(VOCAB[3])));
}

const Sparkle = Mark.create({
  name: "xSparkle",
  addAttributes: () => ({ c: { default: null } }),
  parseHTML: () => [{ tag: "span[data-x]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
});
const Callout = Node.create({
  name: "xCallout",
  group: "block",
  content: "block+",
  parseHTML: () => [{ tag: "aside" }],
  renderHTML: () => ["aside", 0],
});
const Aside = Node.create({
  name: "xAside",
  group: "inline",
  inline: true,
  content: "text*",
  addAttributes: () => ({ kind: { default: null } }),
  parseHTML: () => [{ tag: "sup[data-x]" }],
  renderHTML: () => ["sup", 0],
});
const Glow = Extension.create({
  name: "xGlow",
  addGlobalAttributes: () => [{ types: ["paragraph"], attributes: { xGlow: { default: null } } }],
});
const LEVEL3_EXTRA = [Sparkle, Callout, Aside, Glow];
const level2 = (history = true): Extensions => docContentExtensions({ history });
const level3 = (history = true): Extensions => [...docContentExtensions({ history }), ...LEVEL3_EXTRA];
// (For the checks of how a level is told and gated, everything this build
// knows beyond level 1 is "2" and what is made up here is "3": three
// levels, the last of them unknown to the build.)
const VOCAB3: Record<number, Vocab> = {
  1: VOCAB[1],
  2: merged(VOCAB[2], VOCAB[3]),
  3: { nodes: { xCallout: [], xAside: ["kind"], paragraph: ["xGlow"] }, marks: { xSparkle: ["c"] } },
};
const lv = levelsFor(VOCAB3);
const schema3 = getSchema(level3());
const schema2 = getSchema(level2());
const schema1 = getSchema(LEVEL1_EXTENSIONS);

const text = (t: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const p = (content: JSONContent[] | string, attrs?: Record<string, unknown>): JSONContent => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  content: typeof content === "string" ? [text(content)] : content,
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

const plain = doc(p("Plain words."), { type: "heading", attrs: { level: 2 }, content: [text("A heading")] });
/** Level 2: what this build writes. */
const rich = doc(
  p([text("Red ", [{ type: "textColor", attrs: { c: "#ff0000" } }]), text("and "), text("large", [{ type: "fontSize", attrs: { pt: 18 } }])]),
  p("Set in from the left.", { indL: 36 }),
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p("A thing done.")] }] },
  { type: "bulletList", content: [{ type: "listItem", content: [p("An item.")] }] },
);
/** Level 3: what a later build might. */
const future = doc(
  p([text("Shiny ", [{ type: "xSparkle", attrs: { c: "#ff0000" } }]), text("words.")]),
  { type: "xCallout", content: [p("Inside a callout.")] },
  p([text("A claim"), { type: "xAside", attrs: { kind: "end" }, content: [text("its source")] }, text(" continues.")], { xGlow: 1 }),
  { type: "bulletList", content: [{ type: "listItem", content: [p("An item.")] }] },
);

// ---------------------------------------------------------------- detection: JSON

check("plain content is level 1", lv.ofJson(plain) === 1);
check("a null attribute isn't use of it", lv.ofJson(doc(p("x", { indL: null, align: null }))) === 1);
check("the rich document needs level 2", lv.ofJson(rich) === 2 && levels.ofJson(rich) === 2);
check("a checklist alone needs level 2", lv.ofJson(doc(rich.content![2])) === 2);
check("content from a later build needs level 3", lv.ofJson(future) === 3);
check("…which this build's own tables don't know at all", levels.ofJson(future) === UNKNOWN_LEVEL);
check("vocabulary no table lists is unknown", lv.ofJson(doc({ type: "widget" })) === UNKNOWN_LEVEL);
check("an unknown attribute on a known node is unknown", lv.ofJson(doc(p("x", { glow: true }))) === UNKNOWN_LEVEL);
check("an unknown mark is unknown", lv.ofJson(doc(p([text("x", [{ type: "sparkle" }])]))) === UNKNOWN_LEVEL);
{
  // Coverage by construction: every name the level-2 schema has beyond
  // level 1 is flagged when it's the only new thing in a document.
  const full = vocabOf(level2());
  const lv = levels;
  const missed: string[] = [];
  // (Each at the level its table says: 2, or 3 for what came after 1.1.0.)
  const nodeAt = (name: string, a?: string) => ((a ? levels.knowsNodeAttr(name, a, 2) : levels.knowsNode(name, 2)) ? 2 : 3);
  const markAt = (name: string, a?: string) => ((a ? levels.knowsMarkAttr(name, a, 2) : levels.knowsMark(name, 2)) ? 2 : 3);
  for (const [name, attrs] of Object.entries(full.nodes)) {
    const isNew = !levels.knowsNode(name, 1);
    if (isNew && lv.ofJson({ type: name }) !== nodeAt(name)) missed.push(name);
    for (const a of attrs) {
      if (!isNew && levels.knowsNodeAttr(name, a, 1)) continue;
      if (lv.ofJson({ type: name, attrs: { [a]: 1 } }) !== Math.max(nodeAt(name), nodeAt(name, a))) missed.push(`${name}.${a}`);
    }
  }
  for (const [name, attrs] of Object.entries(full.marks)) {
    const isNew = !levels.knowsMark(name, 1);
    if (isNew && lv.ofJson(text("x", [{ type: name }])) !== markAt(name)) missed.push(name);
    for (const a of attrs) {
      if (!isNew && levels.knowsMarkAttr(name, a, 1)) continue;
      if (lv.ofJson(text("x", [{ type: name, attrs: { [a]: 1 } }])) !== Math.max(markAt(name), markAt(name, a))) missed.push(`${name}.${a}`);
    }
  }
  check("every node, mark and attribute beyond level 1 is detected", missed.length === 0, missed.join(", "));
}

// ---------------------------------------------------------------- detection: Yjs (real bound editors)

const FIELD = "default";
const bound = (ydoc: Y.Doc, extensions: Extensions, extra: Extensions = []) =>
  new Editor({ element: mountPoint(), extensions: [...extensions, ...extra, Collaboration.configure({ document: ydoc })] });
const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote");
const textOf = (editor: Editor) => editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ");
const select = (editor: Editor, needle: string) => {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text!.includes(needle)) from = pos + node.text!.indexOf(needle);
  });
  if (from < 0) throw new Error(`no "${needle}"`);
  editor.commands.setTextSelection({ from, to: from + needle.length });
};

{
  const ydoc = new Y.Doc();
  const editor = bound(ydoc, level2(false));
  let seen = 1;
  const reset = () => {
    const was = seen;
    seen = 1;
    return was;
  };
  ydoc.getXmlFragment(FIELD).observeDeep((events) => {
    seen = Math.max(seen, lv.ofYEvents(events));
  });

  editor.commands.setContent(doc(p("The quick brown fox."), p("A second paragraph.")));
  check("typing plain text is a level-1 transaction", reset() === 1 && lv.ofYType(ydoc.getXmlFragment(FIELD)) === 1);

  select(editor, "quick");
  editor.commands.toggleBold();
  check("a level-1 mark is a level-1 transaction", reset() === 1);

  select(editor, "brown");
  editor.commands.setMark("textColor", { c: "#ff0000" });
  check("a level-2 mark is seen in the transaction that adds it", reset() === 2);
  check("…and in the content afterwards", lv.ofYType(ydoc.getXmlFragment(FIELD)) === 2);

  select(editor, "brown");
  editor.commands.unsetMark("textColor");
  check("removing it is level 1 again", reset() === 1 && lv.ofYType(ydoc.getXmlFragment(FIELD)) === 1);

  select(editor, "second");
  editor.commands.updateAttributes("paragraph", { indL: 36 });
  check("a level-2 attribute on a level-1 node is seen", reset() === 2);
  editor.commands.updateAttributes("paragraph", { indL: null });
  check("clearing the attribute is level 1", reset() === 1 && lv.ofYType(ydoc.getXmlFragment(FIELD)) === 1);

  editor.commands.insertContentAt(editor.state.doc.content.size, { type: "taskList", content: [{ type: "taskItem", content: [p("To do.")] }] });
  check("an inserted level-2 block is seen", reset() === 2);
  editor.destroy();
}
{
  // The same, a level up: content only a later build would write.
  const ydoc = new Y.Doc();
  const editor = bound(ydoc, level3(false));
  let seen = 1;
  ydoc.getXmlFragment(FIELD).observeDeep((events) => {
    seen = Math.max(seen, lv.ofYEvents(events));
  });
  editor.commands.setContent(doc(p("The quick brown fox.")));
  select(editor, "fox");
  editor.commands.insertContent({ type: "xAside", content: [text("a note")] });
  check("an inserted inline node of a later level is seen", seen === 3);
  editor.destroy();
}

// ---------------------------------------------------------------- the regression that justifies the gate

{
  const newer = new Y.Doc();
  const older = new Y.Doc();
  const writer = bound(newer, level2(false));
  writer.commands.setContent(rich);
  const before = textOf(writer);

  // A client on the old schema (every release through 1.0.6) opens the
  // same document…
  const reader = bound(older, LEVEL1_EXTENSIONS.map((e) => (e.name === "starterKit" ? StarterKit.configure({ undoRedo: false }) : e)));
  sync(newer, older);
  // …and whatever its binding did flows back to everyone.
  sync(older, newer);
  const after = textOf(writer);
  check(
    "an editor bound to vocabulary it doesn't know deletes it for everyone",
    before.includes("Red") && before.includes("A thing done.") && !after.includes("Red") && !after.includes("A thing done."),
    JSON.stringify(after),
  );
  check("…while content it does know survives", after.includes("An item."));
  writer.destroy();
  reader.destroy();
}

// ---------------------------------------------------------------- separate marks merge

{
  // Why run-level formatting will be one mark per property: two people
  // formatting the same words at once must both win.
  const a = new Y.Doc();
  const b = new Y.Doc();
  const alice = bound(a, level2(false));
  alice.commands.setContent(doc(p("Shared words here.")));
  const bob = bound(b, level2(false));
  sync(a, b);

  select(alice, "words");
  alice.commands.setMark("textColor", { c: "#ff0000" });
  select(bob, "words");
  bob.commands.setMark("fontSize", { pt: 18 });
  sync(a, b);
  sync(b, a);

  const marksOn = (editor: Editor) => {
    let names: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === "words") names = node.marks.map((m) => m.type.name).sort();
    });
    return names.join("+");
  };
  check("concurrent colour and size on the same words both survive", marksOn(alice) === "fontSize+textColor" && marksOn(bob) === "fontSize+textColor", `${marksOn(alice)} / ${marksOn(bob)}`);
  alice.destroy();
  bob.destroy();
}

// ---------------------------------------------------------------- down-conversion

{
  const words = (j: JSONContent): string => (j.type === "text" ? (j.text ?? "") : (j.content ?? []).map(words).join(" "));
  {
    // The real case: this build's content for a server still at level 1.
    const down = downlevelJson(rich, 1, schema2);
    const all = words(down);
    check("level-2 content down-converts to level 1", levels.ofJson(down) === 1);
    check("…keeping every word (a checklist as paragraphs)", ["Red", "large", "Set in from the left.", "A thing done.", "An item."].every((w) => all.includes(w)), all);
    let valid = true;
    try {
      schema1.nodeFromJSON(down).check();
    } catch (e) {
      valid = false;
      console.log(String(e));
    }
    check("…as a valid document for every released app", valid);
  }
  const down = downlevelJson(future, 2, schema3, lv);
  const all = words(down);
  check("down-converted content is at the level asked for", lv.ofJson(down) <= 2);
  check(
    "…and keeps every word (an inline node in brackets, a container as paragraphs)",
    ["Shiny", "Inside a callout.", "A claim", "[its source]", "continues.", "An item."].every((w) => all.includes(w)),
    all,
  );
  let valid = true;
  try {
    schema2.nodeFromJSON(down).check();
  } catch (e) {
    valid = false;
    console.log(String(e));
  }
  check("…and is a valid document for the older schema", valid);
  check("content already at the level is returned untouched", downlevelJson(plain, 1, schema3, lv) === plain);
  check("an empty result is still a document", JSON.stringify(downlevelJson(doc({ type: "xCallout", content: [] }), 2, schema3, lv)) === JSON.stringify(doc({ type: "paragraph" })));
}

// ---------------------------------------------------------------- the guard

{
  let cap = 1;
  const ydoc = new Y.Doc();
  const editor = bound(ydoc, level3(false), [SchemaGuard.configure({ level: () => cap, levels: lv })]);
  editor.commands.setContent(doc(p("Guarded words.")));
  const snapshot = () => JSON.stringify(editor.getJSON());

  let was = snapshot();
  select(editor, "Guarded");
  editor.commands.setMark("textColor", { c: "#ff0000" });
  check("at level 1 the guard refuses a level-2 mark", snapshot() === was);
  editor.commands.insertContentAt(editor.state.doc.content.size, { type: "taskList", content: [{ type: "taskItem", content: [p("No.")] }] });
  check("…and a level-2 block", snapshot() === was);
  editor.commands.updateAttributes("paragraph", { indL: 36 });
  check("…and a level-2 attribute", snapshot() === was);
  editor.commands.toggleBold();
  check("…while level-1 edits go through", snapshot() !== was);

  // Pasting from a newer document: converted rather than refused.
  const slice = Slice.fromJSON(schema3, { content: [...rich.content!, ...future.content!], openStart: 0, openEnd: 0 });
  let pasted = slice;
  editor.view.someProp("transformPasted", (f) => {
    pasted = f(pasted, editor.view);
  });
  check("a paste from a newer document is down-converted", lv.ofJson({ type: "doc", content: pasted.content.toJSON() }) === 1 && pasted.content.textBetween(0, pasted.content.size, " ").includes("Inside a callout."));

  // Content arriving from a collaborator is never filtered.
  const other = new Y.Doc();
  const peer = bound(other, level3(false));
  sync(ydoc, other);
  select(peer, "words");
  peer.commands.setMark("fontSize", { pt: 18 });
  sync(other, ydoc);
  check("content from collaborators passes the guard", snapshot().includes("fontSize"));

  cap = 2;
  was = snapshot();
  select(editor, "Guarded");
  editor.commands.setMark("textColor", { c: "#ff0000" });
  check("at level 2 the same edit is allowed", snapshot() !== was && snapshot().includes("textColor"));
  was = snapshot();
  editor.commands.setMark("xSparkle", { c: "#00ff00" });
  check("…while what's newer still isn't", snapshot() === was);
  editor.destroy();
  peer.destroy();
}

finish();
