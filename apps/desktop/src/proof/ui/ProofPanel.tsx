import type { Editor } from "@tiptap/core";
import { ChevronDown, ChevronLeft, ChevronsLeft, ChevronsRight, ChevronUp, Maximize2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";

import { Flyout, FlyoutItem, useIsPhone } from "../../editor/ui/Flyout";
import { toast } from "../../platform/toast";
import { GROUPS } from "../checks";
import { reportsFor } from "../reports";
import type { PlaceView, ProofSession, SkipWhere } from "../session";
import type { Issue } from "../types";
import { useProofSession } from "../useProof";
import { ReportsTab } from "./ReportsTab";
import { RulesEditor } from "./RulesEditor";

/** How many places a list shows before "Show more". */
const PAGE = 60;
const WIDE_KEY = "wf-proof-wide";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The Check panel: what a reading of the whole text found, a finding at a
 * time. Choosing a place selects it in the text. Fix changes it there (as
 * a suggestion, in Suggesting mode).
 */
export function ProofPanel({
  editor,
  format,
  lang,
  ydoc,
  canWrite,
  title,
  comments,
  changes,
  onOpenComments,
  onOpenChanges,
  onClose,
}: {
  editor: Editor | null;
  format: string;
  lang: string;
  /** The document's own Y.Doc (its rules are kept there), and whether this
   *  person may change it. */
  ydoc: Y.Doc | null;
  canWrite: boolean;
  /** The document's title, to name a rules file by. */
  title: string;
  /** Comments still open and changes still suggested: counted by the editor. */
  comments: number;
  changes: number;
  onOpenComments: () => void;
  onOpenChanges: () => void;
  onClose: () => void;
}) {
  const session = useProofSession(editor, format, lang, ydoc, canWrite);
  const phone = useIsPhone();
  const [tab, setTab] = useState<"checks" | "reports" | "rules">("checks");
  const reports = reportsFor(format);
  /** Whose rules the Rules tab is showing. */
  const [scope, setScope] = useState<"document" | "yours">("document");
  const [open, setOpen] = useState<string | null>(null);
  /** On a phone, the sheet folded down to a bar so the text can be seen. */
  const [folded, setFolded] = useState(false);
  /** The panel at about twice its width, for charts and long lists (kept
   *  on this device). */
  const [wide, setWideState] = useState(() => {
    try {
      return localStorage.getItem(WIDE_KEY) === "on";
    } catch {
      return false;
    }
  });
  const setWide = (on: boolean) => {
    setWideState(on);
    try {
      localStorage.setItem(WIDE_KEY, on ? "on" : "off");
    } catch {
      // A convenience only.
    }
  };

  useEffect(() => session?.setOutside(comments, changes), [session, comments, changes]);
  // On a phone the page and the sheet share the height (see styles.css).
  useEffect(() => {
    const body = editor?.view.dom.closest(".wf-doc-body");
    if (!body) return;
    body.classList.add("wf-proof-open");
    return () => body.classList.remove("wf-proof-open");
  }, [editor]);

  const issues = session?.issues() ?? [];
  const issue = tab === "checks" ? (issues.find((i) => i.id === open) ?? null) : null;
  useEffect(() => {
    session?.showIssue(issue ? issue.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by id: the object is new after every reading
  }, [session, issue?.id]);

  const step = (dir: 1 | -1) => {
    if (!issues.length) return;
    const at = issues.findIndex((i) => i.id === open);
    setOpen(issues[(at + dir + issues.length) % issues.length].id);
  };

  return (
    <aside className={`wf-doc-panel wf-proof${folded && phone ? " folded" : ""}${wide && !phone ? " wide" : ""}`} aria-label="Check">
      <header className="wf-doc-panel-header">
        {issue ? (
          <button className="wf-icon" title="All findings" aria-label="All findings" onClick={() => setOpen(null)}>
            <ChevronLeft size={15} />
          </button>
        ) : null}
        {issue ? (
          <h3>Finding</h3>
        ) : (
          <div className="wf-panel-tabs" role="tablist" aria-label="Check">
            <button type="button" role="tab" aria-selected={tab === "checks"} className={tab === "checks" ? "active" : ""} onClick={() => setTab("checks")}>
              Checks
            </button>
            {reports && (
              <button type="button" role="tab" aria-selected={tab === "reports"} className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>
                Reports
              </button>
            )}
            <button type="button" role="tab" aria-selected={tab === "rules"} className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>
              Rules
            </button>
          </div>
        )}
        <span className="wf-statusbar-spacer" />
        {issue && issues.length > 1 && (
          <>
            <span className="wf-proof-at">
              {issues.indexOf(issue) + 1} of {issues.length}
            </span>
            <button className="wf-icon" title="Previous finding" aria-label="Previous finding" onClick={() => step(-1)}>
              <ChevronUp size={14} />
            </button>
            <button className="wf-icon" title="Next finding" aria-label="Next finding" onClick={() => step(1)}>
              <ChevronDown size={14} />
            </button>
          </>
        )}
        {!phone && (
          <button className="wf-icon" title={wide ? "Make the panel narrower" : "Make the panel wider"} aria-label={wide ? "Make the panel narrower" : "Make the panel wider"} aria-pressed={wide} onClick={() => setWide(!wide)}>
            {wide ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
          </button>
        )}
        <button className="wf-icon" title="Close" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {tab === "rules" && session ? (
        <div className="wf-proof-body">
          <div className="wf-review-modes wf-proof-scope" role="group" aria-label="Whose rules">
            <button type="button" className={scope === "document" ? "active" : ""} aria-pressed={scope === "document"} onClick={() => setScope("document")}>
              This document
            </button>
            <button type="button" className={scope === "yours" ? "active" : ""} aria-pressed={scope === "yours"} onClick={() => setScope("yours")}>
              All my documents
            </button>
          </div>
          <RulesEditor scope={scope} ydoc={ydoc} canWrite={canWrite} env={session.env} title={title} />
        </div>
      ) : tab === "reports" && reports && session?.hasRead ? (
        <ReportsTab session={session} book={format === "manuscript"} />
      ) : !session || !session.hasRead ? (
        <div className="wf-proof-reading" role="status">
          <span>Reading the text…</span>
          <progress max={1} value={session?.progress ?? 0} />
        </div>
      ) : issue ? (
        <IssueView
          key={issue.id}
          session={session}
          issue={issue}
          phone={phone}
          folded={folded && phone}
          onFold={setFolded}
          onOpenList={issue.open?.what === "comments" ? onOpenComments : onOpenChanges}
          onGone={() => step(1)}
        />
      ) : (
        <IssueList session={session} issues={issues} onOpen={setOpen} />
      )}
    </aside>
  );
}

function IssueList({ session, issues, onOpen }: { session: ProofSession; issues: Issue[]; onOpen: (id: string) => void }) {
  const total = issues.reduce((n, i) => n + session.count(i), 0);
  const { quiet, unread } = session.quiet();
  return (
    <div className="wf-proof-body">
      <p className="wf-proof-sum">{issues.length ? `${plural(total, "place", "places")} to look at.` : "Nothing to look at. The text is consistent in everything that was checked."}</p>
      {GROUPS.map((group) => {
        const mine = issues.filter((i) => i.group === group.id);
        if (!mine.length) return null;
        return (
          <section key={group.id} className="wf-proof-group">
            <h4>{group.label}</h4>
            {mine.map((i) => (
              <button key={i.id} type="button" className="wf-proof-row" onClick={() => onOpen(i.id)}>
                <span>{i.title}</span>
                <b>{session.count(i).toLocaleString("en-US")}</b>
              </button>
            ))}
          </section>
        );
      })}
      {issues.length > 0 && quiet > 0 && <p className="wf-proof-dim">Nothing found in {plural(quiet, "other check", "other checks")}.</p>}
      {unread > 0 && <p className="wf-proof-dim">{plural(unread, "check reads", "checks read")} English only and did not run.</p>}
    </div>
  );
}

function IssueView({
  session,
  issue,
  phone,
  folded,
  onFold,
  onOpenList,
  onGone,
}: {
  session: ProofSession;
  issue: Issue;
  phone: boolean;
  folded: boolean;
  onFold: (folded: boolean) => void;
  onOpenList: () => void;
  onGone: () => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const [at, setAt] = useState(-1);
  const places = session.todo(issue);
  const target = session.target(issue);
  const fixAll = session.fixableCount(issue, target);
  // (Described only as far as the list shows: a book can have thousands.)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `issue` is new after every reading
  const views = useMemo(() => places.slice(0, shown).map((p) => session.view(issue, p)), [session, issue, shown]);
  const current = at >= 0 && at < places.length ? (at < views.length ? views[at] : session.view(issue, places[at])) : null;

  const go = (index: number, fold = phone) => {
    if (!places.length) return;
    const next = (index + places.length) % places.length;
    const view = next < views.length ? views[next] : session.view(issue, places[next]);
    setAt(next);
    if (!session.select(view)) toast("That text has changed.", "info");
    else if (fold) onFold(true);
  };
  const fix = (view: PlaceView) => {
    if (target === null) return;
    const result = session.fix(view, target);
    if (result === "changed") toast("That text has changed.", "info");
    else if (result === "locked") toast("This place can’t be changed from here.", "info");
  };
  const canFix = (view: PlaceView | null) => !!view && target !== null && view.fixes.includes(target);

  if (issue.open) {
    return (
      <div className="wf-proof-body">
        <h4 className="wf-proof-title">{issue.title}</h4>
        <p className="wf-proof-detail">{issue.detail}</p>
        <div className="wf-proof-actions">
          <button type="button" className="wf-primary" onClick={onOpenList}>
            {issue.open.what === "comments" ? "Show the comments" : "Show the changes"}
          </button>
        </div>
      </div>
    );
  }

  if (folded) {
    return (
      <div className="wf-proof-bar">
        <span className="wf-proof-bar-title">{issue.title}</span>
        <span className="wf-proof-at">
          {Math.max(1, at + 1)} of {places.length}
        </span>
        <button className="wf-icon" title="Previous place" aria-label="Previous place" onClick={() => go(at - 1)}>
          <ChevronUp size={16} />
        </button>
        <button className="wf-icon" title="Next place" aria-label="Next place" onClick={() => go(at + 1)}>
          <ChevronDown size={16} />
        </button>
        {canFix(current) && (
          <button type="button" className="wf-primary" onClick={() => current && fix(current)}>
            Fix
          </button>
        )}
        <button className="wf-icon" title="Show the list" aria-label="Show the list" onClick={() => onFold(false)}>
          <Maximize2 size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="wf-proof-body">
      <h4 className="wf-proof-title">{issue.title}</h4>
      <p className="wf-proof-detail">{issue.detail}</p>
      {issue.forms.length > 1 && (
        <fieldset className="wf-proof-forms">
          <legend>Which is meant?</legend>
          {issue.forms.map((form) => (
            <label key={form.id}>
              <input type="radio" name={`wf-proof-${issue.id}`} checked={issue.preferred === form.id} onChange={() => session.prefer(issue.id, form.id)} />
              <span>{form.label}</span>
              <b>{form.count.toLocaleString("en-US")}</b>
            </label>
          ))}
        </fieldset>
      )}
      <div className="wf-proof-places-head">
        <span>{issue.kind === "consistency" && target !== null ? "Places to change" : "Places"}</span>
        <b>{places.length.toLocaleString("en-US")}</b>
        <span className="wf-statusbar-spacer" />
        <button className="wf-icon" title="Previous place" aria-label="Previous place" disabled={!places.length} onClick={() => go(at - 1)}>
          <ChevronUp size={14} />
        </button>
        <button className="wf-icon" title="Next place" aria-label="Next place" disabled={!places.length} onClick={() => go(at + 1)}>
          <ChevronDown size={14} />
        </button>
      </div>
      <ul className="wf-proof-places">
        {views.map((view, i) => (
          <li key={`${view.key}:${i}`} className={i === at ? "current" : ""}>
            <button type="button" className="wf-proof-snip" onClick={() => go(i)}>
              {view.before}
              <mark>{view.match || " "}</mark>
              {view.after}
            </button>
            <span className="wf-proof-place-actions">
              {canFix(view) && (
                <button type="button" onClick={() => fix(view)}>
                  Fix
                </button>
              )}
              <button type="button" className="wf-link" onClick={() => session.skipPlace(view)}>
                Skip
              </button>
            </span>
          </li>
        ))}
      </ul>
      {places.length > shown && (
        <button type="button" className="wf-link wf-proof-more" onClick={() => setShown(shown + PAGE)}>
          Show {Math.min(PAGE, places.length - shown)} more
        </button>
      )}
      {issue.kind === "consistency" && target === null && <p className="wf-proof-dim">Choose which is meant and the places to change are listed.</p>}
      {issue.kind === "consistency" && (issue.preferredFrom === "document" || issue.preferredFrom === "yours") && (
        <p className="wf-proof-dim">{issue.preferredFrom === "document" ? "Chosen in this document’s rules." : "Chosen in your rules."}</p>
      )}
      <div className="wf-proof-actions">
        {fixAll > 0 && target !== null && (
          <button
            type="button"
            className="wf-primary"
            onClick={() => {
              const made = session.fixAll(issue.id, target);
              if (made) toast(`Changed ${plural(made, "place", "places")}.`, "success");
            }}
          >
            Fix all {fixAll.toLocaleString("en-US")}
          </button>
        )}
        <Flyout title="Set this finding aside" label="Set aside" className="wf-proof-aside">
          {(close) => {
            const pick = (where: SkipWhere) => () => {
              close();
              onGone();
              session.skipIssue(issue.id, where);
            };
            return (
              <>
                <FlyoutItem hint="until you close the panel" onPick={pick("now")}>
                  Just for now
                </FlyoutItem>
                {session.keepsInDocument && (
                  <FlyoutItem hint="for everyone who writes it" onPick={pick("document")}>
                    Fine in this document
                  </FlyoutItem>
                )}
                <FlyoutItem hint="on this device" onPick={pick("yours")}>
                  Never flag in my documents
                </FlyoutItem>
              </>
            );
          }}
        </Flyout>
      </div>
    </div>
  );
}
