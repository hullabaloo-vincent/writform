/**
 * What was read, as a document: the editor's own nodes and marks.
 *
 * Only what differs from the text around it is said. A paragraph in the
 * text's own font and size carries neither, and its words carry a colour
 * or a size only where they are not the paragraph's. The document's own
 * settings (look.ts) say the rest once, for all of it.
 */

import type { JSONContent } from "@tiptap/core";

import { MEDIA_PREFIX } from "../../../../docx/read";
import { encodeCols } from "../../../../editor/schema/sanitize";
import type { Block, ParaBlock, Span } from "./model";
import type { Metrics } from "./paras";

export interface AssembleOptions {
  body: Metrics;
  /** A font's name in the file as a font this app knows (null: none, the
   *  text's own is used). */
  fontId?: (name: string) => string | null;
  /** First lines that start in are the document's setting, not a tab at
   *  the start of each paragraph. */
  indentSet?: boolean;
  /** Colours, fonts and sizes are kept. */
  look?: boolean;
}

type Mark = { type: string; attrs?: Record<string, unknown> };

function inline(spans: Span[], para: ParaBlock | null, opts: AssembleOptions): JSONContent[] {
  const out: JSONContent[] = [];
  const bodyFont = opts.fontId?.(opts.body.font) ?? null;
  const all = !!para?.heading && !!para.bold;
  for (const span of spans) {
    if (span.note) {
      const said = inline(span.note, null, opts).filter((n) => n.type === "text");
      out.push({ type: "footnote", ...(said.length ? { content: said.map((n) => ({ type: "text", text: n.text })) } : {}) });
      continue;
    }
    if (!span.text) continue;
    const last = out[out.length - 1];
    // Space alone has no look of its own: it goes with what it follows.
    if (!span.text.trim() && last?.type === "text") {
      last.text = `${last.text ?? ""}${span.text}`;
      continue;
    }
    const marks: Mark[] = [];
    // (A heading is heavy already.)
    if (span.bold && !all) marks.push({ type: "bold" });
    if (span.italic) marks.push({ type: "italic" });
    if (span.link) marks.push({ type: "link", attrs: { href: span.link } });
    if (opts.look !== false) {
      const font = span.font ? (opts.fontId?.(span.font) ?? null) : null;
      if (font && font !== bodyFont && span.font !== opts.body.font) marks.push({ type: "fontFamily", attrs: { f: font } });
      if (para && span.size && !span.shift && Math.abs(span.size - para.size) > 0.75 && span.size >= 4 && span.size <= 200) marks.push({ type: "fontSize", attrs: { pt: span.size } });
      if (span.color && span.color !== (opts.body.color ?? "#000000") && !span.link) marks.push({ type: "textColor", attrs: { c: span.color } });
    }
    if (span.shift) marks.push({ type: "vscript", attrs: { v: span.shift === "up" ? "super" : "sub" } });
    if (last && last.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text = `${last.text ?? ""}${span.text}`;
    else out.push({ type: "text", text: span.text, ...(marks.length ? { marks } : {}) });
  }
  return out;
}

function paragraph(para: ParaBlock, opts: AssembleOptions): JSONContent {
  const content = inline(para.spans, para, opts);
  const first = content[0];
  if (para.indent && !opts.indentSet && !para.heading && first?.type === "text") first.text = `\t${first.text ?? ""}`;
  const body = content.length ? { content } : {};
  if (para.heading) {
    return { type: "heading", attrs: { level: Math.min(6, Math.max(1, para.heading)), ...(para.align ? { align: para.align } : {}) }, ...body };
  }
  const attrs: Record<string, unknown> = {};
  if (para.element) attrs.element = para.element;
  if (para.align) attrs.align = para.align;
  if (opts.look !== false && !para.element) {
    if (Math.abs(para.size - opts.body.size) > 0.75 && para.size >= 6 && para.size <= 96) attrs.size = para.size;
    // In from the edge more than a first line is: set in as a block.
    if (para.inset && para.inset > 60 && !para.align) attrs.indL = Math.round(Math.min(720, para.inset));
  }
  return { type: "paragraph", ...(Object.keys(attrs).length ? { attrs } : {}), ...body };
}

function block(b: Block, opts: AssembleOptions): JSONContent[] {
  switch (b.kind) {
    case "para": {
      const node = paragraph(b, opts);
      return b.quote ? [{ type: "blockquote", content: [node] }] : [node];
    }
    case "rule":
      return [{ type: "horizontalRule" }];
    case "toc":
      return [{ type: "toc" }];
    case "image":
      return [
        {
          type: "image",
          attrs: {
            src: `${MEDIA_PREFIX}${b.key}`,
            // (The editor measures pictures in the screen's units.)
            width: Math.round((b.w * 96) / 72),
            height: Math.round((b.h * 96) / 72),
            ...(b.alt ? { alt: b.alt.slice(0, 500) } : {}),
            ...(b.caption ? { caption: b.caption.slice(0, 500) } : {}),
            ...(b.align ? { align: b.align } : {}),
          },
        },
      ];
    case "list": {
      const items = b.items.map((item) => {
        const inside = item.blocks.flatMap((child) => block(child, opts));
        // An item begins with a paragraph.
        if (inside[0]?.type !== "paragraph") inside.unshift({ type: "paragraph" });
        return { type: "listItem", content: inside };
      });
      if (!b.ordered) return [{ type: "bulletList", content: items }];
      const type = b.numbering && b.numbering !== "1" ? b.numbering : null;
      return [{ type: "orderedList", attrs: { start: b.start && b.start > 0 ? b.start : 1, type }, content: items }];
    }
    case "table": {
      const rows = b.rows.map((row) => ({
        type: "tableRow",
        content: row.map((cell) => {
          const inside = cell.blocks.flatMap((child) => block(child, opts)).filter((n) => n.type !== "table");
          return { type: "tableCell", attrs: { colspan: cell.colspan, rowspan: cell.rowspan, ...(cell.bg ? { bg: cell.bg } : {}) }, content: inside.length ? inside : [{ type: "paragraph" }] };
        }),
      }));
      const even = b.cols.length > 0 && b.cols.every((w) => Math.abs(w - b.cols[0]) < 0.5);
      return [{ type: "table", attrs: { cols: b.cols.length && !even ? encodeCols(b.cols) : null, head: b.head ? true : null, lines: b.ruled ? null : "none" }, content: rows }];
    }
  }
}

export function assemble(blocks: Block[], opts: AssembleOptions): JSONContent {
  const content = blocks.flatMap((b) => block(b, opts));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}
