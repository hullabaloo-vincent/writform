/**
 * A document kept inside its own PDF.
 *
 * A PDF is the pages, not the document: its styles, its page setup and the
 * way its text flows are gone. Where the writer asks for it, the document
 * itself goes in beside the pages as one attached file, so that opening the
 * PDF in this app gives the document back to go on writing.
 *
 * The file is a zip named `source.subscribe`:
 *
 *   document.json   { subscribe: 1, title, format, level, content, maps }
 *   pictures/…      the document's pictures, each as the file it is
 *
 * `content` is the text as it stands with every suggested change accepted
 * (comments and history are not in it), its pictures named by their place
 * in the zip. `maps` are the document's own settings (docMaps.ts).
 *
 * Whoever has the PDF has the document: that is said where the choice is
 * made. And what comes back out of a PDF is somebody else's file until
 * shown otherwise, so reading one checks everything and trusts nothing: its
 * size, the size of each part before it is unpacked, the level of its
 * formatting, the shape of every value. (The text itself is checked against
 * the editor's schema by whoever makes a document of it.)
 */

import type { JSONContent } from "@tiptap/core";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

import { sniff } from "../../book/engine/pictures";
import { MEDIA_PREFIX, type DocxMedia } from "../../docx/read";
import { levelOfJson } from "../../editor/schema/levels";
import { DOC_MAPS, type DocMapsSnapshot } from "./docMaps";

/** The attached file's name (a PDF reader shows only this). */
export const SOURCE_NAME = "source.subscribe";
export const SOURCE_TYPE = "application/zip";
export const SOURCE_DESCRIPTION = "The document this PDF was made from. Open the PDF in subScribe to go on writing it.";

/** The most a copy may hold, going in and coming out. */
const MAX_ZIP = 96_000_000;
const MAX_JSON = 16_000_000;
const MAX_PICTURE = 24_000_000;
const MAX_PICTURES = 500;
const MAX_ALL_PICTURES = 64_000_000;
const MAX_VALUE = 200_000;
const MAX_KEYS = 5_000;

export interface SourceInput {
  title: string;
  format: string;
  content: JSONContent;
  maps: DocMapsSnapshot;
}

export interface SourceCopy {
  title: string;
  format: string;
  /** Its text, its pictures named by `media` keys (see `mapImages`). */
  content: JSONContent;
  maps: DocMapsSnapshot;
  media: DocxMedia[];
  /** Pictures the text shows that the copy does not hold. */
  left: number;
}

export interface SourceError {
  code: "source_unreadable" | "source_newer";
  message: string;
}
const unreadable = (): SourceError => ({ code: "source_unreadable", message: "The document kept inside this PDF can’t be read." });

const EXTENSION: Record<string, string> = { jpeg: "jpg", png: "png", gif: "gif" };
const FORMATS = /^[a-z][a-z0-9-]{0,31}$/;

/** A book's cover is artwork kept elsewhere (and not the document's text):
 *  it stays behind. */
function withoutCover(maps: DocMapsSnapshot): DocMapsSnapshot {
  const book = maps.book;
  if (!book) return maps;
  const kept = Object.fromEntries(Object.entries(book).filter(([key]) => !key.startsWith("cover.")));
  return { ...maps, book: kept };
}

/**
 * Pack a document for keeping inside its PDF. `fetchPicture` gives a
 * picture's file (null: it couldn't be had, and it is left out and counted).
 */
export async function packSource(input: SourceInput, fetchPicture: (src: string) => Promise<Uint8Array | null>): Promise<{ bytes: Uint8Array; left: number }> {
  const files: Zippable = {};
  const placed = new Map<string, string | null>();
  let left = 0;
  let held = 0;
  const sources: string[] = [];
  const find = (node: JSONContent) => {
    const src = node.type === "image" ? node.attrs?.src : null;
    if (typeof src === "string" && src && !sources.includes(src)) sources.push(src);
    node.content?.forEach(find);
  };
  find(input.content);
  for (const src of sources) {
    const bytes = placed.size < MAX_PICTURES ? await fetchPicture(src).catch(() => null) : null;
    const kind = bytes ? sniff(bytes)?.type : undefined;
    if (!bytes || !kind || bytes.length > MAX_PICTURE || held + bytes.length > MAX_ALL_PICTURES) {
      placed.set(src, null);
      left += 1;
      continue;
    }
    const name = `pictures/${placed.size + 1}.${EXTENSION[kind]}`;
    // (A picture is packed already: it is stored as it is.)
    files[name] = [bytes, { level: 0 }];
    placed.set(src, name);
    held += bytes.length;
  }
  const walk = (node: JSONContent): JSONContent => {
    if (node.type === "image" && typeof node.attrs?.src === "string") return { ...node, attrs: { ...node.attrs, src: placed.get(node.attrs.src) ?? "" } };
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  const content = walk(input.content);
  const json = JSON.stringify({ subscribe: 1, title: input.title, format: input.format, level: levelOfJson(content), content, maps: withoutCover(input.maps) });
  files["document.json"] = [strToU8(json), { level: 6 }];
  return { bytes: zipSync(files), left };
}

/** A map's values as they may be: text, numbers, yes or no, or nothing. */
function cleanMaps(raw: unknown): DocMapsSnapshot {
  const out: DocMapsSnapshot = {};
  if (typeof raw !== "object" || raw === null) return out;
  let keys = 0;
  for (const name of DOC_MAPS) {
    const map = (raw as Record<string, unknown>)[name];
    if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(map)) {
      if (keys >= MAX_KEYS) break;
      if (key.length > 200 || key.startsWith("cover.")) continue;
      const fine = value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= MAX_VALUE);
      if (!fine) continue;
      kept[key] = value;
      keys += 1;
    }
    if (Object.keys(kept).length) out[name] = kept;
  }
  return out;
}

/**
 * Unpack a copy found inside a PDF. `maxLevel` is the newest formatting
 * this app knows. Throws a `SourceError` for a file that is not one, is
 * damaged, is too large to be one, or was made by a newer version.
 */
export function unpackSource(bytes: Uint8Array, maxLevel: number): SourceCopy {
  if (bytes.length > MAX_ZIP) throw unreadable();
  let files: Record<string, Uint8Array>;
  let pictures = 0;
  let held = 0;
  try {
    files = unzipSync(bytes, {
      // Each part's size is known before it is unpacked: what is too large
      // (or is not ours) never is.
      filter(file) {
        if (file.name === "document.json") return file.originalSize <= MAX_JSON;
        if (!/^pictures\/\d{1,4}\.(jpg|png|gif)$/.test(file.name)) return false;
        pictures += 1;
        held += file.originalSize;
        return pictures <= MAX_PICTURES && file.originalSize <= MAX_PICTURE && held <= MAX_ALL_PICTURES;
      },
    });
  } catch {
    throw unreadable();
  }
  const json = files["document.json"];
  if (!json) throw unreadable();
  let said: Record<string, unknown>;
  try {
    said = JSON.parse(strFromU8(json)) as Record<string, unknown>;
  } catch {
    throw unreadable();
  }
  if (typeof said !== "object" || said === null || said.subscribe !== 1) {
    // A container this version has not met: a later one made it.
    if (typeof said === "object" && said !== null && typeof said.subscribe === "number" && said.subscribe > 1) {
      throw { code: "source_newer", message: "The document inside this PDF was made by a newer version of subScribe. Update the app to open it." } satisfies SourceError;
    }
    throw unreadable();
  }
  const content = said.content as JSONContent | undefined;
  if (typeof content !== "object" || content === null || content.type !== "doc" || !Array.isArray(content.content)) throw unreadable();
  if (levelOfJson(content) > maxLevel) {
    throw { code: "source_newer", message: "The document inside this PDF uses formatting from a newer version of subScribe. Update the app to open it." } satisfies SourceError;
  }

  // Its pictures: those the zip holds and that are what their names say.
  const media: DocxMedia[] = [];
  const keys = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith("pictures/")) continue;
    const kind = sniff(data)?.type;
    if (!kind) continue;
    const key = `${MEDIA_PREFIX}source-${media.length + 1}`;
    keys.set(name, key);
    media.push({ key, name: name.slice("pictures/".length), type: `image/${kind}`, bytes: data });
  }
  let left = 0;
  const walk = (node: JSONContent): JSONContent | null => {
    if (node.type === "image") {
      const key = keys.get(String(node.attrs?.src ?? ""));
      // (Never left pointing at wherever it came from.)
      if (!key) {
        left += 1;
        return null;
      }
      return { ...node, attrs: { ...node.attrs, src: key } };
    }
    if (!Array.isArray(node.content)) return node;
    const kids = node.content.map(walk).filter((n): n is JSONContent => n !== null);
    if (!kids.length && (node.type === "doc" || node.type === "blockquote" || node.type === "listItem" || node.type === "tableCell")) return { ...node, content: [{ type: "paragraph" }] };
    return { ...node, content: kids };
  };
  const text = walk(content) ?? { type: "doc", content: [{ type: "paragraph" }] };
  const format = typeof said.format === "string" && FORMATS.test(said.format) ? said.format : "none";
  const title = typeof said.title === "string" ? said.title.slice(0, 200) : "";
  return { title, format, content: text, maps: cleanMaps(said.maps), media, left };
}
