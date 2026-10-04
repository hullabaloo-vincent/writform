/** The `hyphen` package ships per-language CommonJS modules without types. */
declare module "hyphen/*" {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
  export function hyphenate(text: string, options?: { hyphenChar?: string; minWordLength?: number }): Promise<string>;
  const mod: { hyphenateSync: typeof hyphenateSync; hyphenate: typeof hyphenate };
  export default mod;
}
