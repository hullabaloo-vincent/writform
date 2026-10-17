import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { toast } from "../../platform/toast";
import type { PlanEvent } from "../model";
import { cleanDate } from "../model";
import { foldSearch } from "../resolve";
import { sortByDate, storyVsBook, type TimelineRow } from "../timeline";
import { CastPicker, tint } from "./PlanCard";
import { chapterOf, type PlanEnv } from "./usePlan";

const WIDE = "(min-width: 900px)";

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

const TOLD: Record<string, string> = {
  later: "Told later than it happens",
  earlier: "Told before it happens",
  untold: "Not in the book",
  lost: "Its chapter was deleted",
};

function EventEditor({ env, event, onClose }: { env: PlanEnv; event: PlanEvent; onClose: () => void }) {
  const [draft, setDraft] = useState(event);
  const pending = useRef<PlanEvent | null>(null);
  const timer = useRef(0);
  const envRef = useRef(env);
  useLayoutEffect(() => {
    envRef.current = env;
  });
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (pending.current) envRef.current.ops.updateEvent(pending.current);
    pending.current = null;
  }, []);
  useEffect(() => () => flush(), [flush]);
  const change = (next: PlanEvent, now = false) => {
    setDraft(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    if (now) flush();
    else timer.current = window.setTimeout(flush, 400);
  };
  const columns = env.columns?.columns ?? [];
  const current = columns.find((c) => c.cid && c.cid === draft.chapter);
  const [date, setDate] = useState(draft.date ?? "");
  return (
    <div
      className="wf-plan-event editing"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          flush();
          onClose();
        }
      }}
    >
      <input autoFocus className="wf-plan-card-title-in" placeholder="What happens" aria-label="Event" value={draft.title} maxLength={200} onChange={(e) => change({ ...draft, title: e.target.value })} />
      <div className="wf-plan-entry-row">
        <label>
          <span>When</span>
          <input value={draft.when} placeholder="Day 3, that winter" maxLength={40} onChange={(e) => change({ ...draft, when: e.target.value })} />
        </label>
        <label>
          <span>Date to sort by</span>
          <input
            value={date}
            placeholder="1888-04-12"
            maxLength={12}
            aria-invalid={!!date && !cleanDate(date)}
            onChange={(e) => {
              setDate(e.target.value);
              const clean = cleanDate(e.target.value.trim());
              if (clean || !e.target.value.trim()) change({ ...draft, date: clean });
            }}
          />
        </label>
      </div>
      <textarea rows={3} placeholder="Notes" aria-label="Notes" value={draft.text} maxLength={1000} onChange={(e) => change({ ...draft, text: e.target.value })} />
      <div className="wf-plan-card-fields">
        {env.canLink && (
          <label>
            <span>Told in</span>
            <select
              value={current?.key ?? ""}
              onChange={(e) => {
                const column = columns.find((c) => c.key === e.target.value);
                if (!column) {
                  change({ ...draft, chapter: null }, true);
                  return;
                }
                const cid = chapterOf(env, column);
                if (cid) change({ ...draft, chapter: cid }, true);
              }}
            >
              <option value="">Not in the book</option>
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <CastPicker env={env} chosen={draft.cast} onChange={(cast) => change({ ...draft, cast }, true)} />
      </div>
      <div className="wf-plan-card-foot">
        <button
          type="button"
          className="wf-plan-danger"
          onClick={() => {
            pending.current = null;
            const undo = env.ops.removeEvent(event.id);
            toast(`Deleted the event “${event.title || "Untitled event"}”.`, "info", { durationMs: 10000, action: { label: "Undo", run: undo } });
            onClose();
          }}
        >
          Delete
        </button>
        <span className="wf-statusbar-spacer" />
        <button
          type="button"
          className="wf-primary"
          onClick={() => {
            flush();
            onClose();
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

export function TimelinePane({ env, query, onShowInText, onOpenEntry }: { env: PlanEnv; query: string; onShowInText: (pos: number) => void; onOpenEntry: (id: string) => void }) {
  const wide = useWide();
  const [lane, setLane] = useState<"story" | "book">("story");
  const [editing, setEditing] = useState<string | null>(null);
  const columns = env.columns?.columns ?? [];
  const byCid = new Map(columns.map((c, i) => [c.cid ?? "", i]));
  const rows = storyVsBook(env.plan.events, (cid) => byCid.get(cid) ?? -1);
  const q = foldSearch(query);
  const shown = (r: TimelineRow) => !q || foldSearch(`${r.event.title} ${r.event.text} ${r.event.when}`).includes(q);
  const book = rows.filter((r) => r.column >= 0).sort((a, b) => a.column - b.column);
  const box = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<{ id: string; y1: number; y2: number; told: string }[]>([]);
  const [svgH, setSvgH] = useState(0);

  // The lines joining each event's two places.
  useLayoutEffect(() => {
    if (!wide || !box.current) return;
    const measure = () => {
      const root = box.current;
      if (!root) return;
      const base = root.getBoundingClientRect().top;
      const next: typeof wires = [];
      for (const r of book) {
        const a = root.querySelector<HTMLElement>(`[data-story="${r.event.id}"]`);
        const b = root.querySelector<HTMLElement>(`[data-book="${r.event.id}"]`);
        if (!a || !b) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        next.push({ id: r.event.id, y1: ra.top + ra.height / 2 - base, y2: rb.top + rb.height / 2 - base, told: r.told });
      }
      setWires(next);
      setSvgH(root.scrollHeight);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(box.current);
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, env.plan.events, env.columns, editing, query]);

  const add = () => {
    const made = env.ops.addEvent({});
    if (!made) {
      toast("This plan holds as many events as it can.", "info");
      return;
    }
    setEditing(made.id);
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = env.plan.events.findIndex((e) => e.id === id);
    if (i < 0) return;
    const to = i + dir;
    if (to < 0 || to >= env.plan.events.length) return;
    env.ops.moveEvent(id, to);
  };

  const castChips = (event: PlanEvent) =>
    event.cast.length > 0 && (
      <div className="wf-plan-chips">
        {event.cast.map((id) => {
          const e = env.plan.cast.find((x) => x.id === id);
          return e ? (
            <button key={id} type="button" className="wf-plan-chip" style={tint(e.color)} onClick={() => onOpenEntry(id)}>
              {e.name}
            </button>
          ) : null;
        })}
      </div>
    );

  const storyRow = (r: TimelineRow, i: number) =>
    editing === r.event.id && !env.readonly ? (
      <li key={r.event.id} data-story={r.event.id}>
        <EventEditor env={env} event={r.event} onClose={() => setEditing(null)} />
      </li>
    ) : (
      <li key={r.event.id} data-story={r.event.id}>
        <div
          className={`wf-plan-event ${r.told}`}
          tabIndex={0}
          onClick={() => !env.readonly && setEditing(r.event.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" && !env.readonly) setEditing(r.event.id);
            if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !env.readonly) {
              e.preventDefault();
              move(r.event.id, e.key === "ArrowUp" ? -1 : 1);
            }
          }}
        >
          <span className="wf-plan-event-n">{i + 1}</span>
          <div className="wf-plan-event-body">
            <strong>{r.event.title || <span className="wf-plan-dim">Untitled event</span>}</strong>
            <span className="wf-plan-dim">
              {[r.event.when, r.event.date].filter(Boolean).join(", ")}
              {r.column >= 0 && ` · ${columns[r.column].name}`}
            </span>
            {r.told !== "inOrder" && <span className={`wf-plan-told ${r.told}`}>{TOLD[r.told]}</span>}
            {castChips(r.event)}
          </div>
          {!env.readonly && (
            <span className="wf-plan-event-move">
              <button type="button" title="Earlier in the story" aria-label="Earlier in the story" disabled={i === 0} onClick={(e) => {
                  e.stopPropagation();
                  move(r.event.id, -1);
                }}>
                <ArrowUp size={13} />
              </button>
              <button type="button" title="Later in the story" aria-label="Later in the story" disabled={i === rows.length - 1} onClick={(e) => {
                  e.stopPropagation();
                  move(r.event.id, 1);
                }}>
                <ArrowDown size={13} />
              </button>
            </span>
          )}
        </div>
      </li>
    );

  const bookRow = (r: TimelineRow) => (
    <li key={r.event.id} data-book={r.event.id}>
      <button type="button" className={`wf-plan-event book ${r.told}`} title="Show in the text" onClick={() => onShowInText(columns[r.column].pos)}>
        <span className="wf-plan-dim">{columns[r.column].name}</span>
        <strong>{r.event.title || "Untitled event"}</strong>
      </button>
    </li>
  );

  const head = (
    <div className="wf-plan-timeline-head">
      {!env.readonly && (
        <button type="button" className="wf-plan-row-button" onClick={add}>
          <Plus size={14} /> Event
        </button>
      )}
      {!env.readonly && env.plan.events.some((e) => e.date) && (
        <button type="button" className="wf-plan-row-button" onClick={() => {
          const undo = env.ops.reorderEvents(sortByDate(env.plan.events));
          toast("Sorted the events by their dates.", "info", { action: { label: "Undo", run: undo } });
        }}>
          Sort by date
        </button>
      )}
      {!wide && env.canLink && (
        <div className="wf-plan-layout" role="group" aria-label="Order">
          <button type="button" aria-pressed={lane === "story"} className={lane === "story" ? "active" : ""} onClick={() => setLane("story")}>
            Story order
          </button>
          <button type="button" aria-pressed={lane === "book"} className={lane === "book" ? "active" : ""} onClick={() => setLane("book")}>
            Book order
          </button>
        </div>
      )}
    </div>
  );

  if (!env.plan.events.length) {
    return (
      <div className="wf-plan-timeline">
        {head}
        <p className="wf-plan-dim wf-plan-empty">Events in the order they happen in the story. Give each the {env.noun} that tells it, and the book’s own order shows beside it, with flashbacks marked.</p>
      </div>
    );
  }

  const storyList = <ol className="wf-plan-lane story">{rows.map((r, i) => (shown(r) ? storyRow(r, i) : null))}</ol>;
  const bookList = <ol className="wf-plan-lane book">{book.map((r) => (shown(r) ? bookRow(r) : null))}</ol>;
  return (
    <div className="wf-plan-timeline">
      {head}
      {wide && env.canLink ? (
        <div className="wf-plan-lanes" ref={box}>
          <div>
            <h3>In the story</h3>
            {storyList}
          </div>
          <svg className="wf-plan-wires" height={svgH} aria-hidden="true">
            {wires.map((w) => (
              <path key={w.id} className={w.told} d={`M 0 ${w.y1} C 40 ${w.y1}, 40 ${w.y2}, 80 ${w.y2}`} />
            ))}
          </svg>
          <div>
            <h3>In the book</h3>
            {bookList}
          </div>
        </div>
      ) : lane === "book" && env.canLink ? (
        bookList
      ) : (
        storyList
      )}
    </div>
  );
}
