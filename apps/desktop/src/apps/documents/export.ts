import type { JSONContent } from "@tiptap/core";
import JSZip from "jszip";

interface ExportBlock {
  type: string;
  element: string;
  text: string;
}

function blocksFromDoc(doc: JSONContent): ExportBlock[] {
  const read = (node: JSONContent): string =>
    `${node.text ?? ""}${(node.content ?? []).map(read).join("")}`;
  return (doc.content ?? []).map((node) => ({
    type: node.type ?? "paragraph",
    element: String(node.attrs?.element ?? ""),
    text: read(node),
  }));
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

export async function exportDocument(doc: JSONContent, title: string, format: string, kind: "pdf" | "docx") {
  if (kind === "docx") {
    download(await buildDocx(doc, title, format), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${safeName(title)}.docx`);
  } else {
    download(buildPdf(doc, title, format), "application/pdf", `${safeName(title)}.pdf`);
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

function paragraphXml(block: ExportBlock, format: string): string {
  const style = docxStyle(block, format);
  const text = xmlEscape(block.text || " ");
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export async function buildDocx(doc: JSONContent, title: string, format: string): Promise<Uint8Array> {
  const zip = new JSZip();
  const screenplay = format === "screenplay";
  const blocks = blocksFromDoc(doc);
  const body = blocks.map((block) => paragraphXml(block, format)).join("");
  const titleXml = screenplay ? "" : `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${xmlEscape(title)}</w:t></w:r></w:p>`;
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${titleXml}${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="${screenplay ? 1440 : 1440}" w:bottom="1440" w:left="${screenplay ? 2160 : 1440}" w:header="720" w:footer="720"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr></w:body></w:document>`);
  zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`);
  const font = screenplay ? "Courier New" : "Aptos";
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="${screenplay ? 24 : 22}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${screenplay ? 0 : 160}" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${style("Normal", "Normal", 0, 0)}${style("Title", "Title", 0, 240, true, 32)}${style("Heading1", "Heading 1", 0, 160, true, 26)}${style("Action", "Action", 0, 0)}${style("SceneHeading", "Scene Heading", 0, 240, true)}${style("Character", "Character", 3168, 0)}${style("Parenthetical", "Parenthetical", 2304, 2016)}${style("Dialogue", "Dialogue", 1440, 2160)}${style("Transition", "Transition", 0, 0, false, undefined, "right")}</w:styles>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function style(id: string, name: string, left: number, right: number, bold = false, size?: number, align?: string): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr><w:ind w:left="${left}" w:right="${right}"/>${align ? `<w:jc w:val="${align}"/>` : ""}</w:pPr><w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}</w:rPr></w:style>`;
}

function ascii(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7E]/g, "?");
}
const pdfEscape = (value: string) => ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

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

export function buildPdf(doc: JSONContent, title: string, format: string): Uint8Array {
  const screenplay = format === "screenplay";
  const blocks = blocksFromDoc(doc);
  const pages: string[] = [];
  let commands: string[] = [];
  let y = 720;
  const finish = () => {
    const pageNo = pages.length + 1;
    commands.push(`BT /F1 10 Tf 540 756 Td (${pageNo}.) Tj ET`);
    pages.push(commands.join("\n"));
    commands = [];
    y = 720;
  };
  if (!screenplay) {
    commands.push(`BT /F2 20 Tf 72 ${y} Td (${pdfEscape(title)}) Tj ET`);
    y -= 34;
  }
  for (const block of blocks) {
    let x = screenplay ? 108 : 72;
    let width = screenplay ? 432 : 468;
    let font = "F1";
    let size = screenplay ? 12 : 11;
    let leading = screenplay ? 14.4 : 15;
    let before = screenplay ? 12 : 5;
    if (screenplay) {
      if (block.element === "character") { x = 266; width = 230; }
      else if (block.element === "parenthetical") { x = 223; width = 245; }
      else if (block.element === "dialogue") { x = 180; width = 252; }
      else if (block.element === "transition") { x = 396; width = 144; }
      if (block.element === "scene_heading") { font = "F2"; before = 18; }
    } else if (block.type === "heading") { font = "F2"; size = 15; leading = 19; before = 15; }
    const value = screenplay && ["scene_heading", "character", "transition"].includes(block.element) ? block.text.toUpperCase() : block.text;
    const lines = wrap(value, Math.max(8, Math.floor(width / (size * 0.6))));
    if (y - before - lines.length * leading < 60) finish();
    y -= before;
    for (const line of lines) {
      commands.push(`BT /${font} ${size} Tf ${x} ${y.toFixed(1)} Td (${pdfEscape(line)}) Tj ET`);
      y -= leading;
    }
  }
  if (commands.length || pages.length === 0) finish();

  const objects: string[] = [];
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = "";
  objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>`;
  const kids: string[] = [];
  for (const content of pages) {
    const pageNo = objects.length + 1;
    const contentNo = pageNo + 1;
    kids.push(`${pageNo} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
