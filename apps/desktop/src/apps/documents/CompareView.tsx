import type { JSONContent } from "@tiptap/core";
import { ArrowLeftRight, ChevronDown, ChevronUp, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { useIsPhone } from "../../editor/ui/Flyout";
import { compareDocs, type CompareRow, type Segment } from "./compare";

/** One of the two versions being compared. */
export interface CompareSide {
  /** "Now", a version's name or date, a file's name. */
  title: string;
  doc: JSONContent;
}

const NAMED: Record<string, string> = { picture: "Picture", divider: "Divider line", contents: "Table of contents" };

function Cell({ segments, kind, empty }: { segments: Segment[] | null; kind?: string; empty?: boolean }) {
  if (!segments) return <div className="wf-cmp-cell wf-cmp-none" aria-hidden />;
  const heading = kind?.startsWith("heading");
  const named = kind ? NAMED[kind] : undefined;
  const text = segments.map((s) => s.text).join("");
  return (
    <div className={`wf-cmp-cell${heading ? " wf-cmp-heading" : ""}${kind === "code" ? " wf-cmp-code" : ""}`}>
      {named && <span className="wf-cmp-thing">{named}</span>}
      {!text && !named && empty !== false && <span className="wf-cmp-blank">(empty paragraph)</span>}
      {segments.map((seg, i) =>
        seg.op === "same" ? <Fragment key={i}>{seg.text}</Fragment> : seg.op === "del" ? <del key={i}>{seg.text}</del> : <ins key={i}>{seg.text}</ins>,
      )}
    </div>
  );
}

/**
 * Two versions of a document side by side, with what differs marked word
 * by word: what was taken out on the left, what was put in on the right.
 * On a narrow screen (or by choice) both in one column.
 */
export function CompareView({ before, after, onClose }: { before: CompareSide; after: CompareSide; onClose: () => void }) {
  const phone = useIsPhone();
  const [swapped, setSwapped] = useState(false);
  const [inline, setInline] = useState(phone);
  const [all, setAll] = useState(false);
  const left = swapped ? after : before;
  const right = swapped ? before : after;
  const result = useMemo(() => compareDocs(left.doc, right.doc), [left.doc, right.doc]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(-1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Stretches of unchanged paragraphs fold to one line unless asked for.
  const shown = useMemo(() => {
    const out: ({ row: CompareRow; change: number } | { skipped: number })[] = [];
    let change = 0;
    let run = 0;
    for (const row of result.rows) {
      if (row.status === "same" && !all) {
        run += 1;
        continue;
      }
      if (run) out.push({ skipped: run });
      run = 0;
      out.push({ row, change: row.status === "same" ? -1 : change });
      if (row.status !== "same") change += 1;
    }
    if (run) out.push({ skipped: run });
    return out;
  }, [result, all]);

  const go = (dir: 1 | -1) => {
    if (!result.changed) return;
    const next = (at + dir + result.changed) % result.changed;
    setAt(next);
    bodyRef.current?.querySelector(`[data-change="${next}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const summary = result.changed
    ? `${result.changed} ${result.changed === 1 ? "paragraph differs" : "paragraphs differ"} · +${result.wordsAdded.toLocaleString()} / −${result.wordsRemoved.toLocaleString()} words`
    : "The text is the same.";

  return (
    <div className="wf-cmp-overlay" role="dialog" aria-label="Compare versions">
      <header className="wf-cmp-bar">
        <button className="wf-icon" title="Close (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
        <strong>Compare</strong>
        <span className="wf-cmp-summary">{summary}</span>
        <span className="wf-statusbar-spacer" />
        <button className="wf-icon" title="Previous difference" disabled={!result.changed} onClick={() => go(-1)}>
          <ChevronUp size={16} />
        </button>
        <button className="wf-icon" title="Next difference" disabled={!result.changed} onClick={() => go(1)}>
          <ChevronDown size={16} />
        </button>
        <button className={all ? "active" : ""} aria-pressed={all} title="Show the paragraphs that are the same too" onClick={() => setAll(!all)}>
          Whole text
        </button>
        <button className={inline ? "active" : ""} aria-pressed={inline} title="Both versions in one column" onClick={() => setInline(!inline)}>
          One column
        </button>
        <button className="wf-icon" title="Swap the sides" onClick={() => setSwapped(!swapped)}>
          <ArrowLeftRight size={16} />
        </button>
      </header>
      <div className={`wf-cmp-heads${inline ? " inline" : ""}`}>
        <div>
          <span className="wf-cmp-tag del">Before</span> {left.title}
        </div>
        <div>
          <span className="wf-cmp-tag ins">After</span> {right.title}
        </div>
      </div>
      <div className="wf-cmp-body" ref={bodyRef}>
        <div className={`wf-cmp-sheet${inline ? " inline" : ""}`}>
          {shown.map((item, i) =>
            "skipped" in item ? (
              <button key={i} type="button" className="wf-cmp-skip" title="Show the whole text" onClick={() => setAll(true)}>
                {item.skipped.toLocaleString()} unchanged {item.skipped === 1 ? "paragraph" : "paragraphs"}
              </button>
            ) : (
              <div
                key={i}
                className={`wf-cmp-row${item.change === at ? " current" : ""}`}
                data-status={item.row.status}
                data-change={item.change >= 0 ? item.change : undefined}
              >
                {inline ? (
                  <Cell segments={item.row.merged} kind={item.row.rightKind ?? item.row.leftKind} />
                ) : (
                  <>
                    <Cell segments={item.row.left} kind={item.row.leftKind} />
                    <Cell segments={item.row.right} kind={item.row.rightKind} />
                  </>
                )}
              </div>
            ),
          )}
          {result.rows.length === 0 && <p className="wf-friend-dim">Both versions are empty.</p>}
        </div>
      </div>
    </div>
  );
}
