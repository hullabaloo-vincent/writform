/**
 * The print PDF: the display list drawn with PDFKit as a low-level writer.
 *
 * - Fonts are embedded as subsets, registered from the very fontkit objects
 *   the layout measured with, so every width agrees with the layout.
 * - Text is pure black (CMYK 0/0/0/100), as printers want for body text.
 * - Every page carries a TrimBox and BleedBox (no bleed: both equal the
 *   page), document metadata, and an outline of the chapters.
 * - The metadata is written twice, as a PDF wants: in its Info and as XMP
 *   (ours: see xmp.ts), saying the same thing. Pages are labelled with the
 *   numbers printed on them (labels.ts), so a reader's "page 12" is the
 *   page that says 12.
 * - No annotations, links or form fields (KDP and IngramSpark reject them).
 *
 * Documents (as opposed to books) ask for `color: "rgb"` and `links`: text
 * and rules in their own colours, highlights and shading, clickable links,
 * pages of differing sizes. A book's display list uses none of that, and its
 * PDF comes out byte for byte as before.
 *
 * A document may also ask to be TAGGED: its display list then says whose
 * each run of words and each picture is (an element of `dl.struct`), and
 * the file carries that structure for screen readers and for text that
 * reflows. Everything else on the page (rules, shading, running heads) is
 * marked as decoration. See "tagged" below.
 *
 * Pictures come ready (see engine/pictures.ts): a JPEG's own bytes, which
 * are wrapped and never encoded again, a PNG file with nothing see-through
 * in it, which PDFKit reads, or plain pixels, which are packed here. Each
 * goes into the file once, however often it is drawn. They may be asked for
 * as the pages that show them are reached (`feed`), so that a document full
 * of them never has them all in memory at once.
 *
 * A document may ask to be an ARCHIVE copy (PDF/A-2b, or 3b when it carries
 * another file): a file that says of itself everything a reader in many
 * years will need. Its fonts are inside it already. What is added: the
 * claim, in its metadata, a statement of what its colour numbers mean (an
 * sRGB profile, see srgb.ts), and the one thing it must not do is seen to:
 * a character no font here can draw is left out, where otherwise the box
 * that stands for "missing" would be drawn. There is no validator here, so
 * this rests on the standard's rules, kept as a checklist in the harness.
 *
 * A book for a press may ask for PDF/X-1a:2001 (`x1a`), the form printers
 * name: PDF 1.3, black ink and greys only, every font inside, nothing
 * see-through, and a statement of the printing condition it was made for
 * (a registered one, named, so no profile is carried). And for BLEED: each
 * sheet larger than the page by an eighth of an inch at the top, the foot
 * and the outside edge (never the binding edge), with the page marked on it
 * as the trim. Both are a checklist in the harness too.
 *
 * As a booklet, pages are imposed two to a sheet for saddle stitching: the
 * count padded to a multiple of four, sides in the classic order [N,1],
 * [2,N−1], [N−2,3]… Print two-sided, flipping on the short edge, then fold.
 */

import { zlibSync } from "fflate";
import type * as fontkit from "fontkit";
import PDFDocument from "pdfkit";

import { filterRows, pictureKey, type PdfPicture, type RawPicture } from "../engine/pictures";
import type { DisplayList } from "../engine/types";
import { pageLabels, plainLabels } from "./labels";
import { srgbProfile } from "./srgb";
import { pdfaClaim, xmpPacket } from "./xmp";

const BLACK: [number, number, number, number] = [0, 0, 0, 100];

/** Shape for the bits of PDFKit we use (its bundled types lag the code). */
interface Doc {
  registerFont(name: string, src: unknown): Doc;
  addPage(options: { size: [number, number]; margin: number }): Doc;
  font(name: string): Doc;
  fontSize(size: number): Doc;
  text(text: string, x: number, y: number, options: Record<string, unknown>): Doc;
  fillColor(color: number[] | string): Doc;
  strokeColor(color: number[] | string): Doc;
  rect(x: number, y: number, w: number, h: number): Doc;
  fill(color: string): Doc;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): Doc;
  link(x: number, y: number, w: number, h: number, url: string, options?: Record<string, unknown>): Doc;
  goTo(x: number, y: number, w: number, h: number, name: string, options?: Record<string, unknown>): Doc;
  addNamedDestination(name: string, fit: "XYZ", left: number | null, top: number | null, zoom: number | null): Doc;
  lineWidth(w: number): Doc;
  moveTo(x: number, y: number): Doc;
  lineTo(x: number, y: number): Doc;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): Doc;
  dash(length: number, options: { space: number }): Doc;
  stroke(): Doc;
  save(): Doc;
  restore(): Doc;
  translate(x: number, y: number): Doc;
  image(src: Picture, x: number, y: number, options: { width: number; height: number }): Doc;
  openImage(src: Uint8Array): Picture & { embed(doc: Doc): void };
  file(src: Uint8Array, options: Record<string, unknown>): Doc;
  roundedRect(x: number, y: number, w: number, h: number, r: number): Doc;
  ellipse(x: number, y: number, rx: number, ry: number): Doc;
  clip(): Doc;
  on(event: "data", cb: (chunk: Uint8Array) => void): Doc;
  on(event: "end" | "error", cb: (err?: unknown) => void): Doc;
  end(): void;
  page: { dictionary: { data: Record<string, unknown> } };
  outline: Outline;
  struct(type: string, options?: Record<string, unknown>): Struct;
  addStructure(element: Struct): Doc;
  markStructureContent(tag: string): unknown;
  markContent(tag: string, options?: Record<string, unknown>): Doc;
  endMarkedContent(): Doc;
  /** PDFKit's own, reached for what it has no call for. */
  version: number;
  ref(data?: Record<string, unknown>): Ref;
  _root: { data: Record<string, unknown> };
  endMetadata(): void;
}

interface Ref {
  compress: boolean;
  write(chunk: Uint8Array): void;
  end(chunk?: Uint8Array): void;
}

/** A picture that is in the file, as PDFKit draws one. */
interface Picture {
  width: number;
  height: number;
  label?: string;
  obj?: unknown;
  /** How its pixels are turned to be shown (EXIF). */
  orientation?: number;
}

/** One element of the file's structure, as PDFKit holds it. */
interface Struct {
  add(child: unknown): Struct;
  end(): void;
  dictionary: { data: Record<string, unknown> };
}

interface Outline {
  addItem(title: string, options?: { expanded?: boolean }): Outline;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The slant of a synthetic italic (about 12°), as a shear. */
const OBLIQUE = 0.21;

export interface RenderOptions {
  booklet?: boolean;
  /** "k": pure black ink, CMYK (books — the default). "rgb": screen
   *  colours, and the items' own colours (documents). */
  color?: "k" | "rgb";
  /** Write links as annotations (never for print-on-demand books). */
  links?: boolean;
  /** Write the structure the display list carries (`dl.struct`), for
   *  screen readers. Nothing to do with a booklet's imposed sheets. */
  tagged?: boolean;
  /** An archive copy: PDF/A-2b, or 3b (one that carries another file).
   *  For a document in screen colours, not a booklet. */
  archive?: "2b" | "3b";
  /** A book for a press, as PDF/X-1a:2001: black ink and greys only. */
  x1a?: boolean;
  /** Bleed, in points: each sheet this much larger than its page at the
   *  top, the foot and the outside edge. */
  bleed?: number;
  /** A file to carry inside (the document this was made from). Not for a
   *  booklet. */
  attach?: PdfAttachment;
  /** Pictures not handed over with the rest: asked for by name as the
   *  pages that show them are reached. */
  feed?: (refs: string[]) => Promise<Map<string, PdfPicture>>;
}

/** A file carried inside a PDF. */
export interface PdfAttachment {
  name: string;
  /** Its media type ("application/zip"). */
  type: string;
  /** What it is, for someone looking through the PDF's attachments. */
  description: string;
  bytes: Uint8Array;
}

export async function renderPdf(
  dl: DisplayList,
  /** fontkit font for each DisplayList face. */
  fonts: fontkit.Font[],
  images: Map<string, PdfPicture>,
  onProgress?: (done: number, total: number) => void,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  const ink: number[] | string = opts.color === "rgb" ? "#000000" : BLACK;
  // A colour as this file writes it. In a book's black ink a grey is black
  // alone (white is no ink at all), so its print standard holds.
  const paint = (color: string): number[] | string => {
    if (opts.color === "rgb") return color;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
    if (!m || m[1].toLowerCase() !== m[2].toLowerCase() || m[2].toLowerCase() !== m[3].toLowerCase()) return color;
    return [0, 0, 0, Math.round((1 - parseInt(m[1], 16) / 255) * 1000) / 10];
  };
  const { w, h } = dl.trim;
  const sheetW = opts.booklet ? w * 2 : w;
  // Made and last changed at the same moment: this is a fresh file.
  const now = new Date();
  const keywords = dl.meta.keywords ?? "";
  const struct = opts.tagged && !opts.booklet && dl.struct?.length ? dl.struct : null;
  const archive = opts.archive && !opts.booklet && opts.color === "rgb" ? opts.archive : null;
  const attach = opts.attach && !opts.booklet ? opts.attach : null;
  const x1a = !!opts.x1a && !opts.booklet && opts.color !== "rgb";
  const bleed = opts.bleed && !opts.booklet ? opts.bleed : 0;
  /** (To PDFKit the text "False" in a file's Info is text. This stands for
   *  the name, which is what is wanted there.) */
  const NOT_TRAPPED = {};
  const doc = new PDFDocument({
    autoFirstPage: false,
    // No default font: PDFKit would otherwise load Helvetica's metrics.
    font: null,
    size: [sheetW, h],
    margin: 0,
    // (What a table's cell says of itself came with 1.5.)
    pdfVersion: x1a ? "1.3" : struct || archive || attach ? "1.7" : "1.4",
    ...(struct ? { tagged: true } : {}),
    // (Neither is of PDF 1.3, which is all PDF/X-1a:2001 may use.)
    ...(x1a ? {} : { lang: dl.meta.lang, displayTitle: true }),
    info: {
      Title: dl.meta.title,
      Author: dl.meta.author,
      // (Nothing is said where there is nothing to say.)
      ...(dl.meta.subject ? { Subject: dl.meta.subject } : {}),
      ...(keywords ? { Keywords: keywords } : {}),
      Creator: "subScribe",
      Producer: "subScribe",
      CreationDate: now,
      ModDate: now,
      ...(x1a ? { GTS_PDFXVersion: "PDF/X-1:2001", GTS_PDFXConformance: "PDF/X-1a:2001", Trapped: NOT_TRAPPED } : {}),
    },
  } as unknown as PDFKit.PDFDocumentOptions) as unknown as Doc;
  if (x1a) {
    const ref = doc.ref.bind(doc);
    doc.ref = (data?: Record<string, unknown>) => ref(data === NOT_TRAPPED ? ("False" as unknown as Record<string, unknown>) : data);
  }
  // The XMP is ours (PDFKit's leaves "&" in a title as it is, which makes
  // the whole packet unreadable). It says what Info says.
  doc.endMetadata = function (this: Doc) {
    // (PDF 1.3 has no metadata stream.)
    if (this.version === 1.3) return;
    const xmp = xmpPacket({
      title: dl.meta.title,
      author: dl.meta.author,
      subject: dl.meta.subject,
      keywords,
      lang: dl.meta.lang,
      created: now,
      modified: now,
      creator: "subScribe",
      producer: "subScribe",
      ...(archive ? { extra: [pdfaClaim(archive === "3b" ? 3 : 2)] } : {}),
    });
    const ref = this.ref({ Type: "Metadata", Subtype: "XML" });
    ref.compress = false;
    ref.write(new TextEncoder().encode(xmp));
    ref.end();
    this._root.data.Metadata = ref;
  };

  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err) => reject(err));
  });

  // One registered font per font file (style fallbacks share a file).
  const names = new Map<fontkit.Font, string>();
  /** Tagged: what a link inside the document goes to, in words. */
  const titles = new Map(dl.sections.map((section) => [section.id, section.title]));

  const faceName = dl.faces.map((_, i) => {
    const font = fonts[i];
    let name = names.get(font);
    if (!name) {
      name = `F${names.size + 1}`;
      names.set(font, name);
      doc.registerFont(name, font);
    }
    return name;
  });

  // ---- archive: only what a font here can draw is drawn
  const drawable = new Map<fontkit.Font, Map<number, boolean>>();
  const drawn = (text: string, font: fontkit.Font): string => {
    let known = drawable.get(font);
    if (!known) drawable.set(font, (known = new Map()));
    let out = "";
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      let can = known.get(code);
      if (can === undefined) {
        can = font.hasGlyphForCodePoint(code);
        known.set(code, can);
      }
      if (can) out += ch;
    }
    return out;
  };

  // ---- pictures: each into the file once, when it is first drawn
  /** Those still to go in. */
  const waiting = new Map(images);
  const asked = new Set<string>();
  /** Those that are in (null: it couldn't be read, and is left out). */
  const pictures = new Map<string, Picture | null>();
  const profiles = new Map<string, Ref>();
  let pictureCount = 0;
  /** The colours a picture's numbers are in, written once for all that share them. */
  const profile = (icc: Uint8Array, parts: number): Ref => {
    let hash = 2166136261;
    for (let i = 0; i < icc.length; i += 1) hash = Math.imul(hash ^ icc[i], 16777619);
    const key = `${parts}:${icc.length}:${hash >>> 0}`;
    let ref = profiles.get(key);
    if (!ref) {
      ref = doc.ref({ N: parts, Alternate: parts === 1 ? "DeviceGray" : "DeviceRGB" });
      ref.end(icc);
      profiles.set(key, ref);
    }
    return ref;
  };
  /** Rows of pixels, packed as a PNG packs them. */
  const packed = (data: Uint8Array, w: number, parts: number) => ({
    bytes: zlibSync(filterRows(data, w, parts)),
    how: { Filter: "FlateDecode", DecodeParms: { Predictor: 15, Colors: parts, BitsPerComponent: 8, Columns: w } },
  });
  const embed = (picture: PdfPicture): Picture => {
    // A press printing in black takes greys and nothing else: no colour, no
    // profile, nothing see-through.
    if (x1a && (!("kind" in picture) || picture.alpha || picture.icc || !(picture.kind === "gray" || (picture.kind === "jpeg" && picture.gray)))) throw new Error("not greys");
    if (!("kind" in picture)) {
      // A file PDFKit reads itself.
      const image = doc.openImage(picture);
      image.embed(doc);
      return image;
    }
    const raw: RawPicture = picture;
    const parts = raw.kind === "gray" || (raw.kind === "jpeg" && raw.gray) ? 1 : 3;
    const colours = raw.kind === "jpeg" ? null : packed(raw.bytes, raw.w, parts);
    // (The file it was made from, where that turned out the smaller.)
    if (colours && raw.file && !raw.alpha && raw.file.length <= colours.bytes.length) return embed(raw.file);
    const size = { Type: "XObject", Subtype: "Image", Width: raw.w, Height: raw.h, BitsPerComponent: 8 };
    let mask: Ref | null = null;
    if (raw.alpha) {
      const opacity = packed(raw.alpha, raw.w, 1);
      mask = doc.ref({ ...size, ColorSpace: "DeviceGray", ...opacity.how });
      mask.end(opacity.bytes);
    }
    const obj = doc.ref({
      ...size,
      ColorSpace: raw.icc ? ["ICCBased", profile(raw.icc, parts)] : parts === 1 ? "DeviceGray" : "DeviceRGB",
      ...(colours ? colours.how : { Filter: "DCTDecode" }),
      ...(mask ? { SMask: mask } : {}),
    });
    obj.end(colours ? colours.bytes : raw.bytes);
    pictureCount += 1;
    return { width: raw.w, height: raw.h, label: `P${pictureCount}`, obj, orientation: raw.orientation ?? 1 };
  };
  const pictureFor = (ref: string): Picture | null => {
    const known = pictures.get(ref);
    if (known !== undefined) return known;
    const picture = waiting.get(ref);
    waiting.delete(ref);
    let made: Picture | null = null;
    if (picture) {
      try {
        made = embed(picture);
      } catch {
        // Not a picture after all: its place stays empty.
        made = null;
      }
    }
    pictures.set(ref, made);
    return made;
  };
  /** Before pages are drawn: the pictures on them that nobody has given yet. */
  const fetchFor = async (pages: (DisplayList["pages"][number] | undefined)[]) => {
    const feed = opts.feed;
    if (!feed) return;
    const need = new Set<string>();
    for (const page of pages) {
      for (const it of page?.items ?? []) {
        if (it.t !== "image") continue;
        const key = pictureKey(it);
        if (!pictures.has(key) && !waiting.has(key) && !asked.has(key)) need.add(key);
      }
    }
    if (!need.size) return;
    for (const ref of need) asked.add(ref);
    try {
      for (const [ref, picture] of await feed([...need])) waiting.set(ref, picture);
    } catch {
      // They are left out, and the one who asked says so.
    }
  };

  // ---- tagged: the structure, and whose each stretch of a page is
  //
  // Elements are made in the order the document reads. Those the model
  // made come in that order by their index, each when the first thing at or
  // after it is drawn (so an empty cell still has its place in its row). A
  // link or a line of the contents is the layout's own, made where it is
  // first drawn. On the page, a run of items with one owner is one marked
  // stretch, and whatever has no owner is marked as decoration.
  const elements: (Struct | undefined)[] = [];
  /** How far the model's elements have been made. */
  let made = 0;
  /** Links made on this sheet: closed with it (a link's place on the page
   *  is written when it is closed, and must be this page). */
  let sheetLinks: Struct[] = [];
  const make = (id: number): Struct => {
    const known = elements[id];
    if (known) return known;
    const node = struct![id];
    const element = doc.struct(node.role, node.alt ? { alt: node.alt } : {});
    if (node.colspan || node.rowspan || node.scope) {
      element.dictionary.data.A = {
        O: "Table",
        ...(node.scope ? { Scope: node.scope } : {}),
        ...(node.colspan ? { ColSpan: node.colspan } : {}),
        ...(node.rowspan ? { RowSpan: node.rowspan } : {}),
      };
    }
    elements[id] = element;
    if (node.parent < 0) doc.addStructure(element);
    else make(node.parent).add(element);
    return element;
  };
  /** The element `id`, with every element of the model's before it made. */
  const element = (id: number): Struct => {
    if (!struct![id].late) {
      for (; made <= id; made += 1) if (!struct![made].late) make(made);
    }
    return make(id);
  };
  /** What is open on the page: an element's stretch, a kind of decoration, or nothing. */
  let open: number | string | null = null;
  const close = () => {
    if (open === null) return;
    doc.endMarkedContent();
    open = null;
  };
  /** Before an item is drawn: the stretch it belongs in is the open one. */
  const within = (s: number | undefined) => {
    if (!struct) return;
    const want: number | string = s !== undefined && s >= 0 && s < struct.length ? s : s === -1 ? "head" : s === -2 ? "foot" : "decoration";
    if (want === open) return;
    close();
    if (typeof want === "number") element(want).add(doc.markStructureContent(struct[want].role));
    else if (want === "decoration") doc.markContent("Artifact", { type: "Layout" });
    else doc.markContent("Artifact", { type: "Pagination", attached: [want === "head" ? "Top" : "Bottom"] });
    open = want;
  };
  /** A sheet is done: nothing stays open across pages. */
  const closeSheet = () => {
    if (!struct) return;
    close();
    for (const link of sheetLinks) link.end();
    sheetLinks = [];
  };

  const draw = (page: DisplayList["pages"][number], dx: number, dy = 0) => {
    if (dx || dy) doc.save().translate(dx, dy);
    // The fill colour in force; only changed when a run asks for another.
    let fill: string | null = null;
    for (const it of page.items) {
      if (it.t === "text") {
        const words = archive ? drawn(it.text, fonts[it.face]) : it.text;
        if (archive && !words.trim()) continue;
        within(it.s);
        const face = dl.faces[it.face];
        const color = it.color ?? null;
        if (color !== fill) {
          doc.fillColor(color ? paint(color) : ink).strokeColor(color ? paint(color) : ink);
          fill = color;
        }
        const textOpts: Record<string, unknown> = {
          lineBreak: false,
          baseline: "alphabetic",
          // Skip PDFKit's own measuring (only used for links/underlines).
          textWidth: 0,
          wordCount: 1,
        };
        if (it.feat?.length) textOpts.features = it.feat;
        if (it.cs) textOpts.characterSpacing = it.cs;
        // With word spacing set, PDFKit shapes word by word — exactly how
        // the layout measured — so it's always on for multi-word runs.
        if (words.includes(" ")) textOpts.wordSpacing = it.ws || 1e-6;
        if (face?.fakeBold) {
          textOpts.fill = true;
          textOpts.stroke = true;
          doc.lineWidth(it.size * 0.035);
        }
        if (face?.fakeItalic) {
          // Shear about the baseline, so the run keeps its place.
          doc.save().transform(1, 0, -OBLIQUE, 1, OBLIQUE * it.y, 0);
        }
        doc.font(faceName[it.face]).fontSize(it.size).text(words, it.x, it.y, textOpts);
        if (face?.fakeItalic) doc.restore();
      } else if (it.t === "rule") {
        within(undefined);
        doc.save().lineWidth(it.w);
        if (it.color) doc.strokeColor(paint(it.color));
        if (it.dash) doc.dash(it.dash[0], { space: it.dash[1] });
        if (it.wave) {
          // A wave along the line: half a wave up, half down, to its end.
          const a = it.wave;
          const half = a * 2;
          doc.moveTo(it.x1, it.y1);
          let up = true;
          for (let x = it.x1; x < it.x2 - 1e-6; x += half) {
            const end = Math.min(it.x2, x + half);
            doc.quadraticCurveTo((x + end) / 2, it.y1 + (up ? -a : a) * 2, end, it.y1);
            up = !up;
          }
          doc.stroke().restore();
        } else doc.moveTo(it.x1, it.y1).lineTo(it.x2, it.y2).stroke().restore();
      } else if (it.t === "rect") {
        within(undefined);
        doc.save().rect(it.x, it.y, it.w, it.h).fill(it.color).restore();
      } else if (it.t === "link") {
        if (!opts.links) continue;
        // Tagged: the link is part of its Link element, and says where it
        // goes in words (a reader of the file is told that, not "link").
        let more: Record<string, unknown> | undefined;
        if (struct && it.s !== undefined && it.s >= 0 && it.s < struct.length) {
          const owner = element(it.s);
          if (!sheetLinks.includes(owner)) sheetLinks.push(owner);
          more = { structParent: owner, Contents: new String(it.url ?? titles.get(it.to ?? "") ?? "A place in this document") };
        }
        if (it.url) doc.link(it.x, it.y, it.w, it.h, it.url, more);
        else if (it.to) doc.goTo(it.x, it.y, it.w, it.h, it.to, more);
      } else if (it.t === "anchor") {
        if (opts.links) doc.addNamedDestination(it.name, "XYZ", null, it.y, null);
      } else {
        within(it.s);
        // (Where a figure is on its page, which a reader that reflows asks.)
        if (struct && it.s !== undefined && it.s >= 0 && it.s < struct.length) {
          const figure = element(it.s).dictionary.data;
          const pageH = page.size?.h ?? h;
          if (!figure.A) figure.A = { O: "Layout", Placement: "Block", BBox: [it.x, pageH - (it.y + it.h), it.x + it.w, pageH - it.y] };
        }
        // (A picture shown cropped or turned comes made so: never its file.)
        const picture = pictureFor(pictureKey(it));
        // A picture's shape: its rectangle, or with corners rounded (all
        // the way: an oval), `by` inside its edge.
        const shape = (by: number) => {
          const w = Math.max(0, it.w - by * 2);
          const h = Math.max(0, it.h - by * 2);
          const round = it.round ?? 0;
          if (round >= 50) return doc.ellipse(it.x + it.w / 2, it.y + it.h / 2, w / 2, h / 2);
          return round > 0 ? doc.roundedRect(it.x + by, it.y + by, w, h, Math.max(0, (Math.min(it.w, it.h) * round) / 100 - by)) : doc.rect(it.x + by, it.y + by, w, h);
        };
        if (picture && it.round) {
          doc.save();
          shape(0).clip();
          doc.image(picture, it.x, it.y, { width: it.w, height: it.h });
          doc.restore();
        } else if (picture) doc.image(picture, it.x, it.y, { width: it.w, height: it.h });
        if (it.border) {
          doc.save().lineWidth(it.border.w).strokeColor(it.border.color);
          shape(it.border.w / 2).stroke();
          doc.restore();
        }
      }
    }
    if (fill !== null) doc.fillColor(ink).strokeColor(ink);
    if (dx || dy) doc.restore();
    closeSheet();
  };

  /** A new sheet: the document's size, or a page's own. With bleed it is
   *  larger than its page, which sits `left` in from its edge (a left-hand
   *  page has its outside edge, and so its bleed, on the left). */
  const newSheet = (size?: { w: number; h: number }, left = 0) => {
    const pw = size?.w ?? sheetW;
    const ph = size?.h ?? h;
    const sw = pw + bleed;
    const sh = ph + bleed * 2;
    doc.addPage({ size: [sw, sh], margin: 0 });
    doc.page.dictionary.data.TrimBox = [left, bleed, left + pw, bleed + ph];
    doc.page.dictionary.data.BleedBox = [0, 0, sw, sh];
    // (Tagged: a keyboard goes through a page's links in reading order.)
    if (struct) doc.page.dictionary.data.Tabs = "S";
    doc.fillColor(ink).strokeColor(ink);
  };

  if (opts.booklet) {
    const n = Math.max(4, Math.ceil(dl.pages.length / 4) * 4);
    for (let side = 0; side < n / 2; side += 1) {
      const outer = n - 1 - side;
      const [left, right] = side % 2 === 0 ? [outer, side] : [side, outer];
      await fetchFor([dl.pages[left], dl.pages[right]]);
      newSheet();
      if (dl.pages[left]) draw(dl.pages[left], 0);
      if (dl.pages[right]) draw(dl.pages[right], w);
      if (side % 8 === 7) {
        onProgress?.(Math.min(dl.pages.length, (side + 1) * 2), dl.pages.length);
        await tick();
      }
    }
  } else {
    const sectionsAt = new Map<number, typeof dl.sections>();
    for (const s of dl.sections) {
      const list = sectionsAt.get(s.firstPage) ?? [];
      list.push(s);
      sectionsAt.set(s.firstPage, list);
    }
    // The outline nests by level: each entry goes under the nearest earlier
    // entry of a lower level (a chapter under its part, a subsection under
    // its section).
    const open: { level: number; item: Outline }[] = [];
    for (let pi = 0; pi < dl.pages.length; pi += 1) {
      await fetchFor([dl.pages[pi]]);
      const left = bleed && dl.pages[pi].side === "verso" ? bleed : 0;
      newSheet(dl.pages[pi].size, left);
      draw(dl.pages[pi], left, bleed);
      for (const s of sectionsAt.get(pi) ?? []) {
        while (open.length && open[open.length - 1].level >= s.level) open.pop();
        const parent = open.length ? open[open.length - 1].item : doc.outline;
        open.push({ level: s.level, item: parent.addItem(s.title) });
      }
      if (pi % 16 === 15) {
        onProgress?.(pi + 1, dl.pages.length);
        await tick();
      }
    }
  }
  // Tagged: whatever of the model's structure nothing was drawn for (an
  // empty cell at a table's end) still has its place.
  if (struct) for (; made < struct.length; made += 1) if (!struct[made].late) make(made);

  // What a reader's page box shows: the numbers printed on the pages. (A
  // booklet's sheets are not the book's pages.)
  if (!opts.booklet) {
    const runs = pageLabels(dl.pages.map((page) => page.folio));
    if (!plainLabels(runs)) {
      doc._root.data.PageLabels = {
        Nums: runs.flatMap((run) => [
          run.at,
          // (To PDFKit a plain string is a name and a String a text.)
          run.text !== undefined ? { P: new String(run.text) } : { S: run.style, ...(run.start !== undefined ? { St: run.start } : {}) },
        ]),
      };
    }
  }
  // A press: the printing condition the file was made for. A registered
  // one, named (so nothing more is carried): black ink on a web press.
  if (x1a) {
    const intent = doc.ref({
      Type: "OutputIntent",
      S: "GTS_PDFX",
      OutputConditionIdentifier: new String("CGATS TR 001"),
      OutputCondition: new String("SWOP (publication) printing"),
      RegistryName: new String("http://www.color.org"),
      Info: new String("CGATS TR 001 (SWOP)"),
    });
    intent.end();
    doc._root.data.OutputIntents = [intent];
  }
  // The document this was made from, beside its pages (and said to be
  // that: its source).
  if (attach) {
    doc.file(attach.bytes, { name: attach.name, type: attach.type, relationship: "Source", description: attach.description, creationDate: now, modifiedDate: now });
  }
  // Archive: what the file's colour numbers mean.
  if (archive) {
    const intent = doc.ref({
      Type: "OutputIntent",
      S: "GTS_PDFA1",
      OutputConditionIdentifier: new String("sRGB IEC61966-2.1"),
      Info: new String("sRGB IEC61966-2.1"),
      DestOutputProfile: profile(srgbProfile(), 3),
    });
    intent.end();
    doc._root.data.OutputIntents = [intent];
  }
  doc.end();
  await finished;

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
