/**
 * Reading a document: each block's facts (kept between readings), then
 * every check's findings over the whole.
 *
 * A reading is done in turns so that a long book never holds the page
 * (`step` works until its time is up and says whether it has finished).
 * What is known about a block is kept by its text and not by its node:
 * after an undo or a co-writer's change every node is new, and only the
 * blocks whose words changed are read again.
 */

import type { Check, Ctx } from "../checks/check";
import type { Analysis, Env, Issue, Rules, Scan } from "../types";
import { readBlock, type BlockFacts } from "./facts";

export interface Job {
  /** Work for about this long. True once the reading is finished. */
  step(ms: number): boolean;
  /** 0 to 1. */
  progress(): number;
  /** The findings, once finished. */
  result(): Read | null;
}

/** A finished reading: the findings, and the facts they were read from. */
export interface Read {
  scan: Scan;
  facts: BlockFacts[];
  analysis: Analysis;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Reader {
  /** By what a block is (`sig`), then by its text. */
  private kept = new Map<string, Map<string, BlockFacts>>();
  private size = 0;
  private reading = 0;
  /** How many blocks' facts were made (not found) in the last reading. */
  made = 0;

  constructor(
    readonly env: Env,
    private checks: Check<never>[],
  ) {}

  private factsOf(scan: Scan, i: number): BlockFacts {
    const block = scan.blocks[i];
    let bySig = this.kept.get(block.sig);
    if (!bySig) this.kept.set(block.sig, (bySig = new Map()));
    let facts = bySig.get(block.text);
    if (!facts) {
      facts = readBlock(block, this.env);
      bySig.set(block.text, facts);
      this.size += 1;
      this.made += 1;
    }
    facts.seen = this.reading;
    return facts;
  }

  /** Forget blocks that are no longer in the text. */
  private prune(blocks: number): void {
    if (this.size <= blocks * 2 + 500) return;
    for (const [sig, bySig] of this.kept) {
      for (const [text, facts] of bySig) {
        if (facts.seen !== this.reading) {
          bySig.delete(text);
          this.size -= 1;
        }
      }
      if (bySig.size === 0) this.kept.delete(sig);
    }
  }

  read(scan: Scan, rules: Rules): Job {
    this.reading += 1;
    this.made = 0;
    const english = this.env.base === "en";
    const running = this.checks.filter((c) => rules.on(c.id) && (english || !c.english));
    const unread = this.checks.filter((c) => rules.on(c.id) && c.english && !english).map((c) => c.id);
    const n = scan.blocks.length;
    const facts: BlockFacts[] = new Array(n);
    const local = running.map(() => new Array<unknown>(n));
    const stamps = running.map((c) => c.stamp?.(rules) ?? "");
    // Words the writer has said never to flag, in any check.
    const allowed = new Set(rules.words.filter((w) => w.kind === "allow").map((w) => w.find.toLowerCase()));
    let at = 0;
    let check = 0;
    let words = 0;
    const issues: Issue[] = [];
    const quiet: string[] = [];
    let next: Int32Array | null = null;
    let done: Read | null = null;

    const step = (ms: number): boolean => {
      if (done) return true;
      const until = now() + ms;
      while (at < n) {
        const f = (facts[at] = this.factsOf(scan, at));
        words += f.words;
        for (let c = 0; c < running.length; c += 1) {
          const one = running[c];
          if (!one.local) continue;
          let had = f.per.get(one.id);
          if (!had || had.stamp !== stamps[c]) {
            had = { stamp: stamps[c], note: one.local(scan.blocks[at], f, this.env, rules) ?? null };
            f.per.set(one.id, had);
          }
          local[c][at] = had.note;
        }
        at += 1;
        if ((at & 31) === 0 && now() >= until) return false;
      }
      if (!next) {
        next = new Int32Array(n).fill(-1);
        for (let i = 0; i < n; i += 1) if (scan.prev[i] >= 0) next[scan.prev[i]] = i;
      }
      while (check < running.length) {
        const one = running[check];
        const all = one.reduce({ scan, facts, local: local[check], env: this.env, rules, next } as Ctx<never>);
        const found = allowed.size ? all.filter((i) => !i.terms?.some((term) => allowed.has(term))) : all;
        if (found.length) issues.push(...found);
        else quiet.push(one.id);
        check += 1;
        if (now() >= until && check < running.length) return false;
      }
      this.prune(n);
      done = { scan, facts, analysis: { issues, quiet, unread, blocks: n, words } };
      return true;
    };
    return {
      step,
      progress: () => (n === 0 ? 1 : done ? 1 : (at / n) * 0.9 + (check / Math.max(1, running.length)) * 0.1),
      result: () => done,
    };
  }

  /** Read to the end at once (tests, and a reading that is nearly all kept). */
  readNow(scan: Scan, rules: Rules): Read {
    const job = this.read(scan, rules);
    while (!job.step(1000)) {
      // until finished
    }
    return job.result() as Read;
  }
}
