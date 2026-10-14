import { viewKey, type PictureView } from "../../editor/schema/sanitize";
import { bookArtUrls } from "./bookMap";
import type { BookModel } from "./types";

/** Every picture a book's pages draw, each once: those in its text, its
 *  scene break's, and its chapters' art. */
export function modelPictureUrls(model: BookModel): string[] {
  const urls: string[] = [];
  for (const section of model.sections) {
    for (const block of section.blocks) if (block.kind === "image") urls.push(block.url);
    if (section.art?.opener) urls.push(section.art.opener);
    if (section.art?.facing) urls.push(section.art.facing);
  }
  urls.push(...bookArtUrls(model.book));
  return [...new Set(urls)];
}

/** The pictures in a book's text shown cropped or turned: each such view
 *  once, by the name an ebook knows it by (`viewKey`). */
export function modelPictureViews(model: BookModel): { key: string; url: string; view: PictureView }[] {
  const out = new Map<string, { key: string; url: string; view: PictureView }>();
  for (const section of model.sections) {
    for (const block of section.blocks) {
      if (block.kind !== "image" || !block.view) continue;
      const key = viewKey(block.url, block.view);
      out.set(key, { key, url: block.url, view: block.view });
    }
  }
  return [...out.values()];
}
