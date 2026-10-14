import { Extension } from "@tiptap/core";

import { chapterArtValue } from "../../book/cover/art";

/**
 * A chapter's own art, on its heading (level 4): `art`, the picture behind
 * the chapter's first page, and `artFacing`, the one on the page facing
 * it. Each is "none", a picture (`"<w>x<h> <address>"`, book/cover/art.ts),
 * or null for the book's own (Book ▸ Design ▸ Chapter art).
 *
 * Neither is kept by a new paragraph split off the heading.
 */
export const ChapterArt = Extension.create({
  name: "chapterArt",

  addGlobalAttributes() {
    const attr = (name: "art" | "artFacing", data: string) => ({
      default: null,
      keepOnSplit: false,
      parseHTML: (el: HTMLElement) => chapterArtValue(el.getAttribute(data)),
      renderHTML: (attrs: Record<string, unknown>) => {
        const value = chapterArtValue(attrs[name]);
        return value ? { [data]: value } : {};
      },
    });
    return [{ types: ["paragraph", "heading"], attributes: { art: attr("art", "data-art"), artFacing: attr("artFacing", "data-art-facing") } }];
  },
});
