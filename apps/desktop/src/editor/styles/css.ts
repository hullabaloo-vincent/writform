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

function declarations(look: StyleLook, fonts: Record<string, FontInfo>, opts: { indents: boolean }): string {
  const family = look.font ? fontCssFamily(look.font, fonts[look.font]) : null;
  const out = [
    // No font of its own: the document's body font, as everything inherits.
    family ? `font-family: ${family}` : "font-family: inherit",
    `font-size: ${look.size}pt`,
    `font-weight: ${look.bold ? 700 : 400}`,
    `font-style: ${look.italic ? "italic" : "normal"}`,
    `text-decoration: ${look.underline ? "underline" : "none"}`,
    `color: ${look.color ?? "inherit"}`,
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
 */
export function stylesCss(scope: string, styles: ResolvedStyles, fonts: Record<string, FontInfo> = {}): string {
  const rules: string[] = [];
  for (const info of styles.list) {
    if (!info.changed) continue;
    const look = styles.look(info.id);
    if (/^h[1-6]$/.test(info.id)) {
      rules.push(`${scope} .ProseMirror ${info.id} { ${declarations(look, fonts, { indents: true })} }`);
    } else if (info.id === QUOTE_STYLE) {
      rules.push(
        `${scope} .ProseMirror blockquote { margin-left: ${look.indL}pt; margin-right: ${look.indR}pt }`,
        `${scope} .ProseMirror :where(blockquote) p { ${declarations(look, fonts, { indents: false })} }`,
      );
    } else {
      // Ids are `[a-z0-9-]` by grammar (see sheet.ts), safe inside the quotes.
      rules.push(`${scope} :where(.ProseMirror) p[data-element="${info.id}"] { ${declarations(look, fonts, { indents: true })} }`);
    }
  }
  return rules.join("\n");
}
