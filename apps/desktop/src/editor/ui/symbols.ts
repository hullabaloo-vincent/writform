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
