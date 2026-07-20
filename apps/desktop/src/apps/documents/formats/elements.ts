/**
 * Writing-format vocabularies. A format is a set of paragraph "elements"
 * (Final-Draft style): Tab cycles the current paragraph through `elements`,
 * Enter continues with `follower[current]`, and CSS keyed off
 * `data-element` provides the layout (margins, caps, centering).
 */

export interface FormatSpec {
  /** Ordered vocabulary for Tab / Shift-Tab cycling. */
  elements: { id: string; label: string; shortcut?: string }[];
  /** Element given to plain/unmarked paragraphs. */
  defaultElement: string;
  /** What Enter starts after each element. */
  follower: Record<string, string>;
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
  },
  manuscript: {
    elements: [
      { id: "chapter_heading", label: "Chapter Heading" },
      { id: "paragraph", label: "Paragraph" },
    ],
    defaultElement: "paragraph",
    follower: {
      chapter_heading: "paragraph",
      paragraph: "paragraph",
    },
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
  },
};

export function elementLabel(format: string, element: string | null): string {
  const spec = FORMAT_SPECS[format];
  if (!spec) return "";
  const id = element ?? spec.defaultElement;
  return spec.elements.find((e) => e.id === id)?.label ?? id;
}
