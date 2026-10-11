/**
 * Where each line of a set paragraph starts in the editor's text.
 *
 * The composer says how many characters each line holds (spaces aside);
 * the model says where each run of the paragraph sits in the editor's
 * node. Counting through both gives, for every line, the position its
 * first word begins at — which is what lets the editor's page view break a
 * paragraph across pages exactly where the printed page does.
 *
 * A line that begins inside a word (hyphenation) is given the start of
 * that word: the screen can't hyphenate where the page does.
 */

/** What the composer doesn't count: the spaces it breaks at, and what it
 *  drops (zero-width characters, soft hyphens). */
const SPACE = /[ \t\r\n\u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]/;
const DROPPED = /[\u200b\u2060\ufeff\u00ad]/;

export interface PlacedRun {
  text: string;
  /** Where the run starts in its node's content. */
  at?: number;
  /** A note's number: all of it stands at `at`. */
  note?: number;
}

/**
 * For each line, the offset in the node's content its text starts at
 * (undefined where that can't be said). `counts` are the lines' character
 * counts; `skipped` characters at the paragraph's start are in no line (a
 * drop cap's initial).
 */
export function lineOffsets(runs: readonly PlacedRun[], counts: readonly number[], skipped = 0): (number | undefined)[] {
  const out: (number | undefined)[] = new Array<number | undefined>(counts.length).fill(undefined);
  // The index, among counted characters, each line begins at.
  const starts: number[] = [];
  let total = skipped;
  for (const count of counts) {
    starts.push(total);
    total += count;
  }
  let line = 0;
  const skipEmpty = () => {
    while (line < counts.length && counts[line] === 0) line += 1;
  };
  skipEmpty();
  let index = 0;
  let word: number | undefined;
  let glued = false;
  for (const run of runs) {
    if (run.text === "\n") {
      glued = false;
      continue;
    }
    for (let i = 0; i < run.text.length; i += 1) {
      const ch = run.text[i];
      if (DROPPED.test(ch)) continue;
      if (SPACE.test(ch)) {
        glued = false;
        continue;
      }
      const here = run.at === undefined ? undefined : run.note !== undefined ? run.at : run.at + i;
      if (!glued) word = here;
      glued = true;
      if (line < counts.length && index === starts[line]) {
        out[line] = word;
        line += 1;
        skipEmpty();
      }
      index += 1;
    }
  }
  // An empty line (a line break on its own) goes with the line after it.
  for (let i = counts.length - 2; i >= 0; i -= 1) {
    if (counts[i] === 0 && out[i] === undefined) out[i] = out[i + 1];
  }
  return out;
}
