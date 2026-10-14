/**
 * A PDF's pictures.
 *
 * pdf.js holds a page's pictures only while the page is open, and as
 * pixels, not as the files they were. So each is made a file again as its
 * page is read (by whoever can: a canvas, handed in), kept once however
 * often it is drawn, and put in the text where it stood on the page.
 *
 * Left out: what is too small to be a picture of anything (a bullet, a
 * rule drawn as an image), a page's background, and what stands on most
 * pages in the same place (a letterhead's mark).
 */

import type { DocxMedia } from "../../../../docx/read";
import { MEDIA_PREFIX } from "../../../../docx/read";
import type { EncodeImage, EncodedPicture, ImageBlock, Limits, PageData, ParaBlock, PdfImageObject } from "./model";
import { textOf } from "./paras";
import type { PdfPage } from "./read";

/** A picture kept: the key its file is under, and its size in pixels. */
export interface Kept {
  key: string;
  w: number;
  h: number;
}

const OBJECT_WAIT_MS = 20_000;

/** A page's picture, which pdf.js may still be decoding. */
function objectOf(page: PdfPage, id: string): Promise<PdfImageObject | null> {
  const objs = page.objs as unknown as { get: (id: string, done?: (o: unknown) => void) => unknown };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), OBJECT_WAIT_MS);
    try {
      objs.get(id, (obj) => {
        clearTimeout(timer);
        resolve((obj as PdfImageObject | null) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** A number that two files share only if they are the same file (nearly). */
function mark(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let k = 0; k < bytes.length; k += step) {
    h ^= bytes[k];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bytes.length}:${h}`;
}

export class Pictures {
  media: DocxMedia[] = [];
  /** Pictures that could not be kept. */
  left = 0;
  private byMark = new Map<string, Kept>();
  private byPlace = new Map<string, Kept>();
  private held = 0;

  constructor(
    private encode: EncodeImage | undefined,
    private limits: Limits,
  ) {}

  /** Whether a picture on a page is one to keep at all. */
  static wanted(page: PageData, box: { w: number; h: number }, unit: number): boolean {
    if (box.w < 16 || box.h < 16) return false;
    // (As low as a line of text and not much wider: a mark in the text.)
    if (box.h < unit * 1.5 && box.w < unit * 4) return false;
    // (Behind the text, over the whole page.)
    if (page.kind === "text" && page.runs.length > 0 && box.w * box.h >= page.w * page.h * 0.85) return false;
    return true;
  }

  /** Make files of a page's pictures, while the page is open. */
  async take(page: PdfPage, data: PageData, unit: number): Promise<void> {
    const seen = new Set<string>();
    for (const picture of data.pictures) {
      if (seen.has(picture.id) || !Pictures.wanted(data, picture.box, unit)) continue;
      seen.add(picture.id);
      if (!this.encode || this.media.length >= this.limits.pictures || this.held >= this.limits.pictureBytes) {
        this.left += 1;
        continue;
      }
      const object = await objectOf(page, picture.id);
      const encode = this.encode;
      const made: EncodedPicture | null = object ? await encode(object, this.limits.picturePixels).catch(() => null) : null;
      if (!made || !made.bytes.length) {
        this.left += 1;
        continue;
      }
      const same = mark(made.bytes);
      let kept = this.byMark.get(same);
      if (!kept) {
        kept = { key: `pdf-${this.media.length + 1}`, w: made.w, h: made.h };
        this.byMark.set(same, kept);
        this.media.push({ key: `${MEDIA_PREFIX}${kept.key}`, name: `picture-${this.media.length + 1}.${made.type === "image/png" ? "png" : "jpg"}`, type: made.type, bytes: made.bytes });
        this.held += made.bytes.length;
      }
      this.byPlace.set(`${data.n}:${picture.id}`, kept);
    }
  }

  keptAt(page: number, id: string): Kept | null {
    return this.byPlace.get(`${page}:${id}`) ?? null;
  }

  /** A kept picture's file. */
  fileOf(kept: Kept): EncodedPicture | null {
    const found = this.media.find((m) => m.key === `${MEDIA_PREFIX}${kept.key}`);
    return found ? { bytes: found.bytes, type: found.type === "image/png" ? "image/png" : "image/jpeg", w: kept.w, h: kept.h } : null;
  }

  /** Forget pictures nothing shows any more. */
  keepOnly(keys: Set<string>): void {
    this.media = this.media.filter((m) => keys.has(m.key.slice(MEDIA_PREFIX.length)));
  }
}

const CAPTION = /^(?:figure|fig\.?|plate|image|photo(?:graph)?|illustration|chart|map|diagram)\s*\d*/i;

/** Whether the paragraph under a picture is what is said of the picture. */
export function isCaption(para: ParaBlock, image: ImageBlock, bodySize: number): boolean {
  if (para.heading || para.lines > 3 || para.page !== image.page) return false;
  const text = textOf(para).trim();
  if (!text || text.length > 500) return false;
  return CAPTION.test(text) || para.size <= bodySize - 1 || (para.align === "center" && para.spans.every((span) => span.italic || !span.text.trim()));
}
