/**
 * Tracked changes — what a document stores of them. Schema level 2.
 *
 * A suggestion is not applied and remembered somewhere else: it is in the
 * text. Words someone proposes to add carry an `insertion` mark; words they
 * propose to take out stay where they are under a `deletion` mark. Each
 * names who and when. Accepting an insertion takes the mark off; rejecting
 * it takes the words out — and the other way round for a deletion.
 *
 * Marks only live on text (the sync engine keeps none on other nodes), so
 * anything else says the same in one attribute, `tc`:
 *  - on a paragraph or heading it speaks of the paragraph BREAK before it:
 *    `ins` — the break was added (reject: it joins the paragraph above),
 *    `del` — the break is to go (accept: the same);
 *  - on a thing taken whole — a picture, a table, a divider, a footnote, a
 *    contents block, a line break, a block of code — it speaks of the thing.
 *
 * `tc` is one string (see levels.ts, rule 4): `ins:<when>:<who>`, or two of
 * them on separate lines when something one person added another wants out.
 *
 * Read defensively like the rest of the vocabulary (../schema/sanitize.ts):
 * a value that isn't what it should be is "no change here".
 */

import { Extension, Mark, mergeAttributes } from "@tiptap/core";

export type RevKind = "ins" | "del";

export interface Rev {
  /** Who: the name they go by. */
  a: string;
  /** When: seconds since 1970 (0 when unknown). */
  t: number;
}

export interface NodeRevs {
  ins?: Rev;
  del?: Rev;
}

export const INSERTION = "insertion";
export const DELETION = "deletion";
export const markName = (kind: RevKind) => (kind === "ins" ? INSERTION : DELETION);

/** A name as stored: one line, no control characters, not endless. */
export function authorAttr(v: unknown): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 80);
}

const TIME_MAX = 4102444800; // 2100

export function timeAttr(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v < TIME_MAX ? v : 0;
}

export function revOf(attrs: { a?: unknown; t?: unknown } | null | undefined): Rev {
  return { a: authorAttr(attrs?.a), t: timeAttr(attrs?.t) };
}

/** What a node's `tc` says, or null when it says nothing. */
export function parseRevs(v: unknown): NodeRevs | null {
  if (typeof v !== "string" || !v) return null;
  const out: NodeRevs = {};
  for (const line of v.split("\n")) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const kind = line.slice(0, first);
    if (kind !== "ins" && kind !== "del") continue;
    out[kind] = { a: authorAttr(line.slice(second + 1)), t: timeAttr(Number(line.slice(first + 1, second))) };
  }
  return out.ins || out.del ? out : null;
}

export function encodeRevs(revs: NodeRevs | null): string | null {
  if (!revs) return null;
  const lines: string[] = [];
  for (const kind of ["ins", "del"] as const) {
    const rev = revs[kind];
    if (rev) lines.push(`${kind}:${timeAttr(rev.t)}:${authorAttr(rev.a)}`);
  }
  return lines.length ? lines.join("\n") : null;
}

/** `tc` with one kind set (a Rev) or taken off (null). */
export function withRev(tc: unknown, kind: RevKind, rev: Rev | null): string | null {
  const revs: NodeRevs = { ...(parseRevs(tc) ?? {}) };
  if (rev) revs[kind] = rev;
  else delete revs[kind];
  return encodeRevs(revs);
}

/** Each reviewer's changes are one of a few colours, the same everywhere. */
export const REV_COLORS = 6;
export function revColor(author: string): number {
  let h = 0;
  for (const ch of author) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % REV_COLORS;
}

/** "Maya · 12 Oct, 14:03" — for the tooltip and the list of changes. */
export function describeRev(rev: Rev): string {
  const who = rev.a || "Someone";
  if (!rev.t) return who;
  const when = new Date(rev.t * 1000);
  const sameYear = when.getFullYear() === new Date().getFullYear();
  const date = when.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${who} · ${date}, ${time}`;
}

const VERB: Record<RevKind, string> = { ins: "added", del: "deleted" };

/** The attributes a tracked node's element carries (none when untracked). */
export function revDomAttrs(tc: unknown): Record<string, string> {
  const revs = parseRevs(tc);
  if (!revs) return {};
  // A deletion is what shows when both are there.
  const shown: RevKind = revs.del ? "del" : "ins";
  const rev = revs[shown]!;
  return {
    "data-rev": revs.ins && revs.del ? "ins del" : shown,
    "data-rev-v": encodeRevs(revs)!,
    "data-c": String(revColor(rev.a)),
    title: `${describeRev(rev)} — ${VERB[shown]}`,
  };
}

/** For node views that build their own element: show (or stop showing) the
 *  node's tracked state on it. True when the node is tracked. */
export function showRev(dom: HTMLElement, tc: unknown): boolean {
  const attrs = revDomAttrs(tc);
  for (const key of ["data-rev", "data-rev-v", "data-c"]) {
    if (key in attrs) dom.setAttribute(key, attrs[key]);
    else dom.removeAttribute(key);
  }
  if (attrs.title) {
    dom.title = attrs.title;
    dom.dataset.revTitle = "1";
  } else if (dom.dataset.revTitle) {
    // (Only a title this put there.)
    dom.removeAttribute("title");
    delete dom.dataset.revTitle;
  }
  return "data-rev" in attrs;
}

function revMark(name: string, kind: RevKind, tag: "ins" | "del") {
  return Mark.create({
    name,
    // Outside the formatting marks: one <ins> around a phrase, however it
    // is formatted within.
    priority: 1100,
    // Typing at its edge isn't part of it: in Suggesting the new text gets
    // its own mark, in Editing none.
    inclusive: false,

    addAttributes() {
      return {
        a: {
          default: null,
          parseHTML: (el: HTMLElement) => authorAttr(el.getAttribute("data-a")) || null,
          renderHTML: (attrs: { a?: unknown }) => (authorAttr(attrs.a) ? { "data-a": authorAttr(attrs.a) } : {}),
        },
        t: {
          default: null,
          parseHTML: (el: HTMLElement) => timeAttr(Number(el.getAttribute("data-t"))) || null,
          renderHTML: (attrs: { t?: unknown }) => (timeAttr(attrs.t) ? { "data-t": String(timeAttr(attrs.t)) } : {}),
        },
      };
    },

    parseHTML() {
      // Only our own: a web page's <del> is struck-through text, not a
      // suggestion (the strike mark reads it).
      return [{ tag: `${tag}[data-rev]`, priority: 60 }];
    },

    renderHTML({ mark, HTMLAttributes }) {
      const rev = revOf(mark.attrs);
      return [
        tag,
        mergeAttributes(HTMLAttributes, {
          "data-rev": kind,
          "data-c": String(revColor(rev.a)),
          title: `${describeRev(rev)} — ${VERB[kind]}`,
        }),
        0,
      ];
    },
  });
}

export const InsertionMark = revMark(INSERTION, "ins", "ins");
export const DeletionMark = revMark(DELETION, "del", "del");

/** The node types that can say `tc`. */
export const TRACKED_NODES = ["paragraph", "heading", "codeBlock", "horizontalRule", "hardBreak", "image", "table", "footnote", "toc"];

export const TrackedNodes = Extension.create({
  name: "trackedNodes",

  addGlobalAttributes() {
    return [
      {
        types: TRACKED_NODES,
        attributes: {
          tc: {
            default: null,
            // A paragraph made by pressing Enter at the end of a tracked one
            // isn't itself that change.
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => encodeRevs(parseRevs(el.getAttribute("data-rev-v"))),
            renderHTML: (attrs: { tc?: unknown }) => revDomAttrs(attrs.tc),
          },
        },
      },
    ];
  },
});

export const TRACK_EXTENSIONS = [InsertionMark, DeletionMark, TrackedNodes];

/** Transaction metadata: this edit is never to be turned into a suggestion
 *  (accepting and rejecting, restoring a version). */
export const UNTRACKED_META = "wfUntracked";
