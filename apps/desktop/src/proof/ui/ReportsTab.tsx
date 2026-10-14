import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Flyout, FlyoutItem } from "../../editor/ui/Flyout";
import { toast } from "../../platform/toast";
import { REPORTS } from "../reports";
import { GUIDE_FOOT } from "../reports/guides";
import type { ChapterRow, HitGroup, HitItem, Measure, ReportId, ReportResult, Scope } from "../reports/types";
import type { ProofSession } from "../session";
import { Bars } from "./charts/Bars";
import { LengthStrip } from "./charts/LengthStrip";
import { PaceMap } from "./charts/PaceMap";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");
/** How many rows of a list are shown before "Show more". */
const PAGE = 40;

type Where = "all" | "chapter" | "selection";

/**
 * The Reports tab: what the text is like, in numbers, charts and lists of
 * places. Nothing here is a fault to fix. Each report says what was
 * counted, and choosing a row shows it in the text.
 */
export function ReportsTab({ session, book }: { session: ProofSession; book: boolean }) {
  const [where, setWhere] = useState<Where>("all");
  /** The chapter looked at (kept while the caret wanders, once chosen from the table). */
  const [chapter, setChapter] = useState<number | null>(null);
  const [open, setOpen] = useState<ReportId | null>(null);
  /** Word choice: also look inside quote marks (null: as the text's kind has it). */
  const [speech, setSpeech] = useState<boolean | null>(null);
  const rows = session.chapters();
  const selection = session.selectionScope();
  const here = chapter ?? session.chapterAtCaret();
  const scope: Scope = where === "selection" && selection ? selection : where === "chapter" && here >= 0 && rows.length > 1 ? { kind: "chapter", index: here } : { kind: "all" };
  // (Leaving the tab takes its marks out of the text.)
  useEffect(() => () => session.clearHits(), [session]);
  // "This chapter" and "Selection" follow the caret, a moment behind it.
  const [, setMoved] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = session.onSelection(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMoved((n) => n + 1), 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [session]);

  const scopeName = scope.kind === "chapter" ? (rows[scope.index]?.name ?? "") : scope.kind === "blocks" ? "The selection" : book ? "The whole book" : "The whole text";
  const options = speech === null ? {} : { speech };
  const report = open ? session.report(open, scope, options) : null;

  return (
    <div className="wf-proof-body">
      <div className="wf-review-modes wf-proof-scope" role="group" aria-label="What to report on">
        <button
          type="button"
          className={scope.kind === "all" ? "active" : ""}
          aria-pressed={scope.kind === "all"}
          onClick={() => {
            setWhere("all");
            setChapter(null);
          }}
        >
          {book ? "Whole book" : "Whole text"}
        </button>
        <button type="button" className={scope.kind === "chapter" ? "active" : ""} aria-pressed={scope.kind === "chapter"} disabled={rows.length < 2} onClick={() => setWhere("chapter")}>
          This chapter
        </button>
        <button type="button" className={scope.kind === "blocks" ? "active" : ""} aria-pressed={scope.kind === "blocks"} disabled={!selection} onClick={() => setWhere("selection")}>
          Selection
        </button>
      </div>
      {scope.kind !== "all" && <p className="wf-proof-dim">{scope.kind === "chapter" ? `Reporting on ${scopeName}.` : "Reporting on the paragraphs your selection touches."}</p>}

      {open && report ? (
        <ReportView
          key={`${open}:${JSON.stringify(scope)}`}
          session={session}
          report={report}
          rows={rows}
          speech={open === "wording" ? (speech ?? !session.fiction) : null}
          onSpeech={setSpeech}
          onBack={() => {
            session.clearHits();
            setOpen(null);
          }}
          onChapter={(row) => {
            setChapter(row.index);
            setWhere("chapter");
            session.goToBlock(row.block);
          }}
        />
      ) : (
        <ul className="wf-proof-reports">
          {REPORTS.map((r) => {
            const made = session.report(r.id, scope, options);
            return (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r.id)}>
                  <b>{r.label}</b>
                  <span>{made?.headline ?? r.about}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MeasureRow({ measure }: { measure: Measure }) {
  const guide = measure.guide;
  return (
    <li>
      <span>{measure.label}</span>
      <b>{measure.text}</b>
      {guide && (
        <p>
          {guide.state === "in" ? "In the usual range." : guide.state === "above" ? "Higher than usual." : "Lower than usual."} {guide.note} {GUIDE_FOOT} <i>{guide.source}.</i>
        </p>
      )}
    </li>
  );
}

function ReportView({
  session,
  report,
  rows,
  speech,
  onSpeech,
  onBack,
  onChapter,
}: {
  session: ProofSession;
  report: ReportResult;
  rows: ChapterRow[];
  /** Whether speech is looked at too (null: this report has no such choice). */
  speech: boolean | null;
  onSpeech: (on: boolean) => void;
  onBack: () => void;
  onChapter: (row: ChapterRow) => void;
}) {
  const title = REPORTS.find((r) => r.id === report.id)?.label ?? "";
  /** The list being stepped through, and where in it. */
  const [walk, setWalk] = useState<{ group: string; item: number; hit: number } | null>(null);
  const groupAt = (id: string) => report.groups.findIndex((g) => g.id === id);

  const show = (group: HitGroup, item: number, hit: number) => {
    const hits = group.items[item]?.hits ?? [];
    if (!hits.length) return;
    const at = (hit + hits.length) % hits.length;
    setWalk({ group: group.id, item, hit: at });
    session.markHits(hits, at, groupAt(group.id));
    if (!session.selectHit(hits[at])) toast("The text has changed. The report is up to date now.", "info");
  };
  const walking = walk ? report.groups.find((g) => g.id === walk.group) : undefined;
  const walked = walking && walk ? walking.items[walk.item] : undefined;
  const fix = (hits: HitItem["hits"]) => {
    const made = session.fixHits(hits);
    setWalk(null);
    if (made < 0) toast("The text has changed. The report is up to date now.", "info");
    else if (made > 1) toast(`Changed ${made.toLocaleString("en-US")} places.`, "success");
  };
  const here = walked && walk ? walked.hits[walk.hit] : undefined;

  return (
    <>
      <div className="wf-proof-report-head">
        <button className="wf-icon" title="All reports" aria-label="All reports" onClick={onBack}>
          <ChevronLeft size={15} />
        </button>
        <h4 className="wf-proof-title">{title}</h4>
      </div>
      <p className="wf-proof-detail">{report.headline}</p>
      {speech !== null && (
        <label className="wf-proof-tick">
          <input type="checkbox" checked={speech} onChange={(e) => onSpeech(e.target.checked)} />
          <span>Look inside quote marks too</span>
        </label>
      )}
      {report.summary.length > 0 && (
        <ul className="wf-proof-measures">
          {report.summary.map((m) => (
            <MeasureRow key={m.id} measure={m} />
          ))}
        </ul>
      )}
      {report.id === "chapters" && <ChapterTable rows={rows} onPick={onChapter} />}
      {report.series.map((series) => {
        const pick = (i: number) => {
          const hit = series.at?.[i];
          if (!hit) return;
          session.markHits([hit], 0, 0);
          session.selectHit(hit);
        };
        if (series.kind === "strip") return <LengthStrip key={series.id} series={series} onPick={pick} />;
        if (series.kind === "map") return <PaceMap key={series.id} series={series} onPick={pick} />;
        return <Bars key={series.id} series={series} />;
      })}
      {report.groups.map((group, g) => (
        <Group key={group.id} session={session} group={group} slot={g} walk={walk?.group === group.id ? walk : null} onShow={(item, hit) => show(group, item, hit)} onFix={fix} />
      ))}
      {report.notes.map((note) => (
        <p key={note} className="wf-proof-dim">
          {note}
        </p>
      ))}
      {walking && walk && walked && (
        <div className="wf-proof-actions wf-proof-walk">
          <span className="wf-proof-walk-what">{walked.label}</span>
          <span className="wf-proof-at">
            {walk.hit + 1} of {walked.hits.length}
          </span>
          <button className="wf-icon" title="Previous place" aria-label="Previous place" onClick={() => show(walking, walk.item, walk.hit - 1)}>
            <ChevronUp size={14} />
          </button>
          <button className="wf-icon" title="Next place" aria-label="Next place" onClick={() => show(walking, walk.item, walk.hit + 1)}>
            <ChevronDown size={14} />
          </button>
          {here?.fix && session.editable && (
            <button type="button" className="wf-primary" onClick={() => fix([here])}>
              Fix
            </button>
          )}
        </div>
      )}
    </>
  );
}

function Group({
  session,
  group,
  slot,
  walk,
  onShow,
  onFix,
}: {
  session: ProofSession;
  group: HitGroup;
  slot: number;
  walk: { item: number; hit: number } | null;
  onShow: (item: number, hit: number) => void;
  onFix: (hits: HitItem["hits"]) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const [openFor, setOpenFor] = useState(true);
  const fine = (item: HitItem, where: "document" | "yours") => {
    session.allowWord(item.key, where);
    toast(`“${item.key}” will not be remarked on${where === "document" ? " in this document" : ""}.`, "info");
  };
  return (
    <section className="wf-proof-hits">
      <button type="button" className="wf-proof-hits-head" aria-expanded={openFor} onClick={() => setOpenFor(!openFor)}>
        <i className={`wf-proof-swatch s${slot % 6}`} aria-hidden="true" />
        <span>{group.label}</span>
        <b>{num(group.count)}</b>
      </button>
      {openFor && (
        <>
          <p className="wf-proof-dim">{group.hint}</p>
          <ul className="wf-proof-items">
            {group.items.slice(0, shown).map((item, i) => (
              <li key={`${item.label}:${i}`} className={walk?.item === i ? "current" : ""}>
                <button type="button" className="wf-proof-item" onClick={() => onShow(i, walk?.item === i ? walk.hit + 1 : 0)}>
                  <span>{item.label}</span>
                  {item.detail && <em>{item.detail}</em>}
                </button>
                {session.editable && item.hits.some((hit) => hit.fix) && (
                  <button type="button" className="wf-proof-item-fix" title={`Fix every place of ${item.label}`} onClick={() => onFix(item.hits)}>
                    Fix {item.hits.filter((hit) => hit.fix).length === 1 ? "" : "all"}
                  </button>
                )}
                {item.key && (
                  <Flyout title={`About “${item.key}”`} label="…" caret={false} className="wf-proof-item-more">
                    {(close) => (
                      <>
                        {session.keepsInDocument && (
                          <FlyoutItem
                            hint="in this document"
                            onPick={() => {
                              close();
                              fine(item, "document");
                            }}
                          >
                            This is fine
                          </FlyoutItem>
                        )}
                        <FlyoutItem
                          hint="in all my documents"
                          onPick={() => {
                            close();
                            fine(item, "yours");
                          }}
                        >
                          This is fine
                        </FlyoutItem>
                        <FlyoutItem
                          hint="point it out in Checks"
                          onPick={() => {
                            close();
                            session.watchWord(item.key, session.keepsInDocument ? "document" : "yours");
                            toast(`“${item.key}” is now a word to look at.`, "info");
                          }}
                        >
                          Watch this word
                        </FlyoutItem>
                      </>
                    )}
                  </Flyout>
                )}
              </li>
            ))}
          </ul>
          {group.items.length > shown && (
            <button type="button" className="wf-link wf-proof-more" onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, group.items.length - shown)} more
            </button>
          )}
          {group.count > group.items.length && shown >= group.items.length && <p className="wf-proof-dim">The {num(group.items.length)} that stand out most are listed.</p>}
        </>
      )}
    </section>
  );
}

type Sort = "order" | "words" | "speech" | "sentence" | "marks";
const SORTS: { id: Sort; label: string }[] = [
  { id: "order", label: "In order" },
  { id: "marks", label: "What stands apart" },
  { id: "words", label: "Longest first" },
  { id: "speech", label: "Most speech first" },
  { id: "sentence", label: "Longest sentences first" },
];

/** One row a chapter. Choosing a row goes to the chapter and makes every
 *  report about it. */
function ChapterTable({ rows, onPick }: { rows: ChapterRow[]; onPick: (row: ChapterRow) => void }) {
  const [sort, setSort] = useState<Sort>("order");
  const sorted = useMemo(() => {
    const by: Record<Sort, (a: ChapterRow, b: ChapterRow) => number> = {
      order: (a, b) => a.index - b.index,
      marks: (a, b) => b.marks.length - a.marks.length || a.index - b.index,
      words: (a, b) => b.words - a.words,
      speech: (a, b) => b.speech - a.speech,
      sentence: (a, b) => b.sentence - a.sentence,
    };
    return [...rows].sort(by[sort]);
  }, [rows, sort]);
  const marked = (row: ChapterRow, column: ChapterRow["marks"][number]["column"]) => (row.marks.some((m) => m.column === column) ? "marked" : "");
  return (
    <div className="wf-proof-chapters">
      <label className="wf-proof-sort">
        <span>Order</span>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <ul>
        {sorted.map((row) => (
          <li key={row.index}>
            <button type="button" onClick={() => onPick(row)}>
              <b>{row.name}</b>
              <span className="wf-proof-cells">
                <span className={marked(row, "words")}>{num(row.words)} words</span>
                <span className={marked(row, "speech")}>{Math.round(row.speech * 100)}% speech</span>
                <span className={marked(row, "sentence")}>{(Math.round(row.sentence * 10) / 10).toLocaleString("en-US")} a sentence</span>
                {/* (Shown when the panel is made wider.) */}
                <span className={`wf-proof-wide-only ${marked(row, "repeats")}`}>{(Math.round(row.repeats * 10) / 10).toLocaleString("en-US")} repeats in 1,000</span>
                <span className={`wf-proof-wide-only ${marked(row, "long")}`}>{Math.round(row.long * 100)}% long sentences</span>
              </span>
              {row.marks.map((m, i) => (
                <em key={m.column} className={i >= 2 ? "wf-proof-wide-only" : ""}>
                  {m.text}.
                </em>
              ))}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

