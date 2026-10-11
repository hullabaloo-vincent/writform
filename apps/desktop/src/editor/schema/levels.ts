/**
 * Document schema levels on the client.
 *
 * A document's level names the newest vocabulary — node types, marks,
 * attributes — its content uses. The Yjs binding of a client that doesn't
 * know some of it deletes that content for everyone, so the server refuses
 * clients below a document's level and this module tells the sync engine
 * what level content needs: read straight off the JSON, the Yjs types or an
 * editor step, never from a list of "features" someone has to remember to
 * extend.
 *
 * Rules for the tables below (they are a wire format):
 *  1. Never remove or rename a node, mark or attribute.
 *  2. A level's table lists what that level ADDED; level N is the union of
 *     1..N. Released tables never change — add a new level instead.
 *  3. New attributes default to `null`, and `null` means absent: only
 *     attributes with a value count (the binding never writes nulls).
 *  4. Attribute values are strings, numbers, booleans or null. The binding
 *     compares them with `!==`, so an array or object would be rewritten on
 *     every keystroke; composites are encoded strings.
 *  5. Lengths and sizes are points; colours are `#rrggbb`.
 */

import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Step } from "@tiptap/pm/transform";
import * as Y from "yjs";

export interface Vocab {
  /** Node type → the attributes this level gave it. */
  nodes: Record<string, readonly string[]>;
  /** Mark type → the attributes this level gave it. */
  marks: Record<string, readonly string[]>;
}

/** Level 1: everything shipped through 1.0.6 (StarterKit 3, images, the
 *  `element` attribute and paragraph typography). */
const LEVEL_1: Vocab = {
  nodes: {
    doc: [],
    text: [],
    paragraph: ["align", "dropCap", "element", "font", "line", "pageBreakBefore", "sa", "sb", "size"],
    heading: ["align", "dropCap", "font", "level", "line", "pageBreakBefore", "sa", "sb", "size"],
    blockquote: [],
    bulletList: [],
    orderedList: ["start", "type"],
    listItem: [],
    codeBlock: ["language"],
    horizontalRule: [],
    hardBreak: [],
    image: ["alt", "height", "src", "title", "width"],
  },
  marks: {
    bold: [],
    italic: [],
    strike: [],
    underline: [],
    code: [],
    link: ["class", "href", "rel", "target", "title"],
  },
};

const PARA_2 = ["bdr", "colBreak", "indF", "indL", "indR", "keepLines", "keepNext", "lineAt", "lineRule", "sect", "shade", "tc"] as const;

/** Level 2: formatting on a run of text (one mark per property, so
 *  concurrent changes merge), paragraph indents, line-height rules, keeps,
 *  shading and borders, checklists and bullet styles; tables, footnotes
 *  and endnotes, a table of contents, picture placement and captions,
 *  sections and column breaks; tracked changes (the `insertion` and
 *  `deletion` marks on text, `tc` on everything else that can be added or
 *  removed).
 *
 *  Not released yet: until a version ships with it, later vocabulary may
 *  still join this table. From the release on it is frozen and what comes
 *  after takes level 3.
 *
 *  (A cell's `colspan` and `rowspan` default to 1, not null: the table
 *  library does arithmetic on them.) */
const LEVEL_2: Vocab = {
  nodes: {
    paragraph: PARA_2,
    heading: PARA_2,
    bulletList: ["marker"],
    taskList: [],
    taskItem: ["checked"],
    table: ["cols", "head", "lines", "tc"],
    tableRow: [],
    tableCell: ["bg", "colspan", "rowspan"],
    footnote: ["kind", "tc"],
    toc: ["depth", "tc"],
    image: ["align", "caption", "tc"],
    codeBlock: ["tc"],
    horizontalRule: ["tc"],
    hardBreak: ["tc"],
  },
  marks: {
    fontFamily: ["f"],
    fontSize: ["pt"],
    textColor: ["c"],
    highlight: ["c"],
    vscript: ["v"],
    insertion: ["a", "t"],
    deletion: ["a", "t"],
  },
};

export const VOCAB: Readonly<Record<number, Vocab>> = { 1: LEVEL_1, 2: LEVEL_2 };

/** The newest level this build's editor understands. */
export const DOC_SCHEMA_LEVEL = 2;

/** The level of content this build doesn't know at all. */
export const UNKNOWN_LEVEL = Infinity;

export interface Levels {
  /** The level TipTap JSON needs (a document, or any node of one). */
  ofJson(node: JSONContent): number;
  /** The level the content under a Yjs type needs. */
  ofYType(type: Y.XmlFragment | Y.XmlElement | Y.XmlText): number;
  /** The level of what a Yjs transaction added or changed (deep events of
   *  the content fragment). Call it inside the observer. */
  ofYEvents(events: Y.YEvent<Y.AbstractType<unknown>>[]): number;
  /** The level an editor step introduces. */
  ofStep(step: Step, doc: PmNode): number;
  /** Whether `level` knows this node type / mark / attribute. */
  knowsNode(name: string, level: number): boolean;
  knowsMark(name: string, level: number): boolean;
  knowsNodeAttr(node: string, attr: string, level: number): boolean;
  knowsMarkAttr(mark: string, attr: string, level: number): boolean;
}

/** y-tiptap stores overlapping marks as `name--<8-char hash>`. */
const HASHED_MARK = /^(.*)--[a-zA-Z0-9+/=]{8}$/;

export function levelsFor(vocab: Readonly<Record<number, Vocab>>): Levels {
  const nodeLevel = new Map<string, number>();
  const markLevel = new Map<string, number>();
  const nodeAttrLevel = new Map<string, number>();
  const markAttrLevel = new Map<string, number>();
  const order = Object.keys(vocab)
    .map(Number)
    .sort((a, b) => a - b);
  for (const level of order) {
    for (const [name, attrs] of Object.entries(vocab[level].nodes)) {
      if (!nodeLevel.has(name)) nodeLevel.set(name, level);
      for (const a of attrs) if (!nodeAttrLevel.has(`${name}.${a}`)) nodeAttrLevel.set(`${name}.${a}`, level);
    }
    for (const [name, attrs] of Object.entries(vocab[level].marks)) {
      if (!markLevel.has(name)) markLevel.set(name, level);
      for (const a of attrs) if (!markAttrLevel.has(`${name}.${a}`)) markAttrLevel.set(`${name}.${a}`, level);
    }
  }

  const set = (v: unknown) => v !== null && v !== undefined;

  const nodeAttrs = (name: string, attrs: Record<string, unknown> | null | undefined): number => {
    let level = nodeLevel.get(name) ?? UNKNOWN_LEVEL;
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (set(value)) level = Math.max(level, nodeAttrLevel.get(`${name}.${key}`) ?? UNKNOWN_LEVEL);
    }
    return level;
  };

  const markAttrs = (name: string, attrs: unknown): number => {
    let level = markLevel.get(name) ?? UNKNOWN_LEVEL;
    if (attrs && typeof attrs === "object") {
      for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
        if (set(value)) level = Math.max(level, markAttrLevel.get(`${name}.${key}`) ?? UNKNOWN_LEVEL);
      }
    }
    return level;
  };

  /** Text formatting as Yjs holds it: mark name → the mark's attributes. */
  const formatting = (attributes: Record<string, unknown> | undefined): number => {
    let level = 1;
    for (const [key, value] of Object.entries(attributes ?? {})) {
      // A null value removes the mark; `ychange` only appears in diff views.
      if (!set(value) || key === "ychange") continue;
      level = Math.max(level, markAttrs(HASHED_MARK.exec(key)?.[1] ?? key, value));
    }
    return level;
  };

  const ofJson = (node: JSONContent): number => {
    let level = nodeAttrs(node.type ?? "paragraph", node.attrs);
    for (const mark of node.marks ?? []) level = Math.max(level, markAttrs(mark.type, mark.attrs));
    for (const child of node.content ?? []) level = Math.max(level, ofJson(child));
    return level;
  };

  const ofYType = (type: Y.XmlFragment | Y.XmlElement | Y.XmlText): number => {
    if (type instanceof Y.XmlText) {
      let level = 1;
      for (const op of type.toDelta() as { attributes?: Record<string, unknown> }[]) {
        level = Math.max(level, formatting(op.attributes));
      }
      return level;
    }
    let level = type instanceof Y.XmlElement ? nodeAttrs(type.nodeName, type.getAttributes()) : 1;
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlText || child instanceof Y.XmlElement) level = Math.max(level, ofYType(child));
    }
    return level;
  };

  const ofYEvents = (events: Y.YEvent<Y.AbstractType<unknown>>[]): number => {
    let level = 1;
    for (const event of events) {
      const target = event.target;
      if (target instanceof Y.XmlText) {
        for (const op of (event as Y.YTextEvent).delta) level = Math.max(level, formatting(op.attributes));
        continue;
      }
      if (target instanceof Y.XmlElement) {
        for (const key of event.keys.keys()) {
          const value = target.getAttribute(key);
          if (set(value)) level = Math.max(level, nodeAttrLevel.get(`${target.nodeName}.${key}`) ?? UNKNOWN_LEVEL);
        }
      }
      for (const item of event.changes.added) {
        for (const content of item.content.getContent()) {
          if (content instanceof Y.XmlText || content instanceof Y.XmlElement) level = Math.max(level, ofYType(content));
        }
      }
    }
    return level;
  };

  const ofStep = (step: Step, doc: PmNode): number => {
    const json = step.toJSON() as {
      stepType?: string;
      slice?: { content?: JSONContent[] };
      mark?: { type: string; attrs?: Record<string, unknown> };
      pos?: number;
      attr?: string;
      value?: unknown;
    };
    let level = 1;
    for (const node of json.slice?.content ?? []) level = Math.max(level, ofJson(node));
    if (json.mark) level = Math.max(level, markAttrs(json.mark.type, json.mark.attrs));
    if (json.attr !== undefined && set(json.value)) {
      // An attribute set on one node, or on the document itself.
      const node = json.stepType === "docAttr" ? doc : typeof json.pos === "number" ? doc.nodeAt(json.pos) : null;
      const name = node?.type.name ?? "";
      level = Math.max(level, nodeAttrLevel.get(`${name}.${json.attr}`) ?? UNKNOWN_LEVEL);
    }
    return level;
  };

  return {
    ofJson,
    ofYType,
    ofYEvents,
    ofStep,
    knowsNode: (name, level) => (nodeLevel.get(name) ?? UNKNOWN_LEVEL) <= level,
    knowsMark: (name, level) => (markLevel.get(name) ?? UNKNOWN_LEVEL) <= level,
    knowsNodeAttr: (node, attr, level) => (nodeAttrLevel.get(`${node}.${attr}`) ?? UNKNOWN_LEVEL) <= level,
    knowsMarkAttr: (mark, attr, level) => (markAttrLevel.get(`${mark}.${attr}`) ?? UNKNOWN_LEVEL) <= level,
  };
}

/** The levels of this build's vocabulary. */
export const levels = levelsFor(VOCAB);
export const levelOfJson = levels.ofJson;
