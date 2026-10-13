/**
 * Shapes shared by the checker's engine and its panel. Plain data only: the
 * engine takes these and returns these, so it runs the same in a test, on
 * the page, or (later) in a worker. Nothing here imports anything.
 */

/** What kind of text a block is, as far as the checks care. */
export type Role =
  | "body"
  /** A heading of any kind (a chapter title, a Document's Heading 2). */
  | "heading"
  /** A script's dialogue: speech with no quote marks round it. */
  | "speech"
  /** Text written in capitals by convention (a scene heading, a cue). */
  | "caps"
  /** Lines of verse. */
  | "verse"
  /** Someone else's words: an epigraph, a block quote. */
  | "extract";

export interface ListPlace {
  kind: "bullet" | "ordered" | "task";
  depth: number;
  /** Where its item stands in the list. */
  part: "only" | "first" | "middle" | "last";
}

/**
 * One paragraph (or heading, or footnote) as the checks read it. `text` is
 * the text as it would stand: words someone has suggested deleting are
 * left out, a line break is "\n", and anything that isn't text (a picture,
 * a run of code) is one U+FFFC.
 */
export interface BlockInput {
  text: string;
  role: Role;
  /** "h1".."h6", or a format's own: "chapter", "part", "section", "subtitle",
   *  "subheading", "stanza", "title", "act", "scene". Null when not a heading. */
  heading: string | null;
  element: string | null;
  list: ListPlace | null;
  cell: boolean;
  note: boolean;
  /** Inside a block quote. */
  quoted: boolean;
  /** Spans of `text`, flat: [start, end, start, end…]. */
  italic: number[];
  highlight: number[];
  link: number[];
  /** Everything above but the text, as one string: with the text, the key
   *  what is known about a block is kept under. */
  sig: string;
}

/** A document, scanned. Arrays run in step with `blocks`. */
export interface Scan {
  blocks: BlockInput[];
  /** The block each one follows straight on from (the paragraph before it
   *  in the same container, with nothing between), or -1. */
  prev: Int32Array;
  /** Which list a block's item belongs to (0: none). Numbered per scan. */
  list: Int32Array;
}

/** The quote marks a language uses, one character each. */
export interface QuoteChars {
  open2: string;
  close2: string;
  open1: string;
  close1: string;
  /** The marks stand off from the words by a space (French). */
  spaced: boolean;
}

/** What the checks are told about the document as a whole. */
export interface Env {
  /** BCP 47, lowercased ("en-gb"). */
  lang: string;
  /** Its first part ("en"). */
  base: string;
  quotes: QuoteChars;
  /** The document's kind: "none", "manuscript", "screenplay", "stageplay", "poetry". */
  format: string;
  /** Highlighting can be seen in this kind of document. */
  highlights: boolean;
}

export type GroupId =
  | "spelling"
  | "hyphens"
  | "capitals"
  | "names"
  | "numbers"
  | "punctuation"
  | "lists"
  | "italics"
  | "abbreviations"
  | "leftovers"
  | "tidy";

/** One change to a block's text, in offsets of that text. */
export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** What Fix does at a place: change characters, or change formatting. */
export type Fix = { edits: Edit[] } | { mark: "italic" | "highlight"; add: boolean; start: number; end: number };

/** One place an issue occurs. */
export interface Place {
  block: number;
  start: number;
  end: number;
  /** Which of the issue's forms this place is written in. */
  form: string | null;
  /** How to make it each other form ("" when there is one answer). A
   *  place with none can only be looked at. */
  fixes?: Record<string, Fix>;
  /** Leave it out of Fix all: the answer needs a person's eye. */
  review?: boolean;
}

export interface Form {
  id: string;
  label: string;
  count: number;
}

/**
 * Something to look at. `consistency`: the text does a thing two ways
 * (`forms`), and the writer says which is meant. `rule`: one right answer.
 * `look`: only a person can tell.
 */
export interface Issue {
  /** `check:key`. The same from one reading of the text to the next: it
   *  speaks of what was written, never of where. */
  id: string;
  check: string;
  key: string;
  group: GroupId;
  kind: "consistency" | "rule" | "look";
  title: string;
  detail: string;
  forms: Form[];
  /** The form taken to be meant, when there is a way to tell. */
  preferred: string | null;
  preferredFrom: "document" | "yours" | "variety" | "majority" | null;
  places: Place[];
  /** Not a place in the text but a list elsewhere in the app. */
  open?: { what: "comments" | "changes"; count: number };
  /** Words (lowercase) that silence the finding when the writer has said
   *  never to flag them. */
  terms?: string[];
}

export interface Analysis {
  issues: Issue[];
  /** Checks that had nothing to say. */
  quiet: string[];
  /** Checks left out because of the document's language. */
  unread: string[];
  blocks: number;
  words: number;
}

/** One of the writer's own rules about a word or a phrase. */
export interface WordRule {
  id: string;
  /** prefer: write `use` for `find`. look: point `find` out. allow: never
   *  flag `find`, in any check. */
  kind: "prefer" | "look" | "allow";
  find: string;
  use: string;
  note: string;
  /** Capitals must match. */
  cs: boolean;
  from: "yours" | "document";
}

/** The house style as the checks see it: which of them run, and the
 *  writer's words. */
export interface Rules {
  on(check: string): boolean;
  /** A choice of style ("variety": "uk"), or undefined when none is made. */
  setting(name: string): string | number | boolean | undefined;
  words: WordRule[];
  /** Changes whenever `words` does: what is noted about a block's words is
   *  kept under it. */
  wordsStamp: string;
}
