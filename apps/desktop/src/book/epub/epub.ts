/**
 * EPUB 3 from the book model — for Kindle (through KDP), Apple Books, Kobo,
 * Google Play. One XHTML file per section, a navigation document plus the
 * older NCX (Kindle still reads it), an OPF with the book's metadata, and
 * ebook-safe CSS derived from the design: relative units, no forced fonts
 * unless embedded, effects that degrade gracefully on Kindle (small caps
 * are written as uppercase text at a smaller size, drop caps are opt-in).
 */

import { xmlEscape as esc } from "../../apps/documents/ooxml";
import type { Book } from "../model/bookMap";
import { contentsLabel, copyrightParagraphs } from "../model/frontmatter";
import type { Block, BookModel, Run, Section } from "../model/types";

export interface EpubOptions {
  /** Stable identifier when there's no ebook ISBN (stored in the book map). */
  uuid: string;
  cover?: { bytes: Uint8Array; type: "image/jpeg" | "image/png" } | null;
  /** Image bytes for the manuscript's images, by source URL. */
  images?: Map<string, { bytes: Uint8Array; type: string }>;
  /** Embedded font files (only when the book asks for them). */
  fonts?: { family: string; style: "normal" | "italic"; weight: 400 | 700; file: string; bytes: Uint8Array; type: string }[];
  now?: Date;
}

interface Doc {
  id: string;
  href: string;
  title: string;
  body: string;
  /** epub:type of the body. */
  type: string;
  linear?: boolean;
  /** Nested under a part in the navigation. */
  parent?: string;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

function inline(runs: Run[]): string {
  return runs
    .map((r) => {
      if (r.text === "\n") return "<br/>";
      let html = esc(r.text);
      if (r.italic) html = `<i>${html}</i>`;
      if (r.bold) html = `<b>${html}</b>`;
      if (r.href && SAFE_LINK.test(r.href)) html = `<a href="${esc(r.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

/** Pull the first `count` words out of a paragraph's runs as the lead-in. */
function splitLead(runs: Run[], count: number): { lead: Run[]; rest: Run[] } {
  const lead: Run[] = [];
  const rest: Run[] = [];
  let taken = 0;
  let done = false;
  for (const r of runs) {
    if (done || r.text === "\n") {
      rest.push(r);
      done = true;
      continue;
    }
    const words = r.text.split(/(\s+)/);
    let i = 0;
    let head = "";
    for (; i < words.length; i += 1) {
      if (!words[i].trim()) {
        if (taken >= count) break;
        head += words[i];
        continue;
      }
      if (taken >= count) break;
      head += words[i];
      taken += 1;
    }
    if (head) lead.push({ ...r, text: head });
    const tail = words.slice(i).join("");
    if (tail) {
      rest.push({ ...r, text: tail });
      done = true;
    }
  }
  return { lead, rest };
}

function xhtml(title: string, lang: string, bodyType: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="../styles/book.css"/>
</head>
<body epub:type="${bodyType}">
${body}
</body>
</html>
`;
}

function css(book: Book, embedded: EpubOptions["fonts"]): string {
  const d = book.design;
  const fontFaces = (embedded ?? [])
    .map(
      (f) =>
        `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weight}; src: url("../fonts/${f.file}"); }`,
    )
    .join("\n");
  const bodyFamily = embedded?.length ? `font-family: "${embedded[0].family}", serif;` : "";
  const labelStyle =
    d.labelCase === "upper"
      ? "text-transform: uppercase; letter-spacing: 0.15em; font-size: 0.75em;"
      : d.labelCase === "smallcaps"
        ? "font-variant: small-caps; letter-spacing: 0.08em; font-size: 0.9em;"
        : "font-size: 0.9em;";
  const titleStyle = [
    d.titleItalic ? "font-style: italic;" : "",
    d.titleCase === "upper" ? "text-transform: uppercase; letter-spacing: 0.06em;" : "",
    d.titleCase === "smallcaps" ? "font-variant: small-caps;" : "",
  ].join(" ");
  return `${fontFaces}
body { margin: 0; ${bodyFamily} widows: 2; orphans: 2; -webkit-hyphens: auto; -epub-hyphens: auto; hyphens: auto; }
p { margin: 0; text-indent: ${d.indent}em; text-align: ${d.justify ? "justify" : "left"}; }
p.first, p.center, p.right, .scene-break, .verse p, blockquote p, .epigraph p, .front p, li p { text-indent: 0; }
p.center { text-align: center; }
p.right { text-align: right; }
h1 { margin: 3em 0 1.6em; text-align: ${d.headingAlign}; font-weight: normal; line-height: 1.25; -webkit-hyphens: none; hyphens: none; page-break-after: avoid; }
h1 .label { display: block; ${labelStyle} margin-bottom: 0.4em; }
h1 .title { display: block; font-size: 1.35em; ${titleStyle} }
.subtitle { text-align: ${d.headingAlign}; font-style: italic; margin: -1em 0 2em; text-indent: 0; }
.ornament { text-align: center; margin: -0.8em 0 1.6em; text-indent: 0; }
h2.subhead { font-size: 1em; font-weight: normal; font-variant: small-caps; letter-spacing: 0.06em; text-align: center; margin: 1.6em 0 0.6em; }
.scene-break { text-align: center; margin: 1em 0; letter-spacing: 0.3em; }
.page-break { page-break-before: always; break-before: page; }
blockquote { margin: 1em 2em;${d.blockquote === "indent-italic" ? " font-style: italic;" : d.blockquote === "smaller" ? " font-size: 0.92em;" : ""} }
.verse { margin: 1em 2em; }
.verse p { text-align: left; margin-bottom: 0.8em; }
.epigraph { margin: 0 2em 2em; font-style: italic; }
.epigraph p.attribution { text-align: right; font-style: normal; margin-top: 0.4em; }
.lead { font-size: 0.82em; letter-spacing: 0.05em; }
.dropcap { float: left; font-size: 3.1em; line-height: 0.85; margin: 0.06em 0.08em 0 0; }
figure { margin: 1.5em 0; text-align: center; }
figure img { max-width: 100%; }
section.part { text-align: center; margin-top: 30%; }
section.part h1 { margin-top: 0; }
.titlepage { text-align: center; margin-top: 20%; }
.titlepage .book-title { font-size: 1.8em; margin-bottom: 0.4em; }
.titlepage .book-subtitle { font-style: italic; margin-bottom: 3em; }
.titlepage .book-author { font-size: 1.15em; letter-spacing: 0.05em; }
.titlepage .book-publisher { margin-top: 4em; font-size: 0.85em; }
.copyright p { font-size: 0.85em; margin-bottom: 0.9em; text-align: left; }
.dedication, .book-epigraph { text-align: center; margin-top: 30%; font-style: italic; }
.alsoby h1, .about h1 { margin-top: 2em; }
.alsoby p { text-align: center; text-indent: 0; margin-bottom: 0.4em; }
nav#toc ol { list-style: none; padding: 0; }
nav#toc li { margin: 0.4em 0; }
@media amzn-kf8 { .dropcap { margin-top: 0.1em; } }
`;
}

export async function buildEpub(model: BookModel, opts: EpubOptions): Promise<Uint8Array> {
  const book = model.book;
  const meta = book.meta;
  const design = book.design;
  const lang = meta.language || "en-US";
  const now = opts.now ?? new Date();
  const ornament = design.sceneBreak === "blank" ? "* * *" : opts.fonts?.length ? design.ornament : asciiOrnament(design.ornament);
  const docs: Doc[] = [];
  const images: { id: string; href: string; type: string; bytes: Uint8Array }[] = [];
  // Manuscript images that were fetched ship in the book; the rest are left
  // out (the export dialog warns about them).
  const imageHref = new Map<string, string>();
  const imageFor = (url: string): string | null => {
    const known = imageHref.get(url);
    if (known) return known;
    const img = opts.images?.get(url);
    if (!img) return null;
    const ext = img.type === "image/png" ? "png" : img.type === "image/gif" ? "gif" : "jpg";
    const href = `images/img-${imageHref.size + 1}.${ext}`;
    imageHref.set(url, href);
    images.push({ id: `img${imageHref.size}`, href, type: img.type, bytes: img.bytes });
    return href;
  };

  // ---- front matter
  if (opts.cover) {
    const ext = opts.cover.type === "image/png" ? "png" : "jpg";
    images.push({ id: "cover-image", href: `images/cover.${ext}`, type: opts.cover.type, bytes: opts.cover.bytes });
    docs.push({
      id: "cover",
      href: "text/cover.xhtml",
      title: "Cover",
      type: "cover",
      body: `<section epub:type="cover" class="cover"><img src="../images/cover.${ext}" alt="${esc(meta.title)}" style="width:100%;"/></section>`,
    });
  }
  docs.push({
    id: "titlepage",
    href: "text/titlepage.xhtml",
    title: meta.title || "Title page",
    type: "frontmatter",
    body: `<section epub:type="titlepage" class="titlepage front">
<p class="book-title">${esc(meta.title)}</p>
${meta.subtitle ? `<p class="book-subtitle">${esc(meta.subtitle)}</p>` : ""}
${meta.author ? `<p class="book-author">${esc(meta.author)}</p>` : ""}
${meta.publisher ? `<p class="book-publisher">${esc(meta.publisher)}</p>` : ""}
</section>`,
  });
  const copyright: Doc = {
    id: "copyright",
    href: "text/copyright.xhtml",
    title: "Copyright",
    type: book.ebook.copyrightAtBack ? "backmatter" : "frontmatter",
    body: `<section epub:type="copyright-page" class="copyright front">
${copyrightParagraphs(meta, now).map((line) => `<p>${esc(line)}</p>`).join("\n")}
</section>`,
  };
  if (!book.ebook.copyrightAtBack) docs.push(copyright);
  if (meta.dedication.trim() && book.print.dedication) {
    docs.push({
      id: "dedication",
      href: "text/dedication.xhtml",
      title: "Dedication",
      type: "frontmatter",
      body: `<section epub:type="dedication" class="dedication front">${meta.dedication
        .split("\n")
        .map((l) => `<p>${esc(l)}</p>`)
        .join("")}</section>`,
    });
  }
  if (meta.epigraph.trim() && book.print.epigraph) {
    docs.push({
      id: "epigraph",
      href: "text/epigraph.xhtml",
      title: "Epigraph",
      type: "frontmatter",
      body: `<section epub:type="epigraph" class="book-epigraph front">${meta.epigraph
        .split("\n")
        .map((l) => `<p>${esc(l)}</p>`)
        .join("")}${meta.epigraphSource ? `<p class="right">— ${esc(meta.epigraphSource)}</p>` : ""}</section>`,
    });
  }
  if (meta.alsoBy.length && book.print.alsoBy === "front") docs.push(alsoByDoc(meta.alsoBy, meta.author));

  // ---- the story
  let partHref: string | undefined;
  let fileNo = 0;
  let firstBody: string | null = null;
  for (const section of model.sections) {
    fileNo += 1;
    const isPart = section.kind === "part";
    const href = `text/${isPart ? "part" : "ch"}-${String(fileNo).padStart(3, "0")}.xhtml`;
    if (isPart) partHref = href;
    if (section.matter === "body" && !firstBody) firstBody = href;
    const chapterType =
      section.kind === "part"
        ? "part"
        : section.kind === "chapter"
          ? "chapter"
          : sectionType(section.title, section.matter);
    docs.push({
      id: `s${fileNo}`,
      href,
      title: contentsLabel(section),
      type: section.matter === "body" ? "bodymatter" : `${section.matter}matter`,
      body: sectionXhtml(section, chapterType, ornament, book, imageFor),
      parent: !isPart && section.kind === "chapter" ? partHref : undefined,
    });
  }

  // ---- back matter
  if (meta.alsoBy.length && book.print.alsoBy === "back") docs.push(alsoByDoc(meta.alsoBy, meta.author));
  if (meta.aboutAuthor.trim() && book.print.aboutAuthor) {
    docs.push({
      id: "about",
      href: "text/about.xhtml",
      title: "About the Author",
      type: "backmatter",
      body: `<section epub:type="appendix" class="about"><h1><span class="title">About the Author</span></h1>${meta.aboutAuthor
        .split(/\n+/)
        .map((p, i) => `<p${i === 0 ? ' class="first"' : ""}>${esc(p)}</p>`)
        .join("")}</section>`,
    });
  }
  if (book.ebook.copyrightAtBack) docs.push(copyright);

  // ---- navigation
  const navItems = docs.filter((d) => !["cover", "titlepage", "copyright"].includes(d.id));
  const tocList = navList(navItems);
  const navDoc = xhtml(
    "Contents",
    lang,
    "frontmatter",
    `<nav epub:type="toc" id="toc" role="doc-toc"><h1><span class="title">Contents</span></h1>
${tocList}
</nav>
<nav epub:type="landmarks" id="landmarks" hidden=""><ol>
<li><a epub:type="toc" href="nav.xhtml#toc">Contents</a></li>
${firstBody ? `<li><a epub:type="bodymatter" href="${firstBody}">Start reading</a></li>` : ""}
</ol></nav>`,
  ).replace(/\.\.\/styles\//g, "styles/");

  const identifier =
    meta.isbnEbook && /^[\d-\sX]+$/i.test(meta.isbnEbook)
      ? `urn:isbn:${meta.isbnEbook.replace(/[\s-]/g, "")}`
      : `urn:uuid:${opts.uuid}`;
  const modified = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const fonts = opts.fonts ?? [];
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${esc(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${esc(identifier)}</dc:identifier>
<dc:title>${esc(meta.title || "Untitled")}</dc:title>
${meta.author ? `<dc:creator id="creator">${esc(meta.author)}</dc:creator>` : ""}
<dc:language>${esc(lang)}</dc:language>
${meta.publisher ? `<dc:publisher>${esc(meta.publisher)}</dc:publisher>` : ""}
${meta.description ? `<dc:description>${esc(meta.description)}</dc:description>` : ""}
<dc:date>${meta.copyrightYear ?? now.getFullYear()}</dc:date>
<dc:rights>Copyright © ${meta.copyrightYear ?? now.getFullYear()} ${esc(meta.copyrightHolder || meta.author)}</dc:rights>
<meta property="dcterms:modified">${modified}</meta>
${meta.series ? `<meta property="belongs-to-collection" id="series">${esc(meta.series)}</meta>
<meta refines="#series" property="collection-type">series</meta>${meta.seriesNumber ? `
<meta refines="#series" property="group-position">${meta.seriesNumber}</meta>` : ""}` : ""}
${opts.cover ? '<meta name="cover" content="cover-image"/>' : ""}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="styles/book.css" media-type="text/css"/>
${docs.map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`).join("\n")}
${images.map((i) => `<item id="${i.id}" href="${i.href}" media-type="${i.type}"${i.id === "cover-image" ? ' properties="cover-image"' : ""}/>`).join("\n")}
${fonts.map((f, i) => `<item id="font${i + 1}" href="fonts/${f.file}" media-type="${f.type}"/>`).join("\n")}
</manifest>
<spine toc="ncx">
${spineOrder(docs, book.ebook.toc).join("\n")}
</spine>
<guide>
<reference type="toc" title="Contents" href="nav.xhtml#toc"/>
${firstBody ? `<reference type="text" title="Start reading" href="${firstBody}"/>` : ""}
</guide>
</package>
`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(lang)}">
<head>
<meta name="dtb:uid" content="${esc(identifier)}"/>
<meta name="dtb:depth" content="${navItems.some((d) => d.parent) ? 2 : 1}"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${esc(meta.title || "Untitled")}</text></docTitle>
<navMap>
${ncxPoints(navItems)}
</navMap>
</ncx>
`;

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  // The mimetype entry must be first and stored uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
  );
  zip.file("OEBPS/content.opf", opf);
  zip.file("OEBPS/nav.xhtml", navDoc);
  zip.file("OEBPS/toc.ncx", ncx);
  zip.file("OEBPS/styles/book.css", css(book, fonts));
  for (const d of docs) zip.file(`OEBPS/${d.href}`, xhtml(d.title, lang, d.type, d.body));
  for (const i of images) zip.file(`OEBPS/${i.href}`, i.bytes);
  for (const f of fonts) zip.file(`OEBPS/fonts/${f.file}`, f.bytes);
  return zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", compression: "DEFLATE" });
}

/** Ornaments outside every reader's default fonts fall back to asterisks. */
function asciiOrnament(o: string): string {
  return /^[\x20-\x7E]+$/.test(o) ? o : "* * *";
}

function sectionType(title: string, matter: Section["matter"]): string {
  const t = title.toLowerCase();
  if (/^prologue$/.test(t)) return "prologue";
  if (/^epilogue$/.test(t)) return "epilogue";
  if (/^foreword$/.test(t)) return "foreword";
  if (/^preface$/.test(t)) return "preface";
  if (/^introduction$/.test(t)) return "introduction";
  if (/^afterword$/.test(t)) return "afterword";
  if (/^acknowledg(e)?ments$/.test(t)) return "acknowledgments";
  if (/^glossary$/.test(t)) return "glossary";
  if (/^appendix/.test(t)) return "appendix";
  return matter === "body" ? "chapter" : matter === "front" ? "preamble" : "appendix";
}

const ROLE: Record<string, string> = {
  chapter: "doc-chapter",
  part: "doc-part",
  prologue: "doc-prologue",
  epilogue: "doc-epilogue",
  foreword: "doc-foreword",
  preface: "doc-preface",
  introduction: "doc-introduction",
  afterword: "doc-afterword",
  acknowledgments: "doc-acknowledgments",
  glossary: "doc-glossary",
  appendix: "doc-appendix",
};

function sectionXhtml(
  section: Section,
  type: string,
  ornament: string,
  book: Book,
  imageFor: (url: string) => string | null,
): string {
  const design = book.design;
  const head = [
    section.label ? `<span class="label">${esc(section.label)}</span>` : "",
    section.title && !(design.chapterTitle === "hide" && section.kind === "chapter")
      ? `<span class="title">${esc(section.title)}</span>`
      : "",
  ].join("");
  const role = ROLE[type] ? ` role="${ROLE[type]}"` : "";
  const parts: string[] = [];
  parts.push(`<section epub:type="${type}"${role} id="${section.id}"${section.kind === "part" ? ' class="part"' : ""}>`);
  if (head) parts.push(`<h1>${head}</h1>`);
  if (section.subtitle) parts.push(`<p class="subtitle">${esc(section.subtitle)}</p>`);
  if (design.headingOrnament && section.kind === "chapter") parts.push(`<p class="ornament">${esc(design.headingOrnament)}</p>`);
  if (section.epigraph) parts.push(epigraphXhtml(section.epigraph.paras, section.epigraph.attribution));
  let breakNext = false;
  for (const block of section.blocks) {
    if (block.kind === "pageBreak") {
      breakNext = true;
      continue;
    }
    const html = blockXhtml(block, ornament, book, imageFor);
    if (!html) continue;
    parts.push(breakNext ? pageBreakBefore(html) : html);
    breakNext = false;
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** A page break: the block after it starts a new page in the reader (a
 *  class on its opening tag — empty break elements aren't honored everywhere). */
function pageBreakBefore(html: string): string {
  return html.replace(/^<([a-z][a-z0-9]*)(?: class="([^"]*)")?/, (_, tag: string, cls?: string) => `<${tag} class="${cls ? `${cls} ` : ""}page-break"`);
}

function epigraphXhtml(paras: Run[][], attribution: Run[] | null): string {
  return `<div class="epigraph">${paras.map((p) => `<p>${inline(p)}</p>`).join("")}${
    attribution ? `<p class="attribution">— ${inline(attribution)}</p>` : ""
  }</div>`;
}

function blockXhtml(
  block: Block,
  ornament: string,
  book: Book,
  imageFor: (url: string) => string | null,
): string {
  const design = book.design;
  switch (block.kind) {
    case "para": {
      const cls = [
        !block.indent ? "first" : "",
        block.align === "center" ? "center" : block.align === "right" ? "right" : "",
      ]
        .filter(Boolean)
        .join(" ");
      let html = inline(block.runs);
      if (block.opener && block.align === "left") {
        let runs = block.runs;
        let cap = "";
        if (book.ebook.dropCaps && design.dropCap > 0) {
          const first = runs[0]?.text ?? "";
          const m = /^([“"‘'(]*\p{L})/u.exec(first);
          if (m) {
            cap = `<span class="dropcap">${esc(m[1])}</span>`;
            runs = [{ ...runs[0], text: first.slice(m[1].length) }, ...runs.slice(1)];
          }
        }
        if (design.leadIn !== "none") {
          const { lead, rest } = splitLead(runs, design.leadIn === "first-line" ? 6 : 3);
          html = `${cap}<span class="lead">${inline(lead.map((r) => ({ ...r, text: r.text.toUpperCase() })))}</span>${inline(rest)}`;
        } else {
          html = cap + inline(runs);
        }
      }
      return `<p${cls ? ` class="${cls}"` : ""}>${html}</p>`;
    }
    case "scene":
      return `<p class="scene-break" role="separator" aria-label="Scene break">${esc(ornament)}</p>`;
    case "subheading":
      return `<h2 class="subhead">${inline(block.runs)}</h2>`;
    case "blockquote":
      return `<blockquote>${block.paras
        .map((p) => `<p${p.align === "center" ? ' class="center"' : p.align === "right" ? ' class="right"' : ""}>${inline(p.runs)}</p>`)
        .join("")}</blockquote>`;
    case "verse":
      return `<div class="verse"><p>${block.lines.map((l) => inline(l)).join("<br/>")}</p></div>`;
    case "epigraph":
      return epigraphXhtml(block.paras, block.attribution);
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      return `<${tag}>${block.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${tag}>`;
    }
    case "image": {
      const href = imageFor(block.url);
      return href ? `<figure><img src="../${href}" alt="${esc(block.alt)}"/></figure>` : "";
    }
    case "pageBreak":
      return "";
  }
}

function alsoByDoc(titles: string[], author: string): Doc {
  return {
    id: "alsoby",
    href: "text/alsoby.xhtml",
    title: author ? `Also by ${author}` : "Also by",
    type: "frontmatter",
    body: `<section epub:type="appendix" class="alsoby"><h1><span class="title">${esc(author ? `Also by ${author}` : "Also by")}</span></h1>${titles
      .map((t) => `<p><i>${esc(t)}</i></p>`)
      .join("")}</section>`,
  };
}

function navList(items: Doc[]): string {
  const top = items.filter((d) => !d.parent);
  const children = (href: string) => items.filter((d) => d.parent === href);
  const li = (d: Doc): string => {
    const kids = children(d.href);
    return `<li><a href="${d.href}">${esc(d.title)}</a>${kids.length ? `<ol>${kids.map(li).join("")}</ol>` : ""}</li>`;
  };
  return `<ol>${top.map(li).join("\n")}</ol>`;
}

function ncxPoints(items: Doc[]): string {
  let order = 0;
  const point = (d: Doc): string => {
    order += 1;
    const kids = items.filter((k) => k.parent === d.href);
    return `<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${esc(d.title)}</text></navLabel><content src="${d.href}"/>${kids.map(point).join("")}</navPoint>`;
  };
  return items.filter((d) => !d.parent).map(point).join("\n");
}

function spineOrder(docs: Doc[], tocPage: boolean): string[] {
  const out: string[] = [];
  const firstStory = docs.findIndex((d) => d.type === "bodymatter" || /^s\d+$/.test(d.id));
  docs.forEach((d, i) => {
    if (i === firstStory) out.push(`<itemref idref="nav"${tocPage ? "" : ' linear="no"'}/>`);
    out.push(`<itemref idref="${d.id}"/>`);
  });
  if (firstStory < 0) out.push(`<itemref idref="nav"${tocPage ? "" : ' linear="no"'}/>`);
  return out;
}
