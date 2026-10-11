/**
 * Pasting from Word, Google Docs and web pages, and copying out to them.
 *
 * Coming in: other programs describe formatting as inline CSS on a soup of
 * spans. This rewrites that into the few attributes the document's own
 * marks read (`data-tc`, `data-fs`, …) and throws the rest away:
 *
 *  - the typeface and size MOST of the pasted text is in are dropped — that
 *    was the other document's body text, and here it becomes this one's.
 *    Text that differed from it (a heading set larger, a word in another
 *    face) keeps its difference;
 *  - colour and highlight are kept, unless they're just black on white;
 *  - superscript and subscript are kept;
 *  - Word's list paragraphs (`mso-list`), which are plain paragraphs with a
 *    typed bullet, become real lists; tables come as tables, with their
 *    merged cells and shading;
 *  - comments, styles, and Office's bookkeeping elements go.
 *
 * Going out: the marks draw themselves through custom properties, which
 * mean nothing to another program — so copied HTML states the same
 * formatting as ordinary CSS too.
 */

import { Extension } from "@tiptap/core";
import { DOMSerializer, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { catalogNow, loadCatalog } from "../../fonts/catalog";
import { fontCssFamily } from "../../fonts/css";
import { fontIdForWordName, type FontLookup } from "../../fonts/docx";
import { isFontId } from "../../fonts/ids";
import { systemFonts } from "../../fonts/store";
import { colorAttr, cssLengthToPt, roundPt, sizeAttr, toHexColor, vscriptAttr } from "../schema/sanitize";

interface Inherited {
  font: string | null;
  size: number | null;
  color: string | null;
  bg: string | null;
  vs: "sub" | "super" | null;
}

const NONE: Inherited = { font: null, size: null, color: null, bg: null, vs: null };
const BLOCKS = new Set(["P", "DIV", "LI", "TD", "TH", "BODY", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "TABLE", "TR", "TBODY", "PRE"]);
const DROP = new Set(["STYLE", "SCRIPT", "META", "LINK", "TITLE", "XML", "HEAD", "O:P", "W:SDT"]);
/** Properties this rewrites into attributes, and then removes. */
const HANDLED = [
  "font-family",
  "font-size",
  "font",
  "color",
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-origin",
  "background-clip",
  "background-attachment",
  "vertical-align",
];

/** The first family of a CSS `font-family` list, unquoted. */
function firstFamily(value: string): string | null {
  const first = value.split(",")[0]?.trim().replace(/^["']|["']$/g, "").trim();
  if (!first || /^(inherit|initial|unset|serif|sans-serif|monospace|system-ui|-apple-system)$/i.test(first)) return null;
  return first;
}

function ownStyle(el: HTMLElement, inherited: Inherited): Inherited {
  const out = { ...inherited };
  const style = el.style;
  const family = style.fontFamily ? firstFamily(style.fontFamily) : el.tagName === "FONT" ? el.getAttribute("face") : null;
  if (family) out.font = family;
  const size = cssLengthToPt(style.fontSize, inherited.size ?? 12);
  if (size !== null && size > 0) out.size = roundPt(size);
  const color = toHexColor(style.color || (el.tagName === "FONT" ? el.getAttribute("color") : null));
  if (color) out.color = color;
  // A block's background is its paper, not a highlighter pen.
  if (!BLOCKS.has(el.tagName)) {
    const bg = toHexColor(style.backgroundColor || style.background.split(" ")[0]);
    if (bg) out.bg = bg;
  }
  const va = style.verticalAlign;
  if (el.tagName === "SUP" || va === "super") out.vs = "super";
  else if (el.tagName === "SUB" || va === "sub") out.vs = "sub";
  else if (va === "baseline") out.vs = null;
  return out;
}

class Tally<T> {
  private counts = new Map<T, number>();
  add(value: T, weight: number): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + weight);
  }
  top(): T | undefined {
    let best: T | undefined;
    let n = 0;
    for (const [k, v] of this.counts) if (v > n) [best, n] = [k, v];
    return best;
  }
}

/** Word's list paragraphs → real lists. */
function liftWordLists(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const isItem = (el: Element | null): el is HTMLElement =>
    !!el && el.tagName === "P" && /mso-list:/i.test(el.getAttribute("style") ?? "") && !/mso-list:\s*none/i.test(el.getAttribute("style") ?? "");
  const first = [...root.querySelectorAll("p")].filter((p) => isItem(p) && !isItem(p.previousElementSibling));
  for (const start of first) {
    const run: HTMLElement[] = [];
    for (let el: Element | null = start; isItem(el); el = el.nextElementSibling) run.push(el);
    const stack: { list: HTMLElement; level: number; id: string }[] = [];
    let anchor: Element | null = null;
    for (const p of run) {
      const style = p.getAttribute("style") ?? "";
      const level = Number(/level(\d+)/i.exec(style)?.[1] ?? 1);
      // Word numbers its lists (l0, l1…): a different one is a new list.
      const id = /mso-list:\s*(l\d+)/i.exec(style)?.[1] ?? "";
      // The typed marker says what kind of list it was.
      const ignored = [...p.querySelectorAll<HTMLElement>("span")].find((s) => /mso-list:\s*ignore/i.test(s.getAttribute("style") ?? ""));
      const marker = (ignored?.textContent ?? "").trim();
      ignored?.remove();
      const ordered = /^[([]?(\d+|[a-zA-Z]|[ivxlcdm]+)[.)\]]$/i.test(marker);
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      if (stack.length && stack[stack.length - 1].level === level && stack[stack.length - 1].id !== id) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || top.level < level) {
        const list = doc.createElement(ordered ? "ol" : "ul");
        if (!top) {
          if (anchor) anchor.after(list);
          else p.before(list);
          anchor = list;
        } else {
          (top.list.lastElementChild ?? top.list).append(list);
        }
        top = { list, level, id };
        stack.push(top);
      }
      const li = doc.createElement("li");
      const inner = doc.createElement("p");
      while (p.firstChild) inner.append(p.firstChild);
      li.append(inner);
      top.list.append(li);
      p.remove();
    }
  }
}

export interface PasteLookup extends FontLookup {
  /** The schema level the document may use: below 2 nothing is annotated
   *  (the guard would only strip it again). */
  level?: number;
}

/** Another program's clipboard HTML, rewritten for this editor. HTML this
 *  editor wrote itself passes through untouched. */
export function cleanPastedHtml(html: string, lookup: PasteLookup = {}): string {
  if (!html || html.includes("data-pm-slice")) return html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return html;
  }
  const body = doc.body;
  if (!body) return html;

  // What isn't content.
  const walker = doc.createTreeWalker(body, 0x80 /* comments */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
  for (const el of [...body.querySelectorAll("*")]) {
    if (DROP.has(el.tagName)) el.remove();
  }
  // Google Docs wraps everything in one bold-that-isn't.
  for (const b of [...body.querySelectorAll('b[id^="docs-internal-guid"]')]) b.replaceWith(...b.childNodes);
  liftWordLists(body);

  const annotate = (lookup.level ?? 2) >= 2;

  // First pass: what most of the text is set in.
  interface Piece {
    node: Text;
    look: Inherited;
  }
  const pieces: Piece[] = [];
  const fonts = new Tally<string>();
  const sizes = new Tally<number>();
  const visit = (node: Node, inherited: Inherited) => {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      const weight = text.trim().length;
      if (!weight) return;
      pieces.push({ node: node as Text, look: inherited });
      if (inherited.font) fonts.add(inherited.font.toLowerCase(), weight);
      if (inherited.size) sizes.add(inherited.size, weight);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    // Code keeps its own face; headings their own size.
    if (el.tagName === "PRE" || el.tagName === "CODE") return;
    const next = ownStyle(el, inherited);
    if (/^H[1-6]$/.test(el.tagName)) next.size = null;
    for (const child of [...el.childNodes]) visit(child, next);
  };
  visit(body, NONE);
  const baseFont = fonts.top();
  const baseSize = sizes.top();

  // Second pass: each piece of text says how it differs.
  if (annotate) {
    for (const { node, look } of pieces) {
      const attrs: Record<string, string> = {};
      if (look.font && look.font.toLowerCase() !== baseFont) {
        // (The app's default face has no id of its own — it is "no font
        // set" — so where it differs from the text around it, it's named.)
        const id = fontIdForWordName(look.font, lookup) ?? `sys:${look.font.trim()}`;
        if (isFontId(id)) attrs["data-ff"] = id;
      }
      if (look.size && look.size !== baseSize && sizeAttr(look.size) !== null) attrs["data-fs"] = String(look.size);
      if (look.color && look.color !== "#000000") attrs["data-tc"] = look.color;
      if (look.bg && look.bg !== "#ffffff") attrs["data-hl"] = look.bg;
      if (look.vs) attrs["data-vs"] = look.vs;
      let wrapped: Node = node;
      for (const [name, value] of Object.entries(attrs)) {
        const span = doc.createElement("span");
        span.setAttribute(name, value);
        wrapped.parentNode?.replaceChild(span, wrapped);
        span.append(wrapped);
        wrapped = span;
      }
    }
  }

  // A table cell's shading is the cell's (not a highlighter on its words).
  for (const cell of [...body.querySelectorAll<HTMLElement>("td, th")]) {
    const bg = toHexColor(cell.style.backgroundColor || cell.style.background.split(" ")[0] || cell.getAttribute("bgcolor"));
    if (bg && bg !== "#ffffff" && annotate) cell.setAttribute("data-bg", bg);
    cell.removeAttribute("bgcolor");
  }

  // The inline CSS has said its piece.
  for (const el of [...body.querySelectorAll<HTMLElement>("[style]")]) {
    for (const prop of HANDLED) el.style.removeProperty(prop);
    if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
  }
  // <sup>/<sub> were read above; as elements they'd shrink the text twice.
  for (const el of [...body.querySelectorAll("sup, sub")]) el.replaceWith(...el.childNodes);
  for (const el of [...body.querySelectorAll("font")]) el.replaceWith(...el.childNodes);
  return body.innerHTML;
}

/** A serializer whose formatting marks also say what they mean in plain
 *  CSS, for whatever the text is pasted into. */
export function clipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const marks = { ...base.marks };
  if (schema.marks.fontFamily) {
    marks.fontFamily = (mark) => {
      const css = isFontId(mark.attrs.f) ? fontCssFamily(mark.attrs.f) : null;
      return ["span", css ? { "data-ff": mark.attrs.f as string, style: `font-family: ${css}` } : {}, 0];
    };
  }
  if (schema.marks.fontSize) {
    marks.fontSize = (mark) => {
      const pt = sizeAttr(mark.attrs.pt);
      return ["span", pt === null ? {} : { "data-fs": String(pt), style: `font-size: ${pt}pt` }, 0];
    };
  }
  if (schema.marks.textColor) {
    marks.textColor = (mark) => {
      const c = colorAttr(mark.attrs.c);
      return ["span", c ? { "data-tc": c, style: `color: ${c}` } : {}, 0];
    };
  }
  if (schema.marks.highlight) {
    marks.highlight = (mark) => {
      const c = colorAttr(mark.attrs.c);
      return ["span", c ? { "data-hl": c, style: `background-color: ${c}` } : {}, 0];
    };
  }
  if (schema.marks.vscript) {
    marks.vscript = (mark) => {
      const v = vscriptAttr(mark.attrs.v);
      return ["span", v ? { "data-vs": v, style: `vertical-align: ${v}; font-size: smaller` } : {}, 0];
    };
  }
  return new DOMSerializer(base.nodes, marks);
}

export interface PasteFormatOptions {
  /** The schema level the document may use right now. */
  level: () => number;
}

/** The Document format's clipboard: see the top of this file. */
export const PasteFormat = Extension.create<PasteFormatOptions>({
  name: "pasteFormat",

  addOptions() {
    return { level: () => 2 };
  },

  addProseMirrorPlugins() {
    // Names in a paste are matched against the fonts this device knows.
    let installed: FontLookup["installed"];
    void systemFonts().then((map) => {
      installed = map;
    });
    void loadCatalog().catch(() => {});
    const level = this.options.level;
    return [
      new Plugin({
        key: new PluginKey("wf-paste-format"),
        props: {
          transformPastedHTML: (html) => cleanPastedHtml(html, { installed, catalog: catalogNow()?.byName, level: level() }),
          clipboardSerializer: clipboardSerializer(this.editor.schema),
        },
      }),
    ];
  },
});
