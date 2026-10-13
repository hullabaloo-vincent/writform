/**
 * Walks a Word part's body and flattens it to paragraphs of text runs,
 * line breaks and pictures, each with its resolved formatting. Everything
 * Word can wrap text in — content controls, smart tags, tracked insertions,
 * fields, alternate content, tables — is seen through to the text inside.
 */

import { child, children, find, int, onOff, val, type XNode } from "../xml";
import type { Rel } from "./package";
import { readPPr, readRPr, type Numbering, type PProps, type ResolvedStyle, type RProps, type Styles, type Theme } from "./styles";

/** Who made a tracked change, and when (seconds since 1970; 0 unknown). */
export interface FileRev {
  a: string;
  t: number;
}

/** What Word's tracked changes say of a run, a note, a paragraph mark or a
 *  table: inserted, deleted, or one then the other. */
export interface FileRevs {
  ins?: FileRev;
  del?: FileRev;
}

export type Inline =
  | { t: "text"; text: string; props: RProps; href?: string; rev?: FileRevs }
  | { t: "break" }
  | { t: "image"; media: number; w: number; h: number; alt: string; round?: number; border?: { w: number; color: string } }
  /** A field the reader keeps as a field (headers and footers). */
  | { t: "field"; name: string }
  /** A footnote or endnote, with what it says. */
  | { t: "note"; kind: "foot" | "end"; inlines: Inline[]; rev?: FileRevs };

/** A table as the file has it: its grid, and each row's cells. */
export interface TableBlock {
  t: "table";
  /** Column widths, points (empty when the file gives none). */
  grid: number[];
  /** As wide as the text, whatever that is (not a width of its own). */
  full: boolean;
  head: boolean;
  /** Every row was inserted, or every row deleted, as a tracked change. */
  rev?: FileRevs;
  lines: "all" | "rows" | "box" | "none";
  rows: {
    cells: {
      blocks: Block[];
      span: number;
      /** Part of a cell that runs down rows: where it starts, or goes on. */
      merge: "start" | "continue" | null;
      /** Background, `rrggbb`. */
      bg?: string;
      /** Lines of the cell's own, by side: a width in points and a colour
       *  (`rrggbb`), or none there whatever the table draws. */
      borders?: CellBorders;
    }[];
  }[];
}

export type CellSide = "t" | "r" | "b" | "l";
export type CellBorders = Partial<Record<CellSide, { w: number; color: string } | "none">>;

/** A cell's own lines (`w:tcBorders`): only the sides it says something of. */
function cellBorders(node: XNode | undefined): CellBorders | null {
  if (!node) return null;
  const out: CellBorders = {};
  for (const [side, names] of [
    ["t", ["w:top"]],
    ["r", ["w:right", "w:end"]],
    ["b", ["w:bottom"]],
    ["l", ["w:left", "w:start"]],
  ] as const) {
    const b = names.map((n) => child(node, n)).find((x) => x);
    if (!b) continue;
    const kind = b.attrs["w:val"];
    if (kind === "nil" || kind === "none") {
      out[side] = "none";
      continue;
    }
    // (Eighths of a point. Whatever the line's pattern, it is a line here.)
    const w = Math.min(6, Math.max(0.25, (int(b.attrs["w:sz"]) ?? 4) / 8));
    const color = b.attrs["w:color"];
    out[side] = { w, color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "000000" };
  }
  return Object.keys(out).length ? out : null;
}

/** A table of contents field: where it stood, and how deep it goes. */
export interface TocBlock {
  t: "toc";
  depth: number;
}

export type Block = Para | TableBlock | TocBlock;

export interface Para {
  t?: undefined;
  /** The paragraph's formatting: its style, then what was set directly. */
  props: PProps;
  /** The style alone — what this kind of paragraph looks like untouched. */
  style: ResolvedStyle;
  /** The paragraph mark's own run formatting (an empty line's font). */
  mark: RProps;
  inlines: Inline[];
  breakBefore: boolean;
  /** Goes on at the top of the next column. */
  colBreak?: boolean;
  /** A section starts here: the `w:sectPr` that describes it. */
  sect?: XNode;
  /** Its paragraph mark — the break after it — is a tracked change. */
  endRev?: FileRevs;
}

export interface BodyCounts {
  notes: number;
  tables: number;
  textBoxes: number;
  tracked: number;
  contents: number;
  equations: number;
  linkedImages: number;
  /** Things drawn in Word that aren't pictures (shapes, lines, charts). */
  shapes: number;
}

interface Field {
  instr: string;
  phase: "instr" | "result";
  href?: string;
  /** A field whose result isn't worth keeping (a table of contents). */
  hide?: boolean;
  /** A field kept by name (page numbers in a header). */
  keep?: string;
}

const EMU_PER_PX = 9525;

/** Symbol-font characters writers actually meet, by their private-use code. */
const SYMBOLS: Record<string, string> = {
  "symbol:b7": "•",
  "symbol:d7": "×",
  "symbol:b0": "°",
  "symbol:b1": "±",
  "symbol:e2": "®",
  "symbol:e3": "©",
  "symbol:e4": "™",
  "symbol:ae": "→",
  "symbol:ac": "←",
  "wingdings:a7": "▪",
  "wingdings:6c": "●",
  "wingdings:6e": "■",
  "wingdings:71": "❑",
  "wingdings:76": "❖",
  "wingdings:d8": "➢",
  "wingdings:e0": "→",
  "wingdings:fc": "✓",
  "wingdings:fb": "✗",
  "wingdings:a8": "◻",
  "wingdings 2:50": "✓",
};

/** Character styles that mean "this is code". */
const CODE_CHAR = /^(inline code|code char|html code|html typewriter|verbatim char|source text)$/;

/** Fields a header or footer keeps live. */
const KEPT_FIELDS = /^\s*(PAGE|NUMPAGES|SECTIONPAGES|TITLE|AUTHOR|DATE|CREATEDATE|SAVEDATE|PRINTDATE|TIME)\b/i;

export class BodyReader {
  /** Every paragraph, in order, wherever it sits (a table's cells too). */
  paras: Para[] = [];
  /** The content as it is built: paragraphs, tables, contents. */
  tree: Block[] = [];
  /** Where paragraphs are going right now (the tree, or a cell). */
  private target: Block[] = this.tree;
  /** The `w:sectPr` of every section, in order (the last is the body's). */
  sects: XNode[] = [];
  /** The section the next top-level paragraph starts. */
  private pendingSect: XNode | null = null;
  /** Section breaks that don't start a page (read as no break at all). */
  continuous = 0;
  /** Footnotes and endnotes, by id — when the file's notes were read. */
  notes: { foot: Map<string, XNode>; end: Map<string, XNode> } | null = null;
  /** Zip paths of the pictures used, by the index `image` inlines carry. */
  media: string[] = [];
  counts: BodyCounts = { notes: 0, tables: 0, textBoxes: 0, tracked: 0, contents: 0, equations: 0, linkedImages: 0, shapes: 0 };
  /** Keep tracked changes as changes (else they are read as accepted:
   *  insertions as plain text, deletions not at all). */
  track = false;
  /** The tracked change being read inside of. */
  private rev: FileRevs = {};

  private fields: Field[] = [];
  private pendingBreak = false;
  private pendingCol = false;
  private boxes: XNode[] = [];
  private mediaIndex = new Map<string, number>();
  /** How each section break starts the next section, in document order. */
  private sectionStarts: string[] = [];
  private sectionAt = 0;

  constructor(
    private styles: Styles,
    readonly numbering: Numbering,
    private theme: Theme,
    private rels: Map<string, Rel>,
    /** Keep page-number and document-property fields as fields. */
    private keepFields = false,
  ) {}

  /** Read a `w:body` (or a header, footer or cell): its block children. */
  read(container: XNode): void {
    if (container.name === "w:body") {
      // A section break takes its kind from the section that FOLLOWS it.
      const sects: XNode[] = [];
      const collect = (node: XNode) => {
        for (const c of node.children) {
          if (c.name === "w:p") {
            const s = child(child(c, "w:pPr"), "w:sectPr");
            if (s) sects.push(s);
          } else if (c.name === "w:sectPr") sects.push(c);
          else if (c.name === "w:sdt") collect(child(c, "w:sdtContent") ?? c);
        }
      };
      collect(container);
      this.sects = sects;
      this.sectionStarts = sects.slice(1).map((s) => child(s, "w:type")?.attrs["w:val"] ?? "nextPage");
      // More than one section: the first has a setup of its own to say.
      if (sects.length > 1) this.pendingSect = sects[0];
    }
    this.blocks(container);
  }

  /** A table: its grid and lines, and each cell's own blocks. */
  private table(node: XNode): void {
    const tblPr = child(node, "w:tblPr");
    const grid = children(child(node, "w:tblGrid"), "w:gridCol").map((c) => (int(c.attrs["w:w"]) ?? 0) / 20);
    const borders = child(tblPr, "w:tblBorders") ?? this.styles.tableBorders(val(tblPr, "w:tblStyle"));
    const drawn = (name: string) => {
      const b = child(borders, name);
      const v = b?.attrs["w:val"];
      return !!b && v !== "nil" && v !== "none";
    };
    const outer = drawn("w:top") || drawn("w:bottom") || drawn("w:left") || drawn("w:right") || drawn("w:start") || drawn("w:end");
    const across = drawn("w:insideH");
    const down = drawn("w:insideV");
    const sides = drawn("w:left") || drawn("w:right") || drawn("w:start") || drawn("w:end");
    const lines: TableBlock["lines"] = !outer && !across && !down ? "none" : across && !down && !sides ? "rows" : outer && !across && !down ? "box" : "all";
    const width = child(tblPr, "w:tblW");
    const full = width?.attrs["w:type"] === "pct" && (int(width.attrs["w:w"]) ?? 0) >= 4990;
    const block: TableBlock = { t: "table", grid: grid.every((w) => w > 0) ? grid : [], full, head: false, lines, rows: [] };
    const outerTarget = this.target;
    const cellsOf = (row: XNode): XNode[] =>
      row.children.flatMap((c) => (c.name === "w:tc" ? [c] : c.name === "w:sdt" ? children(child(c, "w:sdtContent"), "w:tc") : []));
    const rowRevs: FileRevs[] = [];
    children(node, "w:tr").forEach((row, r) => {
      const trPr = child(row, "w:trPr");
      const added = child(trPr, "w:ins");
      const gone = child(trPr, "w:del");
      if (added || gone) this.counts.tracked += 1;
      // Accepted, a deleted row isn't there.
      if (gone && !this.track) return;
      if (r === 0 && onOff(trPr, "w:tblHeader")) block.head = true;
      const cells: TableBlock["rows"][number]["cells"] = [];
      // Columns a row skips at its start are empty cells here.
      for (let i = 0; i < (int(val(trPr, "w:gridBefore")) ?? 0); i += 1) cells.push({ blocks: [], span: 1, merge: null });
      for (const tc of cellsOf(row)) {
        const tcPr = child(tc, "w:tcPr");
        const merge = child(tcPr, "w:vMerge");
        const fill = child(tcPr, "w:shd")?.attrs["w:fill"];
        const borders = cellBorders(child(tcPr, "w:tcBorders"));
        const cell: TableBlock["rows"][number]["cells"][number] = {
          blocks: [],
          span: Math.max(1, int(val(tcPr, "w:gridSpan")) ?? 1),
          merge: merge ? (merge.attrs["w:val"] === "restart" ? "start" : "continue") : null,
          ...(fill && /^[0-9a-fA-F]{6}$/.test(fill) && fill.toLowerCase() !== "ffffff" ? { bg: fill.toLowerCase() } : {}),
          ...(borders ? { borders } : {}),
        };
        this.target = cell.blocks;
        this.blocks(tc);
        cells.push(cell);
      }
      if (cells.length) {
        block.rows.push({ cells });
        rowRevs.push({ ...(added ? { ins: revOf(added) } : {}), ...(gone ? { del: revOf(gone) } : {}) });
      }
    });
    this.target = outerTarget;
    // A table is tracked whole or not at all here: all of its rows
    // inserted, or all deleted. Otherwise the rows' changes are accepted.
    if (this.track && rowRevs.length) {
      if (rowRevs.every((r) => r.del)) block.rev = { del: rowRevs[0].del };
      else if (rowRevs.every((r) => r.ins && !r.del)) block.rev = { ins: rowRevs[0].ins };
      else block.rows = block.rows.filter((_, i) => !rowRevs[i].del);
    }
    if (block.rows.length) this.target.push(block);
  }

  private blocks(container: XNode): void {
    for (const node of container.children) {
      switch (node.name) {
        case "w:p":
          this.paragraph(node);
          break;
        case "w:tbl":
          this.counts.tables += 1;
          this.table(node);
          break;
        case "w:sdt": {
          const content = child(node, "w:sdtContent");
          if (content) this.blocks(content);
          break;
        }
        case "w:customXml":
        case "w:ins":
        case "w:moveTo":
          this.blocks(node);
          break;
        case "mc:AlternateContent": {
          const pick = child(node, "mc:Choice") ?? child(node, "mc:Fallback");
          if (pick) this.blocks(pick);
          break;
        }
        default:
          break;
      }
    }
  }

  private visible(): boolean {
    return this.fields.every((f) => f.phase === "result" && !f.hide && !f.keep);
  }

  private href(own: string | undefined): string | undefined {
    for (let i = this.fields.length - 1; i >= 0; i -= 1) {
      if (this.fields[i].href) return this.fields[i].href;
    }
    return own;
  }

  private paragraph(p: XNode): void {
    const pPr = child(p, "w:pPr");
    const direct = readPPr(pPr);
    const style = this.styles.para(direct.styleId);
    const props: PProps = { ...style.pPr, ...direct };
    const markDirect = readRPr(child(pPr, "w:rPr"), this.theme);
    const mark: RProps = { ...style.rPr, ...this.styles.char(markDirect.styleId), ...markDirect };

    const markRPr = child(pPr, "w:rPr");
    const markIns = child(markRPr, "w:ins") ?? child(markRPr, "w:moveTo");
    const markDel = child(markRPr, "w:del") ?? child(markRPr, "w:moveFrom");
    if (markDel) this.counts.tracked += 1;
    const endRev: FileRevs | null =
      this.track && (markIns || markDel) ? { ...(markIns ? { ins: revOf(markIns) } : {}), ...(markDel ? { del: revOf(markDel) } : {}) } : null;

    // One Word paragraph can hold a page break in its middle; each side
    // becomes its own paragraph here.
    const segments: { inlines: Inline[]; breakBefore: boolean; viaBreak: boolean; colBreak?: boolean }[] = [
      { inlines: [], breakBefore: this.pendingBreak || !!props.pageBreakBefore, viaBreak: false },
    ];
    this.pendingBreak = false;
    // Inside a field that isn't shown (a table of contents spans many
    // paragraphs), or holding only a picture that couldn't be read: such a
    // paragraph leaves no empty line behind.
    let hidSomething = !this.visible();
    const tocs: TocBlock[] = [];
    const cur = () => segments[segments.length - 1];
    const hasInk = (inlines: Inline[]) =>
      inlines.some((n) => n.t === "image" || n.t === "field" || n.t === "note" || (n.t === "text" && n.text.trim() !== ""));

    const pushText = (text: string, rp: RProps, own?: string) => {
      if (!text) return;
      if (!this.visible()) {
        hidSomething = true;
        return;
      }
      if (rp.hidden) return;
      const href = this.href(own);
      const rev = this.rev.ins || this.rev.del ? this.rev : undefined;
      const last = cur().inlines[cur().inlines.length - 1];
      // Word splits a sentence into many runs (spelling state, revision
      // ids); equal neighbours are one run.
      if (last?.t === "text" && last.href === href && sameRun(last.props, rp) && sameRev(last.rev, rev)) last.text += text;
      else cur().inlines.push({ t: "text", text, props: rp, ...(href ? { href } : {}), ...(rev ? { rev } : {}) });
    };

    const pageBreak = () => {
      if (hasInk(cur().inlines)) segments.push({ inlines: [], breakBefore: true, viaBreak: true });
      else {
        cur().breakBefore = true;
        cur().viaBreak = true;
      }
    };

    // A column break: what follows starts the next column.
    const columnBreak = () => {
      if (hasInk(cur().inlines)) segments.push({ inlines: [], breakBefore: false, viaBreak: true, colBreak: true });
      else cur().colBreak = true;
    };

    const image = (node: XNode) => {
      if (!this.visible()) return;
      const blip = find(node, "a:blip");
      const vml = blip ? undefined : find(node, "v:imagedata");
      const id = blip ? blip.attrs["r:embed"] : vml?.attrs["r:id"];
      if (!id) {
        if (blip?.attrs["r:link"]) {
          this.counts.linkedImages += 1;
          hidSomething = true;
        } else {
          // Not a picture at all: something drawn in Word (a shape, a line,
          // a chart). There is nothing here to draw it with.
          this.counts.shapes += 1;
          hidSomething = true;
        }
        return;
      }
      const rel = this.rels.get(id);
      if (!rel || rel.external) {
        this.counts.linkedImages += 1;
        hidSomething = true;
        return;
      }
      let w: number;
      let h: number;
      const extent = find(node, "wp:extent");
      if (extent) {
        w = (int(extent.attrs.cx) ?? 0) / EMU_PER_PX;
        h = (int(extent.attrs.cy) ?? 0) / EMU_PER_PX;
      } else {
        const css = find(node, "v:shape")?.attrs.style ?? "";
        const len = (key: string) => {
          const m = new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([0-9.]+)(pt|in|px|cm|mm)?`).exec(css);
          if (!m) return 0;
          const v = Number(m[1]);
          const unit = m[2] ?? "px";
          return unit === "pt" ? (v * 96) / 72 : unit === "in" ? v * 96 : unit === "cm" ? (v * 96) / 2.54 : unit === "mm" ? (v * 96) / 25.4 : v;
        };
        w = len("width");
        h = len("height");
      }
      let index = this.mediaIndex.get(rel.target);
      if (index === undefined) {
        index = this.media.length;
        this.media.push(rel.target);
        this.mediaIndex.set(rel.target, index);
      }
      const docPr = find(node, "wp:docPr");
      // Its shape and its outline, as far as a picture has them here: a
      // rounded rectangle or an oval, a line of one colour.
      const frame = find(node, "pic:spPr");
      const shape = find(frame ?? undefined, "a:prstGeom");
      const kind = shape?.attrs.prst ?? "";
      const adjust = Number(/val\s+(-?\d+)/.exec(find(shape ?? undefined, "a:gd")?.attrs.fmla ?? "")?.[1]);
      const round = kind === "ellipse" ? 50 : /round/i.test(kind) ? Math.min(50, Math.max(1, Number.isFinite(adjust) ? adjust / 1000 : 16.7)) : 0;
      const line = find(frame ?? undefined, "a:ln");
      const ink = line && !child(line, "a:noFill") ? find(line, "a:srgbClr")?.attrs.val : undefined;
      const border = line && ink && /^[0-9a-fA-F]{6}$/.test(ink) ? { w: Math.min(12, Math.max(0.25, (int(line.attrs.w) ?? 9525) / 12700)), color: ink.toLowerCase() } : null;
      cur().inlines.push({
        t: "image",
        media: index,
        w: Math.round(w),
        h: Math.round(h),
        alt: docPr?.attrs.descr || docPr?.attrs.title || "",
        ...(round ? { round: Math.round(round * 10) / 10 } : {}),
        ...(border ? { border: { w: Math.round(border.w * 100) / 100, color: border.color } } : {}),
      });
    };

    const graphic = (node: XNode) => {
      const box = find(node, "w:txbxContent");
      if (box) {
        this.counts.textBoxes += 1;
        this.boxes.push(box);
        return;
      }
      image(node);
    };

    const fieldStart = (instr: string): Field => {
      const field: Field = { instr, phase: "result" };
      const link = /^\s*HYPERLINK\s+(?:"([^"]*)"|(\S+))/i.exec(instr);
      if (link && !/\\l\b/.test(instr)) field.href = link[1] ?? link[2];
      if (/^\s*TOC\b/i.test(instr)) {
        // The entries are Word's to keep up to date; here it is one block
        // that lists the headings itself.
        field.hide = true;
        this.counts.contents += 1;
        const levels = /\\o\s+"?\d\s*-\s*(\d)/.exec(instr);
        tocs.push({ t: "toc", depth: levels ? Math.min(6, Math.max(1, Number(levels[1]))) : 3 });
      }
      const kept = this.keepFields ? KEPT_FIELDS.exec(instr) : null;
      if (kept) field.keep = kept[1].toUpperCase();
      return field;
    };

    const runChild = (c: XNode, rp: RProps, own: string | undefined) => {
      // Of a deleted run only its words and its notes are kept (a deleted
      // page break or picture isn't one to bring back).
      // (Text moved away is a plain w:t inside w:moveFrom.)
      if (this.rev.del && !["w:delText", "w:t", "w:tab", "w:footnoteReference", "w:endnoteReference", "mc:AlternateContent"].includes(c.name)) return;
      switch (c.name) {
        case "w:t":
        case "w:delText":
          pushText(c.text, rp, own);
          break;
        case "w:tab":
          pushText("\t", rp, own);
          break;
        case "w:noBreakHyphen":
          pushText("\u2011", rp, own);
          break;
        case "w:softHyphen":
          pushText("\u00ad", rp, own);
          break;
        case "w:cr":
          if (this.visible()) cur().inlines.push({ t: "break" });
          break;
        case "w:br": {
          const type = c.attrs["w:type"];
          if (type === "page") pageBreak();
          else if (type === "column") columnBreak();
          else if (this.visible()) cur().inlines.push({ t: "break" });
          break;
        }
        case "w:sym": {
          const font = (c.attrs["w:font"] ?? "").toLowerCase();
          const code = (c.attrs["w:char"] ?? "").toLowerCase().replace(/^f0/, "");
          const glyph = SYMBOLS[`${font}:${code}`];
          if (glyph) pushText(glyph, { ...rp, font: undefined }, own);
          break;
        }
        case "w:drawing":
        case "w:pict":
        case "w:object":
          graphic(c);
          break;
        case "mc:AlternateContent": {
          const pick = child(c, "mc:Choice") ?? child(c, "mc:Fallback");
          for (const inner of pick?.children ?? []) runChild(inner, rp, own);
          break;
        }
        case "w:fldChar": {
          const type = c.attrs["w:fldCharType"];
          if (type === "begin") this.fields.push({ instr: "", phase: "instr" });
          else if (type === "separate") {
            const top = this.fields[this.fields.length - 1];
            if (top && top.phase === "instr") {
              Object.assign(top, fieldStart(top.instr));
              if (top.keep && this.fields.length === 1) cur().inlines.push({ t: "field", name: top.keep });
            }
          } else if (type === "end") {
            const top = this.fields.pop();
            // A field with no stored result still names what goes there.
            if (top && top.phase === "instr" && this.keepFields && this.fields.length === 0) {
              const kept = KEPT_FIELDS.exec(top.instr);
              if (kept) cur().inlines.push({ t: "field", name: kept[1].toUpperCase() });
            }
          }
          break;
        }
        case "w:instrText": {
          const top = this.fields[this.fields.length - 1];
          if (top && top.phase === "instr") top.instr += c.text;
          break;
        }
        case "w:footnoteReference":
        case "w:endnoteReference": {
          const kind = c.name === "w:footnoteReference" ? "foot" : "end";
          const body = this.notes?.[kind].get(c.attrs["w:id"] ?? "");
          if (!body || !this.visible()) {
            // No notes part to read it from: say so.
            this.counts.notes += 1;
            break;
          }
          // What the note says: its paragraphs as one run of text.
          const sub = new BodyReader(this.styles, this.numbering, this.theme, new Map());
          sub.track = this.track;
          sub.read(body);
          const inlines: Inline[] = [];
          sub.paras.forEach((para, i) => {
            if (i > 0) inlines.push({ t: "text", text: " ", props: {} });
            for (const n of para.inlines) if (n.t === "text") inlines.push(n);
          });
          // (Word starts a note's text with a space after its number.)
          const first = inlines[0];
          if (first?.t === "text") inlines[0] = { ...first, text: first.text.replace(/^\s+/, "") };
          cur().inlines.push({ t: "note", kind, inlines, ...(this.rev.ins || this.rev.del ? { rev: this.rev } : {}) });
          break;
        }
        default:
          break;
      }
    };

    const run = (r: XNode, own: string | undefined) => {
      const direct = readRPr(child(r, "w:rPr"), this.theme);
      const rp: RProps = { ...style.rPr, ...this.styles.char(direct.styleId), ...direct };
      if (direct.styleId && CODE_CHAR.test(this.styles.nameOf(direct.styleId))) rp.code = true;
      for (const c of r.children) runChild(c, rp, own);
    };

    const inline = (node: XNode, own: string | undefined) => {
      for (const c of node.children) {
        switch (c.name) {
          case "w:r":
            run(c, own);
            break;
          case "w:hyperlink": {
            const id = c.attrs["r:id"];
            const rel = id ? this.rels.get(id) : undefined;
            // A link to a place in the document has no address to keep.
            inline(c, rel?.external ? rel.target : own);
            break;
          }
          case "w:ins":
          case "w:moveTo": {
            this.counts.tracked += 1;
            const was = this.rev;
            if (this.track) this.rev = { ...was, ins: revOf(c) };
            inline(c, own);
            this.rev = was;
            break;
          }
          case "w:del":
          case "w:moveFrom": {
            this.counts.tracked += 1;
            // Accepted, what was deleted isn't there.
            if (!this.track) break;
            const was = this.rev;
            this.rev = { ...was, del: revOf(c) };
            inline(c, own);
            this.rev = was;
            break;
          }
          case "w:smartTag":
          case "w:customXml":
          case "w:dir":
          case "w:bdo":
            inline(c, own);
            break;
          case "w:sdt": {
            const content = child(c, "w:sdtContent");
            if (content) inline(content, own);
            break;
          }
          case "w:fldSimple": {
            const field = fieldStart(c.attrs["w:instr"] ?? "");
            if (field.keep && this.fields.length === 0) cur().inlines.push({ t: "field", name: field.keep });
            this.fields.push(field);
            inline(c, own);
            this.fields.pop();
            break;
          }
          case "mc:AlternateContent": {
            const pick = child(c, "mc:Choice") ?? child(c, "mc:Fallback");
            if (pick) inline(pick, own);
            break;
          }
          case "m:oMath":
          case "m:oMathPara":
            this.counts.equations += 1;
            break;
          default:
            break;
        }
      }
    };

    inline(p, undefined);

    const sect = child(pPr, "w:sectPr");
    let nextSection: XNode | null = null;
    if (sect) {
      const start = this.sectionStarts[this.sectionAt] ?? "nextPage";
      this.sectionAt += 1;
      // The section that begins after this paragraph is described by the
      // next `w:sectPr` down the document.
      if (start !== "continuous") nextSection = this.sects[this.sectionAt] ?? null;
      else this.continuous += 1;
    }

    // A contents field that began here stands where the paragraph does.
    for (const toc of tocs) this.target.push(toc);

    const top = this.target === this.tree;
    let last: Para | null = null;
    for (const segment of segments) {
      const empty = !hasInk(segment.inlines) && !segment.inlines.some((n) => n.t === "break");
      // A paragraph that only held a page break IS the break, not a line of
      // its own; one that only held a table of contents goes with it.
      // …and a sliver of a paragraph (a point high, nothing in it) is only
      // there to keep two tables apart or to end a section.
      const sliver = empty && props.lineRule === "exact" && (props.lineAt ?? 99) <= 1;
      if (empty && (segment.viaBreak || hidSomething || sliver)) {
        if (segment.breakBefore) this.pendingBreak = true;
        if (segment.colBreak) this.pendingCol = true;
        continue;
      }
      const para: Para = { props, style, mark, inlines: segment.inlines, breakBefore: segment.breakBefore };
      if (segment.colBreak || this.pendingCol) para.colBreak = true;
      this.pendingCol = false;
      if (top && this.pendingSect) {
        para.sect = this.pendingSect;
        this.pendingSect = null;
        // (A section starts its own page: no page break to say twice.)
        para.breakBefore = false;
      }
      this.paras.push(para);
      this.target.push(para);
      last = para;
    }
    // (The mark ends the paragraph: the last of its pieces.)
    if (last && endRev) last.endRev = endRev;
    if (nextSection) this.pendingSect = nextSection;

    if (this.boxes.length) {
      const boxes = this.boxes;
      this.boxes = [];
      for (const box of boxes) this.blocks(box);
    }
  }
}

const revOf = (node: XNode): FileRev => ({
  a: (node.attrs["w:author"] ?? "").trim(),
  t: Math.max(0, Math.floor((Date.parse(node.attrs["w:date"] ?? "") || 0) / 1000)),
});

const sameOne = (a: FileRev | undefined, b: FileRev | undefined) => (!a && !b) || (!!a && !!b && a.a === b.a && a.t === b.t);
const sameRev = (a: FileRevs | undefined, b: FileRevs | undefined) => sameOne(a?.ins, b?.ins) && sameOne(a?.del, b?.del);

function sameRun(a: RProps, b: RProps): boolean {
  return (
    !!a.b === !!b.b &&
    !!a.i === !!b.i &&
    !!a.u === !!b.u &&
    !!a.strike === !!b.strike &&
    !!a.caps === !!b.caps &&
    !!a.smallCaps === !!b.smallCaps &&
    !!a.hidden === !!b.hidden &&
    !!a.code === !!b.code &&
    a.font === b.font &&
    a.size === b.size &&
    (a.color ?? "") === (b.color ?? "") &&
    (a.highlight ?? "") === (b.highlight ?? "") &&
    a.vert === b.vert
  );
}
