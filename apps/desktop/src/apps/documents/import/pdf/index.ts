/**
 * A PDF read as a document.
 *
 * A PDF is pages of placed strings, lines and pictures, with nothing to say
 * which strings are a paragraph or which paragraph comes next. Reading one
 * is putting that back: lines from strings, the order they are read in,
 * what is furniture and what is text, paragraphs, headings, and so on (each
 * in its own file here, model.ts between them).
 *
 * The result has the shape the Word reader's has, so a caller treats the
 * two alike. Nothing here needs a window: the canvas (to make a file of a
 * picture) and the system's text recogniser are handed in, and so is the
 * person to ask.
 */

import type { JSONContent } from "@tiptap/core";

import type { DocxMedia } from "../../../../docx/read";
import type { Pdfjs } from "../../../../lib/pdfjs";
import { assemble } from "./assemble";
import { findFurniture, type PageLines } from "./furniture";
import { linesOf } from "./lines";
import { findLists } from "./lists";
import { lookOf, type Look, type LookPage } from "./look";
import { cancelled, DESKTOP_LIMITS, throwIfCancelled, type Ask, type Block, type EncodeImage, type Limits, type Line, type PageData, type ParaBlock, type PdfError, type Recognise, type RenderPage, type Run, type SeenLine } from "./model";
import { takeNotes } from "./notes";
import { readingOrder, rejoin, type Placed } from "./order";
import { hyphenated, markHeadings, measure, paragraphs, textOf, type Metrics } from "./paras";
import { isCaption, Pictures } from "./pictures";
import { openPdf, readPage } from "./read";
import { looksLikeScreenplay, screenplayBlocks } from "./screenplay";
import { findTables } from "./tables";
import { taggedBlocks, tagsCover } from "./tagged";

export type { Ask, EncodedPicture, EncodeImage, Limits, PdfError, Recognise, RenderPage, SeenLine } from "./model";
export { DESKTOP_LIMITS, PHONE_LIMITS } from "./model";

export interface PdfReadOptions {
  pdfjs: Pdfjs;
  limits?: Limits;
  ask?: Ask;
  /** How far along it is: pages done, pages in all, and what is being done. */
  progress?: (done: number, total: number, label: string) => void;
  signal?: AbortSignal;
  /** Makes a file of a picture (absent: pictures are left out and counted). */
  encodeImage?: EncodeImage;
  /** A page as a picture (for a page that is a scan). */
  renderPage?: RenderPage;
  /** Reads the text in a picture of a page. */
  recognise?: Recognise;
  /** The language a scan is likely written in ("en-GB"), and how finely a
   *  page is drawn to be read. */
  lang?: string;
  scanDpi?: number;
  /** A font's name as a font this app has, and the family it names. */
  fontId?: (name: string) => string | null;
  fontFamily?: (name: string) => string;
}

export interface PdfRead {
  content: JSONContent;
  suggestedFormat: "none" | "screenplay";
  meta: { title?: string; author?: string };
  /** A patch for the document's settings. */
  settings: Record<string, unknown>;
  /** Entries for the document's font table. */
  fonts: Record<string, string>;
  media: DocxMedia[];
  /** What didn't come across. */
  warnings: string[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A page's lines with what was read of the page besides. */
interface PageRead extends PageLines {
  data: PageData;
  /** A scan whose text is had all the same: from a layer of unseen text
   *  the file brought with it, or read out of the picture here. */
  text?: "layer" | "read";
}

/** Sizes that are one size, read a little differently each time (a
 *  recogniser measures type by the box round a line): each as the middle
 *  of those near it. */
function evenSizes(runs: Run[]): void {
  const sizes = [...new Set(runs.map((run) => run.size))].sort((a, b) => a - b);
  const snap = new Map<number, number>();
  for (let k = 0; k < sizes.length; ) {
    let end = k;
    while (end + 1 < sizes.length && sizes[end + 1] <= sizes[k] * 1.18) end += 1;
    const group = runs.filter((run) => run.size >= sizes[k] && run.size <= sizes[end]).map((run) => run.size);
    const middle = Math.round([...group].sort((a, b) => a - b)[Math.floor(group.length / 2)]);
    for (let j = k; j <= end; j += 1) snap.set(sizes[j], middle);
    k = end + 1;
  }
  for (const run of runs) run.size = snap.get(run.size) ?? run.size;
}

/** Something in the flow of a page: a line of text, or a block made
 *  already (a table, a picture). */
interface Flow extends Placed {
  block?: Block;
}

const percentile = (values: number[], at: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * at)))];
};

/** The size most of a page's letters are in. */
function mainSize(page: PageData): number {
  const by = new Map<number, number>();
  for (const run of page.runs) {
    const key = Math.round(run.size);
    by.set(key, (by.get(key) ?? 0) + run.text.length);
  }
  let best = 12;
  let top = 0;
  for (const [size, letters] of by) {
    if (letters > top) {
      top = letters;
      best = size;
    }
  }
  return best;
}

/** The left edge most lines start at. */
function usualLeft(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.x0 / 3) * 3;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = lines[0].x0;
  let top = 0;
  for (const [key, count] of counts) {
    if (count > top || (count === top && key < best)) {
      top = count;
      best = key;
    }
  }
  // (The edge itself, not the middle of the bucket it fell in.)
  return Math.min(...lines.filter((line) => Math.abs(line.x0 - best) <= 1.5).map((line) => line.x0), best + 1.5);
}

/**
 * A page's lines and blocks in the order they are read. Each line is told
 * the edges of the column it stands in, and whether a column begins with it.
 */
function inOrder(lines: Line[], blocks: Flow[], unit: number, gutters: number[], known: number[] = []): (Line | Block)[] {
  if (!lines.length && !blocks.length) return [];
  const edges = lines.length ? { left: percentile(lines.map((l) => l.x0), 0.05), right: percentile(lines.map((l) => l.x1), 0.95) } : { left: 0, right: 0 };
  const items: Flow[] = [...lines.map((line) => ({ x0: line.x0, x1: line.x1, top: line.top, bottom: line.bottom, line })), ...blocks];
  const out: (Line | Block)[] = [];
  const order = readingOrder(items, unit, known);
  gutters.push(...order.gutters);
  for (const region of order.regions) {
    let run: Line[] = [];
    const flush = () => {
      if (!run.length) return;
      const joined = rejoin(run);
      // A few lines say little of where their edges are: the page's stand
      // for them, unless they are a column (which has its own).
      const own = joined.length >= 4;
      const left = own ? usualLeft(joined) : region.column ? Math.min(...joined.map((l) => l.x0)) : edges.left;
      const right = own ? percentile(joined.map((l) => l.x1), 0.9) : region.column ? Math.max(...joined.map((l) => l.x1)) : edges.right;
      joined.forEach((line, k) => {
        line.left = Math.min(left, line.x0);
        line.right = Math.max(right, line.x1);
        if (k === 0 && region.column) line.starts = true;
      });
      out.push(...joined);
      run = [];
    };
    for (const item of region.items) {
      if (item.line) run.push(item.line);
      else if (item.block) {
        flush();
        out.push(item.block);
      }
    }
    flush();
  }
  return out;
}

const isLine = (item: Line | Block): item is Line => !("kind" in item);

interface OutlineNode {
  title?: string;
  items?: OutlineNode[];
}
/** A file's bookmarks, each with how deep it is. */
function flatOutline(nodes: OutlineNode[], depth = 1, out: { title: string; depth: number }[] = []): { title: string; depth: number }[] {
  for (const node of nodes) {
    if (typeof node.title === "string" && node.title.trim()) out.push({ title: node.title, depth });
    if (Array.isArray(node.items) && depth < 8) flatOutline(node.items, depth + 1, out);
  }
  return out;
}
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** Read a PDF. Throws a `PdfError` for a file that can't be read, and for
 *  an import that was called off. */
export async function readPdf(data: ArrayBuffer | Uint8Array, opts: PdfReadOptions): Promise<PdfRead> {
  const { pdfjs } = opts;
  const limits = opts.limits ?? DESKTOP_LIMITS;
  const warnings: string[] = [];
  throwIfCancelled(opts.signal);
  const { doc, close } = await openPdf(pdfjs, data, limits, opts.ask);
  try {
    if (doc.numPages === 0) throw { code: "pdf_empty", message: "That PDF has no pages." } satisfies PdfError;
    const count = Math.min(doc.numPages, limits.pages);
    if (count < doc.numPages) warnings.push(`only the first ${count} of ${doc.numPages} pages were read`);

    const pages: PageRead[] = [];
    const pictures = new Pictures(opts.encodeImage, limits);
    let turned = 0;
    let drawings = 0;
    for (let n = 1; n <= count; n += 1) {
      throwIfCancelled(opts.signal);
      opts.progress?.(n - 1, count, `Reading page ${n} of ${count}`);
      const page = await doc.getPage(n);
      // (Its pictures are taken while it is open. How tall its text is
      // tells a picture from a mark in a line.)
      const read = await readPage(pdfjs, page, n, (open, data) => pictures.take(open, data, mainSize(data)));
      turned += read.turned;
      if (read.drawings) drawings += 1;
      const seen = read.runs.filter((run) => !run.hidden);
      pages.push({
        n,
        w: read.w,
        h: read.h,
        lines: linesOf(n, seen.filter((run) => !run.artifact)),
        marked: linesOf(n, seen.filter((run) => run.artifact)),
        data: read,
      });
    }
    // Pages that are pictures of text. One that brought its text with it
    // (unseen, under the picture) is read by that. For the rest: ask.
    const letters = (runs: Run[]) => runs.reduce((sum, run) => sum + run.text.replace(/\s+/g, "").length, 0);
    const bare: PageRead[] = [];
    for (const page of pages) {
      if (page.data.kind !== "scan") continue;
      const layer = page.data.runs.filter((run) => run.hidden && !run.artifact);
      if (letters(layer) >= 20) {
        page.lines = linesOf(
          page.n,
          layer.map((run) => ({ ...run, hidden: false })),
        );
        page.text = "layer";
      } else bare.push(page);
    }
    if (bare.length) {
      const canRead = !!opts.recognise;
      const choice = opts.ask?.scan ? await opts.ask.scan(bare.length, canRead) : canRead ? "read" : "pictures";
      if (choice === null) throw cancelled();
      if (choice === "read" && opts.recognise) {
        const most = Math.min(bare.length, limits.ocrPages);
        const found: Run[] = [];
        let done = 0;
        let failed = 0;
        for (const page of bare) {
          if (done + failed >= most) break;
          throwIfCancelled(opts.signal);
          opts.progress?.(done + failed, most, `Reading the text on page ${page.n}`);
          // The picture to read: the scan itself when it is the page, else
          // the page drawn.
          const whole = [...page.data.pictures].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
          const kept = whole ? pictures.keptAt(page.n, whole.id) : null;
          let file = kept ? pictures.fileOf(kept) : null;
          let box = whole?.box ?? { x: 0, y: 0, w: page.w, h: page.h };
          if (opts.renderPage && (!file || !whole || whole.box.w * whole.box.h < page.w * page.h * 0.85)) {
            const open = await doc.getPage(page.n);
            const drawn = await opts.renderPage(open, opts.scanDpi ?? 300).catch(() => null);
            open.cleanup();
            if (drawn) {
              file = drawn;
              box = { x: 0, y: 0, w: page.w, h: page.h };
            }
          }
          let seen: SeenLine[] | null = null;
          try {
            seen = file ? await opts.recognise(file, opts.lang ?? "en-US") : null;
          } catch {
            seen = null;
          }
          if (!seen) {
            failed += 1;
            continue;
          }
          const runs = seen
            .filter((line) => line.confidence >= 0.3 && line.text.trim())
            .map((line): Run => {
              const tall = line.box.h * box.h;
              return {
                text: line.text.trim(),
                x: box.x + line.box.x * box.w,
                // (The box runs from the top of tall letters to the foot of
                // hanging ones: the baseline is a fifth up from its foot.)
                y: box.y + (line.box.y + line.box.h) * box.h - tall * 0.2,
                w: line.box.w * box.w,
                size: Math.min(96, Math.max(5, tall * 0.8)),
                font: "",
                bold: false,
                italic: false,
                mono: false,
                color: null,
                hidden: false,
                mark: -1,
                artifact: false,
              };
            });
          found.push(...runs);
          page.data.runs = runs;
          page.text = "read";
          done += 1;
        }
        evenSizes(found);
        for (const page of bare) if (page.text === "read") page.lines = linesOf(page.n, page.data.runs);
        if (done) warnings.push(`the text of ${plural(done, "scanned page")} was read by this device and may have mistakes`);
        const kept = bare.length - done;
        if (kept) warnings.push(`${plural(kept, "scanned page")} kept as ${kept === 1 ? "a picture" : "pictures"}${bare.length > most ? ` (the most read at once is ${limits.ocrPages})` : ""}`);
      } else warnings.push(`${plural(bare.length, "scanned page")} kept as ${bare.length === 1 ? "a picture" : "pictures"}`);
    }

    throwIfCancelled(opts.signal);
    opts.progress?.(count, count, "Putting the text together");

    const furniture = findFurniture(pages);
    for (const page of pages) page.lines = page.lines.filter((line) => !furniture.drop.has(line));
    const all = pages.flatMap((page) => page.lines);
    const widthOf = (n: number) => pages[n - 1]?.w ?? 612;

    const info = ((await doc.getMetadata().catch(() => null))?.info ?? {}) as Record<string, unknown>;
    const meta: PdfRead["meta"] = {};
    if (typeof info.Title === "string" && info.Title.trim()) meta.title = info.Title.trim().slice(0, 200);
    if (typeof info.Author === "string" && info.Author.trim()) meta.author = info.Author.trim().slice(0, 200);

    let blocks: Block[];
    let look: Look | null = null;
    let body: Metrics = measure(all);
    let suggestedFormat: PdfRead["suggestedFormat"] = "none";
    if (looksLikeScreenplay(all, widthOf)) {
      suggestedFormat = "screenplay";
      blocks = screenplayBlocks(all, widthOf);
    } else {
      const compounds = hyphenated(all);
      const byTags = tagsCover(pages.map((page) => page.data));
      const inCell = (lines: Line[]): Block[] => findLists(paragraphs([...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0), body, compounds));
      // A picture on most of the pages is the paper's, not the text's.
      const onPages = new Map<string, number>();
      for (const page of pages) {
        // (A scanned page's picture is the page.)
        if (page.data.kind === "scan") continue;
        for (const key of new Set(page.data.pictures.map((picture) => pictures.keptAt(page.n, picture.id)?.key))) if (key) onPages.set(key, (onPages.get(key) ?? 0) + 1);
      }
      const often = new Set([...onPages.entries()].filter(([, n]) => n >= Math.max(3, Math.ceil(pages.length * 0.4))).map(([key]) => key));
      // Each page: its notes back with their numbers, its tables made, and
      // what is left to be read as text.
      const parts = pages.map((page) => {
        // (A file that says what everything is has no need of this: its
        // lines are only looked at for the look of the page.)
        if (byTags) return { lines: page.lines, blocks: [] as Flow[] };
        const noted = takeNotes(page.lines, body.size);
        const tables = findTables(page.data, noted.lines, body.size, inCell);
        const used = new Set(tables.flatMap((table) => [...table.used]));
        const shown: Flow[] = [];
        const edge = noted.lines.length ? { left: percentile(noted.lines.map((l) => l.x0), 0.05), right: percentile(noted.lines.map((l) => l.x1), 0.95) } : { left: page.w * 0.12, right: page.w * 0.88 };
        // (A scan whose text was read is its text, not its picture.)
        for (const picture of page.text ? [] : page.data.pictures) {
          const kept = pictures.keptAt(page.n, picture.id);
          if (!kept || (often.has(kept.key) && page.data.kind !== "scan")) continue;
          const { x, y, w, h } = picture.box;
          // No wider than the text is, and placed as it was placed.
          const across = Math.max(36, edge.right - edge.left);
          const scale = Math.min(1, across / w);
          const middle = Math.abs(x + w / 2 - (edge.left + edge.right) / 2) <= across * 0.06;
          const align = w >= across * 0.9 ? undefined : middle ? ("center" as const) : x + w >= edge.right - 4 && x > edge.left + across * 0.2 ? ("right" as const) : undefined;
          shown.push({ x0: x, x1: x + w, top: y, bottom: y + h, block: { kind: "image", page: page.n, key: kept.key, w: w * scale, h: h * scale, ...(align ? { align } : {}) } });
        }
        return {
          lines: noted.lines.filter((line) => !used.has(line)),
          blocks: [...tables.map((table): Flow => ({ x0: table.x0, x1: table.x1, top: table.top, bottom: table.bottom, block: table.block })), ...shown],
        };
      });
      // (Twice where a page shows no columns of its own: the gutters of
      // the other pages may be its gutters too.)
      const gutters: number[] = [];
      const columns: number[] = [];
      const first = parts.map((part) => {
        const own: number[] = [];
        const order = inOrder(
          part.lines.map((line) => ({ ...line })),
          part.blocks,
          body.size,
          own,
        );
        gutters.push(...own);
        // (A gutter cut in two by a line across it is still one gutter.)
        columns.push(own.sort((a, b) => a - b).filter((at, i) => i === 0 || at - own[i - 1] > body.size).length);
        return own.length ? order : null;
      });
      const flow: (Line | Block)[] = [];
      parts.forEach((part, k) => flow.push(...(first[k] ?? inOrder(part.lines, part.blocks, body.size, [], gutters))));
      const text = flow.filter(isLine);
      body = measure(text);
      let paras: ParaBlock[];
      if (byTags) {
        const read = taggedBlocks(
          pages.map((page) => page.data),
          { compounds, picture: (page, id) => pictures.keptAt(page, id) },
        );
        blocks = read.blocks;
        if (read.drawn) drawings += read.drawn;
        paras = [];
        const gather = (list: Block[]) => {
          for (const b of list) {
            if (b.kind === "para") paras.push(b);
            else if (b.kind === "list") b.items.forEach((item) => gather(item.blocks));
          }
        };
        gather(blocks);
      } else {
        blocks = [];
        let run: Line[] = [];
        const flush = () => {
          if (run.length) blocks.push(...paragraphs(run, body, compounds));
          run = [];
        };
        for (const item of flow) {
          if (isLine(item)) run.push(item);
          else {
            flush();
            blocks.push(item);
          }
        }
        flush();
        paras = blocks.filter((b): b is ParaBlock => b.kind === "para");
        markHeadings(paras, body);
        // A file's own bookmarks say what its headings are, and how deep.
        const marks = flatOutline(((await doc.getOutline().catch(() => null)) ?? []) as OutlineNode[]);
        let from = 0;
        for (const mark of marks) {
          const at = paras.findIndex((para, k) => k >= from && para.lines <= 3 && same(textOf(para), mark.title));
          if (at < 0) continue;
          paras[at].heading = Math.min(6, mark.depth);
          delete paras[at].indent;
          delete paras[at].inset;
          from = at + 1;
        }
        // What is said under a picture is the picture's.
        for (let k = 0; k + 1 < blocks.length; k += 1) {
          const image = blocks[k];
          const under = blocks[k + 1];
          if (image.kind !== "image" || under.kind !== "para" || !isCaption(under, image, body.size)) continue;
          image.caption = textOf(under).replace(/\s+/g, " ").trim();
          blocks.splice(k + 1, 1);
        }
        blocks = findLists(blocks);
      }
      const shown = new Set<string>();
      const walk = (list: Block[]) => {
        for (const b of list) {
          if (b.kind === "image") shown.add(b.key);
          else if (b.kind === "list") b.items.forEach((item) => walk(item.blocks));
          else if (b.kind === "table") b.rows.forEach((row) => row.forEach((cell) => walk(cell.blocks)));
        }
      };
      walk(blocks);
      pictures.keepOnly(shown);

      // The pages' look, as the document's settings.
      const lookPages: LookPage[] = pages.map((page, k) => {
        const lines = parts[k].lines;
        const left = lines.filter((l) => l.x1 <= (gutters[0] ?? 0));
        const right = lines.filter((l) => l.x0 >= (gutters[0] ?? Infinity));
        const gap = columns[k] && left.length && right.length ? Math.min(...right.map((l) => l.x0)) - Math.max(...left.map((l) => l.x1)) : 0;
        return { w: page.w, h: page.h, lines, columns: columns[k] ? columns[k] + 1 : 1, gap: Math.max(0, gap) };
      });
      look = lookOf(lookPages, body, furniture, paras, info, opts.fontId, opts.fontFamily ?? ((name) => name));
    }

    if (pictures.left) warnings.push(`${plural(pictures.left, "picture")} left out`);
    if (drawings) warnings.push(`drawings on ${plural(drawings, "page")} left out`);
    if (turned) warnings.push(`${plural(turned, "piece")} of text set at an angle left out`);
    const content = assemble(blocks, { body, fontId: opts.fontId, look: !!look, indentSet: !!look?.indentSet });
    return { content, suggestedFormat, meta, settings: look?.settings ?? {}, fonts: look?.fonts ?? {}, media: look ? pictures.media : [], warnings };
  } finally {
    await close();
  }
}
