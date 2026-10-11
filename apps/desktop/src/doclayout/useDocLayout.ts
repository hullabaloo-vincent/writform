/**
 * A Document's pages as a preview source: the same layout the PDF and the
 * printer get, so what the preview shows is what comes out.
 */

import type { DocSettings } from "../apps/documents/docSettings";
import type { PreviewSource } from "../book/preview/usePreviewLayout";
import type { StyleOverrides } from "../editor/styles/sheet";

export function docSource(
  title: string,
  author: string | undefined,
  settings: DocSettings,
  styles: StyleOverrides = {},
): PreviewSource {
  return {
    // A new layout when the settings or the styles change.
    key: [settings, styles],
    paper: "white",
    noun: "document",
    layout: async (editor, channel) => {
      const { layoutDocPreview } = await import("./exportDoc");
      return layoutDocPreview({ doc: editor.getJSON(), title, author, settings, styles }, channel);
    },
  };
}

/** A screenplay's, a play's or a poem's pages: its format's sheet, set by
 *  the same layout (see scripted.ts). */
export function scriptSource(format: string, title: string, author: string | undefined): PreviewSource {
  return {
    key: [format, title, author],
    paper: "white",
    noun: "pages",
    layout: async (editor, channel) => {
      const [{ layoutDocPreview }, { scriptedAsDocument }, { finalJson }] = await Promise.all([import("./exportDoc"), import("./scripted"), import("../editor/review/final")]);
      return layoutDocPreview({ ...scriptedAsDocument(finalJson(editor.getJSON()), format, title), title, author }, channel);
    },
  };
}
