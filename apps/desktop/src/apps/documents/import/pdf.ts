/**
 * Client-side PDF import with layout recovery.
 *
 * PDF text is positioned glyphs rather than paragraphs. We rebuild visual
 * lines from their coordinates — carrying per-run font names and sizes —
 * then either recover screenplay elements from the stable horizontal
 * indents professional screenplay PDFs use, or reconstruct ordinary prose
 * with headings (font-size clusters), centering (symmetric short lines),
 * first-line indents (leading tab), bold/italic runs, and paragraphs that
 * continue across page boundaries. Images and exact typography are
 * intentionally not imported.
 */

import { loadPdfjs } from "../../../lib/pdfjs";

export interface ImportedRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface ImportedPdfParagraph {
  text: string;
  element?: string;
  kind?: "heading";
  level?: number;
  align?: "center" | null;
  runs?: ImportedRun[];
}

export interface ImportedPdfDocument {
  paragraphs: ImportedPdfParagraph[];
  suggestedFormat: "none" | "screenplay";
}

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface PdfLine {
  text: string;
  segments: Segment[];
  x: number;
  /** Right edge — needed to detect centering and full lines. */
  x1: number;
  y: number;
  height: number;
  size: number;
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
  size: number;
  bold: boolean;
  italic: boolean;
}

export async function pdfToDocument(data: ArrayBuffer): Promise<ImportedPdfDocument> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const doc = await loadingTask.promise;
    const lines: PdfLine[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      // Forces font loading so commonObjs can answer real font names
      // ("…-BoldItalic") for the style detection below.
      await page.getOperatorList();
      const content = await page.getTextContent();
      const items: PositionedText[] = [];

      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const t = item.transform as number[];
        const fontName = resolveFontName(page, content, item.fontName);
        items.push({
          str: item.str,
          x: t[4],
          y: t[5],
          width: Math.abs(item.width) || 0,
          height: Math.abs(item.height || t[3]) || 12,
          size: Math.hypot(t[2], t[3]) || 12,
          bold: /bold|black|heavy|semibold/i.test(fontName),
          italic: /italic|oblique/i.test(fontName),
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
          : richParagraphs(lines),
      suggestedFormat,
    };
  } finally {
    await loadingTask.destroy();
  }
}

/** The item's real font name (subset prefix stripped), or "" unknown. */
function resolveFontName(
  page: { commonObjs: { has?: (id: string) => boolean; get: (id: string) => unknown } },
  content: { styles: Record<string, { fontFamily?: string }> },
  id: string,
): string {
  try {
    const font = page.commonObjs.get(id) as { name?: string } | null;
    if (font?.name) return font.name.replace(/^[A-Z]{6}\+/, "");
  } catch {
    // Not resolved despite the operator-list preload — fall through.
  }
  return content.styles[id]?.fontFamily ?? "";
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
      const segments: Segment[] = [];
      let text = "";
      let right = row[0].x;
      const push = (str: string, bold: boolean, italic: boolean) => {
        const last = segments[segments.length - 1];
        if (last && last.bold === bold && last.italic === italic) last.text += str;
        else segments.push({ text: str, bold, italic });
        text += str;
      };
      for (const item of row) {
        const gap = item.x - right;
        if (text && !/\s$/.test(text) && gap > Math.max(1.5, item.height * 0.16)) {
          // Whitespace inherits the previous run's style.
          push(" ", segments[segments.length - 1].bold, segments[segments.length - 1].italic);
        }
        push(item.str, item.bold, item.italic);
        right = Math.max(right, item.x + item.width);
      }
      for (const s of segments) s.text = s.text.replace(/\s+/g, " ");
      return {
        text: text.replace(/\s+/g, " ").trim(),
        segments: segments.filter((s) => s.text.length > 0),
        x: row[0].x,
        x1: right,
        y: row.reduce((sum, item) => sum + item.y, 0) / row.length,
        height: Math.max(...row.map((item) => item.height)),
        size: Math.max(...row.map((item) => item.size)),
        page,
        pageWidth,
        pageHeight,
      };
    })
    .filter((line) => {
      if (!line.text) return false;
      // Page numbers are running furniture, not document content — both the
      // screenplay convention (top corner) and the book convention (bottom).
      const nearTop = line.y > line.pageHeight - 54;
      const nearBottom = line.y < 54;
      if (nearTop && /^\d+[A-Z]?\.?$/.test(line.text)) return false;
      if (nearBottom && /^\d+$/.test(line.text)) return false;
      return true;
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

/* ---- ordinary prose: metrics, assembly, classification ---- */

interface DocMetrics {
  bodySize: number;
  bodyLeft: number;
  rightEdge: number;
  bodyWidth: number;
  /** Descending heading sizes → levels 1..3. */
  headingSizes: number[];
}

function sizeBucket(size: number): number {
  return Math.round(size * 2) / 2;
}

function measure(lines: PdfLine[]): DocMetrics {
  // Body size = the size carrying the most text.
  const byLength = new Map<number, number>();
  for (const line of lines) {
    const b = sizeBucket(line.size);
    byLength.set(b, (byLength.get(b) ?? 0) + line.text.length);
  }
  let bodySize = 12;
  let best = -1;
  for (const [b, len] of byLength) {
    if (len > best) {
      best = len;
      bodySize = b;
    }
  }

  const bodyLines = lines.filter((l) => Math.abs(sizeBucket(l.size) - bodySize) <= 0.75);
  const leftCounts = new Map<number, number>();
  for (const line of bodyLines) {
    const b = Math.round(line.x / 3) * 3;
    leftCounts.set(b, (leftCounts.get(b) ?? 0) + 1);
  }
  let bodyLeft = bodyLines[0]?.x ?? 72;
  best = -1;
  for (const [b, n] of leftCounts) {
    if (n > best) {
      best = n;
      bodyLeft = b;
    }
  }

  const rights = bodyLines.map((l) => l.x1).sort((a, b) => a - b);
  const rightEdge = rights.length
    ? rights[Math.min(rights.length - 1, Math.floor(rights.length * 0.9))]
    : bodyLeft + 400;

  const headingSizes = [...byLength.keys()]
    .filter((b) => b >= bodySize + 1.5)
    .sort((a, b) => b - a)
    .slice(0, 3);

  return { bodySize, bodyLeft, rightEdge, bodyWidth: Math.max(60, rightEdge - bodyLeft), headingSizes };
}

function isCentered(line: PdfLine, m: DocMetrics): boolean {
  const width = line.x1 - line.x;
  if (width >= m.bodyWidth * 0.8) return false;
  const lineCenter = (line.x + line.x1) / 2;
  const bodyCenter = m.bodyLeft + m.bodyWidth / 2;
  return Math.abs(lineCenter - bodyCenter) <= Math.max(6, m.bodyWidth * 0.05);
}

function startsIndented(line: PdfLine, m: DocMetrics): boolean {
  const offset = line.x - m.bodyLeft;
  return offset >= 6 && offset <= Math.min(60, m.bodyWidth * 0.5);
}

/** Append a line's segments to a paragraph's runs, wrap-aware. */
function appendLine(runs: Segment[], line: PdfLine): void {
  if (runs.length === 0) {
    runs.push(...line.segments.map((s) => ({ ...s })));
    return;
  }
  const last = runs[runs.length - 1];
  const first = line.segments[0];
  if (!first) return;
  if (/\w-$/.test(last.text) && /^[a-z]/.test(first.text)) {
    // De-hyphenate a wrapped word into the previous run.
    last.text = last.text.slice(0, -1);
  } else {
    last.text += " ";
  }
  for (const s of line.segments) {
    const tail = runs[runs.length - 1];
    if (tail.bold === s.bold && tail.italic === s.italic) tail.text += s.text;
    else runs.push({ ...s });
  }
}

function richParagraphs(lines: PdfLine[]): ImportedPdfParagraph[] {
  if (lines.length === 0) return [];
  const m = measure(lines);
  const paragraphs: ImportedPdfParagraph[] = [];

  let runs: Segment[] = [];
  let paraLines: PdfLine[] = [];

  const flush = () => {
    if (paraLines.length === 0) return;
    const text = runs
      .map((r) => r.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      runs = [];
      paraLines = [];
      return;
    }
    const size = sizeBucket(Math.max(...paraLines.map((l) => l.size)));
    const centered = paraLines.every((l) => isCentered(l, m));
    const headingLevel = m.headingSizes.indexOf(size);
    const words = text.split(/\s+/).length;
    const isHeading = headingLevel !== -1 && paraLines.length <= 2 && words <= 14;
    const indented = !centered && !isHeading && startsIndented(paraLines[0], m);

    const cleaned: ImportedRun[] = runs
      .map((r) => ({
        text: r.text.replace(/\s+/g, " "),
        ...(r.bold ? { bold: true } : {}),
        ...(r.italic ? { italic: true } : {}),
      }))
      .filter((r) => r.text.length > 0);
    // Trim outer whitespace without losing inner run boundaries.
    if (cleaned.length) {
      cleaned[0].text = cleaned[0].text.replace(/^\s+/, "");
      cleaned[cleaned.length - 1].text = cleaned[cleaned.length - 1].text.replace(/\s+$/, "");
    }
    if (indented && cleaned.length) cleaned[0].text = `\t${cleaned[0].text}`;

    paragraphs.push({
      text: indented ? `\t${text}` : text,
      ...(isHeading ? { kind: "heading" as const, level: Math.min(headingLevel + 1, 3) } : {}),
      ...(centered ? { align: "center" as const } : {}),
      runs: cleaned,
    });
    runs = [];
    paraLines = [];
  };

  let prev: PdfLine | null = null;
  for (const line of lines) {
    if (prev) {
      const pageChanged = prev.page !== line.page;
      const gap = pageChanged ? Infinity : prev.y - line.y;
      const sizeChanged = Math.abs(sizeBucket(prev.size) - sizeBucket(line.size)) > 0.75;
      const centeredChanged = isCentered(prev, m) !== isCentered(line, m);
      const indentStart =
        startsIndented(line, m) && prev.x <= m.bodyLeft + 2 && !isCentered(line, m);

      let breakHere: boolean;
      if (pageChanged) {
        // Join across the page boundary only when the previous line ran full
        // and the new one resumes at the body margin mid-sentence.
        const prevFull = prev.x1 >= m.rightEdge - m.bodyWidth * 0.15;
        const resumes = line.x <= m.bodyLeft + 2;
        const midSentence =
          !/[.!?:;"”’)\]]$/.test(prev.text) || /^[a-z]/.test(line.text);
        breakHere = !(prevFull && resumes && !sizeChanged && midSentence);
      } else {
        breakHere =
          gap > Math.max(prev.height, line.height) * 1.65 ||
          sizeChanged ||
          centeredChanged ||
          indentStart;
      }
      if (breakHere) flush();
    }
    appendLine(runs, line);
    paraLines.push(line);
    prev = line;
  }
  flush();
  return paragraphs;
}

function joinWrappedText(previous: string, next: string): string {
  if (/\w-$/.test(previous) && /^[a-z]/.test(next)) return previous.slice(0, -1) + next;
  return `${previous} ${next}`;
}
