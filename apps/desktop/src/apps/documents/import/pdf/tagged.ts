/**
 * A tagged PDF read by its tags.
 *
 * Some PDFs say what their pages hold: this is a heading of the second
 * level, this a list and these its items, this a table's header cell, this
 * a picture of a ferry. Word, Google Docs, InDesign and this app write
 * them. Where a file says, nothing is guessed: the paragraphs are the ones
 * it names, in the order it names them, which is the order they are read
 * in however the page is laid out.
 *
 * The tags are believed only when they cover the text (some files tag a
 * title page and nothing else). And they are per page as pdf.js gives
 * them, so what a page break cut in two is still put together here: a
 * paragraph that stops mid-sentence at a page's foot, a list or a table
 * that goes on overleaf.
 */

import { linesOf } from "./lines";
import type { Block, ImageBlock, Line, ListBlock, PageData, ParaBlock, Run, TableBlock, TableCell, TreeNode } from "./model";
import { attachNote } from "./notes";
import { paraOf, textOf } from "./paras";
import type { Kept } from "./pictures";

/** How much of the text the tags must cover to be believed. */
const COVERED = 0.9;

const leavesOf = (node: TreeNode, out: string[] = [], skip?: (node: TreeNode) => boolean): string[] => {
  for (const child of node.children ?? []) {
    if (child.type === "content" && child.id) out.push(child.id);
    else if (!child.type && !skip?.(child)) leavesOf(child, out, skip);
  }
  return out;
};

/** Whether a document's tags say enough to be read by. */
export function tagsCover(pages: PageData[]): boolean {
  let all = 0;
  let tagged = 0;
  for (const page of pages) {
    const named = new Set(page.tree ? leavesOf(page.tree) : []);
    for (const run of page.runs) {
      if (run.artifact || run.hidden) continue;
      const letters = run.text.trim().length;
      all += letters;
      const id = run.mark >= 0 ? page.marks[run.mark]?.id : null;
      if (id && named.has(id)) tagged += letters;
    }
  }
  return all > 0 && tagged >= all * COVERED;
}

const INLINE = new Set(["Span", "Link", "Reference", "Quote", "Em", "Strong", "Code", "Sub", "Sup", "Annot", "Ruby", "Warichu", "Lbl", "Formula", "Form", "BibEntry"]);
const HOLDERS = new Set(["Root", "Document", "Part", "Art", "Sect", "Div", "NonStruct", "Aside", "DocumentFragment", "TBody", "THead", "TFoot", "Index"]);

export interface TaggedOptions {
  compounds: Set<string>;
  /** A page's picture that was kept, by the page and the object's name. */
  picture: (page: number, id: string) => Kept | null;
}

interface Made {
  blocks: Block[];
  /** Tagged pictures that are not pictures here (drawn with lines). */
  drawn: number;
}

/** A page's blocks, by its tags. */
function pageBlocks(page: PageData, opts: TaggedOptions, made: Made, linesBy: WeakMap<ParaBlock, Line[]>): Block[] {
  if (!page.tree) return [];
  const byId = new Map<string, Run[]>();
  const seen = page.runs.filter((run) => !run.artifact && !run.hidden);
  for (const run of seen) {
    const id = run.mark >= 0 ? page.marks[run.mark]?.id : null;
    if (!id) continue;
    const list = byId.get(id);
    if (list) list.push(run);
    else byId.set(id, [run]);
  }
  const xs = seen.map((run) => run.x);
  const ends = seen.map((run) => run.x + run.w);
  const left = xs.length ? Math.min(...xs) : 0;
  const right = ends.length ? Math.max(...ends) : page.w;

  const linesFor = (ids: string[]): Line[] => {
    const lines = linesOf(page.n, ids.flatMap((id) => byId.get(id) ?? []));
    // (Lines are made down the page. A tagged paragraph in two columns is
    // read in the order its file gave, which the runs came in already.)
    for (const line of lines) {
      line.left = left;
      line.right = right;
    }
    return lines;
  };
  const isNote = (node: TreeNode) => node.role === "Note" || node.role === "FENote";

  /** A paragraph of what a node holds, its notes where they are cited. */
  const para = (node: TreeNode, more: Partial<ParaBlock> = {}, skip?: (node: TreeNode) => boolean): ParaBlock | null => {
    const lines = linesFor(leavesOf(node, [], (child) => isNote(child) || !!skip?.(child)));
    const notes: TreeNode[] = [];
    const find = (n: TreeNode) => {
      for (const child of n.children ?? []) {
        if (child.type) continue;
        if (isNote(child)) notes.push(child);
        else if (!skip?.(child)) find(child);
      }
    };
    find(node);
    for (const note of notes) attachNote(lines, linesFor(leavesOf(note)));
    const block = lines.length ? paraOf(lines, opts.compounds) : null;
    if (!block) return null;
    // (What a tag says, the look of the lines does not get to say again.)
    delete block.indent;
    delete block.inset;
    Object.assign(block, more);
    linesBy.set(block, lines);
    return block;
  };

  const isBlock = (node: TreeNode) => !node.type && !INLINE.has(node.role ?? "") && !isNote(node);

  /** What a node holds, as blocks: its own text first when it has text of
   *  its own beside its children. */
  const inside = (node: TreeNode): Block[] => {
    const kids = (node.children ?? []).filter((child) => !child.type);
    if (!kids.some(isBlock)) {
      const one = para(node);
      return one ? [one] : [];
    }
    const out: Block[] = [];
    // (Loose text between a holder's blocks is a paragraph where it stands.)
    let loose: TreeNode[] = [];
    const flush = () => {
      if (!loose.length) return;
      const one = para({ children: loose });
      if (one) out.push(one);
      loose = [];
    };
    for (const child of node.children ?? []) {
      if (child.type || !isBlock(child)) {
        if (child.type === "content" || !child.type) loose.push(child);
        continue;
      }
      flush();
      out.push(...blocksOf(child));
    }
    flush();
    return out;
  };

  const list = (node: TreeNode): ListBlock | null => {
    const items: ListBlock["items"] = [];
    let label = "";
    for (const child of node.children ?? []) {
      if (child.type) continue;
      if (child.role === "L") {
        // (A list straight inside a list belongs to the item before it.)
        const inner = list(child);
        if (inner && items.length) items[items.length - 1].blocks.push(inner);
        continue;
      }
      if (child.role !== "LI") continue;
      const lbl = (child.children ?? []).find((c) => c.role === "Lbl");
      if (lbl && !label)
        label = linesFor(leavesOf(lbl))
          .map((line) => line.text)
          .join("")
          .trim();
      const body = (child.children ?? []).find((c) => c.role === "LBody");
      const blocks = body ? inside(body) : inside({ children: (child.children ?? []).filter((c) => c.role !== "Lbl") });
      items.push({ blocks });
    }
    if (!items.length) return null;
    const number = /^\(?(\d{1,3}|[a-zA-Z]|[ivxlc]{1,5})[.)]?$/i.exec(label);
    if (!number) return { kind: "list", page: page.n, ordered: false, items };
    const raw = number[1];
    const numbering = /^\d+$/.test(raw) ? "1" : /^[ivxlc]+$/i.test(raw) && (raw.length > 1 || raw.toLowerCase() === "i") ? (raw === raw.toUpperCase() ? "I" : "i") : raw === raw.toUpperCase() ? "A" : "a";
    return { kind: "list", page: page.n, ordered: true, numbering, start: /^\d+$/.test(raw) ? Number(raw) : 1, items };
  };

  const table = (node: TreeNode): TableBlock | null => {
    const rows: { cells: TreeNode[] }[] = [];
    const gather = (n: TreeNode) => {
      for (const child of n.children ?? []) {
        if (child.type) continue;
        if (child.role === "TR") rows.push({ cells: (child.children ?? []).filter((c) => c.role === "TH" || c.role === "TD") });
        else if (child.role !== "Caption") gather(child);
      }
    };
    gather(node);
    const filled = rows.filter((row) => row.cells.length);
    if (!filled.length) return null;
    const columns = Math.max(...filled.map((row) => row.cells.length));
    // Where each column stands, from the row that has them all.
    const whole = filled.find((row) => row.cells.length === columns)!;
    const spans = whole.cells.map((cell) => {
      const lines = linesFor(leavesOf(cell));
      return lines.length ? { x0: Math.min(...lines.map((l) => l.x0)), x1: Math.max(...lines.map((l) => l.x1)) } : null;
    });
    const known = spans.every((span) => span !== null) ? (spans as { x0: number; x1: number }[]) : null;
    const grid: TableCell[][] = filled.map((row) => {
      // A row short of cells has cells that run across columns. pdf.js
      // does not say which: each cell is in the column its words start in,
      // and runs up to the next one's.
      const short = row.cells.length < columns;
      let at = 0;
      const starts = row.cells.map((cell) => {
        let col = at;
        if (short && known) {
          const lines = linesFor(leavesOf(cell));
          const x = lines.length ? Math.min(...lines.map((l) => l.x0)) : null;
          if (x !== null) for (let k = at; k < columns; k += 1) if (x >= known[k].x0 - 3) col = k;
        }
        col = Math.min(col, columns - (row.cells.length - row.cells.indexOf(cell)));
        at = col + 1;
        return col;
      });
      return row.cells.map((cell, c) => ({ blocks: inside(cell), colspan: Math.max(1, (c + 1 < starts.length ? starts[c + 1] : columns) - starts[c]), rowspan: 1 }));
    });
    // (A first cell that starts late has nothing before it to span: the
    // row is as wide as the table all the same.)
    for (const row of grid) {
      const have = row.reduce((sum, cell) => sum + cell.colspan, 0);
      if (have < columns) row[row.length - 1].colspan += columns - have;
    }
    const cols = known ? known.map((span, c) => (c + 1 < known.length ? known[c + 1].x0 - span.x0 : Math.max(24, span.x1 - span.x0 + 10))) : [];
    const ruledHere = page.rules.length >= 4;
    return { kind: "table", page: page.n, cols: cols.every((w) => w > 4) ? cols : [], rows: grid, head: filled[0].cells.every((cell) => cell.role === "TH") && filled.length > 1, ruled: ruledHere };
  };

  const figure = (node: TreeNode): Block[] => {
    const ids = leavesOf(node, [], (child) => child.role === "Caption");
    const numbers = new Set(ids.map((id) => Number(/_mc(\d+)$/.exec(id)?.[1] ?? -1)));
    const shown = page.pictures.find((picture) => picture.mc !== null && numbers.has(picture.mc));
    const kept = shown ? opts.picture(page.n, shown.id) : null;
    const said = (node.children ?? []).find((child) => child.role === "Caption");
    const caption = said ? para(said) : null;
    if (!shown || !kept) {
      if (!shown) made.drawn += 1;
      // (No picture to show: what was said of it is still text.)
      const words = para(node, {}, (child) => child.role === "Caption");
      return [...(words ? [words] : []), ...(caption ? [caption] : [])];
    }
    const across = Math.max(36, right - left);
    const scale = Math.min(1, across / shown.box.w);
    const middle = Math.abs(shown.box.x + shown.box.w / 2 - (left + right) / 2) <= across * 0.06;
    const block: ImageBlock = {
      kind: "image",
      page: page.n,
      key: kept.key,
      w: shown.box.w * scale,
      h: shown.box.h * scale,
      ...(node.alt?.trim() ? { alt: node.alt.trim() } : {}),
      ...(caption ? { caption: textOf(caption).replace(/\s+/g, " ").trim() } : {}),
      ...(shown.box.w < across * 0.9 && middle ? { align: "center" as const } : {}),
    };
    return [block];
  };

  function blocksOf(node: TreeNode): Block[] {
    const role = node.role ?? "";
    if (HOLDERS.has(role)) return inside(node);
    const heading = /^H([1-6])$/.exec(role);
    if (heading || role === "H" || role === "Title") {
      const one = para(node, { heading: heading ? Number(heading[1]) : 1 });
      return one ? [one] : [];
    }
    switch (role) {
      case "L": {
        const made = list(node);
        return made ? [made] : [];
      }
      case "Table": {
        const made = table(node);
        const said = (node.children ?? []).find((child) => child.role === "Caption");
        const caption = said ? para(said) : null;
        return [...(caption ? [caption] : []), ...(made ? [made] : [])];
      }
      case "Figure":
        return figure(node);
      case "TOC":
        // The contents are made again from the headings, by the document.
        return [{ kind: "toc", page: page.n }];
      case "BlockQuote": {
        const blocks = inside(node);
        for (const b of blocks) if (b.kind === "para") b.quote = true;
        return blocks;
      }
      case "Artifact":
      case "Private":
        return [];
      default:
        // A paragraph, a caption on its own, and whatever else holds text.
        return inside(node);
    }
  }

  return inside(page.tree);
}

const endsSentence = (text: string) => /[.!?:;"”’)\]]$/.test(text.trim());

/**
 * The document's blocks, by its tags. `drawn` counts tagged figures that
 * are drawings (no picture to keep).
 */
export function taggedBlocks(pages: PageData[], opts: TaggedOptions): { blocks: Block[]; drawn: number } {
  const made: Made = { blocks: [], drawn: 0 };
  const linesBy = new WeakMap<ParaBlock, Line[]>();
  let toc = false;
  for (const page of pages) {
    const mine = pageBlocks(page, opts, made, linesBy);
    for (const block of mine) {
      const prev = made.blocks[made.blocks.length - 1];
      const turn = prev && prev.page !== block.page;
      // (The contents, tagged on each page they run over, are one block.)
      if (block.kind === "toc") {
        if (toc) continue;
        toc = true;
      }
      if (turn && prev.kind === "para" && block.kind === "para" && !prev.heading && !block.heading && !!prev.quote === !!block.quote) {
        // A paragraph the page break cut: it stopped mid-sentence on a
        // full line, and goes on at the edge.
        const before = linesBy.get(prev) ?? [];
        const after = linesBy.get(block) ?? [];
        const last = before[before.length - 1];
        const first = after[0];
        const text = textOf(prev);
        if (last && first && (!endsSentence(text) || /^\p{Ll}/u.test(textOf(block))) && last.x1 >= (last.right ?? last.x1) - ((last.right ?? last.x1) - (last.left ?? last.x0)) * 0.15) {
          const joined = paraOf([...before, ...after], opts.compounds);
          if (joined) {
            delete joined.indent;
            delete joined.inset;
            Object.assign(prev, { spans: joined.spans, lines: joined.lines });
            linesBy.set(prev, [...before, ...after]);
            continue;
          }
        }
      }
      // A list that goes on overleaf (a numbered one carries its count on:
      // one that counts from one again is a new list).
      if (turn && prev.kind === "list" && block.kind === "list" && prev.ordered === block.ordered && (!block.ordered || (block.start ?? 1) !== 1)) {
        prev.items.push(...block.items);
        continue;
      }
      if (turn && prev.kind === "table" && block.kind === "table" && prev.rows[0]?.reduce((n, c) => n + c.colspan, 0) === block.rows[0]?.reduce((n, c) => n + c.colspan, 0) && !block.head) {
        prev.rows.push(...block.rows);
        continue;
      }
      made.blocks.push(block);
    }
  }
  return made;
}
