/**
 * A small XML reader for Word packages. The parts of a .docx are
 * machine-written and well-formed, so this is a scanner, not a validator —
 * but it resolves namespaces, because the prefix is only a convention: the
 * same element may arrive as `w:p` (transitional), under the "strict"
 * namespace, or under a prefix another program chose. Every known namespace
 * is rewritten to the prefix the rest of the reader expects.
 *
 * No DOM: this runs in workers and in Node as well as the page.
 */

export interface XNode {
  /** Canonical qualified name: `w:p`, `a:blip`. */
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** The element's own text (its direct character data, concatenated). */
  text: string;
}

/** Namespace URI → the prefix this reader uses. Both the transitional and
 *  the ISO "strict" spellings. */
const CANON: Record<string, string> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://purl.oclc.org/ooxml/drawingml/picture": "pic",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "urn:schemas-microsoft-com:vml": "v",
  "urn:schemas-microsoft-com:office:office": "o",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape": "wps",
  "http://schemas.openxmlformats.org/officeDocument/2006/math": "m",
  "http://purl.oclc.org/ooxml/officeDocument/math": "m",
  "http://schemas.openxmlformats.org/package/2006/relationships": "rel",
  "http://schemas.openxmlformats.org/package/2006/content-types": "ct",
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties": "cp",
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://purl.org/dc/terms/": "dcterms",
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Outside Unicode, or a lone surrogate: nothing to show.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0) return "";
      return String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? whole;
  });
}

export class XmlError extends Error {}

/** Deepest nesting accepted: real documents stay in the tens. */
const MAX_DEPTH = 256;

/**
 * Parse a document; returns its root element. Throws `XmlError` on input
 * that isn't XML at all (a truncated part still yields what was read).
 */
export function parseXml(source: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  // Each open element, with the namespace bindings in force inside it.
  const stack: { node: XNode; ns: Record<string, string> }[] = [{ node: root, ns: {} }];
  const n = source.length;
  let i = 0;

  const qualify = (raw: string, ns: Record<string, string>, isAttr: boolean): string => {
    const colon = raw.indexOf(":");
    const prefix = colon < 0 ? "" : raw.slice(0, colon);
    const local = colon < 0 ? raw : raw.slice(colon + 1);
    // Unprefixed attributes have no namespace; unprefixed elements take the default.
    if (!prefix && isAttr) return local;
    const uri = ns[prefix];
    const canon = uri === undefined ? prefix : (CANON[uri] ?? prefix);
    return canon ? `${canon}:${local}` : local;
  };

  while (i < n) {
    const lt = source.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.node.text += decode(source.slice(i));
      break;
    }
    if (lt > i) top.node.text += decode(source.slice(i, lt));
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      top.node.text += source.slice(i + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (source.startsWith("<!", i)) {
      // A DOCTYPE: not something a Word part carries. Skip it whole (and
      // any internal subset) rather than interpret it.
      let depth = 0;
      let j = i;
      for (; j < n; j += 1) {
        if (source[j] === "[") depth += 1;
        else if (source[j] === "]") depth -= 1;
        else if (source[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (source[i + 1] === "/") {
      const end = source.indexOf(">", i + 2);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? n : end + 1;
      continue;
    }

    // A start tag: the name, then attributes, quoted either way.
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(source[j])) j += 1;
    const rawName = source.slice(i + 1, j);
    if (!rawName) throw new XmlError("Not an XML document");
    const rawAttrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(source[j])) j += 1;
      if (j >= n) break;
      if (source[j] === ">") {
        j += 1;
        break;
      }
      if (source[j] === "/") {
        selfClosing = true;
        j += 1;
        continue;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(source[k])) k += 1;
      const attrName = source.slice(j, k);
      while (k < n && /\s/.test(source[k])) k += 1;
      if (source[k] !== "=") {
        // A bare attribute isn't XML; step over it.
        j = Math.max(k, j + 1);
        continue;
      }
      k += 1;
      while (k < n && /\s/.test(source[k])) k += 1;
      const quote = source[k];
      if (quote !== '"' && quote !== "'") throw new XmlError("Not an XML document");
      const close = source.indexOf(quote, k + 1);
      if (close < 0) throw new XmlError("Not an XML document");
      rawAttrs.push([attrName, decode(source.slice(k + 1, close))]);
      j = close + 1;
    }

    let ns = top.ns;
    for (const [key, value] of rawAttrs) {
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        if (ns === top.ns) ns = { ...top.ns };
        ns[key === "xmlns" ? "" : key.slice(6)] = value;
      }
    }
    const node: XNode = { name: qualify(rawName, ns, false), attrs: {}, children: [], text: "" };
    for (const [key, value] of rawAttrs) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      node.attrs[qualify(key, ns, true)] = value;
    }
    top.node.children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlError("This file is nested too deeply to read");
      stack.push({ node, ns });
    }
    i = j;
  }

  const first = root.children[0];
  if (!first) throw new XmlError("Not an XML document");
  return first;
}

/** The first child with this name. */
export function child(node: XNode | undefined, name: string): XNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) if (c.name === name) return c;
  return undefined;
}

export function children(node: XNode | undefined, name: string): XNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** The first descendant with this name, depth-first. */
export function find(node: XNode | undefined, name: string): XNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}

/** `w:val` of a child element (`<w:jc w:val="center"/>` → "center"). */
export function val(node: XNode | undefined, name: string): string | undefined {
  return child(node, name)?.attrs["w:val"];
}

/**
 * A Word on/off property: present with no value (or 1/true/on) is on;
 * 0/false/off is off; absent is "not said" (undefined).
 */
export function onOff(node: XNode | undefined, name: string): boolean | undefined {
  const c = child(node, name);
  if (!c) return undefined;
  const v = c.attrs["w:val"];
  return !(v === "0" || v === "false" || v === "off");
}

/** A whole number attribute, or undefined. */
export function int(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = Number.parseInt(value, 10);
  return Number.isFinite(v) ? v : undefined;
}
