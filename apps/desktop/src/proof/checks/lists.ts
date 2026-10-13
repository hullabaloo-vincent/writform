import { key53 } from "../engine/hash";
import { F_CAP, isWordy, PUNCT, SPACE, WORD } from "../engine/tokens";
import type { Form, Issue, Place } from "../types";
import { issue, swap, type Check } from "./check";

/** How an item ends ("." "," "" and so on), whether it begins with a
 *  capital (1), lowercase (0) or neither (-1), and whether it is one
 *  sentence. */
interface Item {
  end: string;
  cap: number;
  one: boolean;
  /** Where its last mark is (or would go), and its first letter. */
  endAt: number;
  capAt: number;
}

/**
 * The items of one list ending differently (some with a full stop, some
 * without) or beginning differently (some with a capital). Only within a
 * list, never across lists, and only a list whose items are each a single
 * sentence or a fragment. A list that runs on as one sentence (each item
 * ending in a comma or the like, the last in a full stop) is as it should be.
 */
export const lists: Check<Item> = {
  id: "lists",
  label: "List items that end or begin differently",
  group: "lists",
  offIn: ["screenplay", "stageplay", "poetry"],
  local(block, facts) {
    if (!block.list) return null;
    const tk = facts.tokens;
    const text = block.text;
    let last = tk.n - 1;
    while (last >= 0 && tk.kind[last] === SPACE) last -= 1;
    if (last < 0) return null;
    let first = 0;
    while (first < tk.n && !isWordy(tk.kind[first])) first += 1;
    const lastCh = tk.kind[last] === PUNCT ? text[tk.start[last]] : "";
    const end = ".,;:!?".includes(lastCh || "x") ? lastCh : "";
    // More than one sentence inside: a paragraph, not an item to compare.
    let stops = 0;
    for (let i = 0; i < last; i += 1) if (tk.kind[i] === PUNCT && ".!?".includes(text[tk.start[i]]) && tk.kind[i + 1] === SPACE) stops += 1;
    const cap = first < tk.n && tk.kind[first] === WORD && first === 0 ? (tk.flag[first] & F_CAP ? 1 : 0) : -1;
    return { end, cap, one: stops === 0, endAt: end ? tk.start[last] : tk.end[last], capAt: first < tk.n ? tk.start[first] : 0 };
  },
  reduce({ scan, local }) {
    const out: Issue[] = [];
    const byList = new Map<number, number[]>();
    scan.blocks.forEach((_, block) => {
      const id = scan.list[block];
      if (id > 0 && local[block]) byList.set(id, [...(byList.get(id) ?? []), block]);
    });
    for (const blocks of byList.values()) {
      if (blocks.length < 3) continue;
      const items = blocks.map((block) => local[block] as Item);
      if (!items.every((item) => item.one)) continue;
      // Named for the list's first words, so the name outlasts edits elsewhere.
      const name = key53(scan.blocks[blocks[0]].text.slice(0, 40));

      // ---- how they end
      const runIn = items.slice(0, -1).every((item) => item.end === "," || item.end === ";") && items[items.length - 1].end === ".";
      const stopped = blocks.filter((_, i) => items[i].end === ".");
      const bare = blocks.filter((_, i) => items[i].end === "");
      if (!runIn && stopped.length && bare.length && stopped.length + bare.length === items.length) {
        const place = (block: number): Place => {
          const item = local[block] as Item;
          return item.end === "." ? { block, start: item.endAt, end: item.endAt + 1, form: "stop", fixes: { bare: swap(item.endAt, item.endAt + 1, "") } } : { block, start: item.endAt, end: item.endAt, form: "bare", fixes: { stop: swap(item.endAt, item.endAt, ".") } };
        };
        const forms: Form[] = [
          { id: "stop", label: "With a full stop", count: stopped.length },
          { id: "bare", label: "With nothing", count: bare.length },
        ];
        out.push(issue(lists, `end.${name}`, "consistency", "A list whose items end differently", "Some items of this list end in a full stop and some in nothing.", blocks.map(place), forms));
      }

      // ---- how they begin
      const upper = blocks.filter((_, i) => items[i].cap === 1);
      const lower = blocks.filter((_, i) => items[i].cap === 0);
      if (upper.length && lower.length) {
        const place = (block: number): Place => {
          const item = local[block] as Item;
          const ch = scan.blocks[block].text[item.capAt];
          return item.cap === 1 ? { block, start: item.capAt, end: item.capAt + 1, form: "capital", fixes: { lower: swap(item.capAt, item.capAt + 1, ch.toLowerCase()) }, review: true } : { block, start: item.capAt, end: item.capAt + 1, form: "lower", fixes: { capital: swap(item.capAt, item.capAt + 1, ch.toUpperCase()) } };
        };
        const forms: Form[] = [
          { id: "capital", label: "With a capital", count: upper.length },
          { id: "lower", label: "Without", count: lower.length },
        ];
        out.push(issue(lists, `cap.${name}`, "consistency", "A list whose items begin differently", "Some items of this list begin with a capital and some do not. (A name keeps its capital: those are left out of Fix all.)", [...upper, ...lower].sort((a, b) => a - b).map(place), forms));
      }
    }
    return out;
  },
};
