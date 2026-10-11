/**
 * Word's formatting model, read: what a paragraph or run looks like is the
 * document defaults, then its style and that style's ancestors, then what
 * was set on it directly. This resolves that chain, and the numbering
 * definitions lists point at.
 */

import { child, children, int, onOff, val, type XNode } from "../xml";

/** Run formatting. Every field optional: absent means "not said here". */
export interface RProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  hidden?: boolean;
  /** Family name. */
  font?: string;
  /** Points. */
  size?: number;
  /** `rrggbb`, lower case; empty for "automatic". */
  color?: string;
  /** A highlighter (or run shading) colour, `rrggbb`; empty for none. */
  highlight?: string;
  vert?: "sup" | "sub";
  styleId?: string;
  /** Set in a "code" character style (the reader's own flag). */
  code?: boolean;
}

/** Paragraph formatting. Lengths in points. */
export interface PProps {
  styleId?: string;
  jc?: string;
  before?: number;
  after?: number;
  /** Line spacing as a multiple of single. */
  line?: number;
  /** An exact / at-least line height, points (then `line` is absent). */
  lineAt?: number;
  lineRule?: "exact" | "atLeast";
  indL?: number;
  indR?: number;
  /** First-line indent; negative is a hanging indent. */
  indFirst?: number;
  numId?: number;
  ilvl?: number;
  pageBreakBefore?: boolean;
  outlineLvl?: number;
  /** A rule above or below (how Word draws a divider line). */
  rule?: boolean;
  /** Borders drawn: which sides (`t`, `b`, `l`, `r`), how heavy, what colour. */
  border?: { sides: string; width: number; color: string } | null;
  /** Background, `rrggbb`; empty for none. */
  shade?: string;
  keepNext?: boolean;
  keepLines?: boolean;
  /** Set in a frame as a drop cap. */
  dropCap?: boolean;
}

export interface Theme {
  major?: string;
  minor?: string;
}

/** Word's highlighter pens. */
export const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: "ffff00",
  green: "00ff00",
  cyan: "00ffff",
  magenta: "ff00ff",
  blue: "0000ff",
  red: "ff0000",
  darkBlue: "000080",
  darkCyan: "008080",
  darkGreen: "008000",
  darkMagenta: "800080",
  darkRed: "800000",
  darkYellow: "808000",
  darkGray: "808080",
  lightGray: "c0c0c0",
  black: "000000",
};

/** A shading's fill as `rrggbb`, or "" when it says "none" (or white,
 *  which on paper is none). Undefined when it says nothing. */
function fillOf(shd: XNode | undefined): string | undefined {
  if (!shd) return undefined;
  const fill = shd.attrs["w:fill"];
  if (!fill) return undefined;
  if (!/^[0-9a-fA-F]{6}$/.test(fill)) return "";
  const hex = fill.toLowerCase();
  return hex === "ffffff" ? "" : hex;
}

const pt = (twips: string | undefined): number | undefined => {
  const v = int(twips);
  return v === undefined ? undefined : v / 20;
};

function themed(ref: string | undefined, theme: Theme): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith("major") ? theme.major : ref.startsWith("minor") ? theme.minor : undefined;
}

export function readRPr(rPr: XNode | undefined, theme: Theme): RProps {
  const out: RProps = {};
  if (!rPr) return out;
  const set = <K extends keyof RProps>(key: K, value: RProps[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("b", onOff(rPr, "w:b"));
  set("i", onOff(rPr, "w:i"));
  set("caps", onOff(rPr, "w:caps"));
  set("smallCaps", onOff(rPr, "w:smallCaps"));
  set("hidden", onOff(rPr, "w:vanish"));
  const strike = onOff(rPr, "w:strike");
  const dstrike = onOff(rPr, "w:dstrike");
  if (strike !== undefined || dstrike !== undefined) out.strike = !!strike || !!dstrike;
  const u = val(rPr, "w:u");
  if (child(rPr, "w:u")) out.u = u !== "none";
  const fonts = child(rPr, "w:rFonts");
  if (fonts) {
    set(
      "font",
      fonts.attrs["w:ascii"] ??
        fonts.attrs["w:hAnsi"] ??
        themed(fonts.attrs["w:asciiTheme"] ?? fonts.attrs["w:hAnsiTheme"], theme) ??
        fonts.attrs["w:cs"],
    );
  }
  const sz = int(val(rPr, "w:sz"));
  if (sz !== undefined && sz > 0) out.size = sz / 2;
  const color = val(rPr, "w:color");
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) out.color = color.toLowerCase();
  else if (color === "auto") out.color = "";
  // A run's shading is a highlighter of any colour; the pen itself wins.
  const shaded = fillOf(child(rPr, "w:shd"));
  if (shaded !== undefined) out.highlight = shaded;
  const highlight = val(rPr, "w:highlight");
  if (highlight) out.highlight = highlight === "none" ? "" : (HIGHLIGHT_HEX[highlight] ?? "");
  const vert = val(rPr, "w:vertAlign");
  if (vert === "superscript") out.vert = "sup";
  else if (vert === "subscript") out.vert = "sub";
  else if (vert) delete out.vert;
  set("styleId", val(rPr, "w:rStyle"));
  return out;
}

export function readPPr(pPr: XNode | undefined): PProps {
  const out: PProps = {};
  if (!pPr) return out;
  const style = val(pPr, "w:pStyle");
  if (style) out.styleId = style;
  const jc = val(pPr, "w:jc");
  if (jc) out.jc = jc;
  const spacing = child(pPr, "w:spacing");
  if (spacing) {
    const before = pt(spacing.attrs["w:before"]);
    const after = pt(spacing.attrs["w:after"]);
    if (before !== undefined) out.before = before;
    if (after !== undefined) out.after = after;
    const line = int(spacing.attrs["w:line"]);
    if (line !== undefined && line > 0) {
      const rule = spacing.attrs["w:lineRule"];
      if (rule === "exact" || rule === "atLeast") {
        out.lineAt = line / 20;
        out.lineRule = rule;
        delete out.line;
      } else {
        out.line = line / 240;
      }
    }
  }
  const ind = child(pPr, "w:ind");
  if (ind) {
    const left = pt(ind.attrs["w:left"] ?? ind.attrs["w:start"]);
    const right = pt(ind.attrs["w:right"] ?? ind.attrs["w:end"]);
    const first = pt(ind.attrs["w:firstLine"]);
    const hanging = pt(ind.attrs["w:hanging"]);
    if (left !== undefined) out.indL = left;
    if (right !== undefined) out.indR = right;
    if (hanging !== undefined) out.indFirst = -hanging;
    else if (first !== undefined) out.indFirst = first;
  }
  const numPr = child(pPr, "w:numPr");
  if (numPr) {
    const numId = int(val(numPr, "w:numId"));
    const ilvl = int(val(numPr, "w:ilvl"));
    if (numId !== undefined) out.numId = numId;
    if (ilvl !== undefined) out.ilvl = ilvl;
  }
  const pb = onOff(pPr, "w:pageBreakBefore");
  if (pb !== undefined) out.pageBreakBefore = pb;
  const outline = int(val(pPr, "w:outlineLvl"));
  if (outline !== undefined) out.outlineLvl = outline;
  const bdr = child(pPr, "w:pBdr");
  if (bdr) {
    const drawn = (side: string) => {
      const v = val(bdr, side);
      return !!child(bdr, side) && v !== "nil" && v !== "none";
    };
    out.rule = (drawn("w:bottom") || drawn("w:top")) && !drawn("w:left") && !drawn("w:right");
    const sides = (["t", "b", "l", "r"] as const).filter((s) => drawn({ t: "w:top", b: "w:bottom", l: "w:left", r: "w:right" }[s])).join("");
    if (sides) {
      // The first drawn side speaks for all (one weight and colour here).
      const one = child(bdr, { t: "w:top", b: "w:bottom", l: "w:left", r: "w:right" }[sides[0] as "t" | "b" | "l" | "r"]);
      const eighths = int(one?.attrs["w:sz"]);
      const color = one?.attrs["w:color"];
      out.border = {
        sides,
        width: eighths ? Math.min(6, Math.max(0.25, eighths / 8)) : 0.75,
        color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "000000",
      };
    } else out.border = null;
  }
  const shade = fillOf(child(pPr, "w:shd"));
  if (shade !== undefined) out.shade = shade;
  const keepNext = onOff(pPr, "w:keepNext");
  if (keepNext !== undefined) out.keepNext = keepNext;
  const keepLines = onOff(pPr, "w:keepLines");
  if (keepLines !== undefined) out.keepLines = keepLines;
  if (child(pPr, "w:framePr")?.attrs["w:dropCap"] && child(pPr, "w:framePr")?.attrs["w:dropCap"] !== "none") {
    out.dropCap = true;
  }
  return out;
}

interface StyleDef {
  id: string;
  name: string;
  type: string;
  basedOn?: string;
  pPr: PProps;
  rPr: RProps;
}

export interface ResolvedStyle {
  /** The style's id in the file (empty for the default style). */
  id: string;
  /** The style's name as Word shows it ("heading 1", "Quote"). */
  name: string;
  pPr: PProps;
  rPr: RProps;
}

export class Styles {
  private byId = new Map<string, StyleDef>();
  private defaults: { pPr: PProps; rPr: RProps } = { pPr: {}, rPr: {} };
  private defaultPara?: string;
  private paraCache = new Map<string, ResolvedStyle>();
  private charCache = new Map<string, RProps>();
  /** Table styles' borders, by style id (with what each is based on). */
  private tables = new Map<string, { borders?: XNode; basedOn?: string }>();

  constructor(root: XNode | null, theme: Theme) {
    if (!root) return;
    const docDefaults = child(root, "w:docDefaults");
    this.defaults = {
      pPr: readPPr(child(child(docDefaults, "w:pPrDefault"), "w:pPr")),
      rPr: readRPr(child(child(docDefaults, "w:rPrDefault"), "w:rPr"), theme),
    };
    for (const node of children(root, "w:style")) {
      const id = node.attrs["w:styleId"];
      if (!id) continue;
      const type = node.attrs["w:type"] ?? "paragraph";
      if (type === "table") {
        this.tables.set(id, { borders: child(child(node, "w:tblPr"), "w:tblBorders"), basedOn: val(node, "w:basedOn") });
        continue;
      }
      const def: StyleDef = {
        id,
        name: val(node, "w:name") ?? id,
        type,
        basedOn: val(node, "w:basedOn"),
        pPr: readPPr(child(node, "w:pPr")),
        rPr: readRPr(child(node, "w:rPr"), theme),
      };
      // A style's own id isn't formatting.
      delete def.pPr.styleId;
      delete def.rPr.styleId;
      this.byId.set(id, def);
      const isDefault = node.attrs["w:default"];
      if (type === "paragraph" && (isDefault === "1" || isDefault === "true")) this.defaultPara = id;
    }
  }

  private chain(id: string | undefined, type: string): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const def = this.byId.get(cur);
      if (!def || def.type !== type) break;
      out.unshift(def);
      cur = def.basedOn;
    }
    return out;
  }

  /** A paragraph style, resolved through its ancestors and the document
   *  defaults. No id (or an unknown one) is the default paragraph style. */
  para(id?: string): ResolvedStyle {
    const key = id && this.byId.get(id)?.type === "paragraph" ? id : (this.defaultPara ?? "");
    const hit = this.paraCache.get(key);
    if (hit) return hit;
    const chain = this.chain(key || undefined, "paragraph");
    const out: ResolvedStyle = {
      id: key,
      name: chain.length ? chain[chain.length - 1].name : "Normal",
      pPr: { ...this.defaults.pPr },
      rPr: { ...this.defaults.rPr },
    };
    for (const def of chain) {
      Object.assign(out.pPr, def.pPr);
      Object.assign(out.rPr, def.rPr);
    }
    this.paraCache.set(key, out);
    return out;
  }

  /** A character style's run formatting (without the defaults). */
  char(id?: string): RProps {
    if (!id) return {};
    const hit = this.charCache.get(id);
    if (hit) return hit;
    const out: RProps = {};
    for (const def of this.chain(id, "character")) Object.assign(out, def.rPr);
    this.charCache.set(id, out);
    return out;
  }

  /** The lines a table style draws (its own, or the style's it is based on). */
  tableBorders(id: string | undefined): XNode | undefined {
    const seen = new Set<string>();
    let cur = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const def = this.tables.get(cur);
      if (!def) return undefined;
      if (def.borders) return def.borders;
      cur = def.basedOn;
    }
    return undefined;
  }

  /** The name of any style (paragraph or character), lower case. */
  nameOf(id?: string): string {
    return (id ? (this.byId.get(id)?.name ?? id) : "").toLowerCase();
  }
}

export interface NumLevel {
  /** `bullet`, `decimal`, `lowerLetter`, … */
  fmt: string;
  start: number;
  /** The marker's pattern: a bullet character, or `%1.%2.` for a number. */
  text?: string;
  /** The typeface the marker is drawn in (Symbol, Wingdings…). */
  font?: string;
}

export class Numbering {
  private abstract = new Map<number, Map<number, NumLevel>>();
  private nums = new Map<number, { abstract: number; overrides: Map<number, Partial<NumLevel>> }>();

  constructor(root: XNode | null) {
    if (!root) return;
    const level = (lvl: XNode): NumLevel => {
      const text = val(lvl, "w:lvlText");
      const font = child(child(lvl, "w:rPr"), "w:rFonts")?.attrs["w:ascii"];
      return {
        fmt: val(lvl, "w:numFmt") ?? "decimal",
        start: int(val(lvl, "w:start")) ?? 1,
        ...(text !== undefined ? { text } : {}),
        ...(font ? { font } : {}),
      };
    };
    for (const node of children(root, "w:abstractNum")) {
      const id = int(node.attrs["w:abstractNumId"]);
      if (id === undefined) continue;
      const levels = new Map<number, NumLevel>();
      for (const lvl of children(node, "w:lvl")) {
        const ilvl = int(lvl.attrs["w:ilvl"]);
        if (ilvl !== undefined) levels.set(ilvl, level(lvl));
      }
      this.abstract.set(id, levels);
    }
    for (const node of children(root, "w:num")) {
      const id = int(node.attrs["w:numId"]);
      const abs = int(val(node, "w:abstractNumId"));
      if (id === undefined || abs === undefined) continue;
      const overrides = new Map<number, Partial<NumLevel>>();
      for (const over of children(node, "w:lvlOverride")) {
        const ilvl = int(over.attrs["w:ilvl"]);
        if (ilvl === undefined) continue;
        const patch: Partial<NumLevel> = {};
        const lvl = child(over, "w:lvl");
        if (lvl) Object.assign(patch, level(lvl));
        const start = int(val(over, "w:startOverride"));
        if (start !== undefined) patch.start = start;
        overrides.set(ilvl, patch);
      }
      this.nums.set(id, { abstract: abs, overrides });
    }
  }

  level(numId: number, ilvl: number): NumLevel | undefined {
    const num = this.nums.get(numId);
    if (!num) return undefined;
    const base = this.abstract.get(num.abstract)?.get(ilvl);
    const over = num.overrides.get(ilvl);
    if (!base && !over) return undefined;
    return { fmt: "decimal", start: 1, ...base, ...over };
  }
}

/** The theme's heading and body typefaces. */
export function readTheme(root: XNode | null): Theme {
  if (!root) return {};
  const scheme = child(child(root, "a:themeElements"), "a:fontScheme");
  const face = (name: string) => child(child(scheme, name), "a:latin")?.attrs.typeface || undefined;
  return { major: face("a:majorFont"), minor: face("a:minorFont") };
}
