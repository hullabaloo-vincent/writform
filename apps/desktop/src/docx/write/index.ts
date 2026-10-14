/**
 * Write a Word document (.docx) from editor content: real headings, nested
 * lists with their own numbering, quotes, code, dividers, pictures, links,
 * and the document's page setup, headers and footers. What Word shows is
 * what the document says, so the file reads back the same (see ../read).
 */

import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";

import {
  bodyLook,
  DEFAULT_SETTINGS,
  pageDims,
  sectionSettings,
  type DocSettings,
  type SlotKey,
} from "../../apps/documents/docSettings";
import { noteKind, type NoteKind } from "../../editor/nodes/Footnote";
import { imageAlign, imageCaption } from "../../editor/nodes/Image";
import { tocDepth } from "../../editor/nodes/Toc";
import { parseRevs, revOf, type NodeRevs, type Rev } from "../../editor/review/TrackMarks";
import { linesAttr, parseCols } from "../../editor/tables/Table";
import { XML_HEAD, xmlEscape } from "../../apps/documents/ooxml";
import { BORDER_PAD_X, BORDER_PAD_Y, colorAttr, firstIndentAttr, indentAttr, lineAtAttr, lineRuleAttr, MARKER_GLYPH, markerAttr, parseBorder, parseSection, sizeAttr, vscriptAttr, type BulletMarker, type SectionProps, type VScript, cellEdges, imageBorder, imageRound } from "../../editor/schema/sanitize";
import {
  BODY_AFTER,
  BODY_LINE,
  BODY_SIZE,
  BULLETS,
  CODE_SIZE,
  LEGAL,
  LIST_HANG,
  LIST_INDENT,
  NUMBER_CYCLE,
  resolveStyles,
  type ResolvedStyles,
  type StyleLook,
  type StyleOverrides,
} from "../../editor/styles/sheet";
import { catalogNow } from "../../fonts/catalog";
import { DEFAULT_WORD_FONT, docxFontName, wordAltName, wordFamilyOf } from "../../fonts/docx";
import { parseFontId } from "../../fonts/ids";
import { knownFont, type FontCategory } from "../../fonts/registry";
import { ordered, wrap } from "./order";

export interface DocxImage {
  bytes: Uint8Array;
  /** `image/png`, `image/jpeg` or `image/gif`. */
  type: string;
  /** Natural size in pixels, when known. */
  width?: number;
  height?: number;
}

export interface DocxWriteOptions {
  title: string;
  author?: string;
  /** The document's format id (`none`, `screenplay`, …). */
  format: string;
  /** Page setup and body text; absent for the scripted formats. */
  settings?: DocSettings;
  /** Picture bytes by the image node's `src`. Missing ones are left out. */
  images?: Map<string, DocxImage>;
  /** What the document has changed about its styles. */
  styles?: StyleOverrides;
  /** The page each top-level heading (with text) lands on, in order — for
   *  a table of contents. Absent: Word fills the numbers in when asked. */
  tocPages?: string[];
}

/** Word's highlighter pens, by colour; any other colour is run shading. */
const HIGHLIGHT_NAME: Record<string, string> = {
  "#ffff00": "yellow",
  "#00ff00": "green",
  "#00ffff": "cyan",
  "#ff00ff": "magenta",
  "#0000ff": "blue",
  "#ff0000": "red",
  "#000080": "darkBlue",
  "#008080": "darkCyan",
  "#008000": "darkGreen",
  "#800080": "darkMagenta",
  "#800000": "darkRed",
  "#808000": "darkYellow",
  "#808080": "darkGray",
  "#c0c0c0": "lightGray",
  "#000000": "black",
};

const hexVal = (color: string) => color.slice(1).toUpperCase();

/** The Word style a built-in paragraph style is written as. */
const STYLE_IDS: Record<string, string> = {
  title: "Title",
  subtitle: "Subtitle",
  caption: "Caption",
  nospace: "NoSpacing",
  quote: "Quote",
};
/** A style id Word accepts for one of the document's own styles. */
const customStyleId = (id: string) => `U${id.replace(/[^a-z0-9]/g, "")}`;

/** As little of a paragraph as there can be (between two tables; at the
 *  end of a section that a table closes). */
const TINY = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>';
const TABLE_GAP = `<w:p><w:pPr>${TINY}<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;

/** A face with the boxes and ticks checklists are marked with. */
const SYMBOL_FONT = "Segoe UI Symbol";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const twips = (points: number) => Math.round(points * 20);
const twipsIn = (inches: number) => Math.round(inches * 1440);
const halfPoints = (points: number) => Math.round(points * 2);
const EMU_PER_PX = 9525;

const SCREENPLAY_STYLES: Record<string, string> = {
  scene_heading: "SceneHeading",
  action: "Action",
  character: "Character",
  parenthetical: "Parenthetical",
  dialogue: "Dialogue",
  transition: "Transition",
};

const NUM_FMT: Record<string, string> = { a: "lowerLetter", A: "upperLetter", i: "lowerRoman", I: "upperRoman" };

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif" };

const PN_FMT: Record<string, string> = {
  "1": "decimal",
  i: "lowerRoman",
  I: "upperRoman",
  a: "lowerLetter",
  A: "upperLetter",
};

type Parts = Record<string, string | string[] | null | undefined | false>;

interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  /** The run's own typeface (its Word name), size, colour and highlight. */
  font?: string | null;
  size?: number | null;
  color?: string | null;
  highlight?: string | null;
  vscript?: VScript | null;
}

/** A paragraph's own font and size, repeated on each of its runs. */
interface Face {
  font: string | null;
  size: number | null;
}

class Writer {
  private rels: string[] = [];
  private relId = 0;
  private links = new Map<string, string>();
  private media: { path: string; bytes: Uint8Array; ext: string }[] = [];
  private mediaRel = new Map<string, { id: string; image: DocxImage }>();
  private nums: string[] = [];
  private abstracts: string[] = [];
  private drawingId = 0;
  /** Pictures the caller had no bytes for. */
  missingImages = 0;
  /** Footnotes and endnotes, as the parts that hold them will. */
  readonly notes: Record<NoteKind, string[]> = { foot: [], end: [] };
  /** The document's headings (top level, with text), for a contents. */
  outline: { level: number; title: string }[] = [];
  /** The width of the text, twentieths of a point. */
  textWidth = 9360;

  /** The document's styles, as its body text and its changes make them. */
  readonly styles: ResolvedStyles;

  constructor(private opts: DocxWriteOptions) {
    this.styles = resolveStyles(bodyLook(opts.settings ?? DEFAULT_SETTINGS), opts.format === "none" ? opts.styles : {});
  }

  rel(type: string, target: string, external = false): string {
    this.relId += 1;
    const id = `rId${this.relId}`;
    this.rels.push(
      `<Relationship Id="${id}" Type="${REL}/${type}" Target="${xmlEscape(target)}"${external ? ' TargetMode="External"' : ""}/>`,
    );
    return id;
  }

  relsXml(): string {
    return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.rels.join("")}</Relationships>`;
  }

  get mediaFiles() {
    return this.media;
  }

  // ---- runs

  // ---- tracked changes

  private revId = 9000;
  /** Paragraphs whose mark — the break after them — is a tracked change
   *  (the document says it of the paragraph that follows). */
  private breaks = new Map<JSONContent, NodeRevs>();

  /** Find the tracked paragraph breaks, before anything is written. */
  noteBreaks(doc: JSONContent): void {
    let prev: JSONContent | null = null;
    const walk = (node: JSONContent) => {
      const type = node.type;
      if (type === "paragraph" || type === "heading") {
        const revs = parseRevs(node.attrs?.tc);
        if (revs && prev) this.breaks.set(prev, revs);
        prev = node;
        return;
      }
      // Nothing joins across a cell's edge, a table, a picture, a rule.
      if (type === "tableCell") prev = null;
      (node.content ?? []).forEach(walk);
      if (type === "tableCell" || type === "table" || type === "image" || type === "horizontalRule" || type === "toc" || type === "codeBlock") prev = null;
    };
    (doc.content ?? []).forEach(walk);
  }

  /** `w:id`, author and date of one tracked change. */
  private revAttrs(rev: Rev): string {
    this.revId += 1;
    const date = rev.t ? ` w:date="${new Date(rev.t * 1000).toISOString().replace(/\.\d+Z$/, "Z")}"` : "";
    return `w:id="${this.revId}" w:author="${xmlEscape(rev.a || "Unknown")}"${date}`;
  }

  /** Runs wrapped as inserted, deleted, or inserted then deleted. */
  private tracked(xml: string, revs: NodeRevs | null): string {
    if (!revs || !xml) return xml;
    let out = xml;
    if (revs.del) out = `<w:del ${this.revAttrs(revs.del)}>${out}</w:del>`;
    if (revs.ins) out = `<w:ins ${this.revAttrs(revs.ins)}>${out}</w:ins>`;
    return out;
  }

  private rPr(marks: Marks, face: Face, mark: NodeRevs | null = null): string {
    if (marks.code) this.fonts.set("Courier New", "monospace");
    const fontName = marks.code ? "Courier New" : (marks.font ?? face.font);
    const font = fontName ? xmlEscape(fontName) : null;
    const size = marks.size ?? face.size;
    const pen = marks.highlight ? HIGHLIGHT_NAME[marks.highlight] : null;
    const parts: Parts = {
      ins: mark?.ins ? `<w:ins ${this.revAttrs(mark.ins)}/>` : null,
      del: mark?.del ? `<w:del ${this.revAttrs(mark.del)}/>` : null,
      rStyle: marks.href ? '<w:rStyle w:val="Hyperlink"/>' : marks.code ? '<w:rStyle w:val="InlineCode"/>' : null,
      rFonts: font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : null,
      b: marks.bold ? "<w:b/>" : null,
      i: marks.italic ? "<w:i/>" : null,
      strike: marks.strike ? "<w:strike/>" : null,
      color: marks.color ? `<w:color w:val="${hexVal(marks.color)}"/>` : null,
      sz: size ? `<w:sz w:val="${halfPoints(size)}"/>` : null,
      szCs: size ? `<w:szCs w:val="${halfPoints(size)}"/>` : null,
      highlight: pen ? `<w:highlight w:val="${pen}"/>` : null,
      u: marks.underline ? '<w:u w:val="single"/>' : null,
      // A highlight in a colour Word has no pen for is shading on the run.
      shd: marks.highlight && !pen ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexVal(marks.highlight)}"/>` : null,
      vertAlign: marks.vscript ? `<w:vertAlign w:val="${marks.vscript === "super" ? "superscript" : "subscript"}"/>` : null,
    };
    return wrap("rPr", parts);
  }

  /** Text as run content: tabs and line breaks are elements, not
   *  characters. (Deleted text has an element of its own.) */
  private textXml(text: string, deleted = false): string {
    let out = "";
    const tag = deleted ? "w:delText" : "w:t";
    for (const piece of text.split(/(\t|\n)/)) {
      if (piece === "\t") out += "<w:tab/>";
      else if (piece === "\n") out += "<w:br/>";
      else if (piece) out += `<${tag} xml:space="preserve">${xmlEscape(piece)}</${tag}>`;
    }
    return out;
  }

  private runs(nodes: JSONContent[] | undefined, face: Face, plainLinks = false): string {
    let out = "";
    // Adjacent runs under one link share a single w:hyperlink.
    let open: string | null = null;
    const close = () => {
      if (open !== null) out += "</w:hyperlink>";
      open = null;
    };
    for (const node of nodes ?? []) {
      if (node.type === "footnote") {
        close();
        out += this.tracked(this.noteRef(node), parseRevs(node.attrs?.tc));
        continue;
      }
      const marks: Marks = {};
      // A suggested change: Word's tracked insertion or deletion.
      const revs: NodeRevs = node.type === "text" ? {} : (parseRevs(node.attrs?.tc) ?? {});
      for (const m of node.marks ?? []) {
        if (m.type === "insertion") revs.ins = revOf(m.attrs);
        else if (m.type === "deletion") revs.del = revOf(m.attrs);
      }
      const changed = revs.ins || revs.del ? revs : null;
      for (const m of node.marks ?? []) {
        if (m.type === "bold") marks.bold = true;
        else if (m.type === "italic") marks.italic = true;
        else if (m.type === "underline") marks.underline = true;
        else if (m.type === "strike") marks.strike = true;
        else if (m.type === "code") marks.code = true;
        else if (m.type === "link" && typeof m.attrs?.href === "string" && m.attrs.href) marks.href = m.attrs.href;
        else if (m.type === "fontFamily") marks.font = this.fontName(typeof m.attrs?.f === "string" ? m.attrs.f : null);
        else if (m.type === "fontSize") marks.size = sizeAttr(m.attrs?.pt);
        else if (m.type === "textColor") marks.color = colorAttr(m.attrs?.c);
        else if (m.type === "highlight") marks.highlight = colorAttr(m.attrs?.c);
        else if (m.type === "vscript") marks.vscript = vscriptAttr(m.attrs?.v);
      }
      // (A note is a part of its own, with no links of its own: its words
      // keep their look.)
      const href = plainLinks ? null : (marks.href ?? null);
      if (plainLinks) delete marks.href;
      if (href !== open) {
        close();
        if (href !== null) {
          let id = this.links.get(href);
          if (!id) {
            id = this.rel("hyperlink", href, true);
            this.links.set(href, id);
          }
          out += `<w:hyperlink r:id="${id}" w:history="1">`;
          open = href;
        }
      }
      const rPr = this.rPr(marks, face);
      if (node.type === "hardBreak") out += this.tracked(`<w:r>${rPr}<w:br/></w:r>`, changed);
      else if (node.type === "text" && node.text) out += this.tracked(`<w:r>${rPr}${this.textXml(node.text, !!revs.del)}</w:r>`, changed);
    }
    close();
    return out;
  }

  /** A note: its text goes to the notes part; here, its reference. */
  private noteRef(node: JSONContent): string {
    const kind = noteKind(node.attrs?.kind);
    const tag = kind === "end" ? "endnote" : "footnote";
    const style = kind === "end" ? "Endnote" : "Footnote";
    const id = this.notes[kind].length + 1;
    this.notes[kind].push(
      `<w:${tag} w:id="${id}"><w:p><w:pPr><w:pStyle w:val="${style}Text"/></w:pPr>` +
        `<w:r><w:rPr><w:rStyle w:val="${style}Reference"/></w:rPr><w:${tag}Ref/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>` +
        `${this.runs(node.content, { font: null, size: null }, true)}</w:p></w:${tag}>`,
    );
    return `<w:r><w:rPr><w:rStyle w:val="${style}Reference"/></w:rPr><w:${tag}Reference w:id="${id}"/></w:r>`;
  }

  // ---- paragraphs

  /** Every family the file names, with what kind of face it is. */
  readonly fonts = new Map<string, FontCategory | undefined>();

  /** A font id's Word name, noted for the file's font table. */
  fontName(id: string | null | undefined): string | null {
    const name = docxFontName(id);
    if (name && id) {
      const parsed = parseFontId(id);
      const category =
        knownFont(id)?.category ?? (parsed?.source === "gf" ? catalogNow()?.byId.get(parsed.key)?.category : undefined);
      if (!this.fonts.has(name) || category) this.fonts.set(name, category ?? this.fonts.get(name));
    }
    return name;
  }

  private face(node: JSONContent): Face {
    const size = Number(node.attrs?.size);
    return {
      font: this.fontName(typeof node.attrs?.font === "string" ? node.attrs.font : null),
      size: Number.isFinite(size) && size > 0 ? size : null,
    };
  }

  /** The properties a paragraph's own attributes ask for. */
  private attrsParts(node: JSONContent, face: Face): Parts {
    const a = node.attrs ?? {};
    const spacing: string[] = [];
    if (typeof a.sa === "number") spacing.push(`w:before="${twips(a.sa)}"`);
    if (typeof a.sb === "number") spacing.push(`w:after="${twips(a.sb)}"`);
    const rule = lineRuleAttr(a.lineRule);
    const at = rule ? lineAtAttr(a.lineAt) : null;
    if (rule && at !== null) {
      spacing.push(`w:line="${twips(at)}" w:lineRule="${rule}"`);
    } else if (typeof a.line === "number" && a.line > 0) {
      spacing.push(`w:line="${Math.round(a.line * 240)}" w:lineRule="auto"`);
    }
    const jc = a.align === "center" ? "center" : a.align === "right" ? "right" : a.align === "justify" ? "both" : "";
    // Indents: only what the paragraph says for itself (its style has the rest).
    const ind: string[] = [];
    const indL = indentAttr(a.indL);
    const indR = indentAttr(a.indR);
    const indF = firstIndentAttr(a.indF);
    if (indL !== null) ind.push(`w:left="${twips(indL)}"`);
    if (indR !== null) ind.push(`w:right="${twips(indR)}"`);
    if (indF !== null) ind.push(indF < 0 ? `w:hanging="${twips(-indF)}"` : `w:firstLine="${twips(indF)}"`);
    // The body's first-line indent belongs to running prose: a centred or
    // right-set line would read as misaligned.
    else if (ind.length && (a.align === "center" || a.align === "right")) ind.push('w:firstLine="0"');
    const border = parseBorder(a.bdr);
    let pBdr: string | null = null;
    if (border) {
      const side = (name: string, space: number) =>
        `<w:${name} w:val="single" w:sz="${Math.max(2, Math.round(border.width * 8))}" w:space="${space}" w:color="${hexVal(border.color)}"/>`;
      pBdr =
        "<w:pBdr>" +
        (border.sides.includes("t") ? side("top", BORDER_PAD_Y) : "") +
        (border.sides.includes("l") ? side("left", BORDER_PAD_X) : "") +
        (border.sides.includes("b") ? side("bottom", BORDER_PAD_Y) : "") +
        (border.sides.includes("r") ? side("right", BORDER_PAD_X) : "") +
        "</w:pBdr>";
    }
    const shade = colorAttr(a.shade);
    // The paragraph mark carries the face too, so an empty line keeps it —
    // and says when the break after it is a tracked change.
    const mark = this.rPr({}, face, this.breaks.get(node) ?? null);
    return {
      keepNext: a.keepNext === true ? "<w:keepNext/>" : null,
      keepLines: a.keepLines === true ? "<w:keepLines/>" : null,
      pageBreakBefore: a.pageBreakBefore ? "<w:pageBreakBefore/>" : null,
      pBdr,
      shd: shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexVal(shade)}"/>` : null,
      spacing: spacing.length ? `<w:spacing ${spacing.join(" ")}/>` : null,
      ind: ind.length ? `<w:ind ${ind.join(" ")}/>` : null,
      jc: jc ? `<w:jc w:val="${jc}"/>` : null,
      rPr: mark || null,
    };
  }

  private paragraph(node: JSONContent, extra: Parts = {}): string {
    const face = this.face(node);
    const parts: Parts = { ...this.attrsParts(node, face), ...extra };
    const align = node.attrs?.align;
    // The body's first-line indent belongs to running prose: a centred or
    // right-set line would read as misaligned.
    if ((align === "center" || align === "right") && !parts.ind && !parts.numPr) {
      parts.ind = '<w:ind w:firstLine="0"/>';
    }
    if (node.attrs?.dropCap && this.opts.format !== "screenplay") {
      const framed = this.dropCap(node, face, parts);
      if (framed) return framed;
    }
    const colBreak = node.attrs?.colBreak === true ? '<w:r><w:br w:type="column"/></w:r>' : "";
    return `<w:p>${wrap("pPr", parts)}${colBreak}${this.runs(node.content, face)}</w:p>`;
  }

  /** A real Word drop cap: the first letter in its own frame paragraph, the
   *  rest following as the normal paragraph — the shape Word itself writes. */
  private dropCap(node: JSONContent, face: Face, parts: Parts): string | null {
    const content = (node.content ?? []).map((n) => ({ ...n }));
    const first = content.findIndex((n) => n.type === "text" && (n.text ?? "").trim());
    if (first < 0) return null;
    const text = (content[first].text ?? "").replace(/^\s+/, "");
    const letter = [...text][0];
    const rest = text.slice(letter.length);
    if (!rest && content.length === first + 1) return null;
    content[first] = { ...content[first], text: rest };
    const base = face.size ?? this.opts.settings?.bodySize ?? BODY_SIZE;
    const font = face.font ? xmlEscape(face.font) : null;
    const frame =
      `<w:p>${wrap("pPr", {
        pageBreakBefore: parts.pageBreakBefore,
        framePr: '<w:framePr w:dropCap="drop" w:lines="3" w:hSpace="57" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>',
        spacing: `<w:spacing w:after="0" w:line="${Math.round(base * 69)}" w:lineRule="exact"/>`,
        ind: '<w:ind w:firstLine="0"/>',
      })}<w:r>${wrap("rPr", {
        rFonts: font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>` : null,
        sz: `<w:sz w:val="${halfPoints(Math.round(base * 3.3))}"/>`,
      })}<w:t xml:space="preserve">${xmlEscape(letter)}</w:t></w:r></w:p>`;
    const body = `<w:p>${wrap("pPr", { ...parts, pageBreakBefore: null, ind: '<w:ind w:firstLine="0"/>' })}${this.runs(
      content.filter((n) => n.type !== "text" || n.text),
      face,
    )}</w:p>`;
    return frame + body;
  }

  private image(node: JSONContent): string {
    const src = String(node.attrs?.src ?? "");
    let entry = this.mediaRel.get(src);
    if (!entry) {
      const image = this.opts.images?.get(src);
      const ext = image ? IMAGE_EXT[image.type] : undefined;
      if (!image || !ext) {
        this.missingImages += 1;
        return "";
      }
      const name = `image${this.media.length + 1}.${ext}`;
      this.media.push({ path: `word/media/${name}`, bytes: image.bytes, ext });
      entry = { id: this.rel("image", `media/${name}`), image };
      this.mediaRel.set(src, entry);
    }
    // The size the document gives it, else its own, capped to the text width.
    const s = this.opts.settings ?? DEFAULT_SETTINGS;
    const maxPx = Math.max(96, (pageDims(s).w - s.ml - s.mr - s.gutter) * 96);
    let w = Number(node.attrs?.width) || entry.image.width || 480;
    let h = Number(node.attrs?.height) || entry.image.height || 0;
    if (!h) h = entry.image.width && entry.image.height ? (w * entry.image.height) / entry.image.width : w * 0.75;
    if (w > maxPx) {
      h = (h * maxPx) / w;
      w = maxPx;
    }
    const cx = Math.round(w * EMU_PER_PX);
    const cy = Math.round(h * EMU_PER_PX);
    this.drawingId += 1;
    const id = this.drawingId;
    const alt = xmlEscape(String(node.attrs?.alt ?? node.attrs?.title ?? ""));
    // Its shape (corners rounded, or an oval) and the line round it.
    const round = imageRound(node.attrs?.round);
    const geom = !round
      ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
      : round >= 50
        ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
        : `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(round * 1000)}"/></a:avLst></a:prstGeom>`;
    const edge = imageBorder(node.attrs?.bdr);
    const outline = edge ? `<a:ln w="${Math.round(edge.w * 12700)}"><a:solidFill><a:srgbClr val="${hexVal(edge.color)}"/></a:solidFill></a:ln>` : "";
    const drawing =
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${id}" name="Picture ${id}"${alt ? ` descr="${alt}"` : ""}/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${entry.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${geom}${outline}</pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
    const align = imageAlign(node.attrs?.align);
    const jc = align ? `<w:jc w:val="${align}"/>` : null;
    const caption = imageCaption(node.attrs?.caption);
    const picture = `<w:p>${wrap("pPr", { keepNext: caption ? "<w:keepNext/>" : null, ind: '<w:ind w:firstLine="0"/>', jc })}${this.tracked(`<w:r>${drawing}</w:r>`, parseRevs(node.attrs?.tc))}</w:p>`;
    if (!caption) return picture;
    // The caption: a paragraph of its own in the Caption style, kept with
    // the picture and set to the same side.
    return `${picture}<w:p>${wrap("pPr", { pStyle: '<w:pStyle w:val="Caption"/>', jc })}<w:r>${this.textXml(caption)}</w:r></w:p>`;
  }

  // ---- tables

  private table(node: JSONContent, depth: number, quoted: boolean): string {
    const rows = node.content ?? [];
    const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, 63) : 1);
    const count = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((n, c) => n + whole(c.attrs?.colspan), 0)));
    const own = parseCols(node.attrs?.cols, count);
    const widths = (own ?? Array.from({ length: count }, () => this.textWidth / 20 / count)).map((w) => Math.max(1, twips(w)));
    const lines = linesAttr(node.attrs?.lines);
    const line = '<w:{n} w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
    const none = '<w:{n} w:val="nil"/>';
    const side = (name: string, on: boolean) => (on ? line : none).replace("{n}", name);
    const outer = lines === "all" || lines === "box";
    const borders = wrap("tblBorders", {
      top: side("top", outer || lines === "rows"),
      left: side("left", outer),
      bottom: side("bottom", outer || lines === "rows"),
      right: side("right", outer),
      insideH: side("insideH", lines === "all" || lines === "rows"),
      insideV: side("insideV", lines === "all"),
    });
    const tblPr = wrap("tblPr", {
      // Its own width — or all of the text's, shared out.
      tblW: own ? `<w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` : '<w:tblW w:w="5000" w:type="pct"/>',
      tblBorders: borders,
      tblLayout: '<w:tblLayout w:type="fixed"/>',
      tblCellMar: '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>',
    });
    const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;

    // A cell that runs down rows is a cell in each of them for Word: the
    // first starts the merge, the others go on with it.
    const open: ({ span: number; left: number } | null)[] = Array.from({ length: count }, () => null);
    let out = "";
    const whose = parseRevs(node.attrs?.tc);
    rows.forEach((row, r) => {
      let cells = "";
      const queue = [...(row.content ?? [])];
      let c = 0;
      while (c < count) {
        const above = open[c];
        const widthOf = (span: number) => widths.slice(c, c + span).reduce((a, b) => a + b, 0);
        if (above) {
          cells += `<w:tc>${wrap("tcPr", { tcW: `<w:tcW w:w="${widthOf(above.span)}" w:type="dxa"/>`, gridSpan: above.span > 1 ? `<w:gridSpan w:val="${above.span}"/>` : null, vMerge: "<w:vMerge/>" })}<w:p/></w:tc>`;
          above.left -= 1;
          const span = above.span;
          if (above.left <= 0) for (let i = c; i < c + span; i += 1) open[i] = null;
          c += span;
          continue;
        }
        const cell = queue.shift();
        if (!cell) {
          // A row short of cells (a concurrent edit): filled out, so the
          // grid stays whole.
          cells += `<w:tc>${wrap("tcPr", { tcW: `<w:tcW w:w="${widths[c]}" w:type="dxa"/>` })}<w:p/></w:tc>`;
          c += 1;
          continue;
        }
        const span = Math.min(whole(cell.attrs?.colspan), count - c);
        const down = Math.min(whole(cell.attrs?.rowspan), rows.length - r);
        const bg = colorAttr(cell.attrs?.bg);
        const edges = cellEdges(cell.attrs?.bdr);
        const names = { t: "top", l: "left", b: "bottom", r: "right" } as const;
        const tcBorders = edges
          ? `<w:tcBorders>${(["t", "l", "b", "r"] as const)
              .filter((side) => edges[side])
              .map((side) => {
                const e = edges[side]!;
                return e.w > 0 ? `<w:${names[side]} w:val="single" w:sz="${Math.max(2, Math.round(e.w * 8))}" w:space="0" w:color="${hexVal(e.color)}"/>` : `<w:${names[side]} w:val="nil"/>`;
              })
              .join("")}</w:tcBorders>`
          : null;
        const blocks = cell.content ?? [];
        let inner = this.blocksXml(blocks, depth, quoted);
        // A cell holds at least a paragraph, and ends with one.
        if (!inner || blocks[blocks.length - 1]?.type === "table") inner += "<w:p/>";
        cells += `<w:tc>${wrap("tcPr", {
          tcW: `<w:tcW w:w="${widthOf(span)}" w:type="dxa"/>`,
          gridSpan: span > 1 ? `<w:gridSpan w:val="${span}"/>` : null,
          vMerge: down > 1 ? '<w:vMerge w:val="restart"/>' : null,
          tcBorders,
          shd: bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexVal(bg)}"/>` : null,
        })}${inner}</w:tc>`;
        if (down > 1) {
          const held = { span, left: down - 1 };
          for (let i = c; i < c + span; i += 1) open[i] = held;
        }
        c += span;
      }
      // A table suggested (or struck) whole: each of its rows says so.
      const trPr = wrap("trPr", {
        tblHeader: r === 0 && node.attrs?.head === true ? "<w:tblHeader/>" : null,
        ins: whose?.ins ? `<w:ins ${this.revAttrs(whose.ins)}/>` : null,
        del: whose?.del ? `<w:del ${this.revAttrs(whose.del)}/>` : null,
      });
      out += `<w:tr>${trPr}${cells}</w:tr>`;
    });
    return `<w:tbl>${tblPr}${grid}${out}</w:tbl>`;
  }

  /** A table of contents: a field Word can update, holding the headings as
   *  they stand (with their pages, when the caller knew them). */
  private toc(node: JSONContent): string {
    const depth = tocDepth(node.attrs?.depth);
    const begin =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-${depth}" \\h \\z \\u </w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
    const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const entries = this.outline.map((e, i) => ({ ...e, page: this.opts.tocPages?.[i] ?? "" })).filter((e) => e.level <= depth);
    if (!entries.length) {
      return `<w:p>${begin}<w:r><w:t xml:space="preserve">Headings you add will be listed here.</w:t></w:r>${end}</w:p>`;
    }
    const tabs = `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${this.textWidth}"/></w:tabs>`;
    return entries
      .map(
        (e, i) =>
          `<w:p>${wrap("pPr", { pStyle: `<w:pStyle w:val="TOC${e.level}"/>`, tabs })}${i === 0 ? begin : ""}` +
          `<w:r><w:t xml:space="preserve">${xmlEscape(e.title)}</w:t></w:r>${e.page ? `<w:r><w:tab/></w:r><w:r><w:t>${xmlEscape(e.page)}</w:t></w:r>` : ""}` +
          `${i === entries.length - 1 ? end : ""}</w:p>`,
      )
      .join("");
  }

  // ---- lists

  private level(ilvl: number, fmt: string, text: string, start: number, font?: string): string {
    const left = twips(LIST_INDENT * (ilvl + 1));
    const face = font ? xmlEscape(font) : null;
    if (font) this.fonts.set(font, this.fonts.get(font));
    return `<w:lvl w:ilvl="${ilvl}">${ordered("lvl", {
      start: `<w:start w:val="${start}"/>`,
      numFmt: `<w:numFmt w:val="${fmt}"/>`,
      lvlText: `<w:lvlText w:val="${xmlEscape(text)}"/>`,
      lvlJc: '<w:lvlJc w:val="left"/>',
      pPr: `<w:pPr><w:ind w:left="${left}" w:hanging="${twips(LIST_HANG)}"/></w:pPr>`,
      rPr: face ? `<w:rPr><w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:hint="default"/></w:rPr>` : null,
    })}</w:lvl>`;
  }

  private newNum(levels: string[], kind = "hybridMultilevel"): number {
    const abstractId = this.abstracts.length;
    this.abstracts.push(
      `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="${kind}"/>${levels.join("")}</w:abstractNum>`,
    );
    const numId = this.nums.length + 1;
    this.nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`);
    return numId;
  }

  private bulletNums = new Map<string, number>();

  /** Bulleted lists of one kind share a definition (bullets don't count). */
  private bullets(marker: BulletMarker | null): number {
    const key = marker ?? "";
    let num = this.bulletNums.get(key);
    if (!num) {
      num = this.newNum(
        Array.from({ length: 9 }, (_, i) =>
          marker
            ? this.level(i, "bullet", MARKER_GLYPH[marker], 1, marker === "check" || marker === "arrow" ? SYMBOL_FONT : undefined)
            : this.level(i, "bullet", BULLETS[i % BULLETS.length], 1),
        ),
      );
      this.bulletNums.set(key, num);
    }
    return num;
  }

  /** A checklist: a box per item, ticked or not (two definitions — the
   *  mark is the list's, in Word). */
  private tasks(checked: boolean): number {
    const key = checked ? "task:on" : "task:off";
    let num = this.bulletNums.get(key);
    if (!num) {
      num = this.newNum(Array.from({ length: 9 }, (_, i) => this.level(i, "bullet", checked ? "\u2612" : "\u2610", 1, SYMBOL_FONT)));
      this.bulletNums.set(key, num);
    }
    return num;
  }

  /** A numbered list gets a definition of its own, so its count is its own. */
  private numbered(depth: number, type: unknown, start: unknown): number {
    const first = Number.isFinite(Number(start)) && Number(start) >= 0 ? Math.round(Number(start)) : 1;
    return this.newNum(
      Array.from({ length: 9 }, (_, i) => {
        const fmt =
          i === depth ? (NUM_FMT[String(type ?? "")] ?? "decimal") : NUMBER_CYCLE[i % NUMBER_CYCLE.length];
        return this.level(i, fmt, `%${i + 1}.`, i === depth ? first : 1);
      }),
    );
  }

  /** Legal numbering from `depth` down: "1.", "1.1.", "1.1.1." — one
   *  definition for the list and the lists inside it. */
  private legal(depth: number, start: unknown): number {
    const first = Number.isFinite(Number(start)) && Number(start) >= 0 ? Math.round(Number(start)) : 1;
    return this.newNum(
      Array.from({ length: 9 }, (_, i) => {
        if (i < depth) return this.level(i, "decimal", `%${i + 1}.`, 1);
        let text = "";
        for (let k = depth; k <= i; k += 1) text += `%${k + 1}.`;
        return this.level(i, "decimal", text, i === depth ? first : 1);
      }),
      "multilevel",
    );
  }

  numberingXml(): string | null {
    if (!this.nums.length) return null;
    return `${XML_HEAD}<w:numbering ${NS}>${this.abstracts.join("")}${this.nums.join("")}</w:numbering>`;
  }

  /** `legalNum`: the definition of the legal list this one is nested in. */
  private list(node: JSONContent, depth: number, quoted: boolean, legalNum?: number): string {
    const ilvl = Math.min(8, depth);
    const isOrdered = node.type === "orderedList";
    const isTasks = node.type === "taskList";
    const type = typeof node.attrs?.type === "string" ? node.attrs.type : null;
    const isLegal = isOrdered && (type === LEGAL || (type === null && legalNum !== undefined));
    const numId = isLegal
      ? (legalNum ?? this.legal(ilvl, 1))
      : isOrdered
        ? this.numbered(ilvl, type, node.attrs?.start)
        : isTasks
          ? 0
          : this.bullets(markerAttr(node.attrs?.marker));
    let out = "";
    for (const item of node.content ?? []) {
      let first = true;
      const itemNum = isTasks ? this.tasks(item.attrs?.checked === true) : numId;
      for (const block of item.content ?? []) {
        if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
          out += this.list(block, depth + 1, quoted, isLegal ? numId : undefined);
        } else if (block.type === "paragraph" && first) {
          out += this.paragraph(block, {
            pStyle: '<w:pStyle w:val="ListParagraph"/>',
            numPr: `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${itemNum}"/></w:numPr>`,
          });
        } else {
          // Further blocks of an item line up under its text.
          out += this.block(block, depth + 1, quoted, `<w:ind w:left="${twips(LIST_INDENT * (ilvl + 1))}" w:firstLine="0"/>`);
        }
        first = false;
      }
    }
    return out;
  }

  // ---- blocks

  private paragraphStyle(node: JSONContent): string | null {
    const element = typeof node.attrs?.element === "string" ? node.attrs.element : "";
    if (this.opts.format === "screenplay") return SCREENPLAY_STYLES[element] ?? "Action";
    // A manuscript's chapters are the outline Word's navigation shows.
    if (element === "chapter_heading" || element === "part_heading" || element === "section_heading") return "Heading1";
    if (element === "subheading") return "Heading2";
    // A Document's named styles.
    if (this.opts.format === "none" && element && this.styles.has(element)) {
      return STYLE_IDS[element] ?? (element.startsWith("u-") ? customStyleId(element) : null);
    }
    return null;
  }

  /** Blocks one after another. (Two tables in a row need a paragraph
   *  between them, or Word makes one table of the two.) */
  blocksXml(nodes: JSONContent[], depth = 0, quoted = false): string {
    let out = "";
    nodes.forEach((n, i) => {
      if (i > 0 && n.type === "table" && nodes[i - 1].type === "table") out += TABLE_GAP;
      out += this.block(n, depth, quoted);
    });
    return out;
  }

  /** `sectPr`: this block is the last of its section — a paragraph says so
   *  for itself (see `writeDocx`). */
  block(node: JSONContent, depth = 0, quoted = false, ind?: string, sectPr?: string): string {
    switch (node.type) {
      case "paragraph": {
        const style = this.paragraphStyle(node) ?? (quoted ? "Quote" : null);
        return this.paragraph(node, {
          pStyle: style ? `<w:pStyle w:val="${style}"/>` : null,
          ...(ind ? { ind } : {}),
          ...(sectPr ? { sectPr } : {}),
        });
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
        return this.paragraph(node, { pStyle: `<w:pStyle w:val="Heading${level}"/>`, ...(sectPr ? { sectPr } : {}) });
      }
      case "table":
        return this.table(node, depth, quoted);
      case "toc":
        return this.toc(node);
      case "blockquote":
        return this.blocksXml(node.content ?? [], depth, true);
      case "bulletList":
      case "orderedList":
      case "taskList":
        return this.list(node, depth, quoted);
      case "codeBlock": {
        const text = (node.content ?? []).map((n) => n.text ?? "").join("");
        return text
          .split("\n")
          .map(
            (line) =>
              `<w:p>${wrap("pPr", { pStyle: '<w:pStyle w:val="Code"/>', ...(ind ? { ind } : {}) })}${
                line ? `<w:r>${this.textXml(line)}</w:r>` : ""
              }</w:p>`,
          )
          .join("");
      }
      case "horizontalRule":
        return `<w:p>${wrap("pPr", {
          pBdr: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>',
          ind: '<w:ind w:firstLine="0"/>',
        })}</w:p>`;
      case "image":
        return this.image(node);
      default:
        // An unknown block still has its text.
        return node.content ? node.content.map((n) => this.block(n, depth, quoted)).join("") : "";
    }
  }
}

// ---- headers and footers

const FIELDS: Record<string, string> = {
  page: "PAGE",
  pages: "NUMPAGES",
  title: "TITLE",
  author: "AUTHOR",
  date: 'DATE \\@ "MMMM d, yyyy"',
};

/** One slot's text as runs, with its `{fields}` as live Word fields. */
function slotRuns(text: string, sample: Record<string, string>): string {
  let out = "";
  for (const piece of text.split(/(\{(?:page|pages|title|author|date)\})/)) {
    if (!piece) continue;
    const key = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (key && FIELDS[key]) {
      out += `<w:fldSimple w:instr=" ${xmlEscape(FIELDS[key])} "><w:r><w:t xml:space="preserve">${xmlEscape(sample[key] ?? "")}</w:t></w:r></w:fldSimple>`;
    } else {
      out += `<w:r><w:t xml:space="preserve">${xmlEscape(piece)}</w:t></w:r>`;
    }
  }
  return out;
}

/** A header or footer part: left, centre and right on one line. */
function bandXml(
  tag: "hdr" | "ftr",
  [left, centre, right]: [string, string, string],
  textWidth: number,
  sample: Record<string, string>,
): string {
  const tabs = `<w:tabs><w:tab w:val="center" w:pos="${Math.round(textWidth / 2)}"/><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs>`;
  const inner =
    slotRuns(left, sample) +
    "<w:r><w:tab/></w:r>" +
    slotRuns(centre, sample) +
    "<w:r><w:tab/></w:r>" +
    slotRuns(right, sample);
  return `${XML_HEAD}<w:${tag} ${NS}><w:p>${wrap("pPr", {
    pStyle: `<w:pStyle w:val="${tag === "hdr" ? "Header" : "Footer"}"/>`,
    tabs,
  })}${inner}</w:p></w:${tag}>`;
}

// ---- styles

function styleXml(
  id: string,
  name: string,
  o: {
    type?: "paragraph" | "character";
    basedOn?: string | null;
    next?: string;
    isDefault?: boolean;
    quick?: boolean;
    priority?: number;
    pPr?: Parts;
    rPr?: Parts;
  } = {},
): string {
  const type = o.type ?? "paragraph";
  return `<w:style w:type="${type}"${o.isDefault ? ' w:default="1"' : ""} w:styleId="${id}">${ordered("style", {
    name: `<w:name w:val="${name}"/>`,
    basedOn: o.basedOn === null || o.isDefault ? null : `<w:basedOn w:val="${o.basedOn ?? (type === "paragraph" ? "Normal" : "DefaultParagraphFont")}"/>`,
    next: o.next ? `<w:next w:val="${o.next}"/>` : null,
    uiPriority: o.priority !== undefined ? `<w:uiPriority w:val="${o.priority}"/>` : null,
    qFormat: o.quick ? "<w:qFormat/>" : null,
    pPr: o.pPr ? wrap("pPr", o.pPr) : null,
    rPr: o.rPr ? wrap("rPr", o.rPr) : null,
  })}</w:style>`;
}

/** A paragraph style from its look: everything stated, so nothing depends
 *  on what Word's own Normal would have said. */
function lookStyleXml(
  id: string,
  name: string,
  look: StyleLook,
  writer: Writer,
  body: { font: string | null },
  o: { priority?: number; next?: string } = {},
): string {
  const fontName = look.font && look.font !== body.font ? writer.fontName(look.font) : null;
  const font = fontName ? xmlEscape(fontName) : null;
  // A first-line indent is for running prose: a centred or right-set style
  // has none (as on screen and in the page layout), though it may hang.
  const indF = look.indF > 0 && (look.align === "center" || look.align === "right") ? 0 : look.indF;
  const first = indF < 0 ? `w:hanging="${twips(-indF)}"` : `w:firstLine="${twips(indF)}"`;
  return styleXml(id, name, {
    next: o.next,
    quick: true,
    priority: o.priority,
    pPr: {
      keepNext: look.keepNext ? "<w:keepNext/>" : null,
      keepLines: look.keepLines ? "<w:keepLines/>" : null,
      spacing: `<w:spacing w:before="${twips(look.before)}" w:after="${twips(look.after)}" w:line="${Math.round(look.line * 240)}" w:lineRule="auto"/>`,
      ind: `<w:ind w:left="${twips(look.indL)}" w:right="${twips(look.indR)}" ${first}/>`,
      jc: `<w:jc w:val="${look.align === "justify" ? "both" : look.align}"/>`,
      outlineLvl: look.outline ? `<w:outlineLvl w:val="${look.outline - 1}"/>` : null,
    },
    rPr: {
      rFonts: font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : null,
      b: look.bold ? "<w:b/>" : '<w:b w:val="0"/>',
      i: look.italic ? "<w:i/>" : '<w:i w:val="0"/>',
      color: look.color ? `<w:color w:val="${hexVal(look.color)}"/>` : null,
      sz: `<w:sz w:val="${halfPoints(look.size)}"/>`,
      szCs: `<w:szCs w:val="${halfPoints(look.size)}"/>`,
      u: look.underline ? '<w:u w:val="single"/>' : null,
    },
  });
}

function stylesXml(opts: DocxWriteOptions, writer: Writer): string {
  const s = opts.settings;
  const screenplay = opts.format === "screenplay";
  const size = screenplay ? 12 : (s?.bodySize ?? BODY_SIZE);
  const fontName = screenplay ? "Courier New" : (writer.fontName(s?.bodyFont) ?? DEFAULT_WORD_FONT);
  if (!writer.fonts.has(fontName)) writer.fonts.set(fontName, screenplay ? "monospace" : "serif");
  writer.fonts.set("Courier New", "monospace");
  const font = xmlEscape(fontName);
  const after = screenplay ? 0 : (s?.paraSpacing ?? Math.round(BODY_AFTER * size * 10) / 10);
  const line = screenplay ? 1 : (s?.bodyLine ?? BODY_LINE);
  const indent = !screenplay && s?.firstIndent ? twipsIn(s.firstIndent) : 0;
  // The named styles, from the one table the screen and the page layout
  // read (a screenplay's are the built-in ones at its fixed size).
  const styles = screenplay
    ? resolveStyles({ font: null, size, line, after, firstIndent: 0 })
    : writer.styles;
  const body = { font: s?.bodyFont ?? null };

  const out: string[] = [
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:sz w:val="${halfPoints(size)}"/><w:szCs w:val="${halfPoints(size)}"/></w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="${twips(after)}" w:line="${Math.round(line * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`,
    // The first-line indent lives on Normal alone, so headings and titles
    // aren't indented with it.
    styleXml("Normal", "Normal", {
      isDefault: true,
      quick: true,
      pPr: indent ? { ind: `<w:ind w:firstLine="${indent}"/>` } : {},
    }),
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`,
    lookStyleXml("Title", "Title", styles.look("title"), writer, body, { next: "Normal", priority: 10 }),
    lookStyleXml("Subtitle", "Subtitle", styles.look("subtitle"), writer, body, { next: "Normal", priority: 11 }),
  ];
  for (let level = 1; level <= 6; level += 1) {
    out.push(lookStyleXml(`Heading${level}`, `heading ${level}`, styles.look(`h${level}`), writer, body, { next: "Normal", priority: 9 }));
  }
  out.push(
    lookStyleXml("Quote", "Quote", styles.look("quote"), writer, body, { priority: 29 }),
    lookStyleXml("Caption", "caption", styles.look("caption"), writer, body, { next: "Normal", priority: 35 }),
    lookStyleXml("NoSpacing", "No Spacing", styles.look("nospace"), writer, body, { priority: 1 }),
  );
  // The document's own styles, under their own names.
  for (const info of styles.list) {
    if (info.builtin) continue;
    out.push(lookStyleXml(customStyleId(info.id), xmlEscape(info.name), styles.look(info.id), writer, body, { priority: 40 }));
  }
  // Notes: small, single spaced; their numbers raised.
  const noteSize = Math.max(7, Math.round(size * 0.85 * 2) / 2);
  for (const kind of ["Footnote", "Endnote"]) {
    out.push(
      styleXml(`${kind}Text`, `${kind.toLowerCase()} text`, {
        priority: 99,
        pPr: { spacing: `<w:spacing w:after="${twips(noteSize * 0.25)}" w:line="${Math.round(Math.min(line, 1.15) * 240)}" w:lineRule="auto"/>`, ind: '<w:ind w:firstLine="0"/>' },
        rPr: { sz: `<w:sz w:val="${halfPoints(noteSize)}"/>`, szCs: `<w:szCs w:val="${halfPoints(noteSize)}"/>` },
      }),
      styleXml(`${kind}Reference`, `${kind.toLowerCase()} reference`, {
        type: "character",
        priority: 99,
        rPr: { vertAlign: '<w:vertAlign w:val="superscript"/>' },
      }),
    );
  }
  // A table of contents: one style a level, each set in a little further.
  for (let level = 1; level <= 6; level += 1) {
    out.push(
      styleXml(`TOC${level}`, `toc ${level}`, {
        next: "Normal",
        priority: 39,
        pPr: {
          spacing: `<w:spacing w:after="0" w:line="${Math.round(Math.min(line, 1.3) * 240)}" w:lineRule="auto"/>`,
          ind: `<w:ind w:left="${twips((level - 1) * size * 1.5)}" w:firstLine="0"/>`,
        },
        rPr: level === 1 ? { b: "<w:b/>" } : {},
      }),
    );
  }
  out.push(
    styleXml("ListParagraph", "List Paragraph", {
      quick: true,
      priority: 34,
      pPr: { ind: `<w:ind w:left="${twips(LIST_INDENT)}" w:firstLine="0"/>`, contextualSpacing: "<w:contextualSpacing/>" },
    }),
    styleXml("Code", "Code", {
      quick: true,
      pPr: { spacing: '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', ind: '<w:ind w:firstLine="0"/>' },
      rPr: {
        rFonts: '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>',
        sz: `<w:sz w:val="${halfPoints(size * CODE_SIZE)}"/>`,
      },
    }),
    styleXml("Header", "header", { priority: 99, pPr: { spacing: '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', ind: '<w:ind w:firstLine="0"/>' } }),
    styleXml("Footer", "footer", { priority: 99, pPr: { spacing: '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', ind: '<w:ind w:firstLine="0"/>' } }),
    styleXml("InlineCode", "Inline Code", {
      type: "character",
      rPr: { rFonts: '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' },
    }),
    styleXml("Hyperlink", "Hyperlink", {
      type: "character",
      priority: 99,
      rPr: { color: '<w:color w:val="0563C1"/>', u: '<w:u w:val="single"/>' },
    }),
  );
  if (screenplay) {
    const el = (id: string, name: string, left: number, right: number, bold = false, align?: string) =>
      styleXml(id, name, {
        pPr: { ind: `<w:ind w:left="${left}" w:right="${right}"/>`, jc: align ? `<w:jc w:val="${align}"/>` : null },
        rPr: { b: bold ? "<w:b/>" : null },
      });
    out.push(
      el("Action", "Action", 0, 0),
      el("SceneHeading", "Scene Heading", 0, 240, true),
      el("Character", "Character", 3168, 0),
      el("Parenthetical", "Parenthetical", 2304, 2016),
      el("Dialogue", "Dialogue", 1440, 2160),
      el("Transition", "Transition", 0, 0, false, "right"),
    );
  }
  return `${XML_HEAD}<w:styles ${NS}>${out.join("")}</w:styles>`;
}

// ---- the package

const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml";

export interface DocxWritten {
  bytes: Uint8Array;
  /** Pictures left out because their bytes weren't supplied. */
  missingImages: number;
}

export async function writeDocx(doc: JSONContent, opts: DocxWriteOptions): Promise<DocxWritten> {
  const zip = new JSZip();
  const writer = new Writer(opts);
  writer.noteBreaks(doc);
  const screenplay = opts.format === "screenplay";
  const s: DocSettings = opts.settings ?? {
    ...DEFAULT_SETTINGS,
    // The scripted formats keep their fixed sheet.
    mt: 1,
    mr: 1,
    mb: 1,
    ml: screenplay ? 1.5 : 1,
  };

  const stylesRel = writer.rel("styles", "styles.xml");
  const settingsRel = writer.rel("settings", "settings.xml");
  void stylesRel;
  void settingsRel;

  const page = pageDims(s);
  const textWidth = twipsIn(page.w - s.ml - s.mr - s.gutter);
  writer.textWidth = Math.max(1440, textWidth);
  // The headings a table of contents lists.
  for (const node of doc.content ?? []) {
    if (node.type !== "heading") continue;
    const title = (node.content ?? []).map((n) => (n.type === "text" ? (n.text ?? "") : " ")).join("").replace(/\s+/g, " ").trim();
    if (title) writer.outline.push({ level: Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)), title });
  }

  // Headers and footers: one part per kind of page in use.
  const sample = {
    page: "1",
    pages: "1",
    title: opts.title,
    author: opts.author ?? "",
    date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
  };
  const overrides: string[] = [];
  const refs: { header: string[]; footer: string[] } = { header: [], footer: [] };
  const variants: [string, string, boolean][] = [
    ["", "default", true],
    ["1", "first", s.hfFirst],
    ["e", "even", s.hfEven],
  ];
  let partNo = 0;
  for (const [variant, type, on] of variants) {
    if (!on) continue;
    for (const band of ["h", "f"] as const) {
      const slots = (["L", "C", "R"] as const).map((side) => s[`${band}${variant}${side}` as SlotKey]) as [string, string, string];
      // Word needs the first/even parts to exist even when empty, or it
      // repeats the default one there.
      if (type === "default" && slots.every((t) => !t)) continue;
      partNo += 1;
      const tag = band === "h" ? "hdr" : "ftr";
      const name = `${band === "h" ? "header" : "footer"}${partNo}.xml`;
      zip.file(`word/${name}`, bandXml(tag, slots, textWidth, sample));
      const id = writer.rel(band === "h" ? "header" : "footer", name);
      overrides.push(`<Override PartName="/word/${name}" ContentType="${CT}.${band === "h" ? "header" : "footer"}+xml"/>`);
      refs[band === "h" ? "header" : "footer"].push(
        `<w:${band === "h" ? "header" : "footer"}Reference w:type="${type}" r:id="${id}"/>`,
      );
    }
  }

  /** A section's page setup. The first one in the file names the headers
   *  and footers; the sections after it take them from there. */
  let sectsWritten = 0;
  const sectXml = (props: SectionProps | null): string => {
    const ss = sectionSettings(s, props);
    const dims = pageDims(ss);
    const first = sectsWritten === 0;
    sectsWritten += 1;
    // Where its page numbers start: the document's for the first section,
    // its own for one that restarts them.
    const start = first ? (props?.pn ?? (s.pnStart !== 1 ? s.pnStart : null)) : (props?.pn ?? null);
    return wrap("sectPr", {
      headerReference: first ? refs.header : null,
      footerReference: first ? refs.footer : null,
      pgSz: `<w:pgSz w:w="${twipsIn(dims.w)}" w:h="${twipsIn(dims.h)}"${dims.w > dims.h ? ' w:orient="landscape"' : ""}/>`,
      pgMar: `<w:pgMar w:top="${twipsIn(ss.mt)}" w:right="${twipsIn(ss.mr)}" w:bottom="${twipsIn(ss.mb)}" w:left="${twipsIn(ss.ml)}" w:header="${twipsIn(ss.hd)}" w:footer="${twipsIn(ss.fd)}" w:gutter="${twipsIn(ss.gutter)}"/>`,
      lnNumType: ss.lineNumbers ? '<w:lnNumType w:countBy="1" w:restart="newPage"/>' : null,
      pgNumType:
        ss.pnFormat !== "1" || start !== null
          ? `<w:pgNumType w:fmt="${PN_FMT[ss.pnFormat] ?? "decimal"}"${start !== null ? ` w:start="${start}"` : ""}/>`
          : null,
      cols: ss.cols > 1 ? `<w:cols w:num="${ss.cols}" w:space="${twipsIn(ss.colGap)}"/>` : null,
      titlePg: first && s.hfFirst ? "<w:titlePg/>" : null,
    });
  };

  // The text, section by section: in Word a section's setup is said by the
  // paragraph that ENDS it (and the last one's at the end of the body).
  const nodes = doc.content ?? [];
  const startOf = (node: JSONContent | undefined): SectionProps | null =>
    node && (node.type === "paragraph" || node.type === "heading") ? parseSection(node.attrs?.sect) : null;
  let current = startOf(nodes[0]);
  let body = "";
  nodes.forEach((node, i) => {
    const next = i + 1 < nodes.length ? startOf(nodes[i + 1]) : null;
    if (i > 0 && node.type === "table" && nodes[i - 1].type === "table") body += TABLE_GAP;
    if (!next) {
      body += writer.block(node);
      return;
    }
    const xml = sectXml(current);
    current = next;
    if (node.type === "paragraph" || node.type === "heading") body += writer.block(node, 0, false, undefined, xml);
    // (A list or a table can't say it: a sliver of a paragraph does.)
    else body += `${writer.block(node)}<w:p><w:pPr>${TINY}${xml}</w:pPr></w:p>`;
  });
  const sectPr = sectXml(current);

  const numbering = writer.numberingXml();
  if (numbering) {
    writer.rel("numbering", "numbering.xml");
    zip.file("word/numbering.xml", numbering);
    overrides.push(`<Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/>`);
  }
  // Footnotes and endnotes: a part each, when there are any — with the
  // two entries Word expects first (the rule above the notes, and the one
  // above notes that ran over from the page before).
  const hasNotes: Record<"foot" | "end", boolean> = { foot: writer.notes.foot.length > 0, end: writer.notes.end.length > 0 };
  for (const [kind, tag, file] of [
    ["foot", "footnote", "footnotes"],
    ["end", "endnote", "endnotes"],
  ] as const) {
    if (!hasNotes[kind]) continue;
    const plain = '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';
    zip.file(
      `word/${file}.xml`,
      `${XML_HEAD}<w:${file} ${NS}>` +
        `<w:${tag} w:type="separator" w:id="-1"><w:p>${plain}<w:r><w:separator/></w:r></w:p></w:${tag}>` +
        `<w:${tag} w:type="continuationSeparator" w:id="0"><w:p>${plain}<w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>` +
        `${writer.notes[kind].join("")}</w:${file}>`,
    );
    writer.rel(file, `${file}.xml`);
    overrides.push(`<Override PartName="/word/${file}.xml" ContentType="${CT}.${file}+xml"/>`);
  }
  const exts = new Set(writer.mediaFiles.map((m) => m.ext));
  for (const m of writer.mediaFiles) zip.file(m.path, m.bytes);

  zip.file(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      [...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("") +
      `<Override PartName="/word/document.xml" ContentType="${CT}.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="${CT}.styles+xml"/>` +
      `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>` +
      `<Override PartName="/word/fontTable.xml" ContentType="${CT}.fontTable+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      overrides.join("") +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `</Relationships>`,
  );
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  zip.file(
    "docProps/core.xml",
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xmlEscape(opts.title)}</dc:title>${opts.author ? `<dc:creator>${xmlEscape(opts.author)}</dc:creator>` : ""}` +
      `${opts.settings?.subject ? `<dc:subject>${xmlEscape(opts.settings.subject)}</dc:subject>` : ""}${opts.settings?.keywords ? `<cp:keywords>${xmlEscape(opts.settings.keywords)}</cp:keywords>` : ""}` +
      `${opts.settings?.lang ? `<dc:language>${xmlEscape(opts.settings.lang)}</dc:language>` : ""}` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  zip.file("word/document.xml", `${XML_HEAD}<w:document ${NS}><w:body>${body}${sectPr}</w:body></w:document>`);
  zip.file("word/styles.xml", stylesXml(opts, writer));
  // The fonts the file names: what kind each is, and — for a family that
  // stands in for a commercial one — the font Word should use if it lacks
  // it (so a file set in Carlito opens in Calibri where that's what's there).
  writer.rel("fontTable", "fontTable.xml");
  zip.file(
    "word/fontTable.xml",
    `${XML_HEAD}<w:fonts ${NS}>${[...writer.fonts]
      .map(([name, category]) => {
        const alt = wordAltName(name);
        return `<w:font w:name="${xmlEscape(name)}">${ordered("font", {
          altName: alt ? `<w:altName w:val="${xmlEscape(alt)}"/>` : null,
          family: `<w:family w:val="${wordFamilyOf(category)}"/>`,
          pitch: `<w:pitch w:val="${category === "monospace" ? "fixed" : "variable"}"/>`,
        })}</w:font>`;
      })
      .join("")}</w:fonts>`,
  );
  zip.file(
    "word/settings.xml",
    `${XML_HEAD}<w:settings ${NS}>${ordered("settings", {
      mirrorMargins: s.mirror ? "<w:mirrorMargins/>" : null,
      autoHyphenation: s.hyphenate ? "<w:autoHyphenation/>" : null,
      evenAndOddHeaders: s.hfEven ? "<w:evenAndOddHeaders/>" : null,
      footnotePr: hasNotes.foot ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : null,
      endnotePr: hasNotes.end ? '<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>' : null,
      // Without this Word opens the file in compatibility mode.
      compat:
        '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>',
    })}</w:settings>`,
  );
  zip.file("word/_rels/document.xml.rels", writer.relsXml());

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, missingImages: writer.missingImages };
}

/** Every image `src` in a document, in order. */
export function imageSources(doc: JSONContent): string[] {
  const out: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "image" && typeof node.attrs?.src === "string" && node.attrs.src) out.push(node.attrs.src);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}
