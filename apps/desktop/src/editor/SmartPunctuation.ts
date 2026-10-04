/**
 * Typographer's punctuation as you type: curly quotes and apostrophes,
 * `--` → em dash, `...` → ellipsis. Input rules only — no schema change, so
 * it's safe on shared documents. Backspace right after a substitution
 * undoes it (TipTap's undoInputRule), rules never fire inside code, and the
 * whole thing can be switched off per device.
 */

import { Extension, InputRule } from "@tiptap/core";

export interface QuoteStyle {
  open2: string;
  close2: string;
  open1: string;
  close1: string;
}

const NNBSP = " "; // narrow no-break space, French guillemet spacing

export const QUOTE_STYLES: Record<string, QuoteStyle> = {
  en: { open2: "“", close2: "”", open1: "‘", close1: "’" },
  de: { open2: "„", close2: "“", open1: "‚", close1: "‘" },
  fr: { open2: `«${NNBSP}`, close2: `${NNBSP}»`, open1: `‹${NNBSP}`, close1: `${NNBSP}›` },
};

/** Quote style for a BCP-47 language tag (English for anything unknown). */
export function quoteStyleFor(lang: string | null | undefined): QuoteStyle {
  const base = (lang ?? "en").toLowerCase().split(/[-_]/)[0];
  return QUOTE_STYLES[base] ?? QUOTE_STYLES.en;
}

const PREF_KEY = "wf-smart-punct";

export function smartPunctuationEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSmartPunctuationEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // preference only
  }
}

/** What may precede an OPENING quote: line start, space, an opening
 *  bracket, a dash, or another opening quote. */
const OPENER = "(^|[\\s(\\[{\\u2014\\u2013\\u201C\\u2018\\u201E\\u00AB-])";

export interface SmartPunctuationOptions {
  /** Read at type time, so a change of book language applies immediately. */
  quotes: () => QuoteStyle;
}

export const SmartPunctuation = Extension.create<SmartPunctuationOptions>({
  name: "smartPunctuation",

  addOptions() {
    return { quotes: () => QUOTE_STYLES.en };
  },

  addInputRules() {
    const quotes = () => this.options.quotes();
    const rule = (find: RegExp, replace: (match: RegExpMatchArray) => string) =>
      new InputRule({
        find,
        handler: ({ state, range, match }) => {
          if (!smartPunctuationEnabled()) return null;
          state.tr.insertText(replace(match), range.from, range.to);
        },
      });
    return [
      rule(/--$/, () => "—"),
      rule(/\.\.\.$/, () => "…"),
      // An apostrophe inside or after a word is always ’ (don’t, the ’90s
      // is handled by the closing rule).
      rule(/([\p{L}\p{N}])'$/u, (m) => `${m[1]}’`),
      rule(new RegExp(`${OPENER}"$`), (m) => `${m[1]}${quotes().open2}`),
      rule(/"$/, () => quotes().close2),
      rule(new RegExp(`${OPENER}'$`), (m) => `${m[1]}${quotes().open1}`),
      rule(/'$/, () => quotes().close1),
    ];
  },
});
