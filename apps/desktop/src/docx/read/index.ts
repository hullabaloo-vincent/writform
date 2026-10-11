/**
 * Read a Word document (.docx): its text and formatting as editor content,
 * its page setup, headers and footers as document settings, and its
 * pictures as bytes for the caller to store.
 */

import type { JSONContent } from "@tiptap/core";

import { matchPageSize } from "../../apps/documents/docSettings";
import { loadCatalog } from "../../fonts/catalog";
import { categoryOfWordFamily } from "../../fonts/docx";
import { knownFont, type FontCategory } from "../../fonts/registry";
import { systemFonts } from "../../fonts/store";
import { child, children, int, onOff, type XNode } from "../xml";
import { BodyReader, type Para } from "./body";
import { MEDIA_PREFIX, toContent } from "./content";
import { DocxPackage } from "./package";
import { sectionProps } from "./section";
import { Numbering, readTheme, Styles } from "./styles";

export { DocxError } from "./package";
export { MEDIA_PREFIX } from "./content";

export interface DocxMedia {
  /** The `src` the content's image nodes carry until the caller stores it. */
  key: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface DocxRead {
  content: JSONContent;
  meta: { title?: string; author?: string };
  /** A patch for the document's settings map. */
  settings: Record<string, unknown>;
  /** Entries for the document's style table (see editor/styles/docStyles.ts). */
  styles: Record<string, string>;
  /** Entries for the document's font table (see fonts/docFonts.ts). */
  fonts: Record<string, string>;
  media: DocxMedia[];
  /** What didn't come across, for the import toast. */
  warnings: string[];
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

const PN_FORMATS: Record<string, string> = {
  decimal: "1",
  lowerRoman: "i",
  upperRoman: "I",
  lowerLetter: "a",
  upperLetter: "A",
};

const FIELD_TOKENS: Record<string, string> = {
  PAGE: "{page}",
  NUMPAGES: "{pages}",
  SECTIONPAGES: "{pages}",
  TITLE: "{title}",
  AUTHOR: "{author}",
  DATE: "{date}",
  CREATEDATE: "{date}",
  SAVEDATE: "{date}",
  PRINTDATE: "{date}",
  TIME: "{date}",
};

const inches = (twips: number | undefined): number | undefined =>
  twips === undefined ? undefined : Math.round((twips / 1440) * 1000) / 1000;

/** A header or footer's first line, as [left, centre, right]. */
function slotLine(paras: Para[]): [string, string, string] {
  for (const para of paras) {
    let text = "";
    for (const n of para.inlines) {
      if (n.t === "text") text += n.props.caps ? n.text.toUpperCase() : n.text;
      else if (n.t === "field") text += FIELD_TOKENS[n.name] ?? "";
      else if (n.t === "break") text += " ";
    }
    if (!text.trim()) continue;
    const parts = text.split("\t").map((s) => s.trim());
    if (parts.length >= 3) return [parts[0], parts[1], parts.slice(2).join(" ").trim()];
    if (parts.length === 2) return [parts[0], parts[1], ""];
    const jc = para.props.jc ?? "";
    if (jc === "center") return ["", parts[0], ""];
    if (jc === "right" || jc === "end") return ["", "", parts[0]];
    return [parts[0], "", ""];
  }
  return ["", "", ""];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface DocxReadOptions {
  /** What becomes of Word's tracked changes: kept as suggested changes to
   *  accept or reject here (the default), or read as already accepted. */
  changes?: "keep" | "accept";
}

export async function readDocx(buffer: ArrayBuffer | Uint8Array, opts: DocxReadOptions = {}): Promise<DocxRead> {
  const pkg = await DocxPackage.open(buffer);
  const rels = await pkg.relsOf(pkg.main);
  const part = async (suffix: string): Promise<XNode | null> => {
    const path = await pkg.related(suffix);
    return path ? pkg.xml(path) : null;
  };

  const theme = readTheme(await part("/theme"));
  const styles = new Styles(await part("/styles"), theme);
  const numbering = new Numbering(await part("/numbering"));
  const docSettings = await part("/settings");

  const root = await pkg.xml(pkg.main);
  const body = child(root ?? undefined, "w:body");
  if (!root || !body) {
    const err = new Error("This Word document has no readable text.") as Error & { code: string };
    err.code = "docx_unreadable";
    throw err;
  }

  const reader = new BodyReader(styles, numbering, theme, rels);
  reader.track = opts.changes !== "accept";
  // Footnotes and endnotes live in parts of their own, by id.
  const notesOf = async (suffix: string, tag: string): Promise<Map<string, XNode>> => {
    const out = new Map<string, XNode>();
    for (const note of children((await part(suffix)) ?? undefined, tag)) {
      // (Ids -1 and 0 are the rule above the notes, not notes.)
      if (note.attrs["w:id"] && !note.attrs["w:type"]) out.set(note.attrs["w:id"], note);
    }
    return out;
  };
  reader.notes = { foot: await notesOf("/footnotes", "w:footnote"), end: await notesOf("/endnotes", "w:endnote") };
  reader.read(body);
  // A font the file names may be installed here, or in the online catalog.
  const [installed, catalog] = await Promise.all([
    systemFonts().catch(() => new Map<string, { family: string }>()),
    loadCatalog().catch(() => null),
  ]);
  // Page setup: the last section speaks for the document; the others say
  // how they differ.
  let sect = child(body, "w:sectPr");
  if (!sect) {
    for (const p of children(body, "w:p")) sect = child(child(p, "w:pPr"), "w:sectPr") ?? sect;
  }
  const converted = toContent(reader.paras, styles, numbering, { installed, catalog: catalog?.byName }, { tree: reader.tree, base: sectionProps(sect) });

  // What the document should remember about fonts the app doesn't own:
  // the name, and (from Word's own font table) what kind of face it is.
  const kinds = new Map<string, FontCategory>();
  for (const font of children((await part("/fontTable")) ?? undefined, "w:font")) {
    const kind = categoryOfWordFamily(child(font, "w:family")?.attrs["w:val"]);
    if (font.attrs["w:name"] && kind) kinds.set(font.attrs["w:name"].toLowerCase(), kind);
  }
  const fonts: Record<string, string> = {};
  for (const [id, name] of converted.fontNames) {
    if (knownFont(id)) continue;
    const category = catalog?.byId.get(id.slice(3))?.category ?? kinds.get(name.toLowerCase());
    fonts[id] = JSON.stringify({ n: id.startsWith("gf:") ? (catalog?.byId.get(id.slice(3))?.family ?? name) : name, ...(category ? { c: category } : {}) });
  }
  const settings: Record<string, unknown> = { ...converted.settings };

  const slots: Record<string, string> = {};
  for (const band of ["h", "f"]) {
    for (const variant of ["", "1", "e"]) for (const side of ["L", "C", "R"]) slots[`${band}${variant}${side}`] = "";
  }
  if (sect) {
    const size = child(sect, "w:pgSz");
    const w = inches(int(size?.attrs["w:w"]));
    const h = inches(int(size?.attrs["w:h"]));
    if (w && h) {
      const named = matchPageSize(w, h);
      if (named) Object.assign(settings, named);
      else Object.assign(settings, { pageSize: "custom", pw: w, ph: h, landscape: w > h });
    }
    const mar = child(sect, "w:pgMar");
    if (mar) {
      const set = (key: string, attr: string) => {
        const v = inches(int(mar.attrs[attr]));
        // Word allows negative margins (they pin the text); read as their size.
        if (v !== undefined) settings[key] = Math.abs(v);
      };
      set("mt", "w:top");
      set("mr", "w:right");
      set("mb", "w:bottom");
      set("ml", "w:left");
      set("gutter", "w:gutter");
      set("hd", "w:header");
      set("fd", "w:footer");
    }
    const cols = child(sect, "w:cols");
    const count = int(cols?.attrs["w:num"]);
    if (count && count > 1) {
      settings.cols = Math.min(3, count);
      const gap = inches(int(cols?.attrs["w:space"]));
      if (gap) settings.colGap = gap;
    }
    const pn = child(sect, "w:pgNumType");
    if (pn) {
      const fmt = PN_FORMATS[pn.attrs["w:fmt"] ?? ""];
      if (fmt) settings.pnFormat = fmt;
    }
    // Where the numbering starts is the FIRST section's to say (a later
    // section that restarts it says so for itself).
    const start = int(child(reader.sects[0] ?? sect, "w:pgNumType")?.attrs["w:start"]);
    if (start !== undefined) settings.pnStart = start;
    if (child(sect, "w:lnNumType")) settings.lineNumbers = true;
    // The document's first page is the first section's.
    if (onOff(reader.sects[0] ?? sect, "w:titlePg")) settings.hfFirst = true;

    // A section that names no header of a kind has the one before it: so
    // each kind is whichever section last said, looking back from the end.
    const kinds: Record<string, string> = { default: "", first: "1", even: "e" };
    const all = reader.sects.length ? reader.sects : [sect];
    for (const [name, band] of [
      ["w:headerReference", "h"],
      ["w:footerReference", "f"],
    ] as const) {
      const said = new Set<string>();
      const refs: XNode[] = [];
      for (let i = all.length - 1; i >= 0; i -= 1) {
        for (const ref of children(all[i], name)) {
          const type = ref.attrs["w:type"] ?? "default";
          if (said.has(type)) continue;
          said.add(type);
          refs.push(ref);
        }
      }
      for (const ref of refs) {
        const variant = kinds[ref.attrs["w:type"] ?? "default"];
        const rel = rels.get(ref.attrs["r:id"] ?? "");
        if (variant === undefined || !rel || rel.external) continue;
        const partRoot = await pkg.xml(rel.target);
        if (!partRoot) continue;
        const hf = new BodyReader(styles, numbering, theme, await pkg.relsOf(rel.target), true);
        hf.read(partRoot);
        const [l, c, r] = slotLine(hf.paras);
        slots[`${band}${variant}L`] = l.slice(0, 200);
        slots[`${band}${variant}C`] = c.slice(0, 200);
        slots[`${band}${variant}R`] = r.slice(0, 200);
      }
    }
  }
  Object.assign(settings, slots);
  if (docSettings) {
    if (onOff(docSettings, "w:evenAndOddHeaders")) settings.hfEven = true;
    if (onOff(docSettings, "w:mirrorMargins")) settings.mirror = true;
    if (onOff(docSettings, "w:autoHyphenation")) settings.hyphenate = true;
  }

  // Document properties.
  const meta: DocxRead["meta"] = {};
  const rootRels = await pkg.relsOf("");
  for (const rel of rootRels.values()) {
    if (!rel.type.endsWith("/core-properties") || rel.external) continue;
    const core = await pkg.xml(rel.target);
    const title = child(core ?? undefined, "dc:title")?.text.trim();
    const creator = child(core ?? undefined, "dc:creator")?.text.trim();
    if (title) meta.title = title;
    if (creator) meta.author = creator;
  }

  // Pictures: the kinds a browser shows; the rest are skipped.
  const media: DocxMedia[] = [];
  const kept = new Set<string>();
  let skippedImages = reader.counts.linkedImages;
  for (let i = 0; i < reader.media.length; i += 1) {
    const path = reader.media[i];
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    const type = IMAGE_TYPES[ext];
    const bytes = type ? await pkg.bytes(path) : null;
    if (!type || !bytes || bytes.byteLength === 0) continue;
    const key = `${MEDIA_PREFIX}${i}`;
    kept.add(key);
    media.push({ key, name: path.split("/").pop() ?? `image.${ext}`, type, bytes });
  }
  const content = mapImages(converted.content, (src) => {
    if (kept.has(src)) return src;
    skippedImages += 1;
    return null;
  });

  const c = reader.counts;
  const warnings: string[] = [];
  if (skippedImages) warnings.push(`${plural(skippedImages, "picture")} skipped`);
  if (c.notes) warnings.push(`${plural(c.notes, "footnote")} skipped`);
  if (c.textBoxes) warnings.push(`${plural(c.textBoxes, "text box", "text boxes")} flattened`);
  if (c.equations) warnings.push(`${plural(c.equations, "equation")} skipped`);
  if (c.tracked) warnings.push(reader.track ? "tracked changes kept as suggestions (see Changes)" : "tracked changes accepted");
  if (reader.continuous) warnings.push(`${plural(reader.continuous, "section break")} within a page left out`);

  return { content, meta, settings, styles: converted.styles, fonts, media, warnings };
}

/**
 * Rewrite every image's `src` (a stored address for a file's picture), or
 * drop the image when `resolve` returns null. Empty containers left behind
 * are kept valid.
 */
export function mapImages(doc: JSONContent, resolve: (src: string) => string | null): JSONContent {
  const walk = (node: JSONContent): JSONContent | null => {
    if (node.type === "image") {
      const src = String(node.attrs?.src ?? "");
      if (!src.startsWith(MEDIA_PREFIX)) return node;
      const next = resolve(src);
      return next === null ? null : { ...node, attrs: { ...node.attrs, src: next } };
    }
    if (!node.content) return node;
    const content = node.content.map(walk).filter((n): n is JSONContent => n !== null);
    if (content.length === node.content.length && content.every((n, i) => n === node.content![i])) return node;
    if (content.length === 0) {
      // A quote or the document itself must hold something.
      if (node.type === "doc" || node.type === "blockquote") return { ...node, content: [{ type: "paragraph" }] };
      if (node.type === "listItem") return { ...node, content: [{ type: "paragraph" }] };
    }
    return { ...node, content };
  };
  return walk(doc) ?? { type: "doc", content: [{ type: "paragraph" }] };
}
