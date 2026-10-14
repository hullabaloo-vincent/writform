/**
 * The document's styles as a stylesheet for the editing page. Only what the
 * document has changed is written here — the built-in looks are ordinary
 * rules in styles.css — so a document that has never touched its styles
 * adds nothing.
 *
 * Specificity is the point of the odd selectors: every rule here weighs
 * exactly what the built-in rule for the same paragraph weighs (one class,
 * one class, one element), so it replaces it by coming later, and still
 * loses to formatting set on the paragraph itself (`[data-size]`, …).
 */

import { fontCssFamily } from "../../fonts/css";
import type { FontInfo } from "../../fonts/css";
import { lineCss, QUOTE_STYLE, type ResolvedStyles, type StyleLook } from "./sheet";

/** How a colour is shown on the page it is drawn on (dark paper lightens
 *  what could not be read there: editor/ui/darkPaper.ts). */
export type Ink = (color: string) => string;

function declarations(look: StyleLook, fonts: Record<string, FontInfo>, opts: { indents: boolean; ink?: Ink }): string {
  const family = look.font ? fontCssFamily(look.font, fonts[look.font]) : null;
  const out = [
    // No font of its own: the document's body font, as everything inherits.
    family ? `font-family: ${family}` : "font-family: inherit",
    `font-size: ${look.size}pt`,
    `font-weight: ${look.bold ? 700 : 400}`,
    `font-style: ${look.italic ? "italic" : "normal"}`,
    `text-decoration: ${look.underline ? "underline" : "none"}`,
    `color: ${look.color ? (opts.ink ? opts.ink(look.color) : look.color) : "inherit"}`,
    `text-align: ${look.align}`,
    `line-height: ${lineCss(look.line)}`,
    `margin-top: ${look.before}pt`,
    `margin-bottom: ${look.after}pt`,
    `text-indent: ${look.align === "center" || look.align === "right" ? 0 : look.indF}pt`,
  ];
  if (opts.indents) out.push(`margin-left: ${look.indL}pt`, `margin-right: ${look.indR}pt`);
  return out.join("; ");
}

/**
 * CSS for the styles this document has changed or added. `scope` is a
 * selector for the page element the editor sits in — an attribute or class
 * selector (one class's worth of weight), unique to this document's view.
 * With `ink`, a style's colour is shown as that says, and as it is on a
 * shaded paragraph or in a shaded cell, which bring a ground of their own.
 */
export function stylesCss(scope: string, styles: ResolvedStyles, fonts: Record<string, FontInfo> = {}, ink?: Ink): string {
  const rules: string[] = [];
  const rule = (selector: string, look: StyleLook, indents: boolean) => {
    rules.push(`${selector} { ${declarations(look, fonts, { indents, ink })} }`);
    if (ink && look.color && ink(look.color) !== look.color) rules.push(`${selector}:is([data-shade], td[data-bg] *) { color: ${look.color} }`);
  };
  for (const info of styles.list) {
    if (!info.changed) continue;
    const look = styles.look(info.id);
    if (/^h[1-6]$/.test(info.id)) {
      rule(`${scope} .ProseMirror ${info.id}`, look, true);
    } else if (info.id === QUOTE_STYLE) {
      rules.push(`${scope} .ProseMirror blockquote { margin-left: ${look.indL}pt; margin-right: ${look.indR}pt }`);
      rule(`${scope} .ProseMirror :where(blockquote) p`, look, false);
    } else {
      // Ids are `[a-z0-9-]` by grammar (see sheet.ts), safe inside the quotes.
      rule(`${scope} :where(.ProseMirror) p[data-element="${info.id}"]`, look, true);
    }
  }
  return rules.join("\n");
}
