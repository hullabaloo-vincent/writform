/**
 * Export every accessible document as portable files — nothing stays locked
 * in the app. Produces a zip mirroring your folders, with each document as
 * Markdown (readable anywhere) plus its full TipTap JSON (lossless).
 */

import { yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import type { DocumentFolder } from "../../bindings/proto/DocumentFolder";
import type { DocumentListItem } from "../../bindings/proto/DocumentListItem";
import { backend } from "../../lib/backend";
import { documentsApi } from "./api";
import { b64decode, b64encode } from "./collab";

interface PmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
}

export async function exportAllDocuments(
  items: DocumentListItem[],
  folders: DocumentFolder[],
): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const used = new Set<string>();

  for (const item of items) {
    const doc = item.document;
    const detail = await documentsApi.detail(doc.id);
    const ydoc = new Y.Doc();
    try {
      if (detail.state_b64) Y.applyUpdate(ydoc, b64decode(detail.state_b64));
      const json = yDocToProsemirrorJSON(ydoc, "default") as PmNode;

      const dir =
        item.my_access === "owner"
          ? doc.folder_id !== null && folderName.has(doc.folder_id)
            ? `My documents/${sanitize(folderName.get(doc.folder_id) ?? "Folder")}`
            : "My documents"
          : "Shared with me";
      let base = `${dir}/${sanitize(doc.title) || "Untitled"}`;
      if (used.has(base)) base = `${base} (${doc.id})`;
      used.add(base);

      zip.file(`${base}.md`, pmToMarkdown(json));
      zip.file(`${base}.json`, JSON.stringify(json, null, 2));
    } finally {
      ydoc.destroy();
    }
  }

  const bytes = await zip.generateAsync({ type: "uint8array" });
  const stamp = new Date().toISOString().slice(0, 10);
  return backend.saveExport(`writform-export-${stamp}.zip`, b64encode(bytes));
}

function sanitize(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** TipTap/ProseMirror JSON → Markdown. Formats degrade gracefully: element
 *  paragraphs (screenplay etc.) become plain paragraphs with their layout
 *  conventions already baked into the text where possible. */
export function pmToMarkdown(doc: PmNode): string {
  const blocks = (doc.content ?? []).map((n) => blockToMd(n, "")).filter((b) => b !== null);
  return `${blocks.join("\n\n")}\n`;
}

function blockToMd(node: PmNode, indent: string): string | null {
  switch (node.type) {
    case "paragraph": {
      const text = inline(node.content);
      const element = node.attrs?.element as string | undefined;
      // Keep screenplay/stageplay structure legible in plain Markdown.
      if (element === "scene_heading" || element === "act_heading") {
        return `${indent}**${text.toUpperCase()}**`;
      }
      return indent + text;
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${indent}${"#".repeat(level)} ${inline(node.content)}`;
    }
    case "bulletList":
      return (node.content ?? [])
        .map((li) => listItem(li, indent, "- "))
        .join("\n");
    case "orderedList":
      return (node.content ?? [])
        .map((li, i) => listItem(li, indent, `${i + 1}. `))
        .join("\n");
    case "blockquote":
      return (node.content ?? [])
        .map((n) => blockToMd(n, indent))
        .filter((b): b is string => b !== null)
        .map((b) => `${indent}> ${b.slice(indent.length)}`)
        .join("\n>\n");
    case "codeBlock":
      return `${indent}\`\`\`\n${inline(node.content)}\n${indent}\`\`\``;
    case "horizontalRule":
      return `${indent}---`;
    case "image":
      return `${indent}![](${String(node.attrs?.src ?? "")})`;
    default:
      // Unknown block: flatten to its text so nothing silently vanishes.
      return node.content ? indent + inline(node.content) : null;
  }
}

function listItem(li: PmNode, indent: string, marker: string): string {
  const inner = (li.content ?? [])
    .map((n) => blockToMd(n, ""))
    .filter((b): b is string => b !== null);
  const [first, ...rest] = inner.length > 0 ? inner : [""];
  const cont = rest.map((r) => `${indent}  ${r}`);
  return [`${indent}${marker}${first}`, ...cont].join("\n");
}

function inline(nodes: PmNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      if (n.type === "image") return `![](${String(n.attrs?.src ?? "")})`;
      let text = n.text ?? "";
      for (const mark of n.marks ?? []) {
        if (mark.type === "bold") text = `**${text}**`;
        else if (mark.type === "italic") text = `*${text}*`;
        else if (mark.type === "strike") text = `~~${text}~~`;
        else if (mark.type === "code") text = `\`${text}\``;
        else if (mark.type === "link") text = `[${text}](${String(mark.attrs?.href ?? "")})`;
      }
      return text;
    })
    .join("");
}
