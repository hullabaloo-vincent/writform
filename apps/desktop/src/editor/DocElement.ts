import { Extension } from "@tiptap/core";

/**
 * Adds an `element` attribute to paragraphs (rendered as `data-element`).
 * Formats style these via CSS; the attribute syncs through Yjs like any
 * node attribute, and unknown/null values degrade to the format's default
 * styling — switching a document's format never invalidates content.
 */
export const DocElement = Extension.create({
  name: "docElement",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          element: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute("data-element"),
            renderHTML: (attributes: { element?: string | null }) =>
              attributes.element ? { "data-element": attributes.element } : {},
          },
        },
      },
    ];
  },
});

/** Book-manuscript elements that open a section of the book — a chapter, a
 *  part, an unnumbered chapter — each of which starts on a new page. */
export const SECTION_ELEMENTS = new Map<string, "chapter" | "part" | "section">([
  ["chapter_heading", "chapter"],
  ["part_heading", "part"],
  ["section_heading", "section"],
]);

/** Whether a block opens a section of the book: a chapter-like element, or
 *  a top-level heading (the chapters of a document that isn't a manuscript). */
export function opensSection(node: { type: { name: string }; attrs: Record<string, unknown> }): boolean {
  if (node.type.name === "heading") return node.attrs.level === 1;
  return typeof node.attrs.element === "string" && SECTION_ELEMENTS.has(node.attrs.element);
}
