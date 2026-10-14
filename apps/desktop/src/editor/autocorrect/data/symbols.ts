// What a few keys typed in a row turn into, in any language. Written for
// this app. The first of each pair is what is typed.
export const SYMBOLS: readonly (readonly [string, string])[] = [
  ["(c)", "©"],
  ["(C)", "©"],
  ["(r)", "®"],
  ["(R)", "®"],
  ["(tm)", "™"],
  ["(TM)", "™"],
  ["<->", "↔"],
  ["->", "→"],
  ["<-", "←"],
  ["=>", "⇒"],
];

/** Fractions that have a character of their own. */
export const FRACTIONS: ReadonlyMap<string, string> = new Map([
  ["1/2", "½"],
  ["1/4", "¼"],
  ["3/4", "¾"],
  ["1/3", "⅓"],
  ["2/3", "⅔"],
]);
