/** Shared word counting for documents, sessions, and reading time. */

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** "n min read" at ~200 wpm; under a minute rounds up to 1. */
export function readingTime(words: number): string {
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

/** Word count for TipTap JSON (sessions hold docs as JSON, not an editor). */
export function countWordsInDocJson(doc: unknown): number {
  let text = "";
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { text?: unknown; content?: unknown[] };
    if (typeof n.text === "string") text += `${n.text} `;
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return countWords(text);
}
