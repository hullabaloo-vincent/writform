/**
 * Hyphenation by language (Liang patterns from the `hyphen` package, loaded
 * lazily — German alone is ¾ MB). Book rules on top: only words of six
 * letters or more, at least two letters before a break and three after,
 * never words in capitals (acronyms), words with digits, or URLs.
 * Capitalized words (names, sentence starts) may break — the composer
 * makes those breaks dearer, as InDesign and TeX do by default.
 */

type Module = { hyphenateSync: (text: string, opts?: { hyphenChar?: string }) => string };

const LOADERS: Record<string, () => Promise<unknown>> = {
  "en-us": () => import("hyphen/en-us"),
  "en-gb": () => import("hyphen/en-gb"),
  fr: () => import("hyphen/fr"),
  de: () => import("hyphen/de-1996"),
  es: () => import("hyphen/es"),
  it: () => import("hyphen/it"),
  nl: () => import("hyphen/nl"),
  pt: () => import("hyphen/pt"),
};

function loaderFor(lang: string): (() => Promise<unknown>) | null {
  const l = lang.toLowerCase();
  if (LOADERS[l]) return LOADERS[l];
  const base = l.split(/[-_]/)[0];
  if (base === "en") return l.includes("gb") || l.includes("uk") ? LOADERS["en-gb"] : LOADERS["en-us"];
  return LOADERS[base] ?? null;
}

/** Split a word into syllables at allowed break points ([word] = none). */
export type Hyphenator = (word: string) => string[];

const SOFT = "\u00ad";

export async function loadHyphenator(lang: string): Promise<Hyphenator | null> {
  const load = loaderFor(lang);
  if (!load) return null;
  let mod: Module;
  try {
    const raw = (await load()) as { default?: Module } & Partial<Module>;
    mod = (raw.hyphenateSync ? raw : raw.default) as Module;
    if (!mod?.hyphenateSync) return null;
  } catch {
    return null;
  }
  const cache = new Map<string, string[]>();
  return (word: string) => {
    const hit = cache.get(word);
    if (hit) return hit;
    let parts: string[] = [word];
    const letters = word.replace(/[^\p{L}]/gu, "");
    if (
      letters.length >= 6 &&
      !/\d/.test(word) &&
      !/[/@:.]/.test(word.replace(/[.,;:!?…]+$/, "")) &&
      !/^\p{Lu}+$/u.test(letters)
    ) {
      // Patterns know straight apostrophes only; same length, so offsets hold.
      const lookup = word.replace(/’/g, "'");
      const marked = mod.hyphenateSync(lookup, { hyphenChar: SOFT });
      const raw = marked.split(SOFT);
      if (raw.length > 1) {
        // Re-slice the ORIGINAL word at the same offsets.
        const pieces: string[] = [];
        let at = 0;
        for (const r of raw) {
          pieces.push(word.slice(at, at + r.length));
          at += r.length;
        }
        // At least 2 letters before a break and 3 after.
        while (pieces.length > 1 && pieces[0].replace(/[^\p{L}]/gu, "").length < 2) {
          pieces.splice(0, 2, pieces[0] + pieces[1]);
        }
        while (pieces.length > 1 && pieces[pieces.length - 1].replace(/[^\p{L}]/gu, "").length < 3) {
          const n = pieces.length;
          pieces.splice(n - 2, 2, pieces[n - 2] + pieces[n - 1]);
        }
        parts = pieces;
      }
    }
    cache.set(word, parts);
    return parts;
  };
}
