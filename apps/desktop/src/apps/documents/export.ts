import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";

import { pageSizeDef, type DocSettings } from "./docSettings";

interface ExportRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface ExportBlock {
  type: string;
  element: string;
  align: string;
  font: string;
  size: number;
  /** Line-spacing multiple; 0 = unset. */
  line: number;
  /** Space before/after in points; null = unset (0 is meaningful). */
  sa: number | null;
  sb: number | null;
  dropCap: boolean;
  pageBreakBefore: boolean;
  /** True for list items — their runs start with a literal marker. */
  marker: boolean;
  runs: ExportRun[];
  text: string;
}

/** Flatten the doc to leaf blocks: list items become their own blocks with
 *  literal markers (they used to concatenate — "apple","banana" exported as
 *  "applebanana"), blockquote children flatten, and inline marks survive as
 *  runs so DOCX can emit real bold/italic. */
function blocksFromDoc(doc: JSONContent): ExportBlock[] {
  const runsOf = (node: JSONContent, bold: boolean, italic: boolean, out: ExportRun[]) => {
    const b = bold || (node.marks ?? []).some((m) => m.type === "bold");
    const i = italic || (node.marks ?? []).some((m) => m.type === "italic");
    if (node.type === "hardBreak") out.push({ text: "\n", bold: b, italic: i });
    if (node.text) out.push({ text: node.text, bold: b, italic: i });
    for (const child of node.content ?? []) runsOf(child, b, i, out);
  };

  const out: ExportBlock[] = [];
  const pushLeaf = (node: JSONContent, marker = "") => {
    const runs: ExportRun[] = [];
    if (marker) runs.push({ text: marker, bold: false, italic: false });
    runsOf(node, false, false, runs);
    const spacePt = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    out.push({
      type: node.type ?? "paragraph",
      element: String(node.attrs?.element ?? ""),
      align: String(node.attrs?.align ?? ""),
      font: String(node.attrs?.font ?? ""),
      size: Number(node.attrs?.size ?? 0) || 0,
      line: Number(node.attrs?.line ?? 0) || 0,
      sa: spacePt(node.attrs?.sa),
      sb: spacePt(node.attrs?.sb),
      dropCap: Boolean(node.attrs?.dropCap),
      pageBreakBefore: Boolean(node.attrs?.pageBreakBefore),
      marker: marker !== "",
      runs,
      text: runs.map((r) => r.text).join(""),
    });
  };
  const expand = (node: JSONContent, marker = "") => {
    if (node.type === "bulletList" || node.type === "orderedList") {
      let n = 0;
      for (const item of node.content ?? []) {
        n += 1;
        const itemMarker = node.type === "bulletList" ? "• " : `${n}. `;
        (item.content ?? []).forEach((child, idx) =>
          expand(child, idx === 0 ? itemMarker : "   "),
        );
      }
    } else if (node.type === "blockquote") {
      for (const child of node.content ?? []) expand(child, marker);
    } else {
      pushLeaf(node, marker);
    }
  };
  for (const node of doc.content ?? []) expand(node);
  return out;
}

function safeName(title: string): string {
  return (title.trim() || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}

function download(bytes: Uint8Array, mime: string, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportDocument(doc: JSONContent, title: string, format: string, kind: "pdf" | "docx" | "booklet", settings?: DocSettings) {
  if (kind === "docx") {
    download(await buildDocx(doc, title, format, settings), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${safeName(title)}.docx`);
  } else if (kind === "booklet") {
    download(buildBookletPdf(doc, title, format, settings), "application/pdf", `${safeName(title)} (booklet).pdf`);
  } else {
    download(buildPdf(doc, title, format, settings), "application/pdf", `${safeName(title)}.pdf`);
  }
}

const xmlEscape = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function docxStyle(block: ExportBlock, format: string): string {
  if (format === "screenplay") {
    const map: Record<string, string> = {
      scene_heading: "SceneHeading", action: "Action", character: "Character",
      parenthetical: "Parenthetical", dialogue: "Dialogue", transition: "Transition",
    };
    return map[block.element] ?? "Action";
  }
  if (block.type === "heading") return "Heading1";
  return "Normal";
}

const DOCX_FONTS: Record<string, string> = {
  times: "Times New Roman",
  palatino: "Palatino",
  sans: "Arial",
  mono: "Courier New",
  comic: "Comic Sans MS",
};

function paragraphXml(block: ExportBlock, format: string): string {
  const style = docxStyle(block, format);
  // OOXML pPr child order matters: pStyle, pageBreakBefore, spacing, jc.
  const props = [`<w:pStyle w:val="${style}"/>`];
  if (block.pageBreakBefore) props.push("<w:pageBreakBefore/>");
  const spacing: string[] = [];
  if (block.sa !== null) spacing.push(`w:before="${Math.round(block.sa * 20)}"`);
  if (block.sb !== null) spacing.push(`w:after="${Math.round(block.sb * 20)}"`);
  if (block.line) spacing.push(`w:line="${Math.round(block.line * 240)}" w:lineRule="auto"`);
  if (spacing.length) props.push(`<w:spacing ${spacing.join(" ")}/>`);
  const jc =
    block.align === "center"
      ? "center"
      : block.align === "right"
        ? "right"
        : block.align === "justify"
          ? "both"
          : "";
  if (jc) props.push(`<w:jc w:val="${jc}"/>`);

  const face = DOCX_FONTS[block.font];
  const runProps = (run: ExportRun) => {
    const parts: string[] = [];
    if (face) parts.push(`<w:rFonts w:ascii="${face}" w:hAnsi="${face}"/>`);
    if (run.bold) parts.push("<w:b/>");
    if (run.italic) parts.push("<w:i/>");
    if (block.size) parts.push(`<w:sz w:val="${block.size * 2}"/>`);
    return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
  };
  const runs = block.runs.length
    ? block.runs
    : [{ text: " ", bold: false, italic: false }];
  const body = runs
    .map(
      (run) =>
        `<w:r>${runProps(run)}<w:t xml:space="preserve">${xmlEscape(run.text || " ")}</w:t></w:r>`,
    )
    .join("");
  return `<w:p><w:pPr>${props.join("")}</w:pPr>${body}</w:p>`;
}

/** Split a real Word drop cap off a paragraph: the first letter becomes its
 *  own frame-anchored paragraph (`w:framePr w:dropCap`), exactly the shape
 *  Word itself writes, and the rest follows as the normal paragraph. */
function dropCapXml(block: ExportBlock, format: string, basePt: number): string | null {
  const rest = block.runs.map((r) => ({ ...r }));
  let letter = "";
  for (const run of rest) {
    const t = run.text.replace(/^\s+/, "");
    if (!t) {
      run.text = "";
      continue;
    }
    letter = [...t][0];
    run.text = t.slice(letter.length);
    break;
  }
  if (!letter) return null;
  const trimmed = rest.filter((r) => r.text);
  if (!trimmed.length) return null;

  const capPt = Math.round(basePt * 3.3);
  const lineExact = Math.round(basePt * 69); // ≈ three single-spaced lines
  const face = DOCX_FONTS[block.font];
  const frame =
    `<w:p><w:pPr><w:pStyle w:val="Normal"/>` +
    (block.pageBreakBefore ? "<w:pageBreakBefore/>" : "") +
    `<w:framePr w:dropCap="drop" w:lines="3" w:hSpace="57" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>` +
    `<w:spacing w:after="0" w:line="${lineExact}" w:lineRule="exact"/></w:pPr>` +
    `<w:r><w:rPr>${face ? `<w:rFonts w:ascii="${face}" w:hAnsi="${face}"/>` : ""}<w:sz w:val="${capPt * 2}"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEscape(letter)}</w:t></w:r></w:p>`;
  const restBlock: ExportBlock = {
    ...block,
    dropCap: false,
    pageBreakBefore: false,
    runs: trimmed,
    text: trimmed.map((r) => r.text).join(""),
  };
  return frame + paragraphXml(restBlock, format);
}

export async function buildDocx(doc: JSONContent, title: string, format: string, settings?: DocSettings): Promise<Uint8Array> {
  const zip = new JSZip();
  const screenplay = format === "screenplay";
  const blocks = blocksFromDoc(doc);
  const basePt = settings ? (settings.bodySize ?? 12) : screenplay ? 12 : 11;
  const body = blocks
    .map((block) => {
      if (block.dropCap && !screenplay) {
        const framed = dropCapXml(block, format, block.size || basePt);
        if (framed) return framed;
      }
      return paragraphXml(block, format);
    })
    .join("");
  const titleXml = screenplay ? "" : `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${xmlEscape(title)}</w:t></w:r></w:p>`;
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  // Page geometry: the document's own settings for Plain docs, the classic
  // letter defaults otherwise. Twips: 1in = 1440.
  const page = settings ? pageSizeDef(settings.pageSize) : { w: 8.5, h: 11 };
  const tw = (inches: number) => Math.round(inches * 1440);
  const mar = settings
    ? { top: tw(settings.mt), right: tw(settings.mr), bottom: tw(settings.mb), left: tw(settings.ml) }
    : { top: 1440, right: 1440, bottom: 1440, left: screenplay ? 2160 : 1440 };
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${titleXml}${body}<w:sectPr><w:pgSz w:w="${tw(page.w)}" w:h="${tw(page.h)}"/><w:pgMar w:top="${mar.top}" w:right="${mar.right}" w:bottom="${mar.bottom}" w:left="${mar.left}" w:header="720" w:footer="720"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr></w:body></w:document>`);
  zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`);
  // Body defaults follow the document settings (a Plain doc always has them
  // now, so its export matches the on-screen Georgia 12pt look); the
  // scripted formats keep their previous fixed defaults.
  const font = screenplay
    ? "Courier New"
    : settings
      ? (DOCX_FONTS[settings.bodyFont ?? ""] ?? "Georgia")
      : "Aptos";
  const defSz = screenplay ? 24 : settings ? basePt * 2 : 22;
  const defAfter = screenplay ? 0 : settings?.paraSpacing !== null && settings?.paraSpacing !== undefined ? Math.round(settings.paraSpacing * 20) : 160;
  const defLine = settings?.bodyLine ? Math.round(settings.bodyLine * 240) : 240;
  const defInd = settings?.firstIndent ? `<w:ind w:firstLine="${tw(settings.firstIndent)}"/>` : "";
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="${defSz}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${defAfter}" w:line="${defLine}" w:lineRule="auto"/>${defInd}</w:pPr></w:pPrDefault></w:docDefaults>${style("Normal", "Normal", 0, 0)}${style("Title", "Title", 0, 240, true, 32)}${style("Heading1", "Heading 1", 0, 160, true, 26)}${style("Action", "Action", 0, 0)}${style("SceneHeading", "Scene Heading", 0, 240, true)}${style("Character", "Character", 3168, 0)}${style("Parenthetical", "Parenthetical", 2304, 2016)}${style("Dialogue", "Dialogue", 1440, 2160)}${style("Transition", "Transition", 0, 0, false, undefined, "right")}</w:styles>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function style(id: string, name: string, left: number, right: number, bold = false, size?: number, align?: string): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr><w:ind w:left="${left}" w:right="${right}"/>${align ? `<w:jc w:val="${align}"/>` : ""}</w:pPr><w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr></w:style>`;
}

/**
 * cp1252's 0x80–0x9F block — the characters writers actually type (smart
 * quotes, em dashes, ellipses). Everything 0xA0–0xFF passes through as
 * Latin-1. The old exporter flattened ALL of these to "?".
 */
const CP1252_HIGH: Record<string, number> = {
  "€": 128, "‚": 130, "ƒ": 131, "„": 132, "…": 133,
  "†": 134, "‡": 135, "ˆ": 136, "‰": 137, "Š": 138,
  "‹": 139, "Œ": 140, "Ž": 142, "‘": 145, "’": 146,
  "“": 147, "”": 148, "•": 149, "–": 150, "—": 151,
  "˜": 152, "™": 153, "š": 154, "›": 155, "œ": 156,
  "ž": 158, "Ÿ": 159,
};

/** Map to WinAnsi (cp1252); only genuinely unrepresentable chars become "?". */
function winAnsi(value: string): string {
  let out = "";
  // NFC composes é rather than decomposing it (NFKD left "e" + a combining
  // mark the map couldn't represent).
  for (const ch of value.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (ch in CP1252_HIGH) out += String.fromCharCode(CP1252_HIGH[ch]);
    else if (ch === "−") out += "-";
    else if (ch === "\n" || ch === "\t") out += ch;
    else out += "?";
  }
  return out;
}
const pdfEscape = (value: string) => winAnsi(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** The PDF string is pure Latin-1 by construction; encode it byte-for-byte
 * (TextEncoder would emit UTF-8 and corrupt every /Length). */
function latin1Bytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
  return out;
}

function wrap(text: string, maxChars: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  for (const raw of text.split(/\n/)) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + word.length + 1 <= maxChars) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

/** Line-spacing multiples → leading factors for the Courier writer (its
 *  unadorned default is ~1.36em). */
const LINE_PDF: Record<string, number> = {
  "1": 1.15,
  "1.15": 1.3,
  "1.3": 1.45,
  "1.5": 1.7,
  "2": 2.2,
};

interface PdfGeo {
  w: number;
  h: number;
  mt: number;
  mr: number;
  mb: number;
  ml: number;
}

/** Lay the document out into per-page content streams (shared by the
 *  straight PDF and the booklet imposition). */
function layoutPdf(doc: JSONContent, title: string, format: string, settings?: DocSettings): { pages: string[]; geo: PdfGeo } {
  const screenplay = format === "screenplay";
  const blocks = blocksFromDoc(doc);
  // Page geometry in points (1in = 72): document settings for Plain docs,
  // the writer's historical letter defaults otherwise.
  const pageDef = settings ? pageSizeDef(settings.pageSize) : { w: 8.5, h: 11 };
  const geo = {
    w: Math.round(pageDef.w * 72),
    h: Math.round(pageDef.h * 72),
    mt: settings ? settings.mt * 72 : 72,
    mr: settings ? settings.mr * 72 : 72,
    mb: settings ? settings.mb * 72 : 60,
    ml: settings ? settings.ml * 72 : 72,
  };
  const yTop = geo.h - geo.mt;
  const bodyPt = settings?.bodySize ?? 11;
  const defaultGap = settings?.paraSpacing ?? 5;
  const indentPt = settings?.firstIndent ? settings.firstIndent * 72 : 0;
  const pages: string[] = [];
  let commands: string[] = [];
  let y = yTop;
  const finish = () => {
    const pageNo = pages.length + 1;
    commands.push(`BT /F1 10 Tf ${(geo.w - 72).toFixed(1)} ${(geo.h - 36).toFixed(1)} Td (${pageNo}.) Tj ET`);
    pages.push(commands.join("\n"));
    commands = [];
    y = yTop;
  };
  if (!screenplay) {
    commands.push(`BT /F2 20 Tf ${geo.ml.toFixed(1)} ${y.toFixed(1)} Td (${pdfEscape(title)}) Tj ET`);
    y -= 34;
  }
  for (const block of blocks) {
    let x = screenplay ? 108 : geo.ml;
    let width = screenplay ? 432 : geo.w - geo.ml - geo.mr;
    let font = "F1";
    let size = screenplay ? 12 : block.size || bodyPt;
    const lineMul = LINE_PDF[String(block.line || settings?.bodyLine || 0)];
    let leading = screenplay ? 14.4 : size * (lineMul ?? 1.36);
    let before = screenplay ? 12 : (block.sa ?? defaultGap);
    if (screenplay) {
      if (block.element === "character") { x = 266; width = 230; }
      else if (block.element === "parenthetical") { x = 223; width = 245; }
      else if (block.element === "dialogue") { x = 180; width = 252; }
      else if (block.element === "transition") { x = 396; width = 144; }
      if (block.element === "scene_heading") { font = "F2"; before = 18; }
    } else if (block.type === "heading") { font = "F2"; size = 15; leading = 19; before = 15; }
    // An explicit page break starts a fresh page (unless we're already at
    // the top of one).
    if (block.pageBreakBefore && y < yTop) finish();
    const value = screenplay && ["scene_heading", "character", "transition"].includes(block.element) ? block.text.toUpperCase() : block.text;
    const lines = wrap(value, Math.max(8, Math.floor(width / (size * 0.6))));
    if (y - before - lines.length * leading < geo.mb) finish();
    y -= before;
    // Book-style first-line indent: plain body paragraphs only, and never
    // the drop-capped opener.
    const indent =
      !screenplay &&
      indentPt > 0 &&
      block.type === "paragraph" &&
      !block.element &&
      !block.marker &&
      !block.dropCap &&
      (block.align === "" || block.align === "justify")
        ? indentPt
        : 0;
    lines.forEach((line, li) => {
      // Alignment by x-shift with the writer's own monospace metric
      // (0.6em/char). The Courier-only writer honors sizes but not font
      // families; justify degrades to left, drop caps to plain text.
      const slack = Math.max(0, width - line.length * size * 0.6);
      const lineX =
        block.align === "center"
          ? x + slack / 2
          : block.align === "right"
            ? x + slack
            : x + (li === 0 ? indent : 0);
      commands.push(`BT /${font} ${size} Tf ${lineX.toFixed(1)} ${y.toFixed(1)} Td (${pdfEscape(line)}) Tj ET`);
      y -= leading;
    });
    if (!screenplay && block.sb !== null) y -= block.sb;
  }
  if (commands.length || pages.length === 0) finish();
  return { pages, geo };
}

/** Serialize numbered objects into the final byte stream (offsets, xref,
 *  trailer). Object 1 must be the catalog. */
function assemblePdf(objects: string[]): Uint8Array {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return latin1Bytes(pdf);
}

export function buildPdf(doc: JSONContent, title: string, format: string, settings?: DocSettings): Uint8Array {
  const { pages, geo } = layoutPdf(doc, title, format, settings);
  const objects: string[] = [];
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = "";
  objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>`;
  const kids: string[] = [];
  for (const content of pages) {
    const pageNo = objects.length + 1;
    const contentNo = pageNo + 1;
    kids.push(`${pageNo} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${geo.w} ${geo.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  return assemblePdf(objects);
}

/**
 * Saddle-stitch imposition ("book fold"): every output sheet is a
 * double-wide landscape spread holding two document pages, ordered so the
 * printed stack, folded down the middle, reads 1…N. Sides follow the
 * classic sequence [N,1], [2,N−1], [N−2,3], [4,N−3]… with the count padded
 * to a multiple of four (the blanks land mid-stack, as in any booklet).
 * Print two-sided, flipping on the SHORT edge, then fold.
 *
 * Each document page becomes a Form XObject placed twice per sheet — the
 * same content stream the straight export writes, so page numbers and
 * layout carry over exactly.
 */
export function buildBookletPdf(doc: JSONContent, title: string, format: string, settings?: DocSettings): Uint8Array {
  const { pages, geo } = layoutPdf(doc, title, format, settings);
  const n = Math.max(4, Math.ceil(pages.length / 4) * 4);
  while (pages.length < n) pages.push("");

  const objects: string[] = [];
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = "";
  objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>`;
  const formIds: number[] = [];
  for (const content of pages) {
    formIds.push(objects.length + 1);
    objects.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 ${geo.w} ${geo.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  const kids: string[] = [];
  for (let side = 1; side <= n / 2; side += 1) {
    const outer = n - side + 1;
    const left = side % 2 === 1 ? outer : side;
    const right = side % 2 === 1 ? side : outer;
    const content = `q 1 0 0 1 0 0 cm /PL Do Q\nq 1 0 0 1 ${geo.w} 0 cm /PR Do Q`;
    const pageNo = objects.length + 1;
    const contentNo = pageNo + 1;
    kids.push(`${pageNo} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${geo.w * 2} ${geo.h}] /Resources << /XObject << /PL ${formIds[left - 1]} 0 R /PR ${formIds[right - 1]} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n / 2} >>`;
  return assemblePdf(objects);
}
