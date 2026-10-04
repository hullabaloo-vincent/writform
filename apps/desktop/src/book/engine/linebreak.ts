/**
 * Optimal line breaking — Knuth & Plass, "Breaking Paragraphs into Lines"
 * (1981), with TeX's parameters. A paragraph is a list of boxes (text),
 * glue (spaces that stretch and shrink) and penalties (places a line may
 * end, with a cost: hyphenation points, forced breaks). Every feasible set
 * of breaks is weighed at once and the one with the fewest demerits wins,
 * so a tight line early on can buy an even paragraph later.
 *
 * Passes, as TeX does: no hyphenation at a strict tolerance; then with
 * hyphenation; then a final pass with emergency stretch where any line that
 * isn't overfull is acceptable (badness is capped at 10000, "infinitely
 * bad") — so it always succeeds, and only a word wider than the measure
 * sticks out (reported as overfull).
 */

export const INF_PENALTY = 10000;
/** Stretch that absorbs anything (the last line's fill). */
export const FIL = 1e6;

const BOX = 0;
const GLUE = 1;
const PENALTY = 2;

export class Items {
  readonly type: number[] = [];
  readonly width: number[] = [];
  readonly stretch: number[] = [];
  readonly shrink: number[] = [];
  /** Penalty items' cost. */
  readonly cost: number[] = [];
  readonly flagged: boolean[] = [];
  /** A hyphenation point found by the patterns (skipped in the first pass). */
  readonly auto: boolean[] = [];
  /** The caller's payload (for boxes: what to draw). */
  readonly data: number[] = [];

  get length(): number {
    return this.type.length;
  }

  box(width: number, data: number): void {
    this.push(BOX, width, 0, 0, 0, false, false, data);
  }

  glue(width: number, stretch: number, shrink: number): void {
    this.push(GLUE, width, stretch, shrink, 0, false, false, -1);
  }

  penalty(width: number, penalty: number, flagged = false, auto = false): void {
    this.push(PENALTY, width, 0, 0, penalty, flagged, auto, -1);
  }

  isBox(i: number): boolean {
    return this.type[i] === BOX;
  }

  isGlue(i: number): boolean {
    return this.type[i] === GLUE;
  }

  isPenalty(i: number): boolean {
    return this.type[i] === PENALTY;
  }

  private push(
    type: number,
    width: number,
    stretch: number,
    shrink: number,
    penalty: number,
    flagged: boolean,
    auto: boolean,
    data: number,
  ) {
    this.type.push(type);
    this.width.push(width);
    this.stretch.push(stretch);
    this.shrink.push(shrink);
    this.cost.push(penalty);
    this.flagged.push(flagged);
    this.auto.push(auto);
    this.data.push(data);
  }
}

export interface BreakOptions {
  /** Line widths by line number; the last applies to every later line. */
  widths: number[];
  /** Badness limits for the first two passes (TeX's \pretolerance and
   *  \tolerance) and the final one. */
  pretolerance?: number;
  tolerance?: number;
  finalTolerance?: number;
  /** Extra stretch per line in the final pass (TeX's \emergencystretch). */
  emergencyStretch?: number;
  /** Ask for this many lines more (+) or fewer (−) than optimal. */
  looseness?: number;
  linePenalty?: number;
  adjDemerits?: number;
  doubleHyphenDemerits?: number;
  finalHyphenDemerits?: number;
  /** Most hyphenated lines in a row. */
  maxHyphens?: number;
}

export interface BreakResult {
  /** Item index of each line's break (the last is the paragraph's end). */
  breaks: number[];
  /** Each line's adjustment ratio (−1 = fully shrunk, 1 = fully stretched). */
  ratios: number[];
  /** Lines that stick out (couldn't shrink enough). */
  overfull: number;
  /** Which pass succeeded (1–3). */
  pass: number;
}

interface Node {
  pos: number;
  line: number;
  fitness: number;
  w: number;
  y: number;
  z: number;
  demerits: number;
  ratio: number;
  hyphens: number;
  flagged: boolean;
  overfull: boolean;
  prev: Node | null;
}

interface Pass {
  tolerance: number;
  hyphenate: boolean;
  emergency: number;
  final: boolean;
}

function fitnessOf(r: number): number {
  if (r < -0.5) return 3;
  if (r <= 0.5) return 2;
  if (r <= 1) return 1;
  return 0;
}

export function breakLines(items: Items, o: BreakOptions): BreakResult {
  const passes: Pass[] = [
    { tolerance: o.pretolerance ?? 100, hyphenate: false, emergency: 0, final: false },
    { tolerance: o.tolerance ?? 200, hyphenate: true, emergency: 0, final: false },
    { tolerance: o.finalTolerance ?? 10000, hyphenate: true, emergency: o.emergencyStretch ?? 0, final: true },
  ];
  // Looseness needs alternatives: skip the strict first pass.
  const from = o.looseness ? 1 : 0;
  for (let p = from; p < passes.length; p += 1) {
    const result = runPass(items, o, passes[p]);
    if (result) return { ...result, pass: p + 1 };
  }
  // The final pass always returns; this is only reached for empty input.
  return { breaks: [Math.max(0, items.length - 1)], ratios: [0], overfull: 0, pass: 3 };
}

function runPass(items: Items, o: BreakOptions, pass: Pass): Omit<BreakResult, "pass"> | null {
  const n = items.length;
  if (n === 0) return null;
  const widths = o.widths.length ? o.widths : [Infinity];
  const linePenalty = o.linePenalty ?? 10;
  const adjDemerits = o.adjDemerits ?? 10000;
  const doubleHyphen = o.doubleHyphenDemerits ?? 10000;
  const finalHyphen = o.finalHyphenDemerits ?? 5000;
  const maxHyphens = o.maxHyphens ?? 2;
  const looseness = o.looseness ?? 0;
  // Beyond the varying widths, line numbers don't change the future, so
  // candidates merge — unless looseness asks to keep every line count.
  const easyLine = looseness ? Infinity : widths.length;

  const { type, width, stretch, shrink, cost, flagged, auto } = items;
  let sumW = 0;
  let sumY = 0;
  let sumZ = 0;

  let active: Node[] = [
    {
      pos: -1,
      line: 0,
      fitness: 2,
      w: 0,
      y: 0,
      z: 0,
      demerits: 0,
      ratio: 0,
      hyphens: 0,
      flagged: false,
      overfull: false,
      prev: null,
    },
  ];

  /** Totals after a break at `b`: discardable glue that follows is skipped. */
  const after = (b: number) => {
    let w = sumW;
    let y = sumY;
    let z = sumZ;
    for (let i = b; i < n; i += 1) {
      if (type[i] === GLUE) {
        w += width[i];
        y += stretch[i];
        z += shrink[i];
      } else if (type[i] === BOX || (type[i] === PENALTY && cost[i] <= -INF_PENALTY && i > b)) {
        break;
      }
    }
    return { w, y, z };
  };

  const tryBreak = (b: number) => {
    const isPenalty = type[b] === PENALTY;
    const pi = isPenalty ? cost[b] : 0;
    const forced = isPenalty && pi <= -INF_PENALTY;
    const bFlagged = isPenalty && flagged[b];
    const candidates = new Map<number, Node>();
    const next: Node[] = [];

    for (let ai = 0; ai < active.length; ai += 1) {
      const a = active[ai];
      const lineWidth = widths[Math.min(a.line, widths.length - 1)];
      const natural = sumW - a.w + (isPenalty ? width[b] : 0);
      let r: number;
      if (natural < lineWidth) {
        const y = sumY - a.y + pass.emergency;
        r = y > 0 ? (lineWidth - natural) / y : Infinity;
      } else if (natural > lineWidth) {
        const z = sumZ - a.z;
        r = z > 0 ? (lineWidth - natural) / z : -Infinity;
      } else {
        r = 0;
      }
      const badness = r < -1 ? Infinity : Math.min(10000, 100 * Math.abs(r) ** 3);

      const keep = !(r < -1 || forced);
      let artificial = false;
      if (!keep && pass.final && candidates.size === 0 && next.length === 0 && ai === active.length - 1) {
        // About to lose the last active node with nothing feasible: break
        // here anyway (an overfull or very loose line), as TeX's final pass.
        artificial = true;
      }

      const tooManyHyphens = bFlagged && a.flagged && a.hyphens >= maxHyphens;
      if ((badness <= pass.tolerance && r >= -1 && !tooManyHyphens) || artificial) {
        let d: number;
        if (artificial) {
          d = 0;
        } else {
          d = (linePenalty + badness) ** 2;
          if (pi >= 0) d += pi * pi;
          else if (pi > -INF_PENALTY) d -= pi * pi;
          if (bFlagged && a.flagged) d += doubleHyphen;
          if (forced && a.flagged) d += finalHyphen;
        }
        const fit = artificial ? 2 : fitnessOf(r);
        if (!artificial && Math.abs(fit - a.fitness) > 1) d += adjDemerits;
        d += a.demerits;
        const line = a.line + 1;
        const key = fit * 1e7 + Math.min(line, easyLine);
        const existing = candidates.get(key);
        if (!existing || d < existing.demerits) {
          candidates.set(key, {
            pos: b,
            line,
            fitness: fit,
            w: 0,
            y: 0,
            z: 0,
            demerits: d,
            ratio: Number.isFinite(r) ? r : r > 0 ? 10 : -1,
            hyphens: bFlagged ? (a.flagged ? a.hyphens + 1 : 1) : 0,
            flagged: bFlagged,
            overfull: r < -1,
            prev: a,
          });
        }
      }
      if (keep) next.push(a);
    }

    if (candidates.size) {
      const t = after(b);
      for (const c of candidates.values()) {
        c.w = t.w;
        c.y = t.y;
        c.z = t.z;
        next.push(c);
      }
    }
    active = next;
  };

  for (let i = 0; i < n; i += 1) {
    const t = type[i];
    if (t === BOX) {
      sumW += width[i];
    } else if (t === GLUE) {
      if (i > 0 && type[i - 1] === BOX) tryBreak(i);
      sumW += width[i];
      sumY += stretch[i];
      sumZ += shrink[i];
    } else if (cost[i] < INF_PENALTY) {
      if (!pass.hyphenate && auto[i]) continue;
      tryBreak(i);
    }
    if (active.length === 0) return null;
  }

  // The paragraph ends with a forced break, so every survivor ends there.
  const finals = active.filter((a) => a.pos === n - 1);
  if (!finals.length) return null;
  let best = finals[0];
  for (const f of finals) if (f.demerits < best.demerits) best = f;
  if (looseness) {
    const target = best.line + looseness;
    let chosen = best;
    for (const f of finals) {
      const dist = Math.abs(f.line - target);
      const bestDist = Math.abs(chosen.line - target);
      if (dist < bestDist || (dist === bestDist && f.demerits < chosen.demerits)) chosen = f;
    }
    best = chosen;
  }

  const breaks: number[] = [];
  const ratios: number[] = [];
  let overfull = 0;
  for (let node: Node | null = best; node && node.pos >= 0; node = node.prev) {
    breaks.push(node.pos);
    ratios.push(node.ratio);
    if (node.overfull) overfull += 1;
  }
  breaks.reverse();
  ratios.reverse();
  return { breaks, ratios, overfull };
}

/** Where each line's content starts: after a break, discardable glue and
 *  penalties are dropped (up to the next box or forced break). */
export function lineStarts(items: Items, breaks: number[]): number[] {
  const starts: number[] = [];
  let from = 0;
  for (const b of breaks) {
    let s = from;
    while (s < b && !items.isBox(s) && !(items.isPenalty(s) && items.cost[s] <= -INF_PENALTY)) s += 1;
    starts.push(s);
    from = b + 1;
  }
  return starts;
}
