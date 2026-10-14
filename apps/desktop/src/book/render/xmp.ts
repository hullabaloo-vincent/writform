/**
 * A PDF's metadata as XMP, the form libraries, archives and search read.
 *
 * Written here and not left to PDFKit, whose own leaves a title's "&" and
 * "<" as they are (which is not XML: the whole packet is then unreadable),
 * counts its length in characters where bytes are meant, and has no
 * modified date. PDF/A also wants what is said here and in the file's Info
 * to agree to the letter, which is easier to see in one place.
 *
 * Nothing here touches the PDF writer.
 */

export interface XmpFields {
  title: string;
  author: string;
  /** What it is about, in a sentence. */
  subject: string;
  /** As typed: words or phrases with commas between. */
  keywords: string;
  /** BCP 47 ("en-GB"), or "" when not known. */
  lang: string;
  created: Date;
  modified: Date;
  creator: string;
  producer: string;
  /** Further descriptions to go in as they are (a standard's claim). */
  extra?: string[];
}

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // (Control characters have no place in XML at all.)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/** A date as XMP writes it, to the second, in UTC. */
export const xmpDate = (date: Date): string => `${date.toISOString().split(".")[0]}Z`;

/** Keywords as separate words (for the list form XMP also keeps). */
export const keywordList = (keywords: string): string[] =>
  keywords
    .split(/[,;\n]/)
    .map((k) => k.trim())
    .filter(Boolean);

/** What a PDF/A file says of itself: which part of the standard it keeps
 *  to (2, or 3 when it carries other files), at its basic level. For
 *  `XmpFields.extra`. */
export const pdfaClaim = (part: 2 | 3): string =>
  `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n   <pdfaid:part>${part}</pdfaid:part>\n   <pdfaid:conformance>B</pdfaid:conformance>\n  </rdf:Description>`;

export function xmpPacket(f: XmpFields): string {
  const dc: string[] = ["<dc:format>application/pdf</dc:format>"];
  if (f.title) dc.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escape(f.title)}</rdf:li></rdf:Alt></dc:title>`);
  if (f.author) dc.push(`<dc:creator><rdf:Seq><rdf:li>${escape(f.author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (f.subject) dc.push(`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escape(f.subject)}</rdf:li></rdf:Alt></dc:description>`);
  const words = keywordList(f.keywords);
  if (words.length) dc.push(`<dc:subject><rdf:Bag>${words.map((w) => `<rdf:li>${escape(w)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>`);
  if (f.lang) dc.push(`<dc:language><rdf:Bag><rdf:li>${escape(f.lang)}</rdf:li></rdf:Bag></dc:language>`);

  const pdf: string[] = [`<pdf:Producer>${escape(f.producer)}</pdf:Producer>`];
  if (f.keywords) pdf.push(`<pdf:Keywords>${escape(f.keywords)}</pdf:Keywords>`);

  const about = (ns: string, body: string[]) => `<rdf:Description rdf:about="" ${ns}>\n${body.map((line) => `   ${line}`).join("\n")}\n  </rdf:Description>`;
  const parts = [
    about('xmlns:xmp="http://ns.adobe.com/xap/1.0/"', [
      `<xmp:CreateDate>${xmpDate(f.created)}</xmp:CreateDate>`,
      `<xmp:ModifyDate>${xmpDate(f.modified)}</xmp:ModifyDate>`,
      `<xmp:MetadataDate>${xmpDate(f.modified)}</xmp:MetadataDate>`,
      `<xmp:CreatorTool>${escape(f.creator)}</xmp:CreatorTool>`,
    ]),
    about('xmlns:dc="http://purl.org/dc/elements/1.1/"', dc),
    about('xmlns:pdf="http://ns.adobe.com/pdf/1.3/"', pdf),
    ...(f.extra ?? []),
  ];
  // (The mark that opens a packet is U+FEFF, written out so that no editor
  // or tool can lose it.)
  const bom = String.fromCharCode(0xfeff);
  return [
    `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    ...parts.map((part) => `  ${part}`),
    " </rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}
