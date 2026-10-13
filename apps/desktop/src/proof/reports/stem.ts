/**
 * A word cut back to what its forms share: door and doors, walk, walked
 * and walking, quick and quickly. Used only to tell whether two words are
 * the same word, never shown. Our own few rules: they need not be right
 * about English, only the same for every form of a word.
 */
export function stem(word: string): string {
  let w = word;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  else if (w.endsWith("'")) w = w.slice(0, -1);
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(?:x|ch|sh|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("ied") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ing") && w.length > 5) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4) w = undouble(w.slice(0, -2));
  if (w.endsWith("ily") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** running -> run, stopped -> stop (but not: falling -> fal). */
function undouble(w: string): string {
  const n = w.length;
  if (n >= 3 && w[n - 1] === w[n - 2] && !"lsz".includes(w[n - 1]) && !"aeiou".includes(w[n - 1])) return w.slice(0, -1);
  return w;
}
