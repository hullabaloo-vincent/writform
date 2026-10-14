// Small pictures for tests. There is no canvas in Node, so PNGs are written
// here byte by byte and the JPEGs were made once (with cjpeg) and are kept
// as text. Also: the parts a camera writes beside a photograph, to put into
// one of them.

import { deflateSync, inflateSync } from "node:zlib";

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

/** 16 by 8, in four blocks: red beside green, over blue beside white. */
export const QUAD_JPEG = b64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAIABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4d/4aG/6lD/yof/a6/oT/AIkM/wCqi/8ALT/76P6o/wCJ0v8AqQ/+XX/3ufuh/wAOXv8Aq5L/AMs7/wC7K/gv/iDP/Ud/5S/+6H+ZP/Ev3/Uy/wDKP/3U/9k=",
);
/** The same picture, the kind that sharpens as it loads (several passes). */
export const QUAD_PROGRESSIVE = b64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wgARCAAIABADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABwj/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/aAAwDAQACEAMQAAABDkJUugFmT//EABYQAQEBAAAAAAAAAAAAAAAAAAAWF//aAAgBAQABBQKhYu//xAAaEQACAgMAAAAAAAAAAAAAAAAAF2Sio+Lj/9oACAEDAQE/AXTAy8xfyabH/8QAHBEAAQMFAAAAAAAAAAAAAAAAABYXY2Wio+Lj/9oACAECAQE/AWGqOLqIye3Y/8QAGhAAAQUBAAAAAAAAAAAAAAAAADQ2o6Th4v/aAAgBAQAGPwJJJg5KfZ//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/ITE//9oADAMBAAIAAwAAABAD/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPxACf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QKL//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/EBK//9k=",
);
/** 8 by 8 in greys (one number a pixel). */
export const GRAY_JPEG = b64(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APmP/gnx+zb/AMe/+gf3/wCH/r5r/9k=",
);

const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// ----------------------------------------------------------------- PNG

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const chunk = (type: string, data: Uint8Array) => join(u32(data.length), latin(type), data, u32(crc(join(latin(type), data))));

export interface PngOptions {
  /** Four numbers a pixel, the last how opaque. */
  alpha?: boolean;
  /** Say it is stored in passes, or sixteen bits deep (the header only:
   *  such a file is for reading its header, not for drawing). */
  interlaced?: boolean;
  deep?: boolean;
  /** Parts put in before the picture's own (a colour profile, say). */
  chunks?: [string, Uint8Array][];
}

/** A PNG of `w` by `h`, each pixel from `pixel(x, y)`. */
export function png(w: number, h: number, pixel: (x: number, y: number) => number[], opts: PngOptions = {}): Uint8Array {
  const parts = opts.alpha ? 4 : 3;
  const rows = new Uint8Array(h * (1 + w * parts));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = pixel(x, y);
      for (let k = 0; k < parts; k += 1) rows[y * (1 + w * parts) + 1 + x * parts + k] = p[k] ?? 255;
    }
  }
  const head = join(u32(w), u32(h), Uint8Array.of(opts.deep ? 16 : 8, opts.alpha ? 6 : 2, 0, 0, opts.interlaced ? 1 : 0));
  return join(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", head),
    ...(opts.chunks ?? []).map(([type, data]) => chunk(type, data)),
    chunk("IDAT", new Uint8Array(deflateSync(rows))),
    chunk("IEND", new Uint8Array(0)),
  );
}

/** A PNG's colour profile part: its name, then the profile packed. */
export const pngProfile = (name: string): [string, Uint8Array] => ["iCCP", join(latin(`${name}\u0000`), Uint8Array.of(0), new Uint8Array(deflateSync(fakeProfile())))];

/** Rows a PNG (or a PDF that packs like one) has filtered, as they were. */
export function unfilter(packed: Uint8Array, w: number, parts: number): Uint8Array {
  const data = new Uint8Array(inflateSync(packed));
  const stride = w * parts;
  const rows = data.length / (stride + 1);
  const out = new Uint8Array(rows * stride);
  for (let y = 0; y < rows; y += 1) {
    const type = data[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const v = data[y * (stride + 1) + 1 + i];
      const left = i >= parts ? out[y * stride + i - parts] : 0;
      const up = y ? out[(y - 1) * stride + i] : 0;
      out[y * stride + i] = (type === 1 ? v + left : type === 2 ? v + up : v) & 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- JPEG

/** A JPEG with another part put in, straight after its opening. */
export function withPart(jpeg: Uint8Array, marker: number, data: Uint8Array): Uint8Array {
  const length = data.length + 2;
  return join(jpeg.subarray(0, 2), Uint8Array.of(0xff, marker, length >> 8, length & 255), data, jpeg.subarray(2));
}

/** What a camera writes: how the picture is turned, in either byte order,
 *  and words nobody meant to pass on. */
export function withExif(jpeg: Uint8Array, orientation: number, little = true): Uint8Array {
  const n16 = (n: number) => (little ? Uint8Array.of(n & 255, n >> 8) : Uint8Array.of(n >> 8, n & 255));
  const n32 = (n: number) => (little ? Uint8Array.of(n & 255, (n >> 8) & 255, 0, 0) : Uint8Array.of(0, 0, (n >> 8) & 255, n & 255));
  const tiff = join(
    latin(little ? "II" : "MM"),
    n16(42),
    n32(8),
    // Two entries: how wide (to be skipped over), then how it is turned.
    n16(2),
    n16(0x0100),
    n16(4),
    n32(1),
    n32(16),
    n16(0x0112),
    n16(3),
    n32(1),
    n16(orientation),
    n16(0),
    n32(0),
    latin("Taken at 51.5074 N, 0.1278 W"),
  );
  return withPart(jpeg, 0xe1, join(latin("Exif\u0000\u0000"), tiff));
}

/** Something shaped like a colour profile: its length, its kind, and its
 *  mark, with nothing a reader could use. */
export function fakeProfile(kind = "RGB ", size = 200, version = 2, device = "mntr"): Uint8Array {
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out[8] = version;
  out.set(latin(device), 12);
  out.set(latin(kind), 16);
  out.set(latin("acsp"), 36);
  for (let i = 128; i < size; i += 1) out[i] = i & 255;
  return out;
}

/** A JPEG with its colour profile, in as many pieces as asked. */
export function withProfile(jpeg: Uint8Array, profile: Uint8Array, pieces = 1, order: number[] = []): Uint8Array {
  const size = Math.ceil(profile.length / pieces);
  const parts = Array.from({ length: pieces }, (_, i) => join(latin("ICC_PROFILE\u0000"), Uint8Array.of(i + 1, pieces), profile.subarray(i * size, (i + 1) * size)));
  let out = jpeg;
  // (Put in last to first, each lands in front of the one before.)
  for (const i of order.length ? order : parts.map((_, k) => parts.length - 1 - k)) out = withPart(out, 0xe2, parts[i]);
  return out;
}

export { join, latin };
