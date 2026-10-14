/** The symbols worth a click: punctuation a keyboard hides, marks, maths,
 *  currency, arrows and the commonest accented letters. */
export const SYMBOL_GROUPS: { label: string; symbols: string[] }[] = [
  { label: "Punctuation", symbols: ["—", "–", "…", "‘", "’", "“", "”", "«", "»", "¿", "¡", "•", "·", "§", "¶", "†", "‡", "№"] },
  { label: "Marks", symbols: ["©", "®", "™", "°", "′", "″", "✓", "✗", "★", "☆", "♥", "♪"] },
  { label: "Maths", symbols: ["±", "×", "÷", "−", "≠", "≈", "≤", "≥", "∞", "√", "π", "µ", "½", "¼", "¾", "⅓", "⅔", "%"] },
  { label: "Currency", symbols: ["€", "£", "¥", "¢", "₹", "₩", "₽", "₿"] },
  { label: "Arrows", symbols: ["←", "→", "↑", "↓", "↔", "⇐", "⇒", "⇔"] },
  { label: "Letters", symbols: ["á", "à", "â", "ä", "ã", "å", "æ", "ç", "é", "è", "ê", "ë", "í", "î", "ï", "ñ", "ó", "ô", "ö", "õ", "ø", "œ", "ß", "ú", "û", "ü"] },
];

/**
 * Spaces and hyphens that look like the ordinary ones and behave otherwise
 * at a line's end. They cannot be told apart in a grid of symbols, so they
 * are offered by name (and each has a key: see editor/commands/catalog.ts).
 * (Made from their numbers: none of them shows in a source file.)
 */
export const SPECIAL_CHARACTERS: { id: "nbsp" | "nbhyphen" | "softhyphen"; label: string; hint: string; char: string }[] = [
  { id: "nbsp", label: "No-break space", hint: "keeps two words on one line", char: String.fromCharCode(0x00a0) },
  { id: "nbhyphen", label: "No-break hyphen", hint: "a hyphen the line never breaks at", char: String.fromCharCode(0x2011) },
  { id: "softhyphen", label: "Optional hyphen", hint: "shows only where the line breaks there", char: String.fromCharCode(0x00ad) },
];

/** One of them by name. */
export function specialCharacter(id: string): string | null {
  return SPECIAL_CHARACTERS.find((c) => c.id === id)?.char ?? null;
}
