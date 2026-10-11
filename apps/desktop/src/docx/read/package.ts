/**
 * A .docx as a package: a zip of XML parts joined by relationships. This
 * finds the main document by its relationship (its path is a convention,
 * not a rule) and hands out the parts that hang off it.
 */

import type JSZip from "jszip";

import { children, parseXml, type XNode } from "../xml";

export interface Rel {
  type: string;
  target: string;
  external: boolean;
}

/** Largest XML part read (uncompressed characters). A novel's document.xml
 *  is a few megabytes; this stops a crafted archive from filling memory. */
const MAX_PART_CHARS = 96 * 1024 * 1024;
/** Largest picture taken from a file. */
export const MAX_MEDIA_BYTES = 24 * 1024 * 1024;

export class DocxError extends Error {
  code = "docx_unreadable";
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** Resolve a relationship target against the part that owns it. */
function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dirOf(base) + target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export class DocxPackage {
  /** Path of the main document part ("word/document.xml"). */
  main = "word/document.xml";
  private relCache = new Map<string, Map<string, Rel>>();

  private constructor(private zip: JSZip) {}

  static async open(buffer: ArrayBuffer | Uint8Array): Promise<DocxPackage> {
    const { default: JSZipCtor } = await import("jszip");
    let zip: JSZip;
    try {
      zip = await JSZipCtor.loadAsync(buffer);
    } catch {
      throw new DocxError("This isn't a Word document (.docx).");
    }
    const pkg = new DocxPackage(zip);
    const rootRels = await pkg.relsOf("");
    for (const rel of rootRels.values()) {
      if (rel.type.endsWith("/officeDocument") && !rel.external) {
        pkg.main = rel.target;
        break;
      }
    }
    if (!zip.file(pkg.main)) throw new DocxError("This isn't a Word document (.docx).");
    return pkg;
  }

  async text(path: string): Promise<string | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    const text = await file.async("string");
    if (text.length > MAX_PART_CHARS) throw new DocxError("This document is too large to import.");
    return text;
  }

  /** A part parsed as XML, or null when it's absent or not XML. */
  async xml(path: string): Promise<XNode | null> {
    const text = await this.text(path);
    if (text === null) return null;
    try {
      return parseXml(text);
    } catch (e) {
      if (e instanceof DocxError) throw e;
      return null;
    }
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    const bytes = await file.async("uint8array");
    return bytes.byteLength > MAX_MEDIA_BYTES ? null : bytes;
  }

  /** The relationships of a part (`""` for the package itself), with
   *  internal targets resolved to zip paths. */
  async relsOf(part: string): Promise<Map<string, Rel>> {
    const cached = this.relCache.get(part);
    if (cached) return cached;
    const slash = part.lastIndexOf("/");
    const relPath = part ? `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels` : "_rels/.rels";
    const out = new Map<string, Rel>();
    const root = await this.xml(relPath);
    for (const node of children(root ?? undefined, "rel:Relationship")) {
      const id = node.attrs.Id;
      const target = node.attrs.Target;
      if (!id || target === undefined) continue;
      const external = node.attrs.TargetMode === "External";
      out.set(id, {
        type: node.attrs.Type ?? "",
        target: external ? target : resolve(part, target),
        external,
      });
    }
    this.relCache.set(part, out);
    return out;
  }

  /** The first part the main document relates to by this type suffix
   *  ("/styles", "/numbering", "/theme", "/settings"). */
  async related(suffix: string): Promise<string | null> {
    for (const rel of (await this.relsOf(this.main)).values()) {
      if (!rel.external && rel.type.endsWith(suffix)) return rel.target;
    }
    return null;
  }
}
