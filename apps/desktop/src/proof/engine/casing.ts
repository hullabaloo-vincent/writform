/**
 * A replacement written the way the word it replaces was: colour, Colour
 * and COLOUR become color, Color and COLOR.
 */

/** `sure` is false where the original's capitals follow no plain pattern
 *  (iPhone, McDonald): the answer then wants a person's eye. */
export function matchCase(original: string, target: string): { text: string; sure: boolean } {
  const upper = original.toUpperCase();
  const lower = original.toLowerCase();
  if (original === lower) return { text: target, sure: true };
  const letters = [...original].filter((ch) => ch.toLowerCase() !== ch.toUpperCase()).length;
  if (original === upper && letters >= 2) return { text: target.toUpperCase(), sure: true };
  const cap = target.charAt(0).toUpperCase() + target.slice(1);
  if (original === original.charAt(0).toUpperCase() + lower.slice(1)) return { text: cap, sure: true };
  return { text: original.charAt(0) === lower.charAt(0) ? target : cap, sure: false };
}

/** Whether a word has a capital anywhere: such a target is written exactly
 *  as given (Wi-Fi), whatever it replaces. */
export const hasCapital = (text: string): boolean => text !== text.toLowerCase();
