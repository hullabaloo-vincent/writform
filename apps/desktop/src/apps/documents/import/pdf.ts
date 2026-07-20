/**
 * Client-side PDF import with screenplay-aware layout recovery.
 *
 * PDF text is positioned glyphs rather than paragraphs. We first rebuild
 * visual lines from their coordinates, then use the stable horizontal
 * indents used by professional screenplay PDFs to recover screenplay
 * elements. Images and exact typography are intentionally not imported.
 */

export interface ImportedPdfParagraph {
  text: string;
  element?: string;
}

export interface ImportedPdfDocument {
  paragraphs: ImportedPdfParagraph[];
  suggestedFormat: "none" | "screenplay";
}

interface PdfLine {
  text: string;
  x: number;
  y: number;
  height: number;
  page: number;
  pageWidth: number;
  pageHeight: number;
}

interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Older WKWebViews expose ReadableStream#getReader without making streams
 * async-iterable. PDF.js uses `for await` in getTextContent, so add the
 * standards-compatible iterator before loading PDF.js.
 */
function ensureReadableStreamAsyncIterator(): void {
  const Stream = globalThis.ReadableStream;
  if (!Stream) return;
  const streamPrototype = Stream.prototype as unknown as Record<symbol, unknown>;
  if (typeof streamPrototype[Symbol.asyncIterator] === "function") return;

  Object.defineProperty(Stream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* <T>(this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export async function pdfToDocument(data: ArrayBuffer): Promise<ImportedPdfDocument> {
  ensureReadableStreamAsyncIterator();

  // The legacy build supplies Promise.withResolvers and other compatibility
  // shims needed by the macOS desktop webview. It is still lazily bundled.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const doc = await loadingTask.promise;
    const lines: PdfLine[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PositionedText[] = [];

      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        items.push({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: Math.abs(item.width) || 0,
          height: Math.abs(item.height || item.transform[3]) || 12,
        });
      }

      lines.push(...rebuildLines(items, pageNumber, viewport.width, viewport.height));
      page.cleanup();
    }

    const suggestedFormat = looksLikeScreenplay(lines) ? "screenplay" : "none";
    return {
      paragraphs:
        suggestedFormat === "screenplay"
          ? screenplayParagraphs(lines)
          : ordinaryParagraphs(lines),
      suggestedFormat,
    };
  } finally {
    await loadingTask.destroy();
  }
}

function rebuildLines(
  items: PositionedText[],
  page: number,
  pageWidth: number,
  pageHeight: number,
): PdfLine[] {
  const rows: PositionedText[][] = [];
  for (const item of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((candidate) => {
      const baseline = candidate[0];
      return Math.abs(baseline.y - item.y) <= Math.max(2, item.height * 0.22);
    });
    if (row) row.push(item);
    else rows.push([item]);
  }

  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      let right = row[0].x;
      for (const item of row) {
        const gap = item.x - right;
        if (text && !/\s$/.test(text) && gap > Math.max(1.5, item.height * 0.16)) text += " ";
        text += item.str;
        right = Math.max(right, item.x + item.width);
      }
      return {
        text: text.replace(/\s+/g, " ").trim(),
        x: row[0].x,
        y: row.reduce((sum, item) => sum + item.y, 0) / row.length,
        height: Math.max(...row.map((item) => item.height)),
        page,
        pageWidth,
        pageHeight,
      };
    })
    .filter((line) => {
      if (!line.text) return false;
      // Screenplay page numbers are running furniture, not document content.
      const nearTop = line.y > line.pageHeight - 54;
      return !(nearTop && /^\d+[A-Z]?\.?$/.test(line.text));
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

const SCENE_HEADING = /^(?:INT\.|EXT\.|INT\.?\/EXT\.?|I\/E\.|EST\.)(?:\s|$)/i;
const TRANSITION = /^(?:FADE (?:IN|OUT)|CUT TO BLACK)|(?:TO:|FADE OUT\.?|DISSOLVE TO:|MATCH CUT TO:)$/i;

function looksLikeScreenplay(lines: PdfLine[]): boolean {
  const sceneHeadings = lines.filter((line) => SCENE_HEADING.test(line.text)).length;
  if (sceneHeadings >= 2) return true;

  const indentedCues = lines.filter((line) => isCharacterCue(line)).length;
  const transitions = lines.filter((line) => TRANSITION.test(line.text)).length;
  return sceneHeadings >= 1 && indentedCues >= 3 && transitions >= 1;
}

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}

function isCharacterCue(line: PdfLine): boolean {
  const position = line.x / line.pageWidth;
  return (
    position >= 0.34 &&
    position <= 0.68 &&
    line.text.length <= 48 &&
    isAllCaps(line.text) &&
    !SCENE_HEADING.test(line.text) &&
    !TRANSITION.test(line.text)
  );
}

function classifyScreenplayLine(line: PdfLine, previous: string | undefined): string {
  const position = line.x / line.pageWidth;
  if (SCENE_HEADING.test(line.text)) return "scene_heading";
  if (TRANSITION.test(line.text) && position > 0.45) return "transition";
  if (/^\(.+\)$/.test(line.text) && position > 0.28) return "parenthetical";
  if (isCharacterCue(line)) return "character";
  if (
    position >= 0.25 &&
    position <= 0.62 &&
    (previous === "character" || previous === "parenthetical" || previous === "dialogue")
  ) {
    return "dialogue";
  }
  return "action";
}

function screenplayParagraphs(lines: PdfLine[]): ImportedPdfParagraph[] {
  const paragraphs: ImportedPdfParagraph[] = [];
  let currentText = "";
  let currentElement: string | undefined;
  let previousLine: PdfLine | null = null;

  const flush = () => {
    if (currentText) paragraphs.push({ text: currentText, element: currentElement });
    currentText = "";
    currentElement = undefined;
  };

  for (const line of lines) {
    const element = classifyScreenplayLine(line, currentElement);
    const lineGap = previousLine && previousLine.page === line.page ? previousLine.y - line.y : Infinity;
    const canWrap = element === "action" || element === "dialogue";
    const sameParagraph =
      currentElement === element &&
      currentText.length > 0 &&
      canWrap &&
      previousLine?.page === line.page &&
      lineGap <= Math.max(previousLine.height, line.height) * 1.55;

    if (!sameParagraph) flush();
    if (!currentText) {
      currentText = line.text;
      currentElement = element;
    } else {
      currentText = joinWrappedText(currentText, line.text);
    }
    previousLine = line;
  }
  flush();
  return paragraphs;
}

function ordinaryParagraphs(lines: PdfLine[]): ImportedPdfParagraph[] {
  const paragraphs: ImportedPdfParagraph[] = [];
  let current = "";
  let previous: PdfLine | null = null;

  const flush = () => {
    if (current.trim()) paragraphs.push({ text: current.trim() });
    current = "";
  };

  for (const line of lines) {
    const pageBreak = previous !== null && previous.page !== line.page;
    const gap = previous && !pageBreak ? previous.y - line.y : Infinity;
    const paragraphBreak = pageBreak || gap > Math.max(previous?.height ?? 12, line.height) * 1.65;
    if (paragraphBreak) flush();
    current = current ? joinWrappedText(current, line.text) : line.text;
    previous = line;
  }
  flush();
  return paragraphs;
}

function joinWrappedText(previous: string, next: string): string {
  if (/\w-$/.test(previous) && /^[a-z]/.test(next)) return previous.slice(0, -1) + next;
  return `${previous} ${next}`;
}
