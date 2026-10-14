/**
 * The languages a book or a document can be said to be written in: the
 * ones the app can hyphenate and knows the quote marks of. The tag is what
 * goes into a file's properties (a PDF's, an ebook's).
 */
export const LANGUAGES = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pt", "Portuguese"],
] as const;

/** A language tag as files write it ("en-GB"), or "" when it is not one. */
export function cleanLanguage(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(value)) return "";
  const [first, ...rest] = value.split("-");
  // (Language in small letters, a two-letter region in capitals: how tags are usually written.)
  return [first.toLowerCase(), ...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part))].join("-");
}

/** The choices for a list, with one not in it (a document from elsewhere)
 *  shown under its own tag. */
export function languageChoices(current: string): readonly (readonly [string, string])[] {
  return !current || LANGUAGES.some(([tag]) => tag === current) ? LANGUAGES : [[current, current] as const, ...LANGUAGES];
}
