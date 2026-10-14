/**
 * A PDF opened, and each of its pages read as it was drawn.
 *
 * pdf.js gives a page's text (strings with their places and fonts) and,
 * apart from that, how the page was drawn (lib/pdfOps.ts). Here the two are
 * put together: each string gets the colour it was drawn in, whether it was
 * thickened or left unseen, where it leads, and the marked stretch it
 * belongs to. Lines, boxes, pictures and the page's tagged structure come
 * with it.
 */

import { boxThrough, matMul, walkPage, type Mat, type ShownText } from "../../../../lib/pdfOps";
import type { Pdfjs } from "../../../../lib/pdfjs";
import { cancelled, type Ask, type Limits, type Mark, type PageData, type PageLink, type PdfError, type Rule, type Run, type TreeNode } from "./model";

type LoadingTask = ReturnType<Pdfjs["getDocument"]>;
export type PdfDoc = Awaited<LoadingTask["promise"]>;
export type PdfPage = Awaited<ReturnType<PdfDoc["getPage"]>>;

export interface OpenPdf {
  doc: PdfDoc;
  /** Close it (always, when done). */
  close: () => Promise<void>;
}

const invalid = (): PdfError => ({ code: "pdf_invalid", message: "That file can’t be read as a PDF." });

/**
 * Open a PDF. A file with a password asks for it through `ask` (and again
 * while it is wrong). Without anyone to ask, or when the asking is called
 * off, the import ends there.
 */
export async function openPdf(pdfjs: Pdfjs, data: ArrayBuffer | Uint8Array, limits: Limits, ask: Ask = {}): Promise<OpenPdf> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > limits.bytes) {
    throw { code: "pdf_too_large", message: `This PDF is too large to import here. The most is ${Math.round(limits.bytes / 1_000_000)} MB.` } satisfies PdfError;
  }
  // (pdf.js keeps the bytes it is given: these are a copy.)
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, canvasMaxAreaInBytes: 64 * 1024 * 1024 });
  let refused: PdfError | null = null;
  task.onPassword = (update: (password: string | Error) => void, reason: number) => {
    const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    const stop = (error: PdfError) => {
      refused = error;
      update(new Error(error.code));
    };
    if (!ask.password) {
      stop({ code: "pdf_password", message: "This PDF has a password. Save a copy without one and import that." });
      return;
    }
    ask.password(again).then(
      (password) => (password === null ? stop(cancelled()) : update(password)),
      () => stop(cancelled()),
    );
  };
  try {
    const doc = await task.promise;
    return { doc, close: () => task.destroy().catch(() => {}) };
  } catch (error) {
    await task.destroy().catch(() => {});
    if (refused) throw refused;
    if ((error as { name?: string } | null)?.name === "PasswordException") {
      throw { code: "pdf_password", message: "This PDF has a password. Save a copy without one and import that." } satisfies PdfError;
    }
    throw invalid();
  }
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

interface FontObject {
  name?: string;
  bold?: boolean;
  italic?: boolean;
  black?: boolean;
  isMonospace?: boolean;
  fontMatrix?: ArrayLike<number>;
  vertical?: boolean;
}

const BOLD = /bold|black|heavy|semibold|demibold|extrabold/i;
const ITALIC = /italic|oblique/i;
const MONO = /mono|courier|consolas|menlo/i;

/** How text is drawn where a string starts, by looking the place up. */
class Drawn {
  private rows = new Map<number, ShownText[]>();

  constructor(shown: ShownText[]) {
    for (const s of shown) {
      const key = Math.round(s.y);
      const row = this.rows.get(key);
      if (row) row.push(s);
      else this.rows.set(key, [s]);
    }
    for (const row of this.rows.values()) row.sort((a, b) => a.x - b.x);
  }

  /** The strings drawn from `x` to `x + w` on the baseline `y`. */
  along(x: number, y: number, w: number): ShownText[] {
    const out: ShownText[] = [];
    const key = Math.round(y);
    for (const k of [key - 1, key, key + 1]) {
      for (const s of this.rows.get(k) ?? []) {
        if (Math.abs(s.y - y) <= 1 && s.x >= x - 1.5 && s.x <= x + Math.max(w, 0) + 1.5) out.push(s);
      }
    }
    return out.sort((a, b) => a.x - b.x);
  }
}

const inked = (text: string): number => text.replace(/\s+/g, "").length;

interface Look {
  color: string | null;
  thick: boolean;
  hidden: boolean;
}

const lookOf = (s: ShownText, twice = false): Look => {
  const mode = s.mode % 4;
  return { color: s.fill, thick: twice || (mode === 2 && s.pen >= 0.015), hidden: mode === 3 };
};
const sameLook = (a: Look, b: Look) => a.color === b.color && a.thick === b.thick && a.hidden === b.hidden;

/**
 * One page as it was drawn. (The page's own objects are let go when this
 * is done, except its pictures, which `keep` is given the chance to take
 * first.)
 */
export async function readPage(pdfjs: Pdfjs, page: PdfPage, n: number, keep?: (page: PdfPage, data: PageData) => Promise<void>): Promise<PageData> {
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform.slice(0, 6) as Mat;
  const fontOf = (id: string): FontObject | null => {
    try {
      return (page.commonObjs.get(id) as FontObject | null) ?? null;
    } catch {
      return null;
    }
  };

  // (The operator list first: it brings the fonts in, which the names
  // below are asked of.)
  const list = await page.getOperatorList();
  const drawn = walkPage(pdfjs, list, base, fontOf);
  const places = new Drawn(drawn.shown);
  const content = await page.getTextContent({ includeMarkedContent: true });

  const runs: Run[] = [];
  const marks: Mark[] = [];
  const open: number[] = [];
  let turned = 0;
  for (const raw of content.items as unknown[]) {
    const item = raw as Partial<TextItem> & { type?: string; tag?: string; id?: string | null };
    if (item.type === "beginMarkedContent" || item.type === "beginMarkedContentProps") {
      marks.push({ tag: String(item.tag ?? ""), id: item.id ?? null });
      open.push(marks.length - 1);
      continue;
    }
    if (item.type === "endMarkedContent") {
      open.pop();
      continue;
    }
    if (typeof item.str !== "string" || !item.str.trim() || !item.transform) continue;
    const tm = matMul(base, item.transform.slice(0, 6) as Mat);
    const across = Math.hypot(tm[0], tm[1]);
    const up = Math.hypot(tm[2], tm[3]);
    if (!across || !up) continue;
    // Text set at an angle doesn't read on with the rest.
    if (Math.abs(Math.atan2(tm[1], tm[0])) > 0.09) {
      turned += 1;
      continue;
    }
    const size = up;
    const font = fontOf(item.fontName ?? "");
    const name = (font?.name ?? content.styles[item.fontName ?? ""]?.fontFamily ?? "").replace(/^[A-Z]{6}\+/, "");
    // Leaning without an italic face: the letters were sheared.
    const sheared = Math.abs(tm[0] * tm[2] + tm[1] * tm[3]) / (across * up) > 0.1;
    const x = tm[4];
    const y = tm[5];
    const w = Math.abs(item.width ?? 0) || item.str.length * size * 0.5;
    const mark = [...open].reverse().find((k) => marks[k].id !== null) ?? -1;
    const artifact = open.some((k) => marks[k].tag === "Artifact");
    const make = (text: string, at: number, width: number, look: Look | null): Run => ({
      text,
      x: at,
      y,
      w: width,
      size,
      font: name,
      bold: BOLD.test(name) || !!font?.bold || !!font?.black || !!look?.thick,
      italic: ITALIC.test(name) || !!font?.italic || sheared,
      mono: !!font?.isMonospace || MONO.test(name),
      color: look ? look.color : null,
      hidden: !!look?.hidden,
      mark,
      artifact,
    });

    // The same words drawn twice a hair apart are one bold word (pdf.js
    // hands them over as the word written twice).
    let str = item.str;
    const under: ShownText[] = [];
    const twice = new Set<ShownText>();
    for (const s of places.along(x, y, w)) {
      const twin = under.find((u) => u.text === s.text && inked(s.text) > 0 && Math.abs(u.x - s.x) <= size * 0.2);
      if (!twin) {
        under.push(s);
        continue;
      }
      const word = s.text.trim();
      const at = str.indexOf(word);
      const again = at < 0 ? -1 : str.indexOf(word, at + word.length);
      if (again >= 0 && !str.slice(at + word.length, again).trim()) {
        str = str.slice(0, at + word.length) + (/\s$/.test(s.text) ? " " : "") + str.slice(again + word.length);
        twice.add(twin);
      } else under.push(s);
    }
    const looks = under.map((s) => lookOf(s, twice.has(s)));
    if (under.length < 2 || looks.every((l) => sameLook(l, looks[0]))) {
      runs.push(make(str, x, w, looks[0] ?? null));
      continue;
    }
    // One string, drawn in more than one way: cut it where the drawing
    // changes, by counting its letters off against what was drawn.
    const total = inked(str);
    if (under.reduce((sum, s) => sum + inked(s.text), 0) !== total) {
      // (They don't add up: the way most of it was drawn stands for all.)
      let best = 0;
      for (let k = 1; k < under.length; k += 1) if (inked(under[k].text) > inked(under[best].text)) best = k;
      runs.push(make(str, x, w, looks[best]));
      continue;
    }
    let at = 0;
    for (let k = 0; k < under.length; ) {
      let end = k + 1;
      let letters = inked(under[k].text);
      while (end < under.length && sameLook(looks[end], looks[k])) {
        letters += inked(under[end].text);
        end += 1;
      }
      let stop = at;
      for (let seen = 0; stop < str.length && seen < letters; stop += 1) if (!/\s/.test(str[stop])) seen += 1;
      // (Spaces after it go with it, so the next piece starts on a letter.)
      while (end < under.length && stop < str.length && /\s/.test(str[stop])) stop += 1;
      if (end >= under.length) stop = str.length;
      const from = Math.max(x, under[k].x);
      const to = end < under.length ? under[end].x : x + w;
      if (stop > at) runs.push(make(str.slice(at, stop), from, Math.max(0, to - from), looks[k]));
      at = stop;
      k = end;
    }
  }

  // Where links lead.
  const links: PageLink[] = [];
  for (const a of (await page.getAnnotations().catch(() => [])) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]) {
    const url = a.url ?? a.unsafeUrl;
    if (a.subtype !== "Link" || !url || !a.rect || a.rect.length !== 4 || !/^(https?:|mailto:|tel:)/i.test(url)) continue;
    links.push({ box: boxThrough(base, a.rect[0], a.rect[1], a.rect[2], a.rect[3]), url });
  }
  for (const run of runs) {
    const cx = run.x + run.w / 2;
    const cy = run.y - run.size * 0.3;
    const link = links.find((l) => cx >= l.box.x - 1 && cx <= l.box.x + l.box.w + 1 && cy >= l.box.y - 1 && cy <= l.box.y + l.box.h + 1);
    if (link) run.link = link.url;
  }

  // Lines and boxes. A thin box is a line too (that is how many are drawn).
  const rules: Rule[] = [];
  const fills: PageData["fills"] = [];
  let drawings = 0;
  const area = viewport.width * viewport.height;
  for (const path of drawn.paths) {
    const { x, y, w, h } = path.box;
    if (!path.straight) {
      drawings += 1;
      continue;
    }
    const thin = Math.max(2, path.pen);
    if (h <= thin && w >= 6) rules.push({ x0: x, y0: y + h / 2, x1: x + w, y1: y + h / 2 });
    else if (w <= thin && h >= 6) rules.push({ x0: x + w / 2, y0: y, x1: x + w / 2, y1: y + h });
    else if (path.points <= 6 && w > thin && h > thin) {
      if (path.stroked) {
        rules.push({ x0: x, y0: y, x1: x + w, y1: y }, { x0: x, y0: y + h, x1: x + w, y1: y + h }, { x0: x, y0: y, x1: x, y1: y + h }, { x0: x + w, y0: y, x1: x + w, y1: y + h });
      }
      // (A box over most of the page is the paper's colour, not a box.)
      if (path.filled && path.fill && path.fill !== "#ffffff" && w * h < area * 0.6) fills.push({ box: path.box, color: path.fill });
    } else if (w > 3 && h > 3) drawings += 1;
  }

  const pictures = drawn.images
    .filter((image) => !image.mask && image.box.w >= 8 && image.box.h >= 8)
    .map((image) => ({ id: image.id, box: image.box, mc: image.mc, order: image.order }));

  const seen = runs.reduce((sum, run) => sum + (run.hidden ? 0 : inked(run.text)), 0);
  const cover = pictures.reduce((most, p) => Math.max(most, (p.box.w * p.box.h) / area), 0);
  const tree = ((await page.getStructTree().catch(() => null)) as TreeNode | null) ?? null;
  const data: PageData = {
    n,
    w: viewport.width,
    h: viewport.height,
    runs,
    marks,
    pictures,
    rules,
    fills,
    links,
    tree,
    kind: seen < 20 && cover >= 0.6 ? "scan" : runs.length || pictures.length ? "text" : "empty",
    turned,
    drawings,
  };
  if (keep) await keep(page, data);
  page.cleanup();
  return data;
}
