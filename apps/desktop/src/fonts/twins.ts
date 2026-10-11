/**
 * Fonts the app doesn't ship, by name, and what stands in for each on a
 * device that lacks it — on screen and in print.
 *
 * Two kinds of stand-in:
 *  - `catalog`: a family of the online catalog built to the same metrics
 *    (Gelasio for Georgia, Tinos for Times New Roman…), so lines and pages
 *    fall exactly as they would in the original. Needs downloading once.
 *  - `bundled`: the nearest face that ships with the app. Always there.
 */

export interface StandIn {
  /** Bundled family id. */
  bundled: string;
  /** The bundled one has the same widths. */
  metric: boolean;
  /** A catalog family (its id) with the same widths, when there is one. */
  catalog?: string;
}

/** Lower-case family name → its stand-ins. */
const STAND_INS: Record<string, StandIn> = {
  georgia: { bundled: "literata", metric: false, catalog: "gelasio" },
  cambria: { bundled: "literata", metric: false, catalog: "caladea" },
  charter: { bundled: "literata", metric: false },
  "times new roman": { bundled: "libertinus", metric: false, catalog: "tinos" },
  times: { bundled: "libertinus", metric: false, catalog: "tinos" },
  palatino: { bundled: "libertinus", metric: false },
  "palatino linotype": { bundled: "libertinus", metric: false },
  "book antiqua": { bundled: "libertinus", metric: false },
  "linux libertine": { bundled: "libertinus", metric: true },
  garamond: { bundled: "garamond", metric: false },
  "adobe garamond pro": { bundled: "garamond", metric: false },
  baskerville: { bundled: "baskerville", metric: false },
  calibri: { bundled: "carlito", metric: true },
  aptos: { bundled: "carlito", metric: false },
  arial: { bundled: "carlito", metric: false, catalog: "arimo" },
  helvetica: { bundled: "carlito", metric: false, catalog: "arimo" },
  "helvetica neue": { bundled: "carlito", metric: false },
  "segoe ui": { bundled: "carlito", metric: false },
  verdana: { bundled: "carlito", metric: false },
  tahoma: { bundled: "carlito", metric: false },
  "trebuchet ms": { bundled: "carlito", metric: false },
  "comic sans ms": { bundled: "carlito", metric: false },
  "courier new": { bundled: "courier-prime", metric: true },
  courier: { bundled: "courier-prime", metric: true },
  consolas: { bundled: "courier-prime", metric: false },
  menlo: { bundled: "courier-prime", metric: false },
  monaco: { bundled: "courier-prime", metric: false },
};

/** What stands in for a family NAME, if anything is known to. */
export function standInFor(name: string): StandIn | null {
  return STAND_INS[name.trim().toLowerCase()] ?? null;
}

/** What Word should fall back to for a stand-in family when it lacks it —
 *  the font it was standing in for. Lower-case family name → Word name. */
export const WORD_ALT_NAMES: Record<string, string> = {
  carlito: "Calibri",
  gelasio: "Georgia",
  tinos: "Times New Roman",
  arimo: "Arial",
  cousine: "Courier New",
  caladea: "Cambria",
  "courier prime": "Courier New",
  "libertinus serif": "Times New Roman",
  literata: "Georgia",
  "eb garamond": "Garamond",
  "libre baskerville": "Baskerville",
};
