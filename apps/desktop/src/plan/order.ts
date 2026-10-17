/**
 * Order keys: strings that sort the way things are placed, so one thing
 * can be put between two others without renumbering the rest, and two
 * people moving different things never touch the same key. The digits are
 * 0-9, A-Z, a-z, which sort in that order as plain strings. A key never
 * ends in 0, so there is always room before it.
 *
 * Two keys can come out the same (two people putting something in the
 * same place at once): ties sort by id.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];

/** Past this length a list's keys are spread out again. */
export const ORDER_LONG = 48;

/** A key that sorts after `a` and before `b` (null: the start or the end). */
export function between(a: string | null, b: string | null): string {
  const low = a ?? "";
  if (b !== null && low >= b) return midpoint(b, null);
  return midpoint(low, b);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/** `n` keys evenly spread, short and in order: for a list whose keys grew
 *  long. (Trailing zeros are dropped, which keeps the order.) */
export function spread(n: number): string[] {
  let width = 1;
  while (DIGITS.length ** width < n + 1) width += 1;
  const span = DIGITS.length ** width;
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let v = Math.floor(((i + 1) * span) / (n + 1));
    let key = "";
    for (let d = 0; d < width; d += 1) {
      key = DIGITS[v % DIGITS.length] + key;
      v = Math.floor(v / DIGITS.length);
    }
    out.push(key.replace(/0+$/, ""));
  }
  return out;
}

/** Sort by order key, then id. */
export const byOrder = <T extends { order: string; id: string }>(a: T, b: T): number =>
  a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The key for a new item at `index` of a sorted list (0 = first). */
export function orderAt(list: readonly { order: string }[], index: number): string {
  const i = Math.max(0, Math.min(index, list.length));
  return between(i > 0 ? list[i - 1].order : null, i < list.length ? list[i].order : null);
}
