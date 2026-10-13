// Written for this app.

/** Beginnings that make one word of two (co-operate, re-enter). A
 *  compound that starts with one is weighed as a word, not as a phrase. */
export const PREFIXES = new Set("co re pre non anti multi semi sub mid over under self un de dis inter intra micro macro mini post pro super trans ultra counter extra neo pseudo quasi ex".split(" "));

/** Pairs that are two different words: never weighed against each other. */
export const DISTINCT = new Set(
  "recover resign recreation coop reform repress release remark resort resent reserve recount recollect retreat refuse repose restore unionized react recreate redress refund relay repair replace represent resound restrain retire return review".split(
    " ",
  ),
);

/** Second words that make a verb of two words (follow up, break down):
 *  hyphenated as a thing, open as an action. */
export const PARTICLES = new Set("up in out off on down over back away through".split(" "));

export const TENS = new Set("twenty thirty forty fifty sixty seventy eighty ninety".split(" "));
export const UNITS = new Set("one two three four five six seven eight nine".split(" "));

/** The words for numbers up to ninety-nine, by their value. */
export const NUMBER_WORDS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
export const WORDS_FOR = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
export const TENS_FOR = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Words a figure belongs to as a label: page 3, chapter 12, room 9. */
export const LABELS = new Set(
  "page pages chapter chapters room rooms act scene flight figure fig table volume vol book part section line lines verse number no level grade size route highway apartment unit floor step stage phase class year age ages aged gate platform episode season series issue item rule article clause appendix note channel".split(
    " ",
  ),
);
/** Words that make a figure a measure: 5 km, 3 pm, 20 percent. */
export const MEASURES = new Set(
  "percent per cent am pm a.m p.m km m cm mm kg g mg lb lbs oz ft in mph kph mi miles mile meters metres feet foot inches inch yards yard pounds dollars euros cents pence degrees hours hour minutes minute seconds second days day weeks week months month years year o'clock times x million billion thousand hundred".split(
    " ",
  ),
);
