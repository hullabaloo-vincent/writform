/**
 * The bundled font files (unmodified OFL releases, licenses beside them in
 * src/assets/fonts). Vite turns each import into a URL in the app bundle;
 * the files are fetched only when a book is typeset.
 */

import cinzel from "../../assets/fonts/cinzel/Cinzel[wght].ttf?url";
import courierBold from "../../assets/fonts/courier-prime/CourierPrime-Bold.ttf?url";
import courierBoldItalic from "../../assets/fonts/courier-prime/CourierPrime-BoldItalic.ttf?url";
import courierItalic from "../../assets/fonts/courier-prime/CourierPrime-Italic.ttf?url";
import courierRegular from "../../assets/fonts/courier-prime/CourierPrime-Regular.ttf?url";
import garamondBold from "../../assets/fonts/eb-garamond/EBGaramond-Bold.ttf?url";
import garamondBoldItalic from "../../assets/fonts/eb-garamond/EBGaramond-BoldItalic.ttf?url";
import garamondItalic from "../../assets/fonts/eb-garamond/EBGaramond-Italic.ttf?url";
import garamondRegular from "../../assets/fonts/eb-garamond/EBGaramond-Regular.ttf?url";
import libertinusBold from "../../assets/fonts/libertinus/LibertinusSerif-Bold.otf?url";
import libertinusBoldItalic from "../../assets/fonts/libertinus/LibertinusSerif-BoldItalic.otf?url";
import libertinusItalic from "../../assets/fonts/libertinus/LibertinusSerif-Italic.otf?url";
import libertinusRegular from "../../assets/fonts/libertinus/LibertinusSerif-Regular.otf?url";
import baskervilleItalic from "../../assets/fonts/libre-baskerville/LibreBaskerville-Italic[wght].ttf?url";
import baskerville from "../../assets/fonts/libre-baskerville/LibreBaskerville[wght].ttf?url";
import literataItalic from "../../assets/fonts/literata/Literata-Italic[opsz,wght].ttf?url";
import literata from "../../assets/fonts/literata/Literata[opsz,wght].ttf?url";
import playfairItalic from "../../assets/fonts/playfair-display/PlayfairDisplay-Italic[wght].ttf?url";
import playfair from "../../assets/fonts/playfair-display/PlayfairDisplay[wght].ttf?url";
import type { FaceBytes } from "../engine/faces";
import type { FontStyle } from "./registry";

export const FONT_FILES: Record<string, Partial<Record<FontStyle, string>>> = {
  garamond: { regular: garamondRegular, italic: garamondItalic, bold: garamondBold, boldItalic: garamondBoldItalic },
  libertinus: { regular: libertinusRegular, italic: libertinusItalic, bold: libertinusBold, boldItalic: libertinusBoldItalic },
  baskerville: { regular: baskerville, italic: baskervilleItalic },
  literata: { regular: literata, italic: literataItalic },
  playfair: { regular: playfair, italic: playfairItalic },
  cinzel: { regular: cinzel },
  "courier-prime": { regular: courierRegular, italic: courierItalic, bold: courierBold, boldItalic: courierBoldItalic },
};

/** Fetch every bundled style of the given families. */
export async function loadFontFiles(families: string[]): Promise<FaceBytes[]> {
  const wanted = [...new Set(families)].filter((f) => FONT_FILES[f]);
  const jobs = wanted.flatMap((family) =>
    Object.entries(FONT_FILES[family]).map(async ([style, url]) => {
      const res = await fetch(url!);
      if (!res.ok) throw new Error(`Couldn’t load the ${family} font (${res.status}).`);
      return { family, style: style as FontStyle, bytes: new Uint8Array(await res.arrayBuffer()) };
    }),
  );
  return Promise.all(jobs);
}
