/**
 * What a new, empty document starts with. Today that is its paper: the size
 * people print on where the writer is (A4 nearly everywhere, US Letter in
 * the countries that use it).
 *
 * It is written INTO the document as it is made, so everyone who opens it
 * sees the same sheet, whatever their own device says. A document that says
 * nothing still reads as US Letter, as every one made before this does.
 * Only the Document kind has a paper to choose: the scripted kinds and a
 * manuscript keep their own sheets.
 *
 * (Kept apart from docSettings.ts, which the typesetting thread reads.)
 */

import type { Document } from "../../bindings/proto/Document";
import { documentsApi } from "./api";
import { b64encode } from "./collab";
import { docMapsUpdate, type DocMapsSnapshot } from "./docMaps";
import { useLocalDocs } from "./local";

/** Where US Letter is the usual paper (Unicode's CLDR list). Everywhere
 *  else prints on A4. */
export const LETTER_REGIONS: ReadonlySet<string> = new Set(["US", "CA", "MX", "PH", "CL", "CO", "CR", "GT", "PA", "PR", "SV", "VE", "BZ", "NI"]);

export type RegionPaper = "letter" | "a4";

/** The region a language tag speaks of ("en-GB" says GB, and "fr", which
 *  names none, most likely means FR). Null when it cannot be told. */
function regionOf(tag: string): string | null {
  try {
    const region = new Intl.Locale(tag).maximize().region;
    if (region) return region.toUpperCase();
  } catch {
    // An odd tag, or a webview without Intl.Locale: read the tag itself.
  }
  const said = /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(tag);
  return said ? said[1].toUpperCase() : null;
}

/** The paper for someone whose languages are these, in their order of
 *  preference: the first that names a place decides. */
export function paperForLocales(tags: readonly string[]): RegionPaper {
  for (const tag of tags) {
    const region = tag ? regionOf(tag) : null;
    if (region) return LETTER_REGIONS.has(region) ? "letter" : "a4";
  }
  return "letter";
}

/** The paper where this device is. */
export function regionPaper(): RegionPaper {
  if (typeof navigator === "undefined") return "letter";
  const tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  return paperForLocales(tags);
}

/** What a new document of this kind is given before a word is written. */
export function newDocumentMaps(format: string): DocMapsSnapshot {
  return format === "none" ? { settings: { pageSize: regionPaper() } } : {};
}

/** A new, empty document on this device. */
export async function createBlankOnDevice(title: string, format: string): Promise<string> {
  const start = docMapsUpdate(newDocumentMaps(format));
  return useLocalDocs.getState().create(title, format, start ? b64encode(start) : undefined);
}

/** A new, empty document on the server. */
export async function createBlankOnServer(title: string, format: string): Promise<Document> {
  const doc = await documentsApi.create(title, format);
  const start = docMapsUpdate(newDocumentMaps(format));
  // (Should this fail, the document is still made: it reads as US Letter
  // until its page is set up.)
  if (start) await documentsApi.appendUpdate(doc.id, b64encode(start)).catch(() => {});
  return doc;
}
