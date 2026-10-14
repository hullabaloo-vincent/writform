/**
 * The checker at work on one open document: it reads the text when the
 * Check panel opens and again after each pause in the writing, keeps what
 * it found, shows a finding in the text and makes its fixes.
 *
 * It exists only while the panel is open. A reading never moves the
 * selection: only the writer choosing a place does.
 */

import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection, type Selection } from "@tiptap/pm/state";
import type * as Y from "yjs";

import { quoteStyleFor } from "../editor/SmartPunctuation";
import { applyFixes, fixable, type Target } from "./apply";
import { CHECKS } from "./checks";
import { loadVariants, variantsLoaded } from "./checks/spelling";
import { placeKey, snippet } from "./engine/place";
import { Reader, type Job, type Read } from "./engine/run";
import { extract, rangeOf, type Extracted } from "./extract";
import { addProofPlugin, paintProof, PAINT_MAX, removeProofPlugin, type Painted } from "./ProofDecorations";
import { analyse, styleOf, type StyleAnalysis } from "./reports/analysis";
import { buildReport, chapterRows, type ReportOptions } from "./reports";
import type { ChapterRow, Hit, ReportId, ReportResult, Scope } from "./reports/types";
import { Vocab } from "./reports/vocab";
import { docRules, onDocRulesChange, readDocRules } from "./rules/docRules";
import { showInText, touchFirst } from "../editor/ui/reveal";
import { globalRules, useGlobalRules } from "./rules/globalRules";
import { effective, type Effective } from "./rules/layer";
import type { Env, Issue, Place } from "./types";

/** How long after the last change the text is read again, and the longest
 *  a reading waits while the writing goes on. */
const QUIET_MS = 400;
const LONGEST_MS = 2000;
/** How long one turn of a reading may hold the page. */
const TURN_MS = 8;

export function envFor(format: string, lang: string): Env {
  const tag = (lang || "en").toLowerCase();
  const style = quoteStyleFor(tag);
  const one = (mark: string) => mark.trim()[0] ?? mark;
  return {
    lang: tag,
    base: tag.split(/[-_]/)[0],
    quotes: { open2: one(style.open2), close2: one(style.close2), open1: one(style.open1), close1: one(style.close1), spaced: style.open2.length > 1 },
    format,
    // (Highlighting is only drawn in a Document.)
    highlights: format === "none",
  };
}

/** A place as the panel shows it, and enough to find it again later. */
export interface PlaceView {
  issue: string;
  key: string;
  from: number;
  to: number;
  before: string;
  match: string;
  after: string;
  form: string | null;
  /** The forms it can be changed to here and now. */
  fixes: string[];
}

export type FixResult = "done" | "changed" | "locked";

/** Where a finding is set aside: in the document's rules (for everyone
 *  who writes it), in the writer's own (for every document), or only
 *  until the panel closes. */
export type SkipWhere = "document" | "yours" | "now";

export interface ProofOptions {
  /** The document's own Y.Doc: where its rules are kept. */
  ydoc?: Y.Doc | null;
  /** This person may change the document (and so its rules). */
  canWrite?: boolean;
}

export class ProofSession {
  readonly env: Env;
  private reader: Reader;
  private rules: Effective;
  private ydoc: Y.Doc | null;
  private writes: boolean;
  private unlisten: (() => void)[] = [];
  private extracted: Extracted | null = null;
  private last: Read | null = null;
  private job: { job: Job; extracted: Extracted } | null = null;
  private turn: ReturnType<typeof setTimeout> | null = null;
  private wait: ReturnType<typeof setTimeout> | null = null;
  private dirtySince = 0;
  private listeners = new Set<() => void>();
  private keys = new WeakMap<Issue, string[]>();
  private skippedIssues = new Set<string>();
  private skippedPlaces = new Map<string, Set<string>>();
  private picks = new Map<string, string>();
  private outside = { comments: 0, changes: 0 };
  private listed: { version: number; issues: Issue[] } | null = null;
  private shown: { issue: string; key: string | null; from: number } | null = null;
  private stopped = false;
  private vocab: Vocab;
  /** The text read for its style: made when a report first asks, and again
   *  after each reading while the reports are in use. */
  private styled: { read: Read; analysis: StyleAnalysis; rows: ChapterRow[]; reports: Map<string, ReportResult> } | null = null;
  private marked: { hits: Hit[]; current: number; slot: number } | null = null;

  /** Goes up whenever what the panel shows may have changed. */
  version = 0;
  status: "reading" | "ready" = "reading";
  progress = 0;
  /** How many readings have been made (for tests). */
  readings = 0;

  constructor(
    private editor: Editor,
    format: string,
    lang: string,
    options: ProofOptions = {},
  ) {
    this.env = envFor(format, lang);
    this.reader = new Reader(this.env, CHECKS);
    this.vocab = new Vocab(this.env.base);
    this.ydoc = options.ydoc ?? null;
    this.writes = options.canWrite !== false;
    this.rules = this.rulesNow();
  }

  private rulesNow(): Effective {
    return effective(this.env, globalRules(), this.ydoc ? readDocRules(this.ydoc) : null);
  }

  /** The house style in force, for the panel to show. */
  get style(): Effective {
    return this.rules;
  }

  /** Whether what is set aside can be kept in the document. */
  get keepsInDocument(): boolean {
    return !!this.ydoc && this.writes;
  }

  /** The rules changed (here, or a co-writer changed the document's). The
   *  text is read again only when that could change what is found. */
  private onRules = (): void => {
    if (this.stopped) return;
    const next = this.rulesNow();
    const reread = next.stamp !== this.rules.stamp;
    this.rules = next;
    this.listed = null;
    if (reread) {
      this.extracted = null;
      if (this.last) this.flush();
      else this.begin();
    } else {
      this.emit();
      this.repaint();
    }
  };

  // ---- life

  start(): void {
    addProofPlugin(this.editor);
    this.editor.on("update", this.onUpdate);
    if (this.ydoc) this.unlisten.push(onDocRulesChange(this.ydoc, this.onRules));
    this.unlisten.push(useGlobalRules.subscribe(this.onRules));
    this.begin();
    // The table of spellings is for English and is fetched only now. The
    // text is read again when it arrives.
    if (this.env.base === "en" && !variantsLoaded()) {
      void import("./data/en/variants")
        .then(({ VARIANTS }) => {
          loadVariants(VARIANTS);
          if (this.stopped) return;
          this.extracted = null;
          if (this.last) this.flush();
          else this.begin();
        })
        .catch(() => {
          // Without it the spelling check has nothing to say. The rest runs.
        });
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
    if (this.wait) clearTimeout(this.wait);
    this.editor.off("update", this.onUpdate);
    for (const off of this.unlisten) off();
    this.unlisten = [];
    removeProofPlugin(this.editor);
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  private onUpdate = (): void => {
    if (this.stopped) return;
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    if (this.wait) clearTimeout(this.wait);
    const left = Math.max(0, Math.min(QUIET_MS, this.dirtySince + LONGEST_MS - now));
    this.wait = setTimeout(() => this.begin(), left);
  };

  private cancel(): void {
    if (this.turn) clearTimeout(this.turn);
    this.turn = null;
    this.job = null;
  }

  /** Start reading the text as it stands, a turn at a time. */
  private begin(): void {
    if (this.stopped || this.editor.isDestroyed) return;
    this.cancel();
    if (this.wait) clearTimeout(this.wait);
    this.wait = null;
    this.dirtySince = 0;
    // (Already read: a fix reads the text again as it is made.)
    if (this.last && this.extracted?.doc === this.editor.state.doc) return;
    const extracted = extract(this.editor.state.doc, this.env.format);
    const job = this.reader.read(extracted.scan, this.rules);
    this.job = { job, extracted };
    if (!this.last) {
      this.status = "reading";
      this.progress = 0;
    }
    const turn = () => {
      this.turn = null;
      if (this.job?.job !== job) return;
      if (job.step(TURN_MS)) this.finish(job.result() as Read, extracted);
      else {
        if (!this.last) {
          this.progress = job.progress();
          this.emit();
        }
        this.turn = setTimeout(turn, 0);
      }
    };
    this.turn = setTimeout(turn, 0);
  }

  private finish(read: Read, extracted: Extracted): void {
    this.job = null;
    this.last = read;
    this.extracted = extracted;
    this.status = "ready";
    this.progress = 1;
    this.readings += 1;
    this.listed = null;
    this.emit();
    this.repaint();
    // (A report's places are redrawn by the panel, from the new report.)
    if (this.marked) paintProof(this.editor, []);
  }

  /** Bring the reading up to the text as it is this instant. Cheap: all but
   *  the paragraphs that changed is kept. */
  flush(): void {
    if (this.stopped || this.editor.isDestroyed) return;
    if (this.last && this.extracted?.doc === this.editor.state.doc) return;
    this.cancel();
    if (this.wait) clearTimeout(this.wait);
    this.wait = null;
    this.dirtySince = 0;
    const extracted = extract(this.editor.state.doc, this.env.format);
    this.finish(this.reader.readNow(extracted.scan, this.rules), extracted);
  }

  /** The text has been read at least once. */
  get hasRead(): boolean {
    return this.last !== null;
  }

  /** How many paragraphs the last reading had to read afresh (for tests). */
  get made(): number {
    return this.reader.made;
  }

  // ---- what was found

  /** Comments and suggested changes still open: counted by the editor. */
  setOutside(comments: number, changes: number): void {
    if (comments === this.outside.comments && changes === this.outside.changes) return;
    this.outside = { comments, changes };
    this.listed = null;
    this.emit();
  }

  private keysOf(issue: Issue): string[] {
    let keys = this.keys.get(issue);
    if (!keys && this.last) {
      const { scan, facts } = this.last;
      keys = issue.places.map((p) => placeKey(issue.check, issue.key, scan.blocks[p.block].text, facts[p.block].tokens, p.start, p.end));
      this.keys.set(issue, keys);
    }
    return keys ?? [];
  }

  /** The findings, less what the writer has set aside. */
  issues(): Issue[] {
    if (this.listed?.version === this.version) return this.listed.issues;
    const out: Issue[] = [];
    const rules = this.rules;
    for (const found of this.last?.analysis.issues ?? []) {
      if (this.skippedIssues.has(found.id) || rules.skipsIssue(found.id)) continue;
      let issue = found;
      const skipped = this.skippedPlaces.get(found.id);
      if (skipped?.size || rules.hasPlaces) {
        const keys = this.keysOf(found);
        const gone = (key: string) => skipped?.has(key) === true || rules.skipsPlace(key);
        const places = found.places.filter((_, i) => !gone(keys[i]));
        if (!places.length) continue;
        if (places.length !== found.places.length) {
          issue = { ...found, places };
          this.keys.set(
            issue,
            keys.filter((k) => !gone(k)),
          );
        }
      }
      const said = this.picks.get(found.id);
      const kept = rules.pick(found.id);
      const pick = said ?? kept?.form;
      if (pick && issue.forms.some((f) => f.id === pick)) {
        const keys = this.keysOf(issue);
        issue = { ...issue, preferred: pick, preferredFrom: said ? null : (kept?.from ?? null) };
        this.keys.set(issue, keys);
      }
      out.push(issue);
    }
    const { comments, changes } = this.outside;
    const open = (key: "comments" | "changes", count: number, title: string, detail: string) =>
      out.push({ id: `leftovers:${key}`, check: "leftovers", key, group: "leftovers", kind: "look", title, detail, forms: [], preferred: null, preferredFrom: null, places: [], open: { what: key, count } });
    if (comments && this.rules.on("leftovers") && !this.skippedIssues.has("leftovers:comments") && !this.rules.skipsIssue("leftovers:comments")) open("comments", comments, "Open comments", "Comments that nobody has resolved.");
    if (changes && this.rules.on("leftovers") && !this.skippedIssues.has("leftovers:changes") && !this.rules.skipsIssue("leftovers:changes")) open("changes", changes, "Suggested changes", "Changes waiting to be accepted or rejected.");
    this.listed = { version: this.version, issues: out };
    return out;
  }

  /** Checks that ran and found nothing, and checks left out for the language. */
  quiet(): { quiet: number; unread: number } {
    return { quiet: this.last?.analysis.quiet.length ?? 0, unread: this.last?.analysis.unread.length ?? 0 };
  }

  /** The places of an issue still to be dealt with: not those already in
   *  the form taken to be meant. */
  todo(issue: Issue): Place[] {
    // (With no form chosen yet, every place is one to look at.)
    if (issue.kind !== "consistency" || issue.preferred === null) return issue.places;
    return issue.places.filter((p) => p.form !== issue.preferred);
  }

  count(issue: Issue): number {
    return issue.open ? issue.open.count : this.todo(issue).length;
  }

  /** The form a place would be changed to: the one meant, or for an issue
   *  with one answer, that answer. */
  target(issue: Issue): string | null {
    return issue.kind === "consistency" ? issue.preferred : "";
  }

  view(issue: Issue, place: Place): PlaceView {
    const read = this.last as Read;
    const pos = (this.extracted as Extracted).places[place.block];
    const index = issue.places.indexOf(place);
    const { from, to } = rangeOf(pos, place.start, place.end);
    const editable = this.editor.isEditable;
    return {
      issue: issue.id,
      key: this.keysOf(issue)[index] ?? "",
      from,
      to,
      ...snippet(read.scan.blocks[place.block].text, place.start, place.end),
      form: place.form,
      fixes: editable ? Object.keys(place.fixes ?? {}).filter((form) => fixable(pos, (place.fixes as NonNullable<Place["fixes"]>)[form])) : [],
    };
  }

  /** Find a place again in the text as it is now (it may have moved, or
   *  gone). */
  private locate(ref: { issue: string; key: string; from: number }): { issue: Issue; place: Place } | null {
    this.flush();
    const issue = this.issues().find((i) => i.id === ref.issue);
    if (!issue || !this.extracted) return null;
    const keys = this.keysOf(issue);
    let best: Place | null = null;
    let gap = Infinity;
    issue.places.forEach((place, i) => {
      if (keys[i] !== ref.key) return;
      const { from } = rangeOf((this.extracted as Extracted).places[place.block], place.start, place.end);
      const d = Math.abs(from - ref.from);
      if (d < gap) {
        gap = d;
        best = place;
      }
    });
    return best ? { issue, place: best } : null;
  }

  // ---- in the text

  /** Draw an issue's places, and say which one is being looked at. */
  private paint(issue: Issue | null, current: Place | null): void {
    if (!issue || !this.extracted) {
      paintProof(this.editor, []);
      return;
    }
    const places = this.todo(issue);
    // (Round the one being looked at when there are more than can be drawn.)
    const at = current ? Math.max(0, places.indexOf(current)) : 0;
    const first = Math.max(0, Math.min(at - PAINT_MAX / 2, places.length - PAINT_MAX));
    const ranges: Painted[] = places.slice(first, first + PAINT_MAX).map((place) => ({ ...rangeOf((this.extracted as Extracted).places[place.block], place.start, place.end), current: place === current }));
    if (current && !places.includes(current)) ranges.push({ ...rangeOf(this.extracted.places[current.block], current.start, current.end), current: true });
    paintProof(this.editor, ranges);
  }

  /** After a reading: the same issue, where its places are now. */
  private repaint(): void {
    if (!this.shown) return;
    const issue = this.issues().find((i) => i.id === this.shown?.issue) ?? null;
    let current: Place | null = null;
    if (issue && this.shown.key) {
      const keys = this.keysOf(issue);
      let gap = Infinity;
      issue.places.forEach((place, i) => {
        if (keys[i] !== this.shown?.key) return;
        const d = Math.abs(rangeOf((this.extracted as Extracted).places[place.block], place.start, place.end).from - (this.shown?.from ?? 0));
        if (d < gap) {
          gap = d;
          current = place;
        }
      });
    }
    this.paint(issue, current);
  }

  /** Show an issue's places in the text (null: none). */
  showIssue(id: string | null): void {
    this.shown = id ? { issue: id, key: null, from: 0 } : null;
    if (!this.shown) {
      if (!this.marked) paintProof(this.editor, []);
      return;
    }
    this.marked = null;
    this.repaint();
  }

  /**
   * Select a stretch of the text and bring it into view. The scrolling is
   * done here and not left to the editor, which only scrolls to a
   * selection while it has the focus (see editor/ui/reveal.ts). With a mouse the
   * text is then given the focus, so the place can be typed over at once.
   * On a touch screen it is not: that would raise the keyboard over it.
   */
  private go(selection: Selection): void {
    showInText(this.editor.view, selection, !touchFirst());
  }

  /** Select a place and scroll to it. False when the place has gone. */
  select(ref: PlaceView): boolean {
    const hit = this.locate(ref);
    if (!hit || !this.extracted) return false;
    const { doc } = this.editor.state;
    const pos = this.extracted.places[hit.place.block];
    const { from, to } = rangeOf(pos, hit.place.start, hit.place.end);
    const note = this.last?.scan.blocks[hit.place.block].note;
    // (A note's words are edited in its own small editor: select the note.)
    const selection = note ? NodeSelection.create(doc, pos.start - 1) : TextSelection.create(doc, from, to);
    this.shown = { issue: hit.issue.id, key: ref.key, from };
    this.go(selection);
    this.paint(hit.issue, hit.place);
    return true;
  }

  // ---- fixes

  private apply(targets: Target[]): number {
    if (!targets.length) return 0;
    const tr = this.editor.state.tr;
    const made = applyFixes(tr, this.editor.schema, targets);
    if (made) this.editor.view.dispatch(tr);
    return made;
  }

  /** Change one place to `form`. */
  fix(ref: PlaceView, form: string): FixResult {
    if (!this.editor.isEditable) return "locked";
    const hit = this.locate(ref);
    if (!hit || !this.extracted) return "changed";
    const fix = hit.place.fixes?.[form];
    const pos = this.extracted.places[hit.place.block];
    if (!fix || !fixable(pos, fix)) return "locked";
    this.shown = { issue: hit.issue.id, key: null, from: 0 };
    this.apply([{ place: pos, fix }]);
    this.flush();
    return "done";
  }

  /** Change every place of an issue that can be changed to `form`, as one
   *  step (one undo). Returns how many. */
  fixAll(id: string, form: string): number {
    if (!this.editor.isEditable) return 0;
    this.flush();
    const issue = this.issues().find((i) => i.id === id);
    if (!issue || !this.extracted) return 0;
    const targets: Target[] = [];
    for (const place of issue.places) {
      const fix = place.fixes?.[form];
      if (!fix || place.review || (issue.kind === "consistency" && place.form === form)) continue;
      targets.push({ place: this.extracted.places[place.block], fix });
    }
    const made = this.apply(targets);
    this.flush();
    return made;
  }

  /** How many places Fix all would change. */
  fixableCount(issue: Issue, form: string | null): number {
    if (form === null || !this.editor.isEditable || !this.extracted) return 0;
    let n = 0;
    for (const place of issue.places) {
      const fix = place.fixes?.[form];
      if (fix && !place.review && !(issue.kind === "consistency" && place.form === form) && fixable(this.extracted.places[place.block], fix)) n += 1;
    }
    return n;
  }

  // ---- setting aside

  /** Set one place aside. Kept in the document where this person may
   *  change it (so a co-writer isn't asked again), else until the panel
   *  closes. It lapses when the words at that place change. */
  skipPlace(ref: PlaceView): void {
    if (this.ydoc && this.writes) {
      docRules.place(this.ydoc, ref.key);
      return;
    }
    let set = this.skippedPlaces.get(ref.issue);
    if (!set) this.skippedPlaces.set(ref.issue, (set = new Set()));
    set.add(ref.key);
    this.listed = null;
    this.emit();
    this.repaint();
  }

  /** Set a whole finding aside. */
  skipIssue(id: string, where: SkipWhere = "now"): void {
    if (this.shown?.issue === id) this.shown = null;
    if (where === "yours") {
      useGlobalRules.getState().never(id, true);
      return;
    }
    if (where === "document" && this.ydoc && this.writes) {
      docRules.never(this.ydoc, id, true);
      return;
    }
    this.skippedIssues.add(id);
    this.listed = null;
    this.emit();
    this.repaint();
  }

  // ---- the reports

  /** The text read for its style. Cheap after the first time: each block's
   *  part is kept with the block. */
  styleNow(): StyleAnalysis | null {
    const read = this.last;
    if (!read) return null;
    if (this.styled?.read === read) return this.styled.analysis;
    const { scan, facts } = read;
    const analysis = analyse(
      scan,
      scan.blocks.map((_, i) => styleOf(scan, facts, i, this.vocab)),
      this.vocab,
      this.env,
      facts,
    );
    this.styled = { read, analysis, rows: chapterRows(analysis), reports: new Map() };
    return analysis;
  }

  /** Words the writer has said are fine: no report remarks on them. */
  private fine(): Set<string> {
    return new Set(this.rules.words.filter((w) => w.kind === "allow").map((w) => w.find));
  }

  report(id: ReportId, scope: Scope, options: ReportOptions = {}): ReportResult | null {
    const analysis = this.styleNow();
    if (!analysis || !this.styled) return null;
    const key = `${id}|${JSON.stringify(scope)}|${this.rules.wordsStamp}|${options.speech ?? ""}`;
    let made = this.styled.reports.get(key);
    if (!made) {
      made = buildReport(id, analysis, scope, this.fine(), this.styled.rows, options);
      this.styled.reports.set(key, made);
    }
    return made;
  }

  chapters(): ChapterRow[] {
    return this.styleNow() && this.styled ? this.styled.rows : [];
  }

  /** Hear when the selection moves. */
  onSelection(fn: () => void): () => void {
    this.editor.on("selectionUpdate", fn);
    return () => void this.editor.off("selectionUpdate", fn);
  }

  /** The chapter the caret is in, or -1. */
  chapterAtCaret(): number {
    const analysis = this.styleNow();
    if (!analysis || !this.extracted) return -1;
    const block = this.blockAt(this.editor.state.selection.from);
    return block < 0 ? -1 : analysis.chapterOf[block];
  }

  /** The paragraphs the selection touches, as a scope (null: no selection). */
  selectionScope(): Scope | null {
    const { from, to, empty } = this.editor.state.selection;
    if (empty || !this.extracted) return null;
    const a = this.blockAt(from);
    const b = this.blockAt(to);
    return a < 0 || b < 0 ? null : { kind: "blocks", from: a, to: b + 1 };
  }

  /** The block a document position is in (the last that starts at or before it). */
  private blockAt(pos: number): number {
    const places = this.extracted?.places ?? [];
    let lo = 0;
    let hi = places.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (places[mid].start <= pos) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  private rangeOfHit(hit: Hit): { from: number; to: number } | null {
    const place = this.extracted?.places[hit.block];
    return place ? rangeOf(place, hit.start, hit.end) : null;
  }

  /** Draw a report's places in the text, one of them marked. */
  markHits(hits: Hit[], current: number, slot: number): void {
    this.shown = null;
    this.marked = { hits, current, slot };
    this.repaintHits();
  }

  private repaintHits(): void {
    const m = this.marked;
    if (!m || !this.extracted || this.styled?.read !== this.last) {
      if (m) paintProof(this.editor, []);
      return;
    }
    const first = Math.max(0, Math.min(m.current - PAINT_MAX / 2, m.hits.length - PAINT_MAX));
    const ranges: Painted[] = [];
    m.hits.slice(first, first + PAINT_MAX).forEach((hit, i) => {
      const range = this.rangeOfHit(hit);
      if (range) ranges.push({ ...range, slot: m.slot, current: first + i === m.current });
    });
    paintProof(this.editor, ranges);
  }

  clearHits(): void {
    if (!this.marked) return;
    this.marked = null;
    paintProof(this.editor, []);
  }

  /** Select a report's place and scroll to it. False when the text has
   *  changed since the report was made (it is read again at once). */
  selectHit(hit: Hit): boolean {
    if (!this.extracted || this.extracted.doc !== this.editor.state.doc || this.styled?.read !== this.last) {
      this.flush();
      return false;
    }
    const range = this.rangeOfHit(hit);
    if (!range) return false;
    this.go(TextSelection.create(this.editor.state.doc, range.from, range.to));
    return true;
  }

  /** Whether this person can change the text now. */
  get editable(): boolean {
    return this.editor.isEditable;
  }

  /** Whether the text is read as fiction (speech is then left out of the
   *  Word choice report unless asked for). */
  get fiction(): boolean {
    return this.styleNow()?.fiction ?? false;
  }

  /** Make the fixes of a report's places, as one step. Returns how many,
   *  or -1 when the text has changed since the report (it is read again). */
  fixHits(hits: Hit[]): number {
    if (!this.editor.isEditable) return 0;
    if (!this.extracted || this.extracted.doc !== this.editor.state.doc || this.styled?.read !== this.last) {
      this.flush();
      return -1;
    }
    const places = this.extracted.places;
    const targets: Target[] = [];
    for (const hit of hits) if (hit.fix) targets.push({ place: places[hit.block], fix: { edits: hit.fix } });
    const made = this.apply(targets);
    this.marked = null;
    this.flush();
    return made;
  }

  /** Put the caret at the start of a block (a chapter's heading). */
  goToBlock(block: number): void {
    const place = this.extracted?.places[block];
    if (!place || this.extracted?.doc !== this.editor.state.doc) return;
    const { doc } = this.editor.state;
    this.go(TextSelection.create(doc, Math.min(place.start, doc.content.size)));
  }

  /** Never remark on a word again: in this document, or in all of them. */
  allowWord(word: string, where: "document" | "yours"): void {
    if (where === "document" && this.ydoc && this.writes) docRules.word(this.ydoc, { k: "allow", find: word });
    else useGlobalRules.getState().word({ k: "allow", find: word });
  }

  /** Have a word pointed out each time it is used. */
  watchWord(word: string, where: "document" | "yours"): void {
    if (where === "document" && this.ydoc && this.writes) docRules.word(this.ydoc, { k: "look", find: word });
    else useGlobalRules.getState().word({ k: "look", find: word });
  }

  /** Say which form is meant. */
  prefer(id: string, form: string): void {
    this.picks.set(id, form);
    this.listed = null;
    this.emit();
    this.repaint();
  }
}
