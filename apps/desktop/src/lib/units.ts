/**
 * Inches or centimetres, as the people of a place measure a page. The
 * United States, Liberia and Myanmar go by inches. Everyone else by
 * centimetres.
 */

export type Unit = "in" | "cm";

const INCH_REGIONS: ReadonlySet<string> = new Set(["US", "LR", "MM", "PR"]);

/** The region a language tag speaks of ("en-GB" says GB, and "fr", which
 *  names none, most likely means FR). Null when it cannot be told. */
export function regionOf(tag: string): string | null {
  try {
    const region = new Intl.Locale(tag).maximize().region;
    if (region) return region.toUpperCase();
  } catch {
    // An odd tag, or a webview without Intl.Locale: read the tag itself.
  }
  const said = /^[A-Za-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(tag);
  return said ? said[1].toUpperCase() : null;
}


/** The unit of someone whose languages are these: the first that names a
 *  place decides (inches when none does). */
export function unitForLocales(tags: readonly string[]): Unit {
  for (const tag of tags) {
    const region = tag ? regionOf(tag) : null;
    if (region) return INCH_REGIONS.has(region) ? "in" : "cm";
  }
  return "in";
}

/** This device's unit. */
export function regionUnit(): Unit {
  if (typeof navigator === "undefined") return "in";
  return unitForLocales(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** Points in one of a unit. */
export const PT_PER: Record<Unit, number> = { in: 72, cm: 72 / 2.54 };

export const toUnit = (pt: number, unit: Unit): number => Math.round((pt / PT_PER[unit]) * 100) / 100;
export const fromUnit = (v: number, unit: Unit): number => Math.round(v * PT_PER[unit] * 10) / 10;

/** "1.5 in", "3.81 cm". */
export const lengthLabel = (pt: number, unit: Unit): string => `${toUnit(pt, unit).toLocaleString("en-US")} ${unit}`;
