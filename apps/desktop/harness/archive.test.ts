// An archive copy: a PDF that says of itself everything a reader in many
// years will need (PDF/A-2b). There is no validator here, so the standard's
// rules are a checklist (pdfa.ts), run on a document with one of everything
// a file of ours can hold: text in several faces, a link out and a link
// within, a table, a picture kept as it is, one with its own colours, one
// that is see-through, tags, and a character no font here can draw.
//
// The checklist is tried too: a file with each fault put into it has to be
// found out.

import { check, finish } from "./env";
import "./dom";

import { writeFileSync } from "node:fs";
import path from "node:path";

import type { JSONContent } from "@tiptap/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { DEFAULT_SETTINGS } from "../src/apps/documents/docSettings";
import { keptPicture, sniff, type PdfPicture } from "../src/book/engine/pictures";
import { TypesetSession, type DocRequest } from "../src/book/engine/run";
import { loadFontFiles } from "../src/book/fonts/files";
import { srgbProfile } from "../src/book/render/srgb";
import { pdfaClaim, xmpPacket } from "../src/book/render/xmp";
import { buildDocModel } from "../src/doclayout/model";
import { pdfaProblems, pdfObjects } from "./pdfa";
import { fakeProfile, png, QUAD_JPEG, withExif, withProfile } from "./pix";

const t = (text: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (text: string): JSONContent => ({ type: "tableCell", content: [p(t(text))] });

// (A snowman and a face: no face of type here has either.)
const MISSING = String.fromCodePoint(0x1f642);
const doc: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [t("An archive copy")] },
    p(t("Kept for a long time, with "), t("a link out", { type: "link", attrs: { href: "https://example.org/archive" } }), t(", some "), t("bold", "bold"), t(" and "), t("italic", "italic"), t(` words, and a face ${MISSING} no font has.`)),
    { type: "table", attrs: { head: true }, content: [{ type: "tableRow", content: [cell("Year"), cell("Kept")] }, { type: "tableRow", content: [cell("2026"), cell("Yes")] }] },
    { type: "image", attrs: { src: "pic:photo", width: 160, height: 80, alt: "Four blocks of colour" } },
    { type: "image", attrs: { src: "pic:turned", width: 80, height: 160, alt: "The same, on its side" } },
    { type: "image", attrs: { src: "pic:cutout", width: 120, height: 60, alt: "A shape with nothing round it" } },
    { type: "heading", attrs: { level: 2 }, content: [t("Further on")] },
    p(t("The end.")),
  ],
};
const camera = withProfile(withExif(QUAD_JPEG, 6), fakeProfile());
const rgb = new Uint8Array(20 * 10 * 3).fill(120);
const alpha = Uint8Array.from({ length: 200 }, (_, i) => (i % 20 < 5 ? 0 : 255));
const PICTURES = new Map<string, PdfPicture>([
  ["pic:photo", keptPicture(QUAD_JPEG, sniff(QUAD_JPEG)!)],
  ["pic:turned", keptPicture(camera, sniff(camera)!)],
  ["pic:cutout", { kind: "rgb", bytes: rgb, w: 20, h: 10, alpha }],
]);

const session = new TypesetSession();
const make = async (pdf: DocRequest["pdf"], title = "Kept & <sound>") => {
  const model = buildDocModel(doc, { title, author: "A. Writer", settings: { ...DEFAULT_SETTINGS, subject: "What lasts", keywords: "archive, PDF/A", lang: "en-GB", fC: "{page}" }, ...(pdf?.tagged ? { struct: true } : {}) });
  session.addFonts(await loadFontFiles(session.missingFamilies(model.families)));
  const req: DocRequest = {
    kind: "document",
    doc: model,
    families: model.families,
    images: [
      { url: "pic:photo", w: 16, h: 8 },
      { url: "pic:turned", w: 8, h: 16 },
      { url: "pic:cutout", w: 20, h: 10 },
    ],
    ...(pdf ? { pdf } : {}),
  };
  return (await session.pdf(req, () => {}, async (want) => new Map(want.flatMap((w) => (PICTURES.has(w.url) ? [[w.url, PICTURES.get(w.url)!] as [string, PdfPicture]] : []))))).bytes;
};
const latin = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const dump = process.env.WF_DUMP;

// ---------------------------------------------------------- the profile

{
  const icc = srgbProfile();
  const word = (at: number) => latin(icc.subarray(at, at + 4));
  const size = ((icc[0] << 24) | (icc[1] << 16) | (icc[2] << 8) | icc[3]) >>> 0;
  check("the colour profile is made here: a small ICC profile for a screen, in three colours", icc.length === 524 && size === icc.length && word(36) === "acsp" && word(12) === "mntr" && word(16) === "RGB " && word(20) === "XYZ " && icc[8] === 4, `${icc.length} bytes`);
  const tags = Array.from({ length: (icc[128] << 24) | (icc[129] << 16) | (icc[130] << 8) | icc[131] }, (_, i) => word(132 + i * 12)).join(" ");
  check("…with what one has to hold", tags === "desc cprt wtpt chad rXYZ gXYZ bXYZ rTRC gTRC bTRC", tags);
  const fixedAt = (at: number) => (((icc[at] << 24) | (icc[at + 1] << 16) | (icc[at + 2] << 8) | icc[at + 3]) | 0) / 65536;
  const tagAt = (name: string) => {
    const i = tags.split(" ").indexOf(name);
    const at = 132 + i * 12 + 4;
    return ((icc[at] << 24) | (icc[at + 1] << 16) | (icc[at + 2] << 8) | icc[at + 3]) >>> 0;
  };
  const colour = (name: string) => [8, 12, 16].map((k) => fixedAt(tagAt(name) + k));
  const sum = [0, 1, 2].map((k) => colour("rXYZ")[k] + colour("gXYZ")[k] + colour("bXYZ")[k]);
  check("its red, green and blue add up to its white", Math.abs(sum[0] - 0.9642) < 0.0002 && Math.abs(sum[1] - 1) < 0.0002 && Math.abs(sum[2] - 0.8249) < 0.0002, sum.map((n) => n.toFixed(5)).join(" "));
  check("…and are sRGB's", Math.abs(colour("rXYZ")[0] - 0.436) < 0.001 && Math.abs(colour("gXYZ")[1] - 0.7169) < 0.001 && Math.abs(colour("bXYZ")[2] - 0.7139) < 0.001);
  check("its curve is sRGB's, written once for all three", tagAt("rTRC") === tagAt("gTRC") && tagAt("gTRC") === tagAt("bTRC") && Math.abs(fixedAt(tagAt("rTRC") + 12) - 2.4) < 0.001);
  check("it is the same bytes every time", srgbProfile() === icc);
}

// ------------------------------------------------------------ the claim

{
  const claim = pdfaClaim(2);
  check("the claim names the part of the standard and its level", claim.includes("<pdfaid:part>2</pdfaid:part>") && claim.includes("<pdfaid:conformance>B</pdfaid:conformance>") && claim.includes('xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"'));
  const now = new Date(Date.UTC(2026, 9, 13));
  const xmp = xmpPacket({ title: "T", author: "", subject: "", keywords: "", lang: "", created: now, modified: now, creator: "c", producer: "p", extra: [pdfaClaim(3)] });
  check("…and goes into the metadata beside the rest", xmp.includes("<pdfaid:part>3</pdfaid:part>") && xmp.indexOf("pdfaid:part") > xmp.indexOf("pdf:Producer") && xmp.indexOf("pdfaid:part") < xmp.indexOf("</rdf:RDF>"));
}

// ------------------------------------------------------------- the file

const archived = await make({ pictures: "print", tagged: true, archive: true, source: false });
const ordinary = await make({ pictures: "print", tagged: true, archive: false, source: false });
if (dump) {
  writeFileSync(path.join(dump, "archive.pdf"), archived);
  writeFileSync(path.join(dump, "ordinary.pdf"), ordinary);
}

{
  const problems = pdfaProblems(archived);
  check("an archive copy keeps every rule on the list", problems.length === 0, problems.join(" | "));
  const text = latin(archived);
  check("it is a PDF 1.7 that says it is PDF/A-2b", text.startsWith("%PDF-1.7") && text.includes("<pdfaid:part>2</pdfaid:part>"));
  const { objects } = pdfObjects(archived);
  const intent = [...objects.values()].find((o) => /\/Type \/OutputIntent/.test(o.dict));
  check("…and what its colours mean: sRGB, by the profile made here", !!intent && /\/S \/GTS_PDFA1/.test(intent.dict) && /sRGB IEC61966-2\.1/.test(intent.dict) && /\/DestOutputProfile \d+ 0 R/.test(intent.dict));

  const pdf = await getDocument({ data: archived.slice(), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const meta = await pdf.getMetadata();
  const info = meta.info as Record<string, unknown>;
  check("what it says in its Info and in its metadata is the same, to the letter", info.Title === "Kept & <sound>" && meta.metadata?.get("dc:title") === "Kept & <sound>" && info.Author === "A. Writer" && String(meta.metadata?.get("dc:creator")) === "A. Writer" && info.Subject === "What lasts" && meta.metadata?.get("dc:description") === "What lasts" && info.Keywords === "archive, PDF/A" && meta.metadata?.get("pdf:keywords") === "archive, PDF/A", JSON.stringify([info.Title, meta.metadata?.get("dc:title"), meta.metadata?.get("dc:creator"), meta.metadata?.get("pdf:keywords")]));
  const words = (await (await pdf.getPage(1)).getTextContent()).items.map((it) => ("str" in it ? it.str : "")).join(" ");
  check("its words are all there but the character nothing here can draw", words.includes("a face") && words.includes("no font has") && !words.includes(MISSING), words.slice(0, 160));
  const links = (await (await pdf.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Link");
  check("its link still goes where it went, and is set to print", links.length === 1 && links[0].url === "https://example.org/archive" && (links[0].annotationFlags & 4) === 4);
  check("its tags are kept (though the claim is the basic level)", (await pdf.getMarkInfo())?.Marked === true && !!(await (await pdf.getPage(1)).getStructTree()));
  check("its pictures are as they were: a JPEG byte for byte, one in its own colours, one see-through", Buffer.from(archived).indexOf(Buffer.from(QUAD_JPEG)) > 0 && text.includes("/ICCBased") && text.includes("/SMask"));
}

{
  const problems = pdfaProblems(ordinary);
  check("an ordinary PDF makes no such claim, and the list says what it lacks", problems.some((x) => x.startsWith("6.6.4")) && problems.some((x) => x.startsWith("6.2.3")) && !latin(ordinary).includes("pdfaid") && !latin(ordinary).includes("OutputIntent"), problems.join(" | "));
  check("…and draws the box for the character no font has (an archive copy may not)", problems.some((x) => x.startsWith("6.2.11.8")), problems.join(" | "));
  check("that is all that sets the two apart to the list", problems.every((x) => /^6\.(6\.4|2\.3|2\.11\.8)/.test(x)), problems.join(" | "));

  const plain = await make({ pictures: "print", tagged: false, archive: true, source: false }, "Untagged");
  check("an archive copy need not be tagged", pdfaProblems(plain).length === 0 && !latin(plain).includes("/StructTreeRoot"), pdfaProblems(plain).join(" | "));
  const none = await make(undefined, "As before");
  check("nothing asked for: nothing of it in the file", !latin(none).includes("pdfaid") && !latin(none).includes("OutputIntent"));
}

// ------------------------------------------------- the list finds faults

{
  // Each fault is put into a good file without moving a byte (the table of
  // where things are stays true).
  const spoil = (from: string, to: string): Uint8Array => {
    if (from.length !== to.length) throw new Error(`${from} and ${to} differ in length`);
    const text = latin(archived);
    const at = text.indexOf(from);
    if (at < 0) throw new Error(`${from} is not in the file`);
    const out = archived.slice();
    out.set(Buffer.from(to, "latin1"), at);
    return out;
  };
  const found = (bytes: Uint8Array, clause: string) => pdfaProblems(bytes).some((x) => x.startsWith(clause));
  check("a file that claims another part is found out", found(spoil("<pdfaid:part>2<", "<pdfaid:part>1<"), "6.6.4"));
  check("…one whose link is hidden", found(spoil("/F 4", "/F 2"), "6.3.2"));
  check("…one with a font left outside", found(spoil("/FontFile2 ", "/FontFileX "), "6.2.11.4"));
  check("…one that does not say what its colours mean", found(spoil("/GTS_PDFA1", "/GTS_PDFX "), "6.2.3"));
  check("…one packed the old way", found(spoil("/DCTDecode", "/LZWDecode"), "6.1.7.2"));
  check("…one with a script in it", found(spoil("/S /URI", "/S /JS "), "6.5.1") || found(spoil("/S /URI", "/S /JS "), "6.3"));
  check("…one whose picture asks to be smoothed", found(spoil("/BitsPerComponent 8", "/Interpolate true  "), "6.2.8"));
  check("…and one held to the part of the standard it does not claim", pdfaProblems(archived, "3b").some((x) => x.startsWith("6.6.4")));
}

finish();
