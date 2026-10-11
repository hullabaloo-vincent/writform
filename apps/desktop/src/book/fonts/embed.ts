/**
 * A book's fonts as files for its ebook: the app's own faces from the
 * bundle, a catalog family's from the online library (this device's cache,
 * your server, or the public mirror — see fonts/store.ts). Every one is
 * under a licence that allows embedding (OFL, Apache, UFL).
 */

import { catalogFiles } from "../../fonts/store";
import { subsetUnicodeRange } from "../../fonts/subsets";
import { bookExotic } from "../engine/client";
import type { EpubOptions } from "../epub/epub";
import type { BookModel } from "../model/types";
import { FONT_FILES } from "./files";
import { bookFont, isCatalogBookFont, type FontStyle } from "./registry";

type EpubFont = NonNullable<EpubOptions["fonts"]>[number];

const SHAPE: Record<FontStyle, { style: "normal" | "italic"; weight: 400 | 700 }> = {
  regular: { style: "normal", weight: 400 },
  italic: { style: "italic", weight: 400 },
  bold: { style: "normal", weight: 700 },
  boldItalic: { style: "italic", weight: 700 },
};

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "font";

/**
 * The body font's files, then the heading font's when it is another.
 * `missing` names the families that couldn't be had (the ebook then leaves
 * the choice of type to the reader's device, as it does without fonts).
 */
export async function epubFonts(model: BookModel): Promise<{ fonts: EpubFont[]; missing: string[] }> {
  const { bodyFont, headingFont } = model.book.design;
  const fonts: EpubFont[] = [];
  const missing: string[] = [];
  let exotic: string | null = null;
  for (const id of [...new Set([bodyFont, headingFont])]) {
    const info = bookFont(id);
    const family = info.label;
    if (isCatalogBookFont(id)) {
      exotic ??= bookExotic(model);
      const files = await catalogFiles(id, exotic).catch(() => []);
      if (!files.length) {
        missing.push(family);
        continue;
      }
      for (const f of files) {
        const range = subsetUnicodeRange(f.subset);
        fonts.push({ family, ...SHAPE[f.style], file: `${slug(family)}-${f.subset}-${f.style.toLowerCase()}.ttf`, bytes: f.bytes, type: "font/ttf", ...(range ? { range } : {}) });
      }
      continue;
    }
    const files = FONT_FILES[id];
    if (!files) {
      missing.push(family);
      continue;
    }
    for (const [style, url] of Object.entries(files) as [FontStyle, string][]) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const otf = /\.otf(\?|$)/i.test(url);
        fonts.push({ family, ...SHAPE[style], file: `${slug(family)}-${style.toLowerCase()}.${otf ? "otf" : "ttf"}`, bytes: new Uint8Array(await res.arrayBuffer()), type: otf ? "font/otf" : "font/ttf" });
      } catch {
        if (!missing.includes(family)) missing.push(family);
      }
    }
  }
  return { fonts, missing };
}
