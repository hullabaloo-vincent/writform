/**
 * Writing-format vocabularies. A format is a set of paragraph "elements"
 * (Final-Draft style): Tab cycles the current paragraph through `elements`,
 * Enter continues with `follower[current]`, and CSS keyed off
 * `data-element` provides the layout (margins, caps, centering).
 */

export interface ElementSpec {
  id: string;
  label: string;
  shortcut?: string;
  /** Picker grouping (Manuscript's book elements). */
  group?: string;
  /** Tooltip / picker hint. */
  hint?: string;
}

export interface FormatSpec {
  /** Ordered vocabulary for Tab / Shift-Tab cycling. */
  elements: ElementSpec[];
  /** Element given to plain/unmarked paragraphs. */
  defaultElement: string;
  /** What Enter starts after each element. */
  follower: Record<string, string>;
  /**
   * What Tab does on a line with text. Script formats cycle the element
   * anywhere (Final Draft). Prose formats only cycle on an EMPTY line — a
   * writer's reflexive Tab-to-indent must never turn a paragraph into a
   * heading — and otherwise either swallow the key (indents are automatic)
   * or insert a literal tab (poetry's hand-set indents).
   */
  tabOnText: "cycle" | "swallow" | "indent";
}

export const FORMAT_LABELS: Record<string, string> = {
  none: "Plain",
  screenplay: "Screenplay",
  stageplay: "Stage Play",
  manuscript: "Manuscript",
  poetry: "Poetry",
};

export const FORMAT_SPECS: Record<string, FormatSpec> = {
  screenplay: {
    elements: [
      { id: "scene_heading", label: "Scene Heading", shortcut: "⌘1" },
      { id: "action", label: "Action", shortcut: "⌘2" },
      { id: "character", label: "Character", shortcut: "⌘3" },
      { id: "parenthetical", label: "Parenthetical", shortcut: "⌘4" },
      { id: "dialogue", label: "Dialogue", shortcut: "⌘5" },
      { id: "transition", label: "Transition", shortcut: "⌘6" },
    ],
    defaultElement: "action",
    follower: {
      scene_heading: "action",
      action: "action",
      character: "dialogue",
      parenthetical: "dialogue",
      dialogue: "character",
      transition: "scene_heading",
    },
    tabOnText: "cycle",
  },
  stageplay: {
    elements: [
      { id: "act_heading", label: "Act Heading" },
      { id: "scene_heading", label: "Scene Heading" },
      { id: "stage_direction", label: "Stage Direction" },
      { id: "character", label: "Character" },
      { id: "dialogue", label: "Dialogue" },
    ],
    defaultElement: "stage_direction",
    follower: {
      act_heading: "scene_heading",
      scene_heading: "stage_direction",
      stage_direction: "stage_direction",
      character: "dialogue",
      dialogue: "character",
    },
    tabOnText: "cycle",
  },
  /**
   * The book manuscript: what each paragraph IS, never how it looks — the
   * book's design (Y.Map "book") decides that at export, so editing can't
   * break the layout. Scene breaks are the document's horizontal rules and
   * extracts/letters its block quotes. New ids are only new VALUES of the
   * existing `element` attribute: older clients show them as body text.
   */
  manuscript: {
    elements: [
      {
        id: "chapter_heading",
        label: "Chapter Heading",
        shortcut: "⌘1",
        group: "Headings",
        hint: "Numbered automatically by the book design",
      },
      { id: "paragraph", label: "Body", shortcut: "⌘2", group: "Text" },
      {
        id: "part_heading",
        label: "Part Heading",
        shortcut: "⌘3",
        group: "Headings",
        hint: "Starts a part (Part One, Part Two…) on its own page",
      },
      {
        id: "section_heading",
        label: "Unnumbered Chapter",
        shortcut: "⌘4",
        group: "Headings",
        hint: "Prologue, Epilogue, Foreword, Acknowledgments…",
      },
      {
        id: "chapter_subtitle",
        label: "Chapter Subtitle",
        shortcut: "⌘5",
        group: "Headings",
        hint: "A subtitle or date line under a chapter heading",
      },
      { id: "subheading", label: "Subheading", shortcut: "⌘6", group: "Headings" },
      { id: "epigraph", label: "Epigraph", shortcut: "⌘7", group: "Special" },
      {
        id: "attribution",
        label: "Attribution",
        shortcut: "⌘8",
        group: "Special",
        hint: "The source of an epigraph or quote",
      },
      {
        id: "verse",
        label: "Verse",
        shortcut: "⌘9",
        group: "Special",
        hint: "Poetry or lyrics: Enter starts a new line, Enter twice a new stanza",
      },
      {
        id: "flush",
        label: "Body — No Indent",
        group: "Text",
        hint: "A body paragraph that never takes a first-line indent",
      },
    ],
    defaultElement: "paragraph",
    follower: {
      chapter_heading: "paragraph",
      paragraph: "paragraph",
      flush: "paragraph",
      part_heading: "chapter_heading",
      section_heading: "paragraph",
      chapter_subtitle: "paragraph",
      subheading: "paragraph",
      epigraph: "attribution",
      attribution: "paragraph",
      verse: "verse",
    },
    tabOnText: "swallow",
  },
  poetry: {
    elements: [
      { id: "stanza_title", label: "Stanza Title" },
      { id: "line", label: "Line" },
    ],
    defaultElement: "line",
    follower: {
      stanza_title: "line",
      line: "line",
    },
    tabOnText: "indent",
  },
};

export function elementLabel(format: string, element: string | null): string {
  const spec = FORMAT_SPECS[format];
  if (!spec) return "";
  const id = element ?? spec.defaultElement;
  return spec.elements.find((e) => e.id === id)?.label ?? id;
}
