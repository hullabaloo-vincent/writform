// PDF/A, as a checklist. There is no validator to run here, so the rules a
// file of ours could break are checked one by one against the file's own
// objects: its header and trailer, what it says of itself, what its colours
// mean, its fonts, its links, its streams, and what it may not hold. The
// list follows the one in PdfCraft's preflight (ISO 19005-2 and -3, clause
// numbers given), with a few more that only a writer needs. It finds what is
// wrong with a file. It cannot prove a file right: veraPDF does that.

import { inflateSync } from "node:zlib";

export interface PdfObject {
  id: number;
  /** Its dictionary (or whatever it is), as written. */
  dict: string;
  stream: Uint8Array | null;
}

/** Every object of a file PDFKit wrote (a plain table of where each is). */
export function pdfObjects(bytes: Uint8Array): { objects: Map<number, PdfObject>; trailer: string } {
  const raw = Buffer.from(bytes);
  const text = raw.toString("latin1");
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)?.[1] ?? -1);
  const objects = new Map<number, PdfObject>();
  if (start < 0) return { objects, trailer: "" };
  const table = /xref\s+0 (\d+)\s+((?:\d{10} \d{5} [nf]\s+)+)trailer\s+([\s\S]*?)startxref/.exec(text.slice(start));
  if (!table) return { objects, trailer: "" };
  const rows = table[2].trim().split(/\s*\n\s*/);
  rows.forEach((row, id) => {
    const [offset, , kind] = row.trim().split(" ");
    if (kind !== "n") return;
    const at = Number(offset);
    const head = /^(\d+) 0 obj\s/.exec(text.slice(at, at + 24));
    if (!head) return;
    const bodyAt = at + head[0].length;
    const streamAt = text.indexOf("stream\n", bodyAt);
    const endAt = text.indexOf("endobj", bodyAt);
    if (streamAt >= 0 && streamAt < endAt) {
      const dict = text.slice(bodyAt, streamAt);
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      objects.set(id, { id, dict, stream: new Uint8Array(raw.subarray(streamAt + 7, streamAt + 7 + length)) });
    } else {
      objects.set(id, { id, dict: text.slice(bodyAt, endAt), stream: null });
    }
  });
  return { objects, trailer: table[3] };
}

const plain = (o: PdfObject): Uint8Array => {
  if (!o.stream) return new Uint8Array(0);
  if (!/\/Filter \/FlateDecode/.test(o.dict)) return o.stream;
  try {
    return new Uint8Array(inflateSync(o.stream));
  } catch {
    return new Uint8Array(0);
  }
};
const ref = (dict: string, key: string): number | null => {
  const m = new RegExp(`/${key} \\[?(\\d+) 0 R`).exec(dict);
  return m ? Number(m[1]) : null;
};

const FORBIDDEN_ACTIONS = ["Launch", "Sound", "Movie", "ResetForm", "ImportData", "JavaScript", "SetState", "NoOp", "Hide", "SetOCGState", "Rendition", "Trans", "GoTo3DView"];
const ALLOWED_ANNOTATIONS = ["Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "Widget", "PrinterMark", "TrapNet", "Watermark", "Redact", "FileAttachment"];

/** What is wrong with a file that says it is PDF/A (nothing: an empty list). */
export function pdfaProblems(bytes: Uint8Array, level: "2b" | "3b" = "2b"): string[] {
  const out: string[] = [];
  const say = (clause: string, what: string) => out.push(`${clause} ${what}`);
  const raw = Buffer.from(bytes);
  const text = raw.toString("latin1");
  const { objects, trailer } = pdfObjects(bytes);
  if (!objects.size) return ["6.1 the file's table of objects cannot be read"];
  const all = [...objects.values()];

  // 6.1.2 The header: its version, then a line of bytes that are not text.
  if (!/^%PDF-1\.[4-7]\n%/.test(text)) say("6.1.2", "the header is not a PDF's");
  const second = raw.subarray(raw.indexOf(10) + 1, raw.indexOf(10) + 6);
  if (second[0] !== 0x25 || ![1, 2, 3, 4].every((i) => second[i] > 127)) say("6.1.2", "the header has no line of high bytes after it");
  // 6.1.3 The trailer: an ID, and no lock.
  if (!/\/ID \[/.test(trailer)) say("6.1.3", "the trailer has no ID");
  if (/\/Encrypt/.test(trailer)) say("6.1.3", "the file is encrypted");
  if (!/%%EOF\s?$/.test(text)) say("6.1.3", "something follows the end of the file");

  const catalog = all.find((o) => /\/Type \/Catalog/.test(o.dict));
  if (!catalog) return [...out, "6.1 no catalog"];

  // 6.6 What the file says of itself.
  const metaId = ref(catalog.dict, "Metadata");
  const meta = metaId === null ? null : objects.get(metaId);
  if (!meta?.stream) say("6.6.2.1", "there is no XMP metadata");
  else {
    if (/\/Filter/.test(meta.dict)) say("6.6.2.1", "the metadata is packed (some readers of archives want it plain)");
    const xmp = Buffer.from(meta.stream).toString("utf8");
    const part = /<pdfaid:part>(\d)<\/pdfaid:part>/.exec(xmp)?.[1];
    const conformance = /<pdfaid:conformance>(\w)<\/pdfaid:conformance>/.exec(xmp)?.[1];
    if (part !== level[0] || conformance !== "B") say("6.6.4", `the metadata does not say PDF/A-${level}`);
    if (!/^<\?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"\?>/.test(xmp) || !/<\?xpacket end="[wr]"\?>\s*$/.test(xmp)) say("6.6.2.1", "the metadata is not a whole XMP packet");
    if (/<\?xpacket[^>]*(bytes|encoding)=/.test(xmp)) say("6.6.2.1", "the packet's header says its bytes or its encoding");
    // Only what the standard's own lists of properties know.
    const spaces = [...xmp.matchAll(/xmlns:(\w+)=/g)].map((m) => m[1]).filter((name) => !["x", "rdf", "xmp", "dc", "pdf", "pdfaid", "xml"].includes(name));
    if (spaces.length) say("6.6.2.3", `the metadata uses properties of its own (${spaces.join(", ")}) without describing them`);
  }

  // 6.2.3 What colour numbers mean.
  const intents = [...catalog.dict.matchAll(/\/OutputIntents \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/(\d+) 0 R/g)].map((r) => objects.get(Number(r[1]))));
  const intent = intents.find((o) => o && /\/S \/GTS_PDFA1/.test(o.dict));
  let intentParts = 0;
  if (intent) {
    const profileId = ref(intent.dict, "DestOutputProfile");
    const profile = profileId === null ? null : objects.get(profileId);
    if (!profile?.stream) say("6.2.3", "the output intent has no profile");
    else {
      intentParts = Number(/\/N (\d)/.exec(profile.dict)?.[1] ?? 0);
      const icc = plain(profile);
      const size = icc.length >= 4 ? ((icc[0] << 24) | (icc[1] << 16) | (icc[2] << 8) | icc[3]) >>> 0 : -1;
      const word = (at: number) => Buffer.from(icc.subarray(at, at + 4)).toString("latin1");
      if (size !== icc.length || word(36) !== "acsp") say("6.2.3", "the output intent's profile is not an ICC profile");
      else {
        if (icc[8] > 4) say("6.2.3", "the output intent's profile is newer than version 4");
        if (!["mntr", "prtr", "scnr", "spac"].includes(word(12))) say("6.2.3", "the output intent's profile is not a device's");
        if (word(16) !== (intentParts === 3 ? "RGB " : intentParts === 4 ? "CMYK" : "GRAY")) say("6.2.3", "the output intent's profile is not of the kind it says");
      }
    }
    if (!/\/OutputConditionIdentifier \(/.test(intent.dict)) say("6.2.3", "the output intent does not name its condition");
  }

  // The pages' own words: every stream that is not something else.
  const contents = all
    .filter((o) => o.stream && !/\/Type \/(XObject|Metadata|ObjStm|XRef|EmbeddedFile)|\/Subtype \/|\/FunctionType|\/N \d|\/Length1/.test(o.dict))
    .map((o) => Buffer.from(plain(o)).toString("latin1"))
    // (Not a font's table of what its glyphs mean, which looks much the same.)
    .filter((stream) => !stream.includes("begincmap"));
  const page = contents.join("\n");
  const usesRgb = /\/DeviceRGB/.test(page) || /(?:^|\s)(?:[\d.]+ ){3}(?:rg|RG)\s/.test(page) || all.some((o) => /\/Subtype \/Image/.test(o.dict) && /\/ColorSpace \/DeviceRGB/.test(o.dict));
  const usesCmyk = /\/DeviceCMYK/.test(page) || /(?:^|\s)(?:[\d.]+ ){4}[kK]\s/.test(page) || all.some((o) => /\/ColorSpace \/DeviceCMYK/.test(o.dict));
  const usesGray = /\/DeviceGray/.test(page) || /(?:^|\s)[\d.]+ [gG]\s/.test(page) || all.some((o) => /\/ColorSpace \/DeviceGray/.test(o.dict));
  if ((usesRgb || usesCmyk || usesGray) && !intent) say("6.2.3", "device colour is used, but nothing says what it means (no PDF/A output intent)");
  if (usesRgb && intent && intentParts !== 3) say("6.2.4.3", "DeviceRGB is used, but the output intent is not an RGB profile");
  if (usesCmyk && intentParts !== 4) say("6.2.4.3", "DeviceCMYK is used, but the output intent is not a CMYK profile");

  // 6.2.11.8 The box that stands for a character a font does not have.
  for (const stream of contents) {
    for (const m of stream.matchAll(/<([0-9a-fA-F]+)>/g)) {
      if (m[1].length % 4 === 0 && (m[1].match(/.{4}/g) ?? []).includes("0000")) {
        say("6.2.11.8", "the glyph for a missing character is drawn");
        break;
      }
    }
  }

  // 6.5 What a file may not do, 6.3 notes and links.
  if (/\/AA[ <]/.test(catalog.dict)) say("6.5.2", "the document has additional actions");
  if (/\/OCProperties/.test(catalog.dict) && /\/AS /.test(text)) say("6.9", "optional content switches itself");
  for (const o of all) {
    if (/\/JavaScript|\/JS[ (<]/.test(o.dict)) say("6.5.1", "there is JavaScript");
    const action = /\/S \/(\w+)/.exec(o.dict)?.[1];
    if (action && FORBIDDEN_ACTIONS.includes(action) && !/\/Type \/StructElem/.test(o.dict)) say("6.5.1", `a ${action} action is not allowed`);
    if (/\/NeedAppearances true/.test(o.dict)) say("6.4.1", "a form asks its reader to draw it");
    if (/\/Type \/Page\b/.test(o.dict) && /\/AA[ <]/.test(o.dict)) say("6.5.2", "a page has additional actions");
    if (/\/Type \/Annot/.test(o.dict)) {
      const kind = /\/Subtype \/(\w+)/.exec(o.dict)?.[1] ?? "";
      if (!ALLOWED_ANNOTATIONS.includes(kind)) say("6.3.1", `${kind || "unnamed"} annotations are not allowed`);
      const flags = Number(/\/F (\d+)/.exec(o.dict)?.[1] ?? 0);
      if (kind !== "Popup" && ((flags & 4) === 0 || (flags & (1 | 2 | 32 | 256)) !== 0)) say("6.3.2", `a ${kind} annotation is not set to print, or is hidden`);
      if (kind !== "Popup" && kind !== "Link" && !/\/AP /.test(o.dict)) say("6.3.3", `a ${kind} annotation has nothing to show`);
      if (/\/AA[ <]/.test(o.dict)) say("6.5.2", `a ${kind} annotation has additional actions`);
    }
    // 6.2.11 Fonts: every one inside the file.
    if (/\/Type \/FontDescriptor/.test(o.dict) && !/\/FontFile[23]? \d+ 0 R/.test(o.dict)) say("6.2.11.4", `the font ${/\/FontName \/(\S+)/.exec(o.dict)?.[1] ?? ""} is not embedded`);
    if (/\/Type \/Font\b/.test(o.dict)) {
      const kind = /\/Subtype \/(\w+)/.exec(o.dict)?.[1] ?? "";
      if (kind === "CIDFontType2" && !/\/CIDToGIDMap/.test(o.dict)) say("6.2.11.3", "a font does not say which glyph each of its numbers is");
      if (kind === "Type0" && !/\/ToUnicode \d+ 0 R/.test(o.dict)) say("6.2.11.7", "a font does not say what its glyphs mean");
      if (!["Type0", "CIDFontType0", "CIDFontType2"].includes(kind) && !/\/FontDescriptor \d+ 0 R/.test(o.dict)) say("6.2.11.4", `a ${kind} font is not embedded`);
    }
    // 6.1.7 Streams.
    if (o.stream) {
      if (/\/LZWDecode/.test(o.dict)) say("6.1.7.2", "a stream is packed with LZW");
      if (/\/(F|FFilter|FDecodeParms) /.test(o.dict.replace(/\/Filter/g, ""))) say("6.1.7.1", "a stream points at a file outside this one");
      if (/\/Subtype \/Image/.test(o.dict)) {
        if (/\/Interpolate true/.test(o.dict)) say("6.2.8", "a picture asks to be smoothed");
        if (/\/Alternates|\/OPI/.test(o.dict)) say("6.2.8", "a picture has alternates or OPI information");
        const bits = Number(/\/BitsPerComponent (\d+)/.exec(o.dict)?.[1] ?? 8);
        if (![1, 2, 4, 8, 16].includes(bits)) say("6.2.8", `a picture has ${bits} bits a colour`);
      }
      if (/\/Subtype \/PS/.test(o.dict)) say("6.2.9", "PostScript is not allowed");
    }
    // 6.8 Files carried inside.
    if (/\/Type \/Filespec/.test(o.dict) && /\/EF /.test(o.dict)) {
      if (level === "2b") say("6.8", "a file is carried inside (only PDF/A-3 may carry any file)");
      else if (!/\/AFRelationship \//.test(o.dict)) say("6.8", "a file carried inside does not say what it is to the document");
    }
  }
  if (level === "3b" && all.some((o) => /\/Type \/Filespec/.test(o.dict)) && !/\/AF \[/.test(catalog.dict)) say("6.8", "the document does not list the files it carries");
  return [...new Set(out)];
}

/**
 * PDF/X-1a:2001, the same way: what is wrong with a file that says it is
 * one (ISO 15930-1). A press's file: PDF 1.3, black ink and greys (or four
 * inks) and nothing else, every font inside, nothing see-through, each page
 * marked with its trim, and a statement of the printing it was made for.
 */
export function pdfxProblems(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const say = (what: string) => out.push(what);
  const raw = Buffer.from(bytes);
  const text = raw.toString("latin1");
  const { objects, trailer } = pdfObjects(bytes);
  if (!objects.size) return ["the file's table of objects cannot be read"];
  const all = [...objects.values()];
  const value = (id: number | null): string => (id === null ? "" : (objects.get(id)?.dict ?? "").trim());

  if (!text.startsWith("%PDF-1.3\n")) say("it is not a PDF 1.3");
  if (!/\/ID \[/.test(trailer)) say("the trailer has no ID");
  if (/\/Encrypt/.test(trailer)) say("the file is encrypted");

  // What it says of itself.
  const info = objects.get(ref(trailer, "Info") ?? -1)?.dict ?? "";
  const said = (key: string) => value(ref(info, key));
  if (said("GTS_PDFXVersion") !== "(PDF/X-1:2001)") say("its Info does not say PDF/X-1:2001");
  if (said("GTS_PDFXConformance") !== "(PDF/X-1a:2001)") say("its Info does not say PDF/X-1a:2001");
  if (!/^\/(True|False)$/.test(said("Trapped"))) say("its Info does not say whether it is trapped");
  for (const key of ["Title", "CreationDate", "ModDate"]) if (!said(key)) say(`its Info has no ${key}`);

  const catalog = all.find((o) => /\/Type \/Catalog/.test(o.dict));
  if (!catalog) return [...out, "no catalog"];
  // The printing it was made for.
  const intents = [...catalog.dict.matchAll(/\/OutputIntents \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/(\d+) 0 R/g)].map((r) => objects.get(Number(r[1]))));
  const intent = intents.find((o) => o && /\/S \/GTS_PDFX/.test(o.dict));
  if (!intent) say("nothing says what printing it was made for (no PDF/X output intent)");
  else {
    if (!/\/OutputConditionIdentifier \(.+?\)/.test(intent.dict)) say("the output intent does not name its condition");
    // Without a profile, the condition has to be one a registry knows.
    if (!/\/DestOutputProfile/.test(intent.dict) && !/\/RegistryName \(http:\/\/www\.color\.org\)/.test(intent.dict)) say("the output intent carries no profile and names no registry");
  }
  if (/\/(Lang|ViewerPreferences|Metadata|MarkInfo|StructTreeRoot|AA|AcroForm|OCProperties) /.test(catalog.dict.replace(/\/PageLabels[^\n]*/g, ""))) say("the catalog holds something newer than PDF 1.3 (or something a press does not take)");

  // Colour: black, greys, four inks. Nothing in three colours, nothing by a profile.
  const contents = all
    .filter((o) => o.stream && !/\/Type \/(XObject|Metadata)|\/Subtype \/|\/FunctionType|\/N \d|\/Length1/.test(o.dict))
    .map((o) => Buffer.from(plain(o)).toString("latin1"))
    .filter((stream) => !stream.includes("begincmap"));
  const page = contents.join("\n");
  if (/\/DeviceRGB/.test(page) || /(?:^|\s)(?:[\d.]+ ){3}(?:rg|RG)\s/.test(page)) say("a page uses three-colour (RGB) ink");
  if (/\/(ICCBased|CalRGB|CalGray|Lab)\b/.test(text)) say("a colour is given by a profile");
  if (/\/(SMask|CA|ca) /.test(text.replace(/\/SMask \/None/g, "")) || /\/S \/Transparency/.test(text) || /\/BM \/(?!Normal|Compatible)/.test(text)) say("something is see-through");
  for (const o of all) {
    if (/\/Subtype \/Image/.test(o.dict)) {
      const space = /\/ColorSpace \/(\w+)/.exec(o.dict)?.[1] ?? /\/ColorSpace (\[[^\]]*\])/.exec(o.dict)?.[1] ?? "";
      if (space !== "DeviceGray" && space !== "DeviceCMYK") say(`a picture is in ${space || "colours it does not name"}`);
      if (/\/Interpolate true|\/Alternates|\/OPI/.test(o.dict)) say("a picture has something a press does not take");
    }
    if (/\/Type \/FontDescriptor/.test(o.dict) && !/\/FontFile[23]? \d+ 0 R/.test(o.dict)) say("a font is not embedded");
    if (/\/Type \/Annot/.test(o.dict)) say("a page has an annotation");
    if (/\/JavaScript|\/JS[ (<]|\/Type \/Filespec|\/LZWDecode|\/JBIG2Decode|\/JPXDecode/.test(o.dict)) say("the file holds something a press does not take");
    // Each page: its trim, inside its bleed, inside its sheet.
    if (/\/Type \/Page\b/.test(o.dict)) {
      const box = (name: string) => new RegExp(`/${name} \\[([^\\]]+)\\]`).exec(o.dict)?.[1].trim().split(/\s+/).map(Number);
      const media = box("MediaBox");
      const trim = box("TrimBox");
      const bleedBox = box("BleedBox") ?? media;
      if (!trim || !media) say("a page does not say where it is trimmed");
      else if (/\/ArtBox/.test(o.dict)) say("a page has both a trim and an art box");
      else {
        const within = (a: number[], b: number[]) => a[0] >= b[0] - 0.01 && a[1] >= b[1] - 0.01 && a[2] <= b[2] + 0.01 && a[3] <= b[3] + 0.01;
        if (!bleedBox || !within(trim, bleedBox) || !within(bleedBox, media)) say("a page's trim is not inside its bleed, or its bleed not inside its sheet");
      }
    }
  }
  return [...new Set(out)];
}
