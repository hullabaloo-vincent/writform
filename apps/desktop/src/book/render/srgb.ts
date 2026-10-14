/**
 * The sRGB colour profile, made here.
 *
 * A PDF kept for the long term (PDF/A) has to say what its colour numbers
 * mean, by carrying a profile. The ones that go round are somebody's: this
 * is written from the published figures instead (sRGB's three colours, its
 * white and its curve, from IEC 61966-2-1), so there is nothing to license
 * and the file is the same on every device. About half a kilobyte.
 *
 * An ICC version 4 display profile: where each of red, green and blue sits
 * (carried from sRGB's own white to the one a profile speaks in, the usual
 * way, Bradford's), and one curve for all three. Checked against the
 * system's own sRGB profile with Little CMS: the two agree to a fiftieth of
 * the smallest difference an eye can see.
 */

type Matrix = number[][];

/** sRGB's red, green and blue as light (CIE XYZ), under its own white. */
const SRGB: Matrix = [
  [0.4123908, 0.3575843, 0.1804808],
  [0.212639, 0.7151687, 0.0721923],
  [0.0193308, 0.1191948, 0.9505322],
];
/** The white a profile speaks in (D50, as ICC writes it). */
const D50 = [0.9642, 1, 0.8249];
/** Bradford's cone responses. */
const CONES: Matrix = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

const mul = (a: Matrix, b: Matrix): Matrix => a.map((row) => b[0].map((_, j) => row.reduce((n, v, k) => n + v * b[k][j], 0)));
const apply = (m: Matrix, v: number[]): number[] => m.map((row) => row.reduce((n, x, k) => n + x * v[k], 0));
const inverse = (m: Matrix): Matrix => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
};

/** A number as a profile writes one: sixteen bits either side of the point. */
const fixed = (v: number) => Math.round(v * 65536) | 0;
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const sig = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

let made: Uint8Array | null = null;

/** The profile's bytes (the same every time). */
export function srgbProfile(): Uint8Array {
  if (made) return made;
  // From sRGB's white to D50.
  const from = apply(CONES, apply(SRGB, [1, 1, 1]));
  const to = apply(CONES, D50);
  const adapt = mul(inverse(CONES), mul(
    [0, 1, 2].map((k) => [0, 1, 2].map((j) => (j === k ? to[k] / from[k] : 0))),
    CONES,
  ));
  const colours = mul(adapt, SRGB);

  const xyz = (v: number[]) => [...sig("XYZ "), 0, 0, 0, 0, ...v.flatMap((n) => u32(fixed(n)))];
  const words = (s: string) => {
    const utf16 = Array.from(s, (c) => u16(c.charCodeAt(0))).flat();
    return [...sig("mluc"), 0, 0, 0, 0, ...u32(1), ...u32(12), ...sig("enUS"), ...u32(utf16.length), ...u32(28), ...utf16];
  };
  // The curve: ((x + 0.055) / 1.055) to the power 2.4 above 0.04045, and
  // x / 12.92 below.
  const curve = [...sig("para"), 0, 0, 0, 0, ...u16(3), 0, 0, ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].flatMap((n) => u32(fixed(n)))];
  const parts: [string, number[]][] = [
    ["desc", words("sRGB")],
    ["cprt", words("No copyright. Use freely.")],
    ["wtpt", xyz(D50)],
    ["chad", [...sig("sf32"), 0, 0, 0, 0, ...adapt.flat().flatMap((n) => u32(fixed(n)))]],
    ["rXYZ", xyz(colours.map((row) => row[0]))],
    ["gXYZ", xyz(colours.map((row) => row[1]))],
    ["bXYZ", xyz(colours.map((row) => row[2]))],
    ["rTRC", curve],
    ["gTRC", curve],
    ["bTRC", curve],
  ];

  const start = 128 + 4 + parts.length * 12;
  const table: number[] = [];
  const body: number[] = [];
  /** (The three curves are one, written once.) */
  const placed = new Map<number[], { at: number; size: number }>();
  for (const [name, data] of parts) {
    let where = placed.get(data);
    if (!where) {
      where = { at: start + body.length, size: data.length };
      placed.set(data, where);
      body.push(...data);
      while (body.length % 4) body.push(0);
    }
    table.push(...sig(name), ...u32(where.at), ...u32(where.size));
  }
  const head = new Array<number>(128).fill(0);
  const put = (at: number, bytes: number[]) => bytes.forEach((b, k) => (head[at + k] = b));
  put(0, u32(start + body.length));
  // Version 4.2, a display's profile, three colours, speaking in XYZ.
  put(8, [4, 0x20, 0, 0]);
  put(12, sig("mntr"));
  put(16, sig("RGB "));
  put(20, sig("XYZ "));
  // (A date has to be said. Any one would do: this keeps the bytes the same.)
  put(24, [...u16(2026), ...u16(1), ...u16(1), ...u16(0), ...u16(0), ...u16(0)]);
  put(36, sig("acsp"));
  put(68, D50.flatMap((n) => u32(fixed(n))));
  made = Uint8Array.from([...head, ...u32(parts.length), ...table, ...body]);
  return made;
}
