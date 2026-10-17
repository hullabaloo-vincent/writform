import type { Editor } from "@tiptap/core";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";

import type { BookDesign } from "../../book/model/presets";
import { touchFirst, showRange } from "../../editor/ui/reveal";
import { toast } from "../../platform/toast";
import { buildNameIndex, findMentions } from "../mentions";
import { cellKey, placeCards } from "../resolve";
import { useMentions } from "./PlanView";
import { CardEditor, PlanCardView, tint } from "./PlanCard";
import { chapterOf, count, usePlanEnv } from "./usePlan";

export interface PlanPanelProps {
  editor: Editor;
  ydoc: Y.Doc;
  format: string;
  design?: Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">;
  readonly: boolean;
  level: number;
  /** An entry whose mentions to step through, or null for the cards. */
  mentionsOf: string | null;
  onMentions: (entry: string | null) => void;
  onOpenFull: (at?: { column?: string; card?: string; entry?: string }) => void;
  onClose: () => void;
}

/** The block the caret is in. */
const caretBlock = (editor: Editor) => editor.state.selection.$from.index(0);

/** Beside the text: the plan for the chapter being written, and stepping
 *  through a name's mentions. */
export function PlanPanel(props: PlanPanelProps) {
  const { editor, ydoc, format, design, readonly, level, mentionsOf, onMentions, onOpenFull, onClose } = props;
  const env = usePlanEnv(editor, ydoc, format, design, readonly, level);
  const [block, setBlock] = useState(() => caretBlock(editor));
  const [editing, setEditing] = useState<{ id: string; fresh: boolean } | null>(null);
  useEffect(() => {
    let timer = 0;
    const on = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => !editor.isDestroyed && setBlock(caretBlock(editor)), 150);
    };
    editor.on("selectionUpdate", on);
    editor.on("update", on);
    return () => {
      window.clearTimeout(timer);
      editor.off("selectionUpdate", on);
      editor.off("update", on);
    };
  }, [editor]);

  const columns = env.columns?.columns ?? [];
  const column = columns.find((c) => block >= c.index && block < c.endIndex) ?? null;
  const placed = env.columns ? placeCards(env.columns, env.plan) : null;
  const mentions = useMentions(env, env.plan.cast.length > 0);

  // ---------------------------------------------------------- mentions

  const index = useMemo(() => buildNameIndex(env.plan.cast), [env.plan.cast]);
  const entry = env.plan.cast.find((e) => e.id === mentionsOf) ?? null;
  const [places, setPlaces] = useState<{ from: number; to: number }[]>([]);
  const [at, setAt] = useState(-1);
  useEffect(() => {
    if (!entry) {
      setPlaces([]);
      return;
    }
    setPlaces(findMentions(editor.state.doc, index, entry.id));
    setAt(-1);
  }, [entry, index, editor]);
  const step = (dir: 1 | -1) => {
    if (!places.length) return;
    const next = at < 0 ? (dir === 1 ? 0 : places.length - 1) : (at + dir + places.length) % places.length;
    setAt(next);
    showRange(editor.view, places[next].from, places[next].to, !touchFirst());
  };

  if (entry) {
    const snippet = (p: { from: number; to: number }) => {
      const doc = editor.state.doc;
      const before = doc.textBetween(Math.max(0, p.from - 40), p.from, " ", " ");
      const after = doc.textBetween(p.to, Math.min(doc.content.size, p.to + 40), " ", " ");
      return { before: before.replace(/^\S*\s/, "…"), match: doc.textBetween(p.from, p.to, " ", " "), after: after.replace(/\s\S*$/, "…") };
    };
    return (
      <aside className="wf-doc-panel wf-plan-panel">
        <header className="wf-doc-panel-header">
          <h3>Mentions of {entry.name}</h3>
          <span className="wf-statusbar-spacer" />
          <button type="button" className="wf-doc-outline-reorder" onClick={() => onMentions(null)}>
            Done
          </button>
        </header>
        <div className="wf-plan-panel-step">
          <button type="button" title="Previous" aria-label="Previous mention" disabled={!places.length} onClick={() => step(-1)}>
            <ChevronLeft size={15} />
          </button>
          <span>{places.length ? (at >= 0 ? `${at + 1} of ${places.length}` : count(places.length, "mention")) : "Not found in the text"}</span>
          <button type="button" title="Next" aria-label="Next mention" disabled={!places.length} onClick={() => step(1)}>
            <ChevronRight size={15} />
          </button>
        </div>
        <ol className="wf-plan-panel-mentions">
          {places.slice(0, 300).map((p, i) => {
            const s = snippet(p);
            return (
              <li key={`${p.from}`}>
                <button
                  type="button"
                  className={`wf-plan-row-button${i === at ? " active" : ""}`}
                  onClick={() => {
                    setAt(i);
                    showRange(editor.view, p.from, p.to, !touchFirst());
                  }}
                >
                  {s.before}
                  <mark>{s.match}</mark>
                  {s.after}
                </button>
              </li>
            );
          })}
        </ol>
      </aside>
    );
  }

  // ---------------------------------------------------------- the chapter's cards

  const add = (line: string | null) => {
    if (!column) return;
    const chapter = chapterOf(env, column);
    if (!chapter) return;
    const made = env.ops.addCard({ line, chapter });
    if (!made) {
      toast("This plan holds as many cards as it can.", "info");
      return;
    }
    setEditing({ id: made.id, fresh: true });
  };
  const rows = placed?.rows.length ? placed.rows : [{ line: null, key: "" }];
  const who = column && mentions ? [...mentions.byEntry].map(([id, m]) => ({ id, n: m.cols.get(columns.indexOf(column)) ?? 0 })).filter((w) => w.n > 0).sort((a, b) => b.n - a.n) : [];

  return (
    <aside className="wf-doc-panel wf-plan-panel">
      <header className="wf-doc-panel-header">
        <h3>Plan</h3>
        <span className="wf-statusbar-spacer" />
        <button type="button" className="wf-doc-outline-reorder" onClick={() => onOpenFull(column ? { column: column.key } : undefined)}>
          Open the board
        </button>
        <button type="button" className="wf-plan-close" title="Close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {!column ? (
        <p className="wf-plan-dim wf-plan-panel-note">Put the caret in a {env.noun} to see its cards.</p>
      ) : (
        <div className="wf-plan-panel-body">
          <p className="wf-plan-panel-chapter">
            <strong>{column.name}</strong>
            <span className="wf-plan-dim"> · {count(column.words, "word")}</span>
          </p>
          {!env.canLink && <p className="wf-plan-note">Cards can be put in {env.noun}s once this server is updated.</p>}
          {rows.map((row) => {
            const cards = column.cid ? (placed?.cells.get(cellKey(row.line?.id ?? null, column.key)) ?? []) : [];
            if (!cards.length && !row.line) return null;
            return (
              <section key={row.key} className="wf-plan-panel-line" style={tint(row.line?.color)}>
                <h4>{row.line ? row.line.name : "No plot line"}</h4>
                {cards.map((card) =>
                  editing?.id === card.id ? (
                    <CardEditor key={card.id} env={env} card={card} fresh={editing.fresh} onClose={() => setEditing(null)} />
                  ) : (
                    <div key={card.id} onClick={() => !readonly && setEditing({ id: card.id, fresh: false })}>
                      <PlanCardView env={env} card={card} focusable dragging={false} compact onEdit={() => setEditing({ id: card.id, fresh: false })} onOpenEntry={(id) => onOpenFull({ entry: id })} />
                    </div>
                  ),
                )}
                {!readonly && env.canLink && (
                  <button type="button" className="wf-plan-row-button" onClick={() => add(row.line?.id ?? null)}>
                    <Plus size={13} /> Card
                  </button>
                )}
              </section>
            );
          })}
          {!env.plan.lines.length && <p className="wf-plan-dim">Add plot lines on the board to plan each {env.noun} by them.</p>}
          {who.length > 0 && (
            <section className="wf-plan-panel-cast">
              <h4>In this {env.noun}</h4>
              <div className="wf-plan-chips">
                {who.map((w) => {
                  const e = env.plan.cast.find((x) => x.id === w.id);
                  return e ? (
                    <button key={w.id} type="button" className="wf-plan-chip" style={tint(e.color)} title={`Step through the mentions of ${e.name}`} onClick={() => onMentions(e.id)}>
                      {e.name} {w.n}
                    </button>
                  ) : null;
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
