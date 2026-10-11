/**
 * Catalog families come split by script ("subsets"): Latin in one file,
 * Cyrillic in another, and so on. A document needs the Latin file always
 * and the others only for the characters it actually has — this says which.
 * The ranges are the ones the catalog itself slices by.
 */

type Range = [from: number, to: number];

const R = (spec: string): Range[] =>
  spec.split(",").map((part) => {
    const [a, b] = part.split("-");
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });

/** In the order they're tried: the narrowest claim on a character wins. */
const SUBSETS: [name: string, ranges: Range[]][] = [
  ["latin", R("0-FF,131,152-153,2BB-2BC,2C6,2DA,2DC,2000-206F,20AC,2122,2191,2193,2212,2215,FEFF,FFFD")],
  ["vietnamese", R("102-103,110-111,128-129,168-169,1A0-1A1,1AF-1B0,300-301,303-304,308-309,323,329,1EA0-1EF9,20AB")],
  ["latin-ext", R("100-2BA,2BD-2C5,2C7-2CC,2CE-2D7,2DD-2FF,304,308,329,1D00-1DBF,1E00-1E9F,1EF2-1EFF,2020,20A0-20AB,20AD-20C0,2113,2C60-2C7F,A720-A7FF")],
  ["greek", R("370-377,37A-37F,384-38A,38C,38E-3A1,3A3-3FF")],
  ["greek-ext", R("1F00-1FFF")],
  ["cyrillic", R("301,400-45F,490-491,4B0-4B1,2116")],
  ["cyrillic-ext", R("460-52F,1C80-1C8A,20B4,2DE0-2DFF,A640-A69F,FE2E-FE2F")],
  ["hebrew", R("590-5FF,20AA,25CC,FB1D-FB4F")],
  ["arabic", R("600-6FF,750-77F,870-88E,890-891,897-8E1,8E3-8FF,204F,2E41,FB50-FDFF,FE70-FE74,FE76-FEFC")],
  ["devanagari", R("900-97F,1CD0-1CF9,20A8,20B9,20F0,A830-A839,A8E0-A8FF")],
  ["thai", R("E01-E5B")],
  ["korean", R("1100-11FF,3130-318F,AC00-D7AF")],
  ["japanese", R("3000-30FF,31F0-31FF,3400-4DBF,4E00-9FFF,FF00-FFEF")],
  ["chinese-simplified", R("3000-303F,3400-4DBF,4E00-9FFF,FF00-FFEF")],
  ["chinese-traditional", R("3000-303F,3400-4DBF,4E00-9FFF,FF00-FFEF")],
  ["chinese-hongkong", R("3000-303F,3400-4DBF,4E00-9FFF,FF00-FFEF")],
  ["math", R("2200-22FF,27C0-27EF,2980-2AFF,1D400-1D7FF")],
  ["symbols", R("2190-21FF,2300-23FF,2460-24FF,25A0-27BF,1F000-1FAFF")],
];

const within = (code: number, ranges: Range[]) => ranges.some(([a, b]) => code >= a && code <= b);

/**
 * The subsets of a family (`available`, its first being the one always
 * loaded) that `text` needs beyond that first one. A character no subset
 * claims needs nothing here — another font will have to draw it.
 */
export function subsetsFor(text: string, available: string[]): string[] {
  const primary = available[0];
  const have = new Set(available);
  const need = new Set<string>();
  const primaryRanges = SUBSETS.find(([name]) => name === primary)?.[1] ?? [];
  const seen = new Set<number>();
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80 || seen.has(code)) continue;
    seen.add(code);
    if (within(code, primaryRanges)) continue;
    for (const [name, ranges] of SUBSETS) {
      if (name !== primary && have.has(name) && within(code, ranges)) {
        need.add(name);
        break;
      }
    }
  }
  // In the family's own order, so the result is stable.
  return available.filter((name) => need.has(name));
}

/** A subset's characters as a CSS `unicode-range` (null: not one we know). */
export function subsetUnicodeRange(name: string): string | null {
  const ranges = SUBSETS.find(([n]) => n === name)?.[1];
  if (!ranges) return null;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  return ranges.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(", ");
}

/** Whether anything in `text` lies outside plain Latin. */
export function beyondLatin(text: string): boolean {
  const latin = SUBSETS[0][1];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x80 && !within(code, latin)) return true;
  }
  return false;
}
