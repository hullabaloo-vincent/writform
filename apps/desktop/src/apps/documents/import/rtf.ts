/**
 * Minimal RTF → plain text: strips control words and groups, honoring
 * `\par`/`\line` as breaks and `\'hh` hex escapes. Formatting is dropped —
 * documented import limitation.
 */
export function rtfToText(rtf: string): string {
  let out = "";
  let i = 0;
  let skipGroupDepth: number | null = null;
  let depth = 0;

  const DESTINATIONS = new Set([
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "header",
    "footer",
    "pict",
    "object",
    "themedata",
    "colorschememapping",
    "listtable",
    "listoverridetable",
    "latentstyles",
    "generator",
  ]);

  while (i < rtf.length) {
    const ch = rtf[i];
    if (skipGroupDepth !== null) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth < skipGroupDepth) skipGroupDepth = null;
      } else if (ch === "\\") i++; // skip escaped char inside ignored group
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      i++;
      continue;
    }
    if (ch === "\\") {
      const rest = rtf.slice(i + 1);
      const hex = /^'([0-9a-fA-F]{2})/.exec(rest);
      if (hex) {
        out += String.fromCharCode(parseInt(hex[1], 16));
        i += 3;
        continue;
      }
      const esc = rest[0];
      if (esc === "\\" || esc === "{" || esc === "}") {
        out += esc;
        i += 2;
        continue;
      }
      if (esc === "*") {
        // \* marks an optional destination — skip the whole group.
        skipGroupDepth = depth;
        i += 2;
        continue;
      }
      const word = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rest);
      if (word) {
        const name = word[1];
        if (DESTINATIONS.has(name)) {
          skipGroupDepth = depth;
        } else if (name === "par" || name === "line") {
          out += "\n";
        } else if (name === "tab") {
          out += "\t";
        } else if (name === "u" && word[2]) {
          const code = parseInt(word[2], 10);
          out += String.fromCharCode(code < 0 ? code + 65536 : code);
          // RTF unicode is followed by a fallback char to skip.
          i += 1 + word[0].length + 1;
          continue;
        }
        i += 1 + word[0].length;
        continue;
      }
      i += 2; // unknown escape
      continue;
    }
    if (ch !== "\r" && ch !== "\n") out += ch;
    i++;
  }
  return out;
}
