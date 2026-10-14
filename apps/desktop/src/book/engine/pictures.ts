/**
 * Pictures on their way into a PDF.
 *
 * What a picture file is can be told from its first bytes: its size, how a
 * photograph is turned, whether it is see-through anywhere, what colours it
 * is in. From that and the size it is printed at comes what to do with it:
 *
 * - A JPEG that is good enough goes in as it is. It is never encoded a
 *   second time (each time costs sharpness), only tidied: what a camera
 *   wrote beside the picture (where and when it was taken, a small copy of
 *   it, a second picture after the first) is left out.
 * - A drawing or a screenshot saved as a PNG goes in as it is too.
 * - A picture with more pixels than its printed size can show is made
 *   smaller: to 150 pixels an inch for a screen, 300 for paper.
 * - A photograph saved as a PNG becomes a JPEG where that is smaller.
 * - A see-through picture keeps what shows through it.
 * - For a press that prints in black alone, every picture is made greys.
 *
 * Nothing here needs a canvas. The drawing is handed in (`PictureTools`),
 * so the typesetting thread can read this file and the decisions can be
 * tested where there is no canvas at all.
 */

import type { PictureQuality } from "../render/options";

export type PictureType = "jpeg" | "png" | "gif";

export interface PictureInfo {
  type: PictureType;
  /** Pixels as shown. A photograph taken with the camera on its side is
   *  stored unturned and says how to turn it: this is after the turning. */
  w: number;
  h: number;
  /** How the stored pixels are turned to be shown (EXIF's 1 to 8. 1: as
   *  they are). */
  orientation: number;
  /** Where in the file that is said. */
  orientAt?: { at: number; little: boolean };
  /** See-through in places, or may be. */
  alpha: boolean;
  /** The PDF's writer can take the file as it is. */
  plain: boolean;
  /** A JPEG in greys. */
  gray?: boolean;
}

/** A picture ready to be written into the file. */
export interface RawPicture {
  /** "jpeg": a JPEG's own bytes. "rgb": three bytes a pixel, row by row.
   *  "gray": one byte a pixel. */
  kind: "jpeg" | "rgb" | "gray";
  bytes: Uint8Array;
  /** Pixels, as stored. */
  w: number;
  h: number;
  /** A JPEG in greys (one number a pixel). */
  gray?: boolean;
  /** The colours its numbers are in, where the file said (an ICC profile). */
  icc?: Uint8Array;
  /** How it is turned to be shown (EXIF). */
  orientation?: number;
  /** How opaque each pixel is, a byte each. */
  alpha?: Uint8Array;
  /** The file it was made from, to use where this comes out no smaller. */
  file?: Uint8Array;
}

/** A picture for the writer: made ready, or a file it reads itself (a PNG
 *  with nothing see-through in it). */
export type PdfPicture = Uint8Array | RawPicture;

/** A picture and the largest it is printed, in points. */
export interface PictureWant {
  url: string;
  w: number;
  h: number;
}

/** Pixels an inch aimed at, the density past which a picture is made
 *  smaller (a little over is not worth a second encoding), and how hard a
 *  photograph is pressed. */
const QUALITY: Record<Exclude<PictureQuality, "original">, { ppi: number; over: number; jpeg: number }> = {
  screen: { ppi: 150, over: 225, jpeg: 0.75 },
  print: { ppi: 300, over: 450, jpeg: 0.9 },
};
/** A picture that has to be encoded again though nothing was asked of it. */
const ORIGINAL_JPEG = 0.95;
/** The most pixels drawn on a canvas (a phone's is small). */
export const CANVAS_PIXELS = 16_000_000;
export const PHONE_PIXELS = 5_000_000;
/** The most pixels kept exactly, each as it is (a page of them at 300 an
 *  inch). Past this a drawing is pressed like a photograph. */
export const RAW_PIXELS = 9_000_000;
/** A drawing or a screenshot: this share of its pixels are the same as the
 *  one to their left. A photograph has next to none. */
const FLAT_SHARE = 0.5;

// ------------------------------------------------------------- reading

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b: Uint8Array, from: number, to: number) => {
  let out = "";
  for (let i = from; i < to && i < b.length; i += 1) out += String.fromCharCode(b[i]);
  return out;
};

/** What a picture file is, from its own bytes (never from its name). Null
 *  for anything but a PNG, a JPEG or a GIF, and for one cut short. */
export function sniff(bytes: Uint8Array): PictureInfo | null {
  const b = bytes;
  if (b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return sniffPng(b);
  if (b[0] === 0xff && b[1] === 0xd8) return sniffJpeg(b);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const w = b[6] | (b[7] << 8);
    const h = b[8] | (b[9] << 8);
    // (Whether anything shows through is known once it is drawn.)
    return w && h ? { type: "gif", w, h, orientation: 1, alpha: true, plain: false } : null;
  }
  return null;
}

function sniffPng(b: Uint8Array): PictureInfo | null {
  if (b.length < 33 || be32(b, 8) !== 13 || ascii(b, 12, 16) !== "IHDR") return null;
  const w = be32(b, 16);
  const h = be32(b, 20);
  if (!w || !h) return null;
  const bits = b[24];
  const colour = b[25];
  const interlaced = b[28] !== 0;
  let alpha = colour === 4 || colour === 6;
  // Colours that are not the usual ones (a Mac's screenshot is in its
  // screen's): the writer would take the numbers for the usual, and every
  // colour would come out a little off. Drawn first, they are converted.
  let otherColours = false;
  for (let at = 33; at + 12 <= b.length; ) {
    const length = be32(b, at);
    const type = ascii(b, at + 4, at + 8);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "tRNS") alpha = true;
    else if (type === "iCCP") {
      let end = at + 8;
      while (end < at + 8 + Math.min(length, 80) && b[end] !== 0) end += 1;
      if (!/srgb/i.test(ascii(b, at + 8, end))) otherColours = true;
    }
    at += 12 + length;
  }
  return {
    type: "png",
    w,
    h,
    orientation: 1,
    alpha,
    plain: !alpha && !otherColours && !interlaced && bits <= 8 && (colour === 0 || colour === 2 || colour === 3),
  };
}

interface Segment {
  marker: number;
  /** Where its marker is, where what it holds begins, and where it ends. */
  at: number;
  from: number;
  to: number;
}

/** A JPEG's parts in order, up to and with the one its picture data
 *  follows. */
function* segments(b: Uint8Array): Generator<Segment> {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Markers that hold nothing.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) return;
    const length = be16(b, i + 2);
    if (length < 2 || i + 2 + length > b.length) return;
    yield { marker, at: i, from: i + 4, to: i + 2 + length };
    if (marker === 0xda) return;
    i += 2 + length;
  }
}

/** A frame header: every SOF but the three that are something else. */
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const EXIF = "Exif\u0000\u0000";
const ICC = "ICC_PROFILE\u0000";

function sniffJpeg(b: Uint8Array): PictureInfo | null {
  let frame: { kind: number; bits: number; w: number; h: number; parts: number } | null = null;
  let orientation = 1;
  let orientAt: PictureInfo["orientAt"];
  let exifSeen = false;
  for (const s of segments(b)) {
    if (isFrame(s.marker)) {
      if (!frame && s.to - s.from >= 6) frame = { kind: s.marker & 0x0f, bits: b[s.from], h: be16(b, s.from + 1), w: be16(b, s.from + 3), parts: b[s.from + 5] };
    } else if (s.marker === 0xe1 && !exifSeen && ascii(b, s.from, s.from + 6) === EXIF) {
      // (The first such part is the one that counts, as for the writer.)
      exifSeen = true;
      const tiff = s.from + 6;
      if (tiff + 8 > s.to) continue;
      const order = ascii(b, tiff, tiff + 2);
      const little = order === "II";
      if (!little && order !== "MM") continue;
      const r16 = (i: number) => (little ? b[i] | (b[i + 1] << 8) : be16(b, i));
      const r32 = (i: number) => (little ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : be32(b, i));
      if (r16(tiff + 2) !== 42) continue;
      const ifd = tiff + r32(tiff + 4);
      if (ifd + 2 > b.length) continue;
      const count = r16(ifd);
      for (let n = 0; n < count; n += 1) {
        const entry = ifd + 2 + n * 12;
        if (entry + 12 > b.length) break;
        if (r16(entry) !== 0x0112) continue;
        const value = r16(entry + 8);
        if (value >= 1 && value <= 8) {
          orientation = value;
          orientAt = { at: entry + 8, little };
        }
        break;
      }
    }
  }
  if (!frame || !frame.w || !frame.h) return null;
  const turned = orientation > 4;
  return {
    type: "jpeg",
    w: turned ? frame.h : frame.w,
    h: turned ? frame.w : frame.h,
    orientation,
    ...(orientAt ? { orientAt } : {}),
    alpha: false,
    // What a PDF reads as a JPEG: the ordinary kinds, eight bits, in greys
    // or in three colours. (Four inks are read by some as their opposite.)
    plain: frame.kind <= 2 && frame.bits === 8 && (frame.parts === 1 || frame.parts === 3),
    ...(frame.parts === 1 ? { gray: true } : {}),
  };
}

/** A picture's pixels as stored (before any turning). */
export function storedSize(info: PictureInfo): { w: number; h: number } {
  return info.orientation > 4 ? { w: info.h, h: info.w } : { w: info.w, h: info.h };
}

/** The colours a JPEG says its numbers are in (its ICC profile), where it
 *  says so whole and they are of its kind. */
export function jpegProfile(bytes: Uint8Array, parts: 1 | 3): Uint8Array | null {
  const pieces: { n: number; from: number; to: number }[] = [];
  let count = 0;
  for (const s of segments(bytes)) {
    if (s.marker !== 0xe2 || s.to - s.from < 14 || ascii(bytes, s.from, s.from + 12) !== ICC) continue;
    count = bytes[s.from + 13];
    pieces.push({ n: bytes[s.from + 12], from: s.from + 14, to: s.to });
  }
  if (!pieces.length || pieces.length !== count) return null;
  pieces.sort((a, b) => a.n - b.n);
  if (pieces.some((p, i) => p.n !== i + 1)) return null;
  const total = pieces.reduce((n, p) => n + (p.to - p.from), 0);
  if (total < 128 || total > 4_000_000) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(bytes.subarray(p.from, p.to), at);
    at += p.to - p.from;
  }
  if (be32(out, 0) !== total || ascii(out, 36, 40) !== "acsp") return null;
  // One a PDF may carry: no newer than version 4, and of a device (not a
  // link between two, nor a list of named colours).
  if (out[8] > 4 || !["mntr", "scnr", "prtr", "spac"].includes(ascii(out, 12, 16))) return null;
  return ascii(out, 16, 20) === (parts === 1 ? "GRAY" : "RGB ") ? out : null;
}

/**
 * A JPEG with only its picture in it. Its picture data is not touched (so
 * nothing is lost), but what was written beside it goes: the camera's notes
 * (where it was, when, with what), the small copy of itself, its colour
 * profile (which the PDF holds in its own way) and whatever follows the
 * picture's end (a phone puts a second picture there).
 */
export function cleanJpeg(bytes: Uint8Array): Uint8Array {
  const keep: [number, number][] = [[0, 2]];
  let scan = -1;
  for (const s of segments(bytes)) {
    if (s.marker === 0xda) {
      scan = s.at;
      break;
    }
    const app = s.marker >= 0xe0 && s.marker <= 0xef;
    const wanted =
      // How its colours are stored, which a reader needs.
      (s.marker === 0xe0 && ascii(bytes, s.from, s.from + 5) === "JFIF\u0000") || (s.marker === 0xee && ascii(bytes, s.from, s.from + 5) === "Adobe") || (!app && s.marker !== 0xfe);
    if (wanted) keep.push([s.at, s.to]);
  }
  if (scan < 0) return bytes;
  // The picture data: to its end, and no further.
  let end = bytes.length;
  let i = scan + 2 + be16(bytes, scan + 2);
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) i += 2;
    else if (marker === 0xff) i += 1;
    else if (marker === 0xd9) {
      end = i + 2;
      break;
    } else {
      // Another part between two passes of a picture that sharpens as it loads.
      if (i + 4 > bytes.length) break;
      i += 2 + be16(bytes, i + 2);
    }
  }
  keep.push([scan, end]);
  const total = keep.reduce((n, [from, to]) => n + (to - from), 0);
  if (total === bytes.length) return bytes;
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of keep) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

/** A copy of a turned JPEG that says it is upright, so that whatever draws
 *  it draws its pixels as they are stored (and the turning is done once, by
 *  us, the same everywhere). */
export function sayUpright(bytes: Uint8Array, info: PictureInfo): Uint8Array {
  if (!info.orientAt || info.orientation === 1) return bytes;
  const out = bytes.slice();
  const { at, little } = info.orientAt;
  out[at] = little ? 1 : 0;
  out[at + 1] = little ? 0 : 1;
  return out;
}

/**
 * The turning EXIF asks for, as a canvas transform `[a, b, c, d, e, f]`:
 * the stored pixels drawn from the corner, `w` by `h` being the picture as
 * shown, land turned the right way.
 */
export function orientationMatrix(orientation: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, w, 0];
    case 3:
      return [-1, 0, 0, -1, w, h];
    case 4:
      return [1, 0, 0, -1, 0, h];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, w, 0];
    case 7:
      return [0, -1, -1, 0, w, h];
    case 8:
      return [0, -1, 1, 0, 0, h];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

// ------------------------------------------------------------ deciding

export type PicturePlan =
  /** The file goes in as it is. */
  | { act: "keep" }
  | {
      act: "draw";
      /** The pixels to draw it at, as shown. */
      w: number;
      h: number;
      /** How hard a photograph is pressed (a JPEG's quality, 0 to 1). */
      jpeg: number;
      /** The file may still be what goes in, where this is no smaller. */
      fallback: boolean;
      /** It is not being made smaller: worth doing only for a photograph
       *  (a drawing stays the file it is). */
      photoOnly: boolean;
    };

/** What to do with a picture, given the largest it is printed (points). */
export function planPicture(
  info: PictureInfo,
  placed: { w: number; h: number },
  quality: PictureQuality,
  opts: { maxPixels?: number; gray?: boolean } = {},
): PicturePlan {
  const spec = quality === "original" ? null : QUALITY[quality];
  // Greys only: a JPEG that is greys already is the one file that can go in
  // as it is. Everything else is drawn (and kept pixel for pixel, so never
  // more of them than that allows).
  if (opts.gray && info.plain && info.type === "jpeg" && info.gray) return { act: "keep" };
  if (info.plain && !spec && !opts.gray) return { act: "keep" };
  const maxPixels = opts.gray ? Math.min(opts.maxPixels ?? CANVAS_PIXELS, RAW_PIXELS) : (opts.maxPixels ?? CANVAS_PIXELS);
  const ppi = Math.max(placed.w > 0 ? (info.w * 72) / placed.w : 0, placed.h > 0 ? (info.h * 72) / placed.h : 0);
  let scale = spec && ppi > spec.over ? spec.ppi / ppi : 1;
  const smaller = scale < 1;
  // Never more than a canvas holds.
  const pixels = info.w * info.h * scale * scale;
  const capped = pixels > maxPixels;
  if (capped) scale *= Math.sqrt(maxPixels / pixels);
  const whole = capped ? Math.floor : Math.round;
  const w = Math.max(1, whole(info.w * scale));
  const h = Math.max(1, whole(info.h * scale));
  const jpeg = spec ? spec.jpeg : ORIGINAL_JPEG;
  if (!info.plain || opts.gray) return { act: "draw", w, h, jpeg, fallback: false, photoOnly: false };
  if (smaller) return { act: "draw", w, h, jpeg, fallback: true, photoOnly: false };
  // Good as it is. A JPEG is left alone. A PNG is looked at: a photograph
  // saved as one is many times the size it need be.
  if (info.type === "jpeg") return { act: "keep" };
  return { act: "draw", w, h, jpeg, fallback: true, photoOnly: true };
}

/** Whether pixels (four bytes each: red, green, blue, how opaque) look
 *  like a drawing or a screenshot: enough of them are the very colour of
 *  the one to their left. */
export function looksDrawn(rgba: ArrayLike<number>, w: number, h: number): boolean {
  let same = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 1, i = (y * w + 1) * 4; x < w; x += 1, i += 4) {
      if (rgba[i] === rgba[i - 4] && rgba[i + 1] === rgba[i - 3] && rgba[i + 2] === rgba[i - 2] && rgba[i + 3] === rgba[i - 1]) same += 1;
    }
  }
  const pairs = w * h - h;
  return pairs > 0 ? same / pairs >= FLAT_SHARE : true;
}

/** A picture's pixels (four bytes each: red, green, blue, how opaque) as
 *  its colours, how opaque each is where any is not wholly, and whether it
 *  looks like a drawing. */
export function planes(rgba: ArrayLike<number>, w: number, h: number): { rgb: Uint8Array; alpha: Uint8Array | null; flat: boolean } {
  const n = w * h;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  let opaque = true;
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    rgb[p * 3] = rgba[i];
    rgb[p * 3 + 1] = rgba[i + 1];
    rgb[p * 3 + 2] = rgba[i + 2];
    const a = rgba[i + 3];
    alpha[p] = a;
    if (a !== 255) opaque = false;
  }
  return { rgb, alpha: opaque ? null : alpha, flat: looksDrawn(rgba, w, h) };
}

/** A picture's pixels as greys, one byte each: how light each is to the
 *  eye (green counts most, blue least). */
export function grays(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < out.length; p += 1, i += 4) out[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  return out;
}

/**
 * Rows of pixels made ready to be packed, the way a PNG does it: each row
 * is written as it differs from the pixel to its left or the row above,
 * whichever leaves the smallest numbers, with a byte in front saying which.
 * (Packed that way a screenshot is a fraction of the size.)
 */
export function filterRows(data: Uint8Array, w: number, parts: number): Uint8Array {
  const stride = w * parts;
  const rows = stride ? Math.floor(data.length / stride) : 0;
  const out = new Uint8Array(rows * (stride + 1));
  for (let y = 0; y < rows; y += 1) {
    const row = y * stride;
    const above = row - stride;
    let none = 0;
    let left = 0;
    let up = 0;
    for (let i = 0; i < stride; i += 1) {
      const v = data[row + i];
      const l = (v - (i >= parts ? data[row + i - parts] : 0)) & 255;
      const u = (v - (y ? data[above + i] : 0)) & 255;
      none += v < 128 ? v : 256 - v;
      left += l < 128 ? l : 256 - l;
      up += u < 128 ? u : 256 - u;
    }
    const type = left <= none && left <= up ? 1 : up < none ? 2 : 0;
    let o = y * (stride + 1);
    out[o] = type;
    o += 1;
    if (type === 0) out.set(data.subarray(row, row + stride), o);
    else if (type === 1) for (let i = 0; i < stride; i += 1) out[o + i] = (data[row + i] - (i >= parts ? data[row + i - parts] : 0)) & 255;
    else for (let i = 0; i < stride; i += 1) out[o + i] = (data[row + i] - data[above + i]) & 255;
  }
  return out;
}

// -------------------------------------------------------------- making

/** A picture drawn at some size. */
export interface Surface {
  /** Its pixels: red, green, blue and how opaque, each as it is. */
  pixels(): Uint8ClampedArray;
  /** It as a JPEG. Given pixels, those are what is encoded (all of them
   *  taken as opaque). */
  jpeg(quality: number, opaque?: Uint8ClampedArray): Promise<Uint8Array>;
  free(): void;
}

export interface PictureTools {
  /** Read a picture file and draw it `w` by `h` pixels, its stored pixels
   *  turned as `orientation` says, on white where asked (else on nothing). */
  draw(bytes: Uint8Array, type: PictureType, w: number, h: number, orientation: number, white: boolean): Promise<Surface>;
}

/** The file itself, as the writer takes it. (`profile: false`: without the
 *  colours it says its numbers are in, for a press that wants none.) */
export function keptPicture(bytes: Uint8Array, info: PictureInfo, profile = true): PdfPicture {
  if (info.type !== "jpeg") return bytes;
  const icc = profile ? jpegProfile(bytes, info.gray ? 1 : 3) : null;
  return {
    kind: "jpeg",
    bytes: cleanJpeg(bytes),
    ...storedSize(info),
    ...(info.gray ? { gray: true } : {}),
    ...(icc ? { icc } : {}),
    ...(info.orientation !== 1 ? { orientation: info.orientation } : {}),
  };
}

const weight = (p: PdfPicture) => (p instanceof Uint8Array ? p.length : p.bytes.length + (p.icc?.length ?? 0));

/**
 * A picture file made ready for a PDF, for the largest it is printed
 * (`placed`, points). `flatten`: on white, with nothing see-through left
 * (what a press wants). `gray`: in greys alone (a press printing in black).
 */
export async function makePicture(
  bytes: Uint8Array,
  info: PictureInfo,
  placed: { w: number; h: number },
  quality: PictureQuality,
  opts: { flatten?: boolean; maxPixels?: number; gray?: boolean },
  tools: PictureTools,
): Promise<PdfPicture> {
  const plan = planPicture(info, placed, quality, opts);
  if (plan.act === "keep") return keptPicture(bytes, info, !opts.gray);
  const { w, h } = plan;
  if (opts.gray) {
    const drawn = await tools.draw(sayUpright(bytes, info), info.type, w, h, info.orientation, true);
    try {
      return { kind: "gray", bytes: grays(drawn.pixels(), w, h), w, h };
    } finally {
      drawn.free();
    }
  }
  const photo = info.type === "jpeg";
  const surface = await tools.draw(sayUpright(bytes, info), info.type, w, h, info.orientation, photo || !!opts.flatten);
  try {
    if (photo) {
      const made: RawPicture = { kind: "jpeg", bytes: await surface.jpeg(plan.jpeg), w, h };
      if (!plan.fallback) return made;
      const file = keptPicture(bytes, info);
      return weight(made) < weight(file) ? made : file;
    }
    const rgba = surface.pixels();
    // (Looked at only to learn that: a drawing that is fine as it is goes
    // in as its file, and nothing more is made of its pixels.)
    if (plan.photoOnly && looksDrawn(rgba, w, h)) return bytes;
    const { rgb, alpha, flat } = planes(rgba, w, h);
    if (flat && w * h <= RAW_PIXELS) {
      return { kind: "rgb", bytes: rgb, w, h, ...(alpha ? { alpha } : {}), ...(plan.fallback ? { file: bytes } : {}) };
    }
    // A photograph (or a drawing too large to keep pixel for pixel). Its
    // colours are encoded as they are, not dimmed by what shows through.
    if (alpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const made: RawPicture = { kind: "jpeg", bytes: await surface.jpeg(plan.jpeg, alpha ? rgba : undefined), w, h, ...(alpha ? { alpha } : {}) };
    return plan.fallback && weight(made) >= bytes.length ? bytes : made;
  } finally {
    surface.free();
  }
}
