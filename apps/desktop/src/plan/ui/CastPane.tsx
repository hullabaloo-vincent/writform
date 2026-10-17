import { ArrowLeft, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useIsPhone } from "../../editor/ui/Flyout";
import { toast } from "../../platform/toast";
import type { Mentions } from "../mentions";
import { CAST_KINDS, type CastEntry, type CastKind } from "../model";
import { foldSearch } from "../resolve";
import { ColorSwatches, tint } from "./PlanCard";
import { count, type PlanEnv } from "./usePlan";

const KIND_HEADINGS: Record<CastKind, string> = { person: "People", place: "Places", thing: "Things" };
const KIND_ONE: Record<CastKind, string> = { person: "person", place: "place", thing: "thing" };

export interface CastPaneProps {
  env: PlanEnv;
  query: string;
  mentions: Mentions | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onShowMentions: (entryId: string) => void;
  onOpenCard: (cardId: string) => void;
}

/** How strongly a strip's cell is shaded. */
const shade = (n: number): string => (n === 0 ? "" : n < 3 ? " low" : n < 10 ? " mid" : " high");

/** Other names, typed one at a time: Enter or a comma adds one. */
function AkaField({ value, onChange, disabled }: { value: string[]; onChange: (aka: string[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const name = draft.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setDraft("");
  };
  return (
    <div className="wf-plan-aka">
      {value.map((a) => (
        <span key={a} className="wf-plan-chip">
          {a}
          {!disabled && (
            <button type="button" title={`Take “${a}” off`} aria-label={`Take “${a}” off`} onClick={() => onChange(value.filter((x) => x !== a))}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={draft}
          placeholder={value.length ? "Another name" : "Other names it goes by"}
          aria-label="Add another name"
          maxLength={80}
          onChange={(e) => {
            if (e.target.value.endsWith(",")) {
              setDraft(e.target.value.slice(0, -1));
              window.setTimeout(add);
            } else setDraft(e.target.value);
          }}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
        />
      )}
    </div>
  );
}

function EntryEditor({ env, entry, mentions, onShowMentions, onOpenCard, onDeleted }: { env: PlanEnv; entry: CastEntry; mentions: Mentions | null; onShowMentions: (id: string) => void; onOpenCard: (id: string) => void; onDeleted: () => void }) {
  const [draft, setDraft] = useState(entry);
  const pending = useRef<CastEntry | null>(null);
  const timer = useRef(0);
  const envRef = useRef(env);
  useLayoutEffect(() => {
    envRef.current = env;
  });
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    // (A name can't be emptied: what was there stays.)
    if (next) envRef.current.ops.updateEntry(next.name.trim() ? next : { ...next, name: envRef.current.plan.cast.find((e) => e.id === next.id)?.name ?? next.name });
  }, []);
  useEffect(() => () => flush(), [flush]);
  // Changes from elsewhere show, unless something here is waiting.
  useEffect(() => {
    if (!pending.current) setDraft(entry);
  }, [entry]);
  const change = (next: CastEntry, now = false) => {
    setDraft(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    if (now) flush();
    else timer.current = window.setTimeout(flush, 400);
  };
  const ro = env.readonly;
  const found = mentions?.byEntry.get(entry.id);
  const columns = env.columns?.columns ?? [];
  const cards = env.plan.cards.filter((c) => c.cast.includes(entry.id));
  const remove = () => {
    const undo = env.ops.removeEntry(entry.id);
    toast(`Deleted “${entry.name}”.`, "info", { durationMs: 10000, action: { label: "Undo", run: undo } });
    onDeleted();
  };
  return (
    <div className="wf-plan-entry" style={tint(draft.color)}>
      <input className="wf-plan-entry-name" value={draft.name} aria-label="Name" placeholder="Name" maxLength={80} disabled={ro} onChange={(e) => change({ ...draft, name: e.target.value })} />
      <div className="wf-plan-entry-row">
        <label>
          <span>Kind</span>
          <select value={draft.kind} disabled={ro} onChange={(e) => change({ ...draft, kind: e.target.value as CastKind }, true)}>
            {CAST_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === "person" ? "Person" : k === "place" ? "Place" : "Thing"}
              </option>
            ))}
          </select>
        </label>
        {!ro && <ColorSwatches value={draft.color} onPick={(c) => change({ ...draft, color: c }, true)} />}
      </div>
      <div className="wf-plan-entry-field">
        <span>Also called</span>
        <AkaField value={draft.aka} disabled={ro} onChange={(aka) => change({ ...draft, aka }, true)} />
      </div>
      <label className="wf-plan-entry-field">
        <span>Notes</span>
        <textarea rows={5} value={draft.note} maxLength={4000} disabled={ro} placeholder="Who or what this is, and what to remember" onChange={(e) => change({ ...draft, note: e.target.value })} />
      </label>
      <label className="wf-plan-check">
        <input type="checkbox" checked={draft.anyCase} disabled={ro} onChange={(e) => change({ ...draft, anyCase: e.target.checked }, true)} /> Find it in the text whatever its capitals
      </label>

      <h4>In the text</h4>
      {!found || found.total === 0 ? (
        <p className="wf-plan-dim">Not found in the text yet.</p>
      ) : (
        <>
          <p className="wf-plan-dim">
            {count(found.total, "mention")} in {count(found.cols.size, env.noun)}
            {found.first >= 0 && columns[found.first] ? `. First in ${columns[found.first].name}.` : "."}
          </p>
          <div className="wf-plan-strip" role="list" aria-label="Where it appears">
            {columns.map((c, i) => {
              const n = found.cols.get(i) ?? 0;
              return <span key={c.key} role="listitem" className={`wf-plan-strip-cell${shade(n)}`} title={`${c.name}: ${count(n, "mention")}`} />;
            })}
          </div>
          <button type="button" className="wf-plan-row-button" onClick={() => onShowMentions(entry.id)}>
            Step through the mentions
          </button>
        </>
      )}

      <h4>Cards with {entry.name} ({cards.length})</h4>
      {cards.length ? (
        <ul className="wf-plan-entry-cards">
          {cards.map((c) => (
            <li key={c.id}>
              <button type="button" className="wf-plan-row-button" onClick={() => onOpenCard(c.id)}>
                {c.title || "Untitled card"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wf-plan-dim">No card names {entry.name} yet. Name them on a card with its Cast button.</p>
      )}
      {!ro && (
        <div className="wf-plan-entry-foot">
          <button type="button" className="wf-plan-danger" onClick={remove}>
            Delete {entry.name}
          </button>
        </div>
      )}
    </div>
  );
}

export function CastPane({ env, query, mentions, selected, onSelect, onShowMentions, onOpenCard }: CastPaneProps) {
  const phone = useIsPhone();
  const q = foldSearch(query);
  const shown = env.plan.cast.filter((e) => !q || foldSearch(`${e.name} ${e.aka.join(" ")} ${e.note}`).includes(q));
  const entry = env.plan.cast.find((e) => e.id === selected) ?? null;
  const add = (kind: CastKind) => {
    const made = env.ops.addEntry({ kind, name: kind === "person" ? "New person" : kind === "place" ? "New place" : "New thing" });
    if (!made) {
      toast("This plan holds as many entries as it can.", "info");
      return;
    }
    onSelect(made.id);
    window.setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(".wf-plan-entry-name");
      el?.focus();
      el?.select();
    }, 30);
  };
  const list = (
    <div className="wf-plan-cast-list">
      {env.plan.cast.length === 0 && (
        <p className="wf-plan-dim">The people, places and things of the story. Each shows the {env.noun}s it appears in, found by its names in the text.</p>
      )}
      {mentions && mentions.clashes.length > 0 && <p className="wf-plan-note">Two entries share {mentions.clashes.map((c) => `“${c}”`).join(", ")}. It counts for the first of them.</p>}
      {CAST_KINDS.map((kind) => {
        const entries = shown.filter((e) => e.kind === kind);
        return (
          <section key={kind}>
            <header>
              <h3>
                {KIND_HEADINGS[kind]} <span className="wf-plan-dim">{entries.length}</span>
              </h3>
              {!env.readonly && (
                <button type="button" className="wf-plan-row-button" title={`Add a ${KIND_ONE[kind]}`} onClick={() => add(kind)}>
                  <Plus size={14} /> Add
                </button>
              )}
            </header>
            <ul>
              {entries.map((e) => (
                <li key={e.id}>
                  <button type="button" className={`wf-plan-cast-row${selected === e.id ? " active" : ""}`} onClick={() => onSelect(e.id)}>
                    <span className="wf-plan-dot" style={tint(e.color)} />
                    <span className="wf-plan-cast-name">
                      {e.name}
                      {e.aka.length > 0 && <small className="wf-plan-dim"> {e.aka.join(", ")}</small>}
                    </span>
                    <span className="wf-plan-dim">{mentions?.byEntry.get(e.id)?.total ?? 0}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
  const detail = entry ? (
    <EntryEditor key={entry.id} env={env} entry={entry} mentions={mentions} onShowMentions={onShowMentions} onOpenCard={onOpenCard} onDeleted={() => onSelect(null)} />
  ) : (
    <p className="wf-plan-dim wf-plan-entry-none">Choose someone or something to see and change it.</p>
  );
  if (phone) {
    return (
      <div className="wf-plan-cast phone">
        {entry ? (
          <>
            <button type="button" className="wf-plan-row-button" onClick={() => onSelect(null)}>
              <ArrowLeft size={14} /> All entries
            </button>
            {detail}
          </>
        ) : (
          list
        )}
      </div>
    );
  }
  return (
    <div className="wf-plan-cast">
      {list}
      {detail}
    </div>
  );
}
