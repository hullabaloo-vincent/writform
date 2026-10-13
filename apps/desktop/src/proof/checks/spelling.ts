import { hasCapital, matchCase } from "../engine/casing";
import { F_CAP, F_START, F_UNSURE, fold, tokenText, WORD } from "../engine/tokens";
import type { Form, Issue, Place } from "../types";
import { issue, swap, type Check } from "./check";

/**
 * Words spelled more than one way: colour and color, organise and
 * organize, judgement and judgment. The table of which English uses which
 * spelling is VarCon's (see data/en/variants.ts). It is loaded only for
 * English text and only when the Check panel is open, and handed in here.
 */

interface Row {
  words: string[];
  /** For each spelling, how it stands in each variety: "20010". */
  codes: string[];
  /** The line of the table it is on (its word family). */
  family: number;
}

interface Table {
  rows: Row[];
  /** A spelling to its row and its place in it. */
  at: Map<string, [number, number]>;
}

let table: Table | null = null;

/** Hand the table in (the text of data/en/variants.ts). */
export function loadVariants(text: string): void {
  const rows: Row[] = [];
  const at = new Map<string, [number, number]>();
  text.split("\n").forEach((line, family) => {
    if (!line) return;
    for (const part of line.split(";")) {
      const row: Row = { words: [], codes: [], family };
      for (const alt of part.split("/")) {
        const soft = alt.startsWith("~");
        const word = alt.slice(soft ? 1 : 0, -5);
        row.words.push(word);
        row.codes.push(alt.slice(-5));
        // (A spelling that is also another word is never looked up.)
        if (!soft) at.set(word, [rows.length, row.words.length - 1]);
      }
      rows.push(row);
    }
  });
  table = { rows, at };
}

export const variantsLoaded = (): boolean => table !== null;

/** The kinds of English, in the order the table's digits run. */
const ORDER = ["us", "uk", "uk-ize", "ca", "au"];
const NAMES: Record<string, string> = { us: "American", uk: "British", "uk-ize": "British (with -ize)", ca: "Canadian", au: "Australian" };

/** [row, which spelling, start, end] for each word found in the table. */
type Hit = [number, number, number, number];

const american = (code: string): boolean => code[0] === "2" && code[1] === "0" && code[2] === "0";
const british = (code: string): boolean => code[0] === "0" && (code[1] !== "0" || code[2] !== "0");
/** A row that differs only as -ize and -ise do. */
const izeRow = (row: Row): number => row.codes.findIndex((code) => code[0] === "2" && code[1] === "0" && code[2] === "2");

export const spelling: Check<Hit[]> = {
  id: "spelling",
  label: "Words spelled two ways",
  group: "spelling",
  english: true,
  stamp: () => (table ? "1" : "0"),
  local(block, facts) {
    if (!table || block.role === "extract" || block.role === "caps") return null;
    const tk = facts.tokens;
    const hits: Hit[] = [];
    for (let i = 0; i < tk.n; i += 1) {
      if (tk.kind[i] !== WORD) continue;
      // A capital in mid-sentence is a name (the Labour Party, Pearl Harbor).
      const f = tk.flag[i];
      if (f & F_CAP && !(f & (F_START | F_UNSURE)) && block.role !== "heading") continue;
      let word = fold(tokenText(block.text, tk, i));
      let end = tk.end[i];
      if (word.endsWith("'s")) {
        word = word.slice(0, -2);
        end -= 2;
      }
      const found = table.at.get(word);
      if (found) hits.push([found[0], found[1], tk.start[i], end]);
    }
    return hits.length ? hits : null;
  },
  reduce({ scan, local, rules }) {
    if (!table) return [];
    const { rows } = table;
    const out: Issue[] = [];
    const written = (block: number, start: number, end: number, to: string): { text: string; sure: boolean } => (hasCapital(to) ? { text: to, sure: true } : matchCase(scan.blocks[block].text.slice(start, end), to));
    const fixTo = (block: number, start: number, end: number, to: string): Pick<Place, "fixes" | "review"> & { fix: ReturnType<typeof swap> } => {
      const made = written(block, start, end, to);
      return { fix: swap(start, end, made.text), ...(made.sure ? {} : { review: true }) };
    };
    const variety = rules.setting("variety");
    const k = typeof variety === "string" ? ORDER.indexOf(variety) : -1;
    /** Per row: the places of each of its spellings. */
    const used = new Map<number, Map<number, [number, number, number][]>>();
    local.forEach((hits, block) => {
      for (const [row, col, start, end] of hits ?? []) {
        let cols = used.get(row);
        if (!cols) used.set(row, (cols = new Map()));
        const list = cols.get(col);
        if (list) list.push([block, start, end]);
        else cols.set(col, [[block, start, end]]);
      }
    });
    /** Rows a wider finding has already spoken for. */
    const done = new Set<number>();

    if (k >= 0) {
      // A kind of English is asked for: every spelling it does not use.
      const places: Place[] = [];
      for (const [r, cols] of used) {
        const row = rows[r];
        const target = row.codes.findIndex((code) => code[k] === "2");
        if (target < 0) continue;
        for (const [col, list] of cols) {
          if (row.codes[col][k] !== "0") continue;
          done.add(r);
          for (const [block, start, end] of list) {
            const { fix, review } = fixTo(block, start, end, row.words[target]);
            places.push({ block, start, end, form: null, fixes: { "": fix }, ...(review ? { review } : {}) });
          }
        }
      }
      places.sort((a, b) => a.block - b.block || a.start - b.start);
      if (places.length) out.push(issue(spelling, "variety", "rule", `Spellings that are not ${NAMES[ORDER[k]]}`, `The rules ask for ${NAMES[ORDER[k]]} spelling.`, places));
    } else {
      // None is asked for: the text should still be in one.
      const sides = { us: [] as Place[], uk: [] as Place[] };
      const rowsOf = { us: new Set<number>(), uk: new Set<number>() };
      for (const [r, cols] of used) {
        const row = rows[r];
        for (const [col, list] of cols) {
          const code = row.codes[col];
          const side = american(code) ? "us" : british(code) ? "uk" : null;
          if (!side) continue;
          const other = side === "us" ? "uk" : "us";
          const target = side === "us" ? row.codes.findIndex((c) => c[1] === "2") : row.codes.findIndex((c) => c[0] === "2");
          rowsOf[side].add(r);
          for (const [block, start, end] of list) {
            const place: Place = { block, start, end, form: side };
            if (target >= 0) {
              const { fix, review } = fixTo(block, start, end, row.words[target]);
              place.fixes = { [other]: fix };
              if (review) place.review = true;
            }
            sides[side].push(place);
          }
        }
      }
      if (sides.us.length && sides.uk.length) {
        for (const r of [...rowsOf.us, ...rowsOf.uk]) done.add(r);
        const forms: Form[] = [
          { id: "us", label: "American", count: sides.us.length },
          { id: "uk", label: "British", count: sides.uk.length },
        ];
        const places = [...sides.us, ...sides.uk].sort((a, b) => a.block - b.block || a.start - b.start);
        out.push(issue(spelling, "variety", "consistency", "American and British spellings", "Some words are spelled the American way and some the British. Choose one in Rules to hold the whole text to it.", places, forms));
      } else {
        // One English throughout. Within British, -ise and -ize are each a style.
        const ize: Place[] = [];
        const ise: Place[] = [];
        const touched: number[] = [];
        for (const [r, cols] of used) {
          const row = rows[r];
          const z = izeRow(row);
          if (z < 0 || row.words.length !== 2) continue;
          touched.push(r);
          for (const [col, list] of cols) {
            for (const [block, start, end] of list) {
              const { fix, review } = fixTo(block, start, end, row.words[1 - col]);
              (col === z ? ize : ise).push({ block, start, end, form: col === z ? "ize" : "ise", fixes: { [col === z ? "ise" : "ize"]: fix }, ...(review ? { review } : {}) });
            }
          }
        }
        if (ize.length && ise.length) {
          for (const r of touched) done.add(r);
          const forms: Form[] = [
            { id: "ize", label: "-ize (organize)", count: ize.length },
            { id: "ise", label: "-ise (organise)", count: ise.length },
          ];
          out.push(issue(spelling, "ize", "consistency", "Words in -ise and in -ize", "Both endings are used. British English allows either, and a text keeps to one.", [...ize, ...ise].sort((a, b) => a.block - b.block || a.start - b.start), forms));
        }
      }
    }

    // A word written two ways that no wider finding accounts for.
    const families = new Map<number, { head: string; cols: Map<number, Place[]>; label: Map<number, string> }>();
    for (const [r, cols] of used) {
      if (done.has(r) || cols.size < 2) continue;
      const row = rows[r];
      let fam = families.get(row.family);
      // (Named for the row's first spelling, whichever the text uses more.)
      if (!fam) families.set(row.family, (fam = { head: row.words[0], cols: new Map(), label: new Map() }));
      for (const [col, list] of cols) {
        if (!fam.label.has(col)) fam.label.set(col, row.words[col]);
        const places = fam.cols.get(col) ?? [];
        for (const [block, start, end] of list) {
          const fixes: Record<string, ReturnType<typeof swap>> = {};
          let review = false;
          for (const other of cols.keys()) {
            if (other === col) continue;
            const made = fixTo(block, start, end, row.words[other]);
            fixes[String(other)] = made.fix;
            review = review || made.review === true;
          }
          places.push({ block, start, end, form: String(col), fixes, ...(review ? { review } : {}) });
        }
        fam.cols.set(col, places);
      }
    }
    for (const fam of families.values()) {
      const forms: Form[] = [...fam.cols].sort((a, b) => a[0] - b[0]).map(([col, places]) => ({ id: String(col), label: fam.label.get(col) as string, count: places.length }));
      const names = forms.map((f) => f.label);
      out.push({
        ...issue(spelling, `w.${fam.head}`, "consistency", `${names.join(" and ")}`, "The same word, spelled two ways.", [...fam.cols.values()].flat().sort((a, b) => a.block - b.block || a.start - b.start), forms),
        terms: names,
      });
    }
    return out;
  },
};
