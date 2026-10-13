// Sets of punctuation marks the checks test a character against. Kept
// here, with the word lists, because they are things to find in a text
// and not words the app says.

/** What may stand just before an opening quote mark. */
export const OPENS_AFTER = "([{—–-";
/** What may stand just after a closing one. */
export const CLOSES_BEFORE = ".,;:!?)]}…—–";
/** What speech ends with, inside its closing mark. */
export const SPEECH_ENDS = ",.!?…—–";

export const EM = "—";
export const EN = "–";
/** The ways a sentence is broken by a dash: what each is called (with the
 *  mark itself shown, which is why this is here) and how it is written. */
export const DASH_STYLES: { id: string; label: string; text: string }[] = [
  { id: "em", label: "Em dash, closed (word—word)", text: EM },
  { id: "em-spaced", label: "Em dash, spaced (word — word)", text: ` ${EM} ` },
  { id: "en-spaced", label: "En dash, spaced (word – word)", text: ` ${EN} ` },
  { id: "hyphen", label: "Hyphen, spaced (word - word)", text: " - " },
  { id: "double", label: "Two hyphens (word--word)", text: "--" },
];
