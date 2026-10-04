/** Shared pieces of the hand-written Word (.docx) packages. */

/** XML 1.0 forbids most control characters outright; drop them. */
function stripControls(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) out += ch;
  }
  return out;
}

export const xmlEscape = (value: string) =>
  stripControls(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** [Content_Types].xml for a document with the given extra parts. */
export function contentTypes(parts: { name: string; type: string }[]): string {
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${parts
    .map((p) => `<Override PartName="${p.name}" ContentType="${p.type}"/>`)
    .join("")}</Types>`;
}

export const CT = {
  styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  settings: "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  header: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
  footer: "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
};

export function rootRels(): string {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
}

/** document.xml.rels: rId → [type suffix, target]. */
export function documentRels(rels: Record<string, [string, string]>): string {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(
    rels,
  )
    .map(
      ([id, [type, target]]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;
}

export function coreProps(title: string, creator?: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title>${creator ? `<dc:creator>${xmlEscape(creator)}</dc:creator>` : ""}<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}
