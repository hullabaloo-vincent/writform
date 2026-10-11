/**
 * The font store: where a font's files come from, and what each font a
 * document names actually prints in on this device.
 *
 * For every font the answer is the best of, in order:
 *  1. the app's own bundled files;
 *  2. the font itself — installed on this computer (if its licence lets it
 *     be embedded), or downloaded from the online catalog;
 *  3. a catalog family built to the same metrics (Gelasio for Georgia…),
 *     so lines and pages fall exactly as in the original;
 *  4. the nearest bundled face.
 * Anything past (2) is a stand-in, and the export says so.
 *
 * The same answer drives the screen: a catalog family's files are
 * registered with the page under a name of their own (see css.ts), so what
 * the editor and the preview draw is the very file the layout measured.
 */

import type { JSONContent } from "@tiptap/core";

import type { FaceBytes } from "../book/engine/faces";
import { FONT_FILES, loadFontFiles } from "../book/fonts/files";
import { backend, isCmdError, type SystemFontFamily } from "../lib/backend";
import { boldWeight, fontFile, loadCatalog, regularWeight, type CatalogFont } from "./catalog";
import { catalogAlias } from "./css";
import { isFontId, parseFontId } from "./ids";
import { knownFont, type FontCategory, type FontStyle } from "./registry";
import { subsetsFor } from "./subsets";
import { BUNDLED_NAMES, BY_CATEGORY, DEFAULT_BODY, printFace, type PrintFace } from "./substitutes";
import { standInFor } from "./twins";

// ------------------------------------------------------------------ settings

const ONLINE_KEY = "wf-fonts-online";

/** Whether catalog fonts may be downloaded from the public CDN. (Your own
 *  server and this device's cache are always asked.) */
export function onlineFonts(): boolean {
  try {
    return localStorage.getItem(ONLINE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setOnlineFonts(on: boolean): void {
  try {
    localStorage.setItem(ONLINE_KEY, on ? "on" : "off");
  } catch {
    // the setting is best-effort
  }
  forgetFontAnswers();
}

// ------------------------------------------------------------ engine families

/** A catalog family as the layout names it: `gf:<id>[@weight][~subset]`. */
interface CatalogFamily {
  key: string;
  weight?: number;
  subset?: string;
}

function parseCatalogFamily(family: string): CatalogFamily | null {
  const m = /^gf:([a-z0-9][a-z0-9-]{0,63})(?:@([1-9]00))?(?:~([a-z0-9-]{1,40}))?$/.exec(family);
  return m ? { key: m[1], ...(m[2] ? { weight: Number(m[2]) } : {}), ...(m[3] ? { subset: m[3] } : {}) } : null;
}

const catalogFamily = (key: string, weight?: number, subset?: string) =>
  `gf:${key}${weight ? `@${weight}` : ""}${subset ? `~${subset}` : ""}`;

/** The font id a layout family draws (its subset part dropped). */
export function familyFontId(family: string): string {
  const at = family.indexOf("~");
  return at < 0 ? family : family.slice(0, at);
}

// ------------------------------------------------------------- installed fonts

let installed: Promise<Map<string, SystemFontFamily>> | null = null;

/** Fonts installed on this computer, by lower-case name (empty where the
 *  system's fonts can't be read: phones, the browser). */
export function systemFonts(): Promise<Map<string, SystemFontFamily>> {
  installed ??= backend
    .sysfontList()
    .then((list) => new Map(list.map((f) => [f.family.toLowerCase(), f])))
    .catch(() => new Map<string, SystemFontFamily>());
  return installed;
}

// -------------------------------------------------------------------- loading

type Why = "missing" | "licence";

/** Files fetched and not yet handed to the typesetter (which takes them:
 *  bytes cross to its worker by transfer, not by copy). */
const fresh = new Map<string, FaceBytes[]>();
/** What's known about each family's availability, for a while. */
const answers = new Map<string, { ok: boolean; why?: Why; at: number }>();
const inflight = new Map<string, Promise<{ faces: FaceBytes[] | null; why?: Why }>>();
/** A "no" is asked again after this long (the network may be back). */
const RETRY_MS = 60_000;

/** Forget what was learned (the online switch changed, the cache cleared). */
export function forgetFontAnswers(): void {
  answers.clear();
  resolved.clear();
}

async function fetchCatalog(family: string, spec: CatalogFamily): Promise<{ faces: FaceBytes[] | null; why?: Why }> {
  const catalog = await loadCatalog();
  const font = catalog.byId.get(spec.key);
  if (!font) return { faces: null, why: "missing" };
  const subset = spec.subset ?? font.subsets[0];
  if (!font.subsets.includes(subset)) return { faces: null, why: "missing" };
  const regular = regularWeight(font, spec.weight ?? 400);
  const bold = boldWeight(font, regular);
  const wanted: [FontStyle, number, boolean][] = [["regular", regular, false]];
  if (font.italic) wanted.push(["italic", regular, true]);
  if (bold) wanted.push(["bold", bold, false]);
  if (bold && font.italic) wanted.push(["boldItalic", bold, true]);
  const online = onlineFonts();
  const got = await Promise.all(
    wanted.map(async ([style, weight, italic]): Promise<FaceBytes | null> => {
      try {
        const bytes = await backend.fontFetch(spec.key, fontFile(subset, weight, italic), online);
        return { family, style, bytes };
      } catch {
        return null;
      }
    }),
  );
  // The regular is the family; the other styles are a bonus (the layout
  // thickens or slants the regular where one is missing).
  if (!got[0]) return { faces: null, why: "missing" };
  return { faces: got.filter((f): f is FaceBytes => f !== null) };
}

async function fetchSystem(family: string, name: string): Promise<{ faces: FaceBytes[] | null; why?: Why }> {
  const entry = (await systemFonts()).get(name.toLowerCase());
  if (!entry || !entry.styles.includes("regular")) return { faces: null, why: "missing" };
  let why: Why = "missing";
  const got = await Promise.all(
    (["regular", "italic", "bold", "boldItalic"] as FontStyle[])
      .filter((style) => entry.styles.includes(style))
      .map(async (style): Promise<FaceBytes | null> => {
        try {
          const { index, bytes } = await backend.sysfontBytes(entry.family, style === "bold" || style === "boldItalic", style === "italic" || style === "boldItalic");
          return { family, style, bytes, ...(index ? { index } : {}) };
        } catch (e) {
          if (isCmdError(e) && e.code === "not_embeddable") why = "licence";
          return null;
        }
      }),
  );
  const faces = got.filter((f): f is FaceBytes => f !== null);
  return faces.some((f) => f.style === "regular") ? { faces } : { faces: null, why };
}

async function fetchFamily(family: string): Promise<{ faces: FaceBytes[] | null; why?: Why }> {
  if (FONT_FILES[family]) return { faces: await loadFontFiles([family]) };
  const spec = parseCatalogFamily(family);
  if (spec) return fetchCatalog(family, spec);
  if (family.startsWith("sys:")) return fetchSystem(family, family.slice(4));
  return { faces: null, why: "missing" };
}

/** Whether a layout family can be had here; fetches (and keeps) its files
 *  to find out. */
async function available(family: string): Promise<{ ok: boolean; why?: Why }> {
  if (FONT_FILES[family]) return { ok: true };
  const known = answers.get(family);
  if (known && (known.ok || Date.now() - known.at < RETRY_MS)) return known;
  let job = inflight.get(family);
  if (!job) {
    job = fetchFamily(family).finally(() => inflight.delete(family));
    inflight.set(family, job);
  }
  const { faces, why } = await job;
  if (faces) fresh.set(family, faces);
  const answer = { ok: !!faces, ...(why ? { why } : {}), at: Date.now() };
  answers.set(family, answer);
  return answer;
}

/**
 * The files of the given layout families, for the typesetter. Families
 * that can't be had are left out (the layout was told about stand-ins
 * before it got here; this only matters if a cache was emptied meanwhile).
 */
export async function loadFaces(families: string[]): Promise<FaceBytes[]> {
  const out: FaceBytes[] = [];
  for (const family of [...new Set(families)]) {
    const waiting = fresh.get(family);
    if (waiting) {
      fresh.delete(family);
      out.push(...waiting);
      continue;
    }
    const { faces } = await fetchFamily(family);
    if (faces) out.push(...faces);
    else if (FONT_FILES[family]) throw new Error(`Couldn’t load the ${family} font.`);
  }
  return out;
}

// ------------------------------------------------------------------ resolving

const resolved = new Map<string, Promise<PrintFace>>();

async function resolveOne(id: string | null, category?: FontCategory): Promise<PrintFace> {
  const known = id ? knownFont(id) : undefined;
  // The app's own files (and "Sans", which is whatever sans the device has
  // on screen: the bundled sans-serif in print).
  if (known?.face) return printFace(id, category);
  const parsed = id && !known ? parseFontId(id) : null;

  if (parsed?.source === "gf") {
    const catalog = await loadCatalog();
    const font = catalog.byId.get(parsed.key);
    const asked = font?.family ?? parsed.key;
    const family = catalogFamily(parsed.key, parsed.weight);
    if (font && (await available(family)).ok) return { family, substituted: false, metric: true, asked, drawn: asked };
    const bundled = BY_CATEGORY[font?.category ?? category ?? "serif"];
    return { family: bundled, substituted: true, metric: false, asked, drawn: BUNDLED_NAMES[bundled] ?? bundled, why: "missing" };
  }

  // A font by name: one of the classic system stacks, one named in a Word
  // file, or the default body face.
  const asked = !id ? DEFAULT_BODY : known ? known.name : parsed ? parsed.key : DEFAULT_BODY;
  let why: Why = "missing";

  // Installed here, and allowed to be embedded?
  const own = `sys:${asked}`;
  if (isFontId(own) && (await systemFonts()).has(asked.toLowerCase())) {
    const answer = await available(own);
    if (answer.ok) return { family: own, substituted: false, metric: true, asked, drawn: asked };
    if (answer.why === "licence") why = "licence";
  }
  // In the catalog under the same name?
  const catalog = await loadCatalog();
  const listed = catalog.byName.get(asked.toLowerCase());
  if (listed) {
    const family = catalogFamily(listed.id);
    if ((await available(family)).ok) return { family, substituted: false, metric: true, asked, drawn: listed.family };
  }
  // A catalog family built to its metrics?
  const twin = standInFor(asked);
  if (twin?.catalog) {
    const family = catalogFamily(twin.catalog);
    if ((await available(family)).ok) {
      return { family, substituted: true, metric: true, asked, drawn: catalog.byId.get(twin.catalog)?.family ?? twin.catalog, why };
    }
  }
  return { ...printFace(id, category), why };
}

/** What a font id prints in on this device (`null`: the default body face). */
export function resolveFont(id: string | null, category?: FontCategory): Promise<PrintFace> {
  const key = id ?? "";
  let job = resolved.get(key);
  if (!job) {
    job = resolveOne(id, category).catch(() => printFace(id, category));
    resolved.set(key, job);
    // A stand-in for want of the real thing is worth asking about again.
    void job.then((face) => {
      if (face.substituted && face.why === "missing") setTimeout(() => resolved.delete(key), RETRY_MS);
    });
  }
  return job;
}

export interface DocFonts {
  /** What each font id prints in (same answers as `resolveFont`). */
  face: (id: string | null | undefined) => PrintFace;
  /** For each family, the further families tried for characters it lacks
   *  (a catalog family's other scripts). */
  chains: Record<string, string[]>;
  /** Font ids the document uses that this device had to stand in for. */
  missing: { id: string | null; face: PrintFace }[];
}

/**
 * A catalog family's other scripts that `text` needs, as the layout
 * families that draw them — those this device could get. (A catalog family
 * comes split by script: Latin in one file, Cyrillic in another.)
 */
export async function scriptFamilies(family: string, text: string): Promise<string[]> {
  const spec = parseCatalogFamily(family);
  if (!spec || spec.subset || !text) return [];
  const font: CatalogFont | undefined = (await loadCatalog()).byId.get(spec.key);
  if (!font) return [];
  const out: string[] = [];
  for (const subset of subsetsFor(text, font.subsets)) {
    const more = catalogFamily(spec.key, spec.weight, subset);
    if ((await available(more)).ok) out.push(more);
  }
  return out;
}

export interface FontFileOut {
  style: FontStyle;
  /** The script it holds ("latin"), for a `unicode-range`. */
  subset: string;
  bytes: Uint8Array;
}

/**
 * A catalog family's files, as copies to keep (an ebook embeds them): its
 * main script, and the others `text` needs. Empty when it can't be had.
 */
export async function catalogFiles(id: string, text: string): Promise<FontFileOut[]> {
  const spec = parseCatalogFamily(id);
  if (!spec || spec.subset) return [];
  const font = (await loadCatalog()).byId.get(spec.key);
  if (!font) return [];
  const out: FontFileOut[] = [];
  for (const subset of [font.subsets[0], ...subsetsFor(text, font.subsets)]) {
    const family = catalogFamily(spec.key, spec.weight, subset);
    // (Fetched afresh — from this device's cache — so the typesetter's
    // copies stay its own.)
    const { faces } = await fetchFamily(family);
    for (const face of faces ?? []) out.push({ style: face.style, subset, bytes: face.bytes });
  }
  return out;
}

/** Every font id a document names, and its text beyond plain Latin. */
export function fontsUsed(
  doc: JSONContent,
  bodyFont: string | null,
  /** Fonts named outside the text: the document's styles. */
  extra: readonly (string | null)[] = [],
): { ids: (string | null)[]; exotic: string } {
  const ids = new Set<string | null>([bodyFont, ...extra.filter((id) => id === null || isFontId(id))]);
  const exotic = new Set<string>();
  const walk = (node: JSONContent) => {
    const font = node.attrs?.font;
    if (typeof font === "string" && isFontId(font)) ids.add(font);
    for (const mark of node.marks ?? []) {
      if (mark.type === "fontFamily" && isFontId(mark.attrs?.f)) ids.add(mark.attrs.f as string);
    }
    if (node.text) {
      for (const ch of node.text) if (ch.codePointAt(0)! > 0xff && exotic.size < 4000) exotic.add(ch);
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return { ids: [...ids], exotic: [...exotic].join("") };
}

/**
 * Work out what every font in a document prints in — fetching what needs
 * fetching — so the layout (which can't wait) has its answers.
 */
export async function resolveDocFonts(
  doc: JSONContent,
  bodyFont: string | null,
  extra: readonly (string | null)[] = [],
): Promise<DocFonts> {
  const { ids, exotic } = fontsUsed(doc, bodyFont, extra);
  const faces = new Map<string, PrintFace>();
  await Promise.all(ids.map(async (id) => faces.set(id ?? "", await resolveFont(id))));

  const chains: Record<string, string[]> = {};
  if (exotic) {
    await Promise.all(
      [...new Set([...faces.values()].map((f) => f.family))].map(async (family) => {
        const extra = await scriptFamilies(family, exotic);
        if (extra.length) chains[family] = extra;
      }),
    );
  }
  return {
    face: (id) => faces.get(id ?? "") ?? printFace(id),
    chains,
    missing: ids.flatMap((id) => {
      const face = faces.get(id ?? "");
      return face?.substituted && face.asked !== "Sans" ? [{ id, face }] : [];
    }),
  };
}

// --------------------------------------------------------------------- screen

const onScreen = new Map<string, Promise<void>>();

/** Register a catalog family's files with the page, under its own name. */
function showFamily(family: string): Promise<void> {
  const spec = parseCatalogFamily(family);
  if (!spec || typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve();
  let job = onScreen.get(family);
  if (!job) {
    job = (async () => {
      let faces = fresh.get(family);
      if (!faces) faces = (await fetchFamily(family)).faces ?? undefined;
      if (!faces) {
        onScreen.delete(family);
        return;
      }
      const alias = catalogAlias(spec.key, spec.weight);
      await Promise.all(
        faces.map(async (f) => {
          // A copy: the typesetter takes the originals.
          const face = new FontFace(alias, f.bytes.slice().buffer, {
            style: f.style === "italic" || f.style === "boldItalic" ? "italic" : "normal",
            weight: f.style === "bold" || f.style === "boldItalic" ? "700" : "400",
          });
          try {
            document.fonts.add(await face.load());
          } catch {
            // an unreadable face just isn't shown
          }
        }),
      );
    })();
    onScreen.set(family, job);
  }
  return job;
}

/** Make the layout families of a finished layout drawable on the page (the
 *  preview draws each run in the face the layout measured). */
export async function showFamilies(families: string[]): Promise<void> {
  await Promise.all([...new Set(families)].map(showFamily));
}

/**
 * Make a document's fonts show in the editor: downloads the catalog
 * families it names (and the stand-ins for fonts this device lacks) and
 * registers them. Resolves to what couldn't be had.
 */
export async function showDocFonts(
  doc: JSONContent,
  bodyFont: string | null,
  extra: readonly (string | null)[] = [],
): Promise<DocFonts> {
  const fonts = await resolveDocFonts(doc, bodyFont, extra);
  const families = new Set<string>();
  for (const id of fontsUsed(doc, bodyFont, extra).ids) families.add(fonts.face(id).family);
  for (const extra of Object.values(fonts.chains)) for (const f of extra) families.add(f);
  await showFamilies([...families]);
  return fonts;
}

/** Start from nothing (tests). */
export function resetFontStore(): void {
  installed = null;
  fresh.clear();
  answers.clear();
  inflight.clear();
  resolved.clear();
  onScreen.clear();
}
