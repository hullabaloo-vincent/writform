/**
 * Standard Manuscript Format, as Word (.docx) — what agents and editors ask
 * for: 12-point Times New Roman (or Courier), double-spaced, 1″ margins,
 * every paragraph indented ½″, a title page with your contact details and a
 * rounded word count, a running header "Surname / SHORT TITLE / page", each
 * chapter starting on a new page a third of the way down, and a centered #
 * for scene breaks.
 */

import {
  contentTypes,
  coreProps,
  CT,
  documentRels,
  rootRels,
  W_NS,
  XML_HEAD,
  xmlEscape,
} from "../../apps/documents/ooxml";
import type { BookModel, Run, Section } from "../model/types";
import { roundedWordCount, smfNames } from "./names";

export { roundedWordCount, smfNames } from "./names";

const TWIP = 1440;

export async function buildManuscriptDocx(model: BookModel): Promise<Uint8Array> {
  const { meta, contact, smf } = model.book;
  const { surname, shortTitle } = smfNames(model);
  const font = smf.font === "courier" ? "Courier New" : "Times New Roman";
  const underline = smf.italics === "underline";
  const page = smf.paper === "a4" ? { w: 11906, h: 16838 } : { w: 12240, h: 15840 };
  const textWidth = page.w - 2 * TWIP;

  const runXml = (r: Run) => {
    const props = [
      r.bold ? "<w:b/>" : "",
      r.italic ? (underline ? '<w:u w:val="single"/>' : "<w:i/>") : "",
    ].join("");
    if (r.text === "\n") return "<w:r><w:br/></w:r>";
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
  };
  const runs = (rs: Run[]) => rs.map(runXml).join("");
  const p = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
  const text = (t: string) => `<w:r><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`;
  const centered = '<w:ind w:firstLine="0"/><w:jc w:val="center"/>';

  // ---- title page (section 1: no header)
  const contactLines = [
    contact.legalName || meta.author,
    ...contact.address.split("\n"),
    contact.phone,
    contact.email,
  ]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);
  const words = roundedWordCount(model.words);
  const single = '<w:spacing w:line="240" w:lineRule="auto" w:after="0"/><w:ind w:firstLine="0"/>';
  const titleParts: string[] = [];
  contactLines.forEach((line, i) => {
    // The word count sits on the first line, set right with a tab stop.
    titleParts.push(
      i === 0
        ? p(`${text(line)}<w:r><w:tab/></w:r>${text(words)}`, `<w:tabs><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs>${single}`)
        : p(text(line), single),
    );
  });
  if (contactLines.length === 0) {
    titleParts.push(p(`<w:r><w:tab/></w:r>${text(words)}`, `<w:tabs><w:tab w:val="right" w:pos="${textWidth}"/></w:tabs>${single}`));
  }
  if (contact.agent.trim()) {
    titleParts.push(p("", single));
    for (const line of contact.agent.split("\n").map((l) => l.trim()).filter(Boolean)) {
      titleParts.push(p(text(line), single));
    }
  }
  titleParts.push(
    p(text((meta.title || "Untitled").toUpperCase()), `<w:spacing w:before="${TWIP * 3}"/>${centered}`),
    ...(meta.subtitle ? [p(text(meta.subtitle), centered)] : []),
    p(text(`by ${meta.author || contact.legalName || "Author"}`), centered),
  );
  const titleSect = `<w:p><w:pPr><w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${TWIP}" w:right="${TWIP}" w:bottom="${TWIP}" w:left="${TWIP}" w:header="720" w:footer="720" w:gutter="0"/><w:titlePg/></w:sectPr></w:pPr></w:p>`;

  // ---- body (section 2: header, numbering from 1)
  const body: string[] = [];
  const opener = `<w:pageBreakBefore/><w:spacing w:before="${TWIP * 2}"/>${centered}`;
  const sectionHeading = (s: Section) => {
    const lines: string[] = [];
    if (s.kind === "part") lines.push(s.label || "Part", ...(s.title ? [s.title] : []));
    else if (s.kind === "chapter") lines.push(...(s.label ? [s.label] : []), ...(s.title ? [s.title] : []));
    else if (s.title) lines.push(s.title);
    return lines;
  };
  model.sections.forEach((s) => {
    const heading = sectionHeading(s);
    if (heading.length) {
      body.push(p(text(heading[0]), opener));
      for (const line of heading.slice(1)) body.push(p(text(line), centered));
    } else if (body.length) {
      body.push(p("", "<w:pageBreakBefore/>"));
    }
    if (s.subtitle) body.push(p(text(s.subtitle), centered));
    const epigraphs = s.epigraph ? [s.epigraph] : [];
    // A page break goes on the paragraph after it: an empty paragraph of
    // its own would leave a blank line at the top of the page.
    let breakNext = false;
    const add = (inner: string, pPr = "") => {
      body.push(p(inner, (breakNext ? "<w:pageBreakBefore/>" : "") + pPr));
      breakNext = false;
    };
    for (const block of [...epigraphs, ...s.blocks]) {
      switch (block.kind) {
        case "para":
          add(
            runs(block.runs),
            block.align === "center" ? centered : block.align === "right" ? '<w:ind w:firstLine="0"/><w:jc w:val="right"/>' : "",
          );
          break;
        case "scene":
          add(text("#"), centered);
          break;
        case "subheading":
          add(runs(block.runs), centered);
          break;
        case "blockquote":
          for (const para of block.paras) {
            add(runs(para.runs), '<w:ind w:left="720" w:right="720" w:firstLine="0"/>');
          }
          break;
        case "verse":
          add(
            block.lines.map((line, i) => (i ? "<w:r><w:br/></w:r>" : "") + runs(line)).join(""),
            '<w:ind w:left="720" w:firstLine="0"/>',
          );
          break;
        case "epigraph":
          for (const para of block.paras) {
            add(runs(para), '<w:ind w:left="1440" w:right="720" w:firstLine="0"/>');
          }
          if (block.attribution) {
            add(`${text("— ")}${runs(block.attribution)}`, '<w:ind w:firstLine="0"/><w:jc w:val="right"/>');
          }
          break;
        case "list":
          block.items.forEach((item, i) => {
            add(`${text(block.ordered ? `${i + 1}. ` : "• ")}${runs(item)}`, '<w:ind w:left="720" w:firstLine="0"/>');
          });
          break;
        case "pageBreak":
          breakNext = true;
          break;
        case "image":
          add(text(`[Image${block.alt ? `: ${block.alt}` : ""}]`), centered);
          break;
      }
    }
  });
  body.push(p(text("END"), `<w:spacing w:before="480"/>${centered}`));

  const header = `${XML_HEAD}<w:hdr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="right"/></w:pPr>${text(`${surname} / ${shortTitle} / `)}<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:hdr>`;
  const bodySect = `<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${TWIP}" w:right="${TWIP}" w:bottom="${TWIP}" w:left="${TWIP}" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:start="1"/></w:sectPr>`;
  const document = `${XML_HEAD}<w:document ${W_NS}><w:body>${titleParts.join("")}${titleSect}${body.join("")}${bodySect}</w:body></w:document>`;

  const styles = `${XML_HEAD}<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${xmlEscape(model.book.meta.language || "en-US")}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr></w:style></w:styles>`;
  const settings = `${XML_HEAD}<w:settings ${W_NS}><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    contentTypes([
      { name: "/word/styles.xml", type: CT.styles },
      { name: "/word/settings.xml", type: CT.settings },
      { name: "/word/header1.xml", type: CT.header },
    ]),
  );
  zip.file("_rels/.rels", rootRels());
  zip.file(
    "word/_rels/document.xml.rels",
    documentRels({
      rId1: ["styles", "styles.xml"],
      rId2: ["settings", "settings.xml"],
      rId3: ["header", "header1.xml"],
    }),
  );
  zip.file("word/document.xml", document);
  zip.file("word/styles.xml", styles);
  zip.file("word/settings.xml", settings);
  zip.file("word/header1.xml", header);
  zip.file("docProps/core.xml", coreProps(meta.title || "Untitled", meta.author || undefined));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
