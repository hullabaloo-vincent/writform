/**
 * What a font prints in. The page layout can only draw with font files it
 * has, and for now those are the bundled ones — so a font the app doesn't
 * ship (Georgia, Times New Roman, anything named in a Word file) is set in
 * the bundled face nearest to it, and the export says so.
 *
 * This is the answer with no lookups: bundled files only. The font store
 * (./store.ts) does better where it can — the font itself when it's
 * installed and may be embedded, or a same-metrics family from the online
 * catalog — and falls back to exactly this.
 */

import { fontLabel } from "./css";
import { parseFontId } from "./ids";
import { knownFont, type FontCategory } from "./registry";
import { standInFor } from "./twins";

export interface PrintFace {
  /** The bundled family that draws it (a key of the bundled font files). */
  family: string;
  /** Not the font asked for, but a stand-in. */
  substituted: boolean;
  /** The stand-in has the same widths, so lines and pages fall the same. */
  metric: boolean;
  /** What was asked for, and what draws it. */
  asked: string;
  drawn: string;
  /** Why a stand-in: the font isn't on this device (and couldn't be
   *  downloaded), or its licence doesn't allow embedding it. */
  why?: "missing" | "licence";
}

/** What documents are set in when their settings name no font (Georgia). */
export const DEFAULT_BODY = "Georgia";

export const BUNDLED_NAMES: Record<string, string> = {
  literata: "Literata",
  libertinus: "Libertinus Serif",
  garamond: "EB Garamond",
  baskerville: "Libre Baskerville",
  "courier-prime": "Courier Prime",
  carlito: "Carlito",
  playfair: "Playfair Display",
  cinzel: "Cinzel",
};

export const BY_CATEGORY: Record<FontCategory, string> = {
  serif: "literata",
  "sans-serif": "carlito",
  monospace: "courier-prime",
  display: "playfair",
  handwriting: "carlito",
};

/** How a font id prints. `null` is the default body face. */
export function printFace(id: string | null | undefined, category?: FontCategory): PrintFace {
  const known = id ? knownFont(id) : undefined;
  if (known?.face) {
    // The app's own files — or, for "Sans", the bundled sans-serif.
    const own = known.id === known.face || known.id === "mono";
    return { family: known.face, substituted: !own, metric: own, asked: known.menu ?? known.name, drawn: BUNDLED_NAMES[known.face] ?? known.face };
  }
  const asked = !id ? DEFAULT_BODY : known ? known.name : parseFontId(id) ? fontLabel(id) : DEFAULT_BODY;
  const twin = standInFor(asked);
  const family = twin?.bundled ?? BY_CATEGORY[known?.category ?? category ?? "serif"];
  return { family, substituted: true, metric: !!twin?.metric, asked, drawn: BUNDLED_NAMES[family] ?? family, why: "missing" };
}
