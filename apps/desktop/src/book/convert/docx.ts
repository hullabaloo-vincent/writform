/**
 * Word (.docx) import that keeps what a manuscript needs. Mammoth's HTML
 * output drops alignment, page breaks and blank lines; its document MODEL
 * (captured via `transformDocument`) has them all. That model becomes
 * editor JSON here: Heading styles → headings, Quote styles → block quotes,
 * numbering → lists, center/right → alignment, page breaks → "page break
 * before" on the next paragraph, italics/bold/underline → marks. The
 * document's title and author come from docProps/core.xml.
 */

import type { JSONContent } from "@tiptap/core";

interface MNode {
  type: string;
  children?: MNode[];
  value?: string;
  styleName?: string | null;
  alignment?: string | null;
  indent?: { start?: string | null; firstLine?: string | null; hanging?: string | null } | null;
  numbering?: { isOrdered?: boolean; level?: string | number } | null;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  isStrikethrough?: boolean;
  isAllCaps?: boolean;
  isSmallCaps?: boolean;
  breakType?: string;
  href?: string;
}

export interface DocxImport {
  content: JSONContent;
  meta: { title?: string; author?: string };
  /** What didn't come across, for the import toast. */
  warnings: string[];
}

const QUOTE_STYLES = /^(quote|intense quote|block text|quotation|extract)$/i;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function docxToContent(buffer: ArrayBuffer): Promise<DocxImport> {
  const mammoth = await import("mammoth");
  let captured: MNode | null = null;
  await mammoth.convertToHtml(
    { arrayBuffer: buffer },
    {
      transformDocument: (doc: unknown) => {
        captured = doc as MNode;
        return doc as never;
      },
    } as never,
  );

  const meta: DocxImport["meta"] = {};
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buffer);
    const core = await zip.file("docProps/core.xml")?.async("string");
    if (core) {
      const title = /<dc:title>([^<]*)<\/dc:title>/.exec(core)?.[1];
      const creator = /<dc:creator>([^<]*)<\/dc:creator>/.exec(core)?.[1];
      if (title?.trim()) meta.title = decodeXml(title.trim());
      if (creator?.trim()) meta.author = decodeXml(creator.trim());
    }
  } catch {
    // properties are a nicety
  }

  const counts = { images: 0, notes: 0, tables: 0, smallCaps: 0 };
  const blocks: JSONContent[] = [];
  // Word puts a page break either at the end of the paragraph before the
  // break or at the very start of the one after it; both mean "this next
  // paragraph starts a page".
  let pendingPageBreak = false;
  let breakAtStart = false;

  type Marks = { type: string; attrs?: Record<string, unknown> }[];
  const inline = (node: MNode, marks: Marks, out: JSONContent[]) => {
    switch (node.type) {
      case "text":
        if (node.value) out.push({ type: "text", text: node.value, ...(marks.length ? { marks } : {}) });
        return;
      case "tab":
        // A tab opening a paragraph is an old-fashioned indent (dropped by
        // the caller); elsewhere it separates words.
        out.push({ type: "text", text: "\t", ...(marks.length ? { marks } : {}) });
        return;
      case "break":
        if (node.breakType === "page") {
          if (out.every((n) => !n.text?.trim())) breakAtStart = true;
          else pendingPageBreak = true;
        } else if (node.breakType === "line") {
          out.push({ type: "hardBreak" });
        }
        return;
      case "run": {
        const next: Marks = [...marks];
        if (node.isBold) next.push({ type: "bold" });
        if (node.isItalic) next.push({ type: "italic" });
        if (node.isUnderline) next.push({ type: "underline" });
        if (node.isStrikethrough) next.push({ type: "strike" });
        if (node.isSmallCaps) counts.smallCaps += 1;
        const start = out.length;
        for (const c of node.children ?? []) inline(c, next, out);
        if (node.isAllCaps) {
          for (let i = start; i < out.length; i += 1) {
            if (out[i].text) out[i] = { ...out[i], text: out[i].text!.toUpperCase() };
          }
        }
        return;
      }
      case "hyperlink": {
        const next: Marks = node.href ? [...marks, { type: "link", attrs: { href: node.href } }] : marks;
        for (const c of node.children ?? []) inline(c, next, out);
        return;
      }
      case "image":
        counts.images += 1;
        return;
      case "noteReference":
        counts.notes += 1;
        return;
      default:
        for (const c of node.children ?? []) inline(c, marks, out);
    }
  };

  const paragraphOf = (p: MNode): JSONContent & { kind: "p" | "quote" | "list"; ordered?: boolean } => {
    const carried = pendingPageBreak;
    pendingPageBreak = false;
    breakAtStart = false;
    const content: JSONContent[] = [];
    for (const c of p.children ?? []) inline(c, [], content);
    // Leading tabs/spaces were indentation, not text.
    while (content[0]?.text !== undefined && /^[\t ]*$/.test(content[0].text ?? "")) content.shift();
    if (content[0]?.text) content[0] = { ...content[0], text: content[0].text.replace(/^[\t ]+/, "") };
    // Interior tabs read as spaces.
    for (let i = 0; i < content.length; i += 1) {
      if (content[i].text?.includes("\t")) content[i] = { ...content[i], text: content[i].text!.replace(/\t+/g, " ") };
    }
    const style = p.styleName ?? "";
    const heading = /^heading\s*([1-6])$/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? "1" : null);
    const attrs: Record<string, unknown> = {};
    const align = p.alignment ?? "";
    if (align === "center") attrs.align = "center";
    else if (align === "right" || align === "end") attrs.align = "right";
    else if (align === "both" || align === "justify") attrs.align = "justify";
    if (carried || breakAtStart) attrs.pageBreakBefore = true;
    const body = content.length ? { content } : {};
    if (heading) {
      return { type: "heading", attrs: { ...attrs, level: Number(heading) }, ...body, kind: "p" };
    }
    const indented = Number(p.indent?.start ?? 0) >= 720 && !p.numbering;
    return {
      type: "paragraph",
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...body,
      kind: p.numbering ? "list" : QUOTE_STYLES.test(style) || indented ? "quote" : "p",
      ordered: !!p.numbering?.isOrdered,
    };
  };

  const pushGrouped = (items: (JSONContent & { kind: string; ordered?: boolean })[]) => {
    let i = 0;
    while (i < items.length) {
      const item = items[i];
      if (item.kind === "quote") {
        const quote: JSONContent[] = [];
        while (i < items.length && items[i].kind === "quote") {
          const { kind: _k, ordered: _o, ...block } = items[i];
          void _k;
          void _o;
          quote.push(block);
          i += 1;
        }
        blocks.push({ type: "blockquote", content: quote });
      } else if (item.kind === "list") {
        const ordered = !!item.ordered;
        const listItems: JSONContent[] = [];
        while (i < items.length && items[i].kind === "list" && !!items[i].ordered === ordered) {
          const { kind: _k, ordered: _o, ...block } = items[i];
          void _k;
          void _o;
          listItems.push({ type: "listItem", content: [block] });
          i += 1;
        }
        blocks.push({ type: ordered ? "orderedList" : "bulletList", content: listItems });
      } else {
        const { kind: _k, ordered: _o, ...block } = item;
        void _k;
        void _o;
        blocks.push(block);
        i += 1;
      }
    }
  };

  const items: (JSONContent & { kind: "p" | "quote" | "list"; ordered?: boolean })[] = [];
  const walk = (node: MNode) => {
    if (node.type === "paragraph") {
      items.push(paragraphOf(node));
    } else if (node.type === "table") {
      counts.tables += 1;
      // Flatten: each cell's paragraphs in reading order.
      for (const c of node.children ?? []) walk(c);
    } else {
      for (const c of node.children ?? []) walk(c);
    }
  };
  const root = captured as MNode | null;
  for (const c of root?.children ?? []) walk(c);
  pushGrouped(items);

  const warnings: string[] = [];
  if (counts.images) warnings.push(`${counts.images} image${counts.images === 1 ? "" : "s"} skipped`);
  if (counts.notes) warnings.push(`${counts.notes} footnote${counts.notes === 1 ? "" : "s"} skipped`);
  if (counts.tables) warnings.push(`${counts.tables} table${counts.tables === 1 ? "" : "s"} flattened`);

  return {
    content: { type: "doc", content: blocks.length ? blocks : [{ type: "paragraph" }] },
    meta,
    warnings,
  };
}
