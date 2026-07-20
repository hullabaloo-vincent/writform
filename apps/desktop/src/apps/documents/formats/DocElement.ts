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
