import type { JSONContent } from "@tiptap/core";

/**
 * Editor JSON without null attributes. Every paragraph carries ~9 attributes
 * that are almost always null (element, align, font, size, spacing…), so a
 * novel's revision is about half nulls; dropping them halves what history
 * stores and uploads. Lossless: a missing attribute parses back to its
 * default, which is null.
 */
export function compactDocJson(node: JSONContent): JSONContent {
  const out: JSONContent = {};
  if (node.type !== undefined) out.type = node.type;
  if (node.attrs) {
    const attrs: Record<string, unknown> = {};
    let any = false;
    for (const [key, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined) continue;
      attrs[key] = value;
      any = true;
    }
    if (any) out.attrs = attrs;
  }
  if (node.text !== undefined) out.text = node.text;
  if (node.marks && node.marks.length > 0) {
    out.marks = node.marks.map((mark) => {
      const m: { type: string; attrs?: Record<string, unknown> } = { type: mark.type };
      if (mark.attrs) {
        const attrs: Record<string, unknown> = {};
        let any = false;
        for (const [key, value] of Object.entries(mark.attrs)) {
          if (value === null || value === undefined) continue;
          attrs[key] = value;
          any = true;
        }
        if (any) m.attrs = attrs;
      }
      return m;
    });
  }
  if (node.content && node.content.length > 0) out.content = node.content.map(compactDocJson);
  return out;
}

/** The editor's document as the compact JSON string revisions store. */
export function compactDocString(json: JSONContent): string {
  return JSON.stringify(compactDocJson(json));
}
