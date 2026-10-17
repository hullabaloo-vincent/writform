import { Check, Ellipsis } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { Flyout, FlyoutItem } from "../../editor/ui/Flyout";
import { toast } from "../../platform/toast";
import { COLOR_NAMES, PLAN_COLORS, type Card, type Plan, type PlanColor } from "../model";
import { chapterOf, type PlanEnv } from "./usePlan";

/** A plan color as the board draws it. */
export const tint = (color: PlanColor | null | undefined): CSSProperties | undefined => (color ? ({ "--wf-plan-tint": `var(--wf-plan-${color})` } as CSSProperties) : undefined);

/** The color a card shows: its own, else its plot line's. */
export const cardColor = (card: Card, plan: Plan): PlanColor | null => plan.lines.find((l) => l.id === card.line)?.color ?? null;

/** Delete a card, with Undo. */
export function deleteCard(env: PlanEnv, card: Card): void {
  const undo = env.ops.removeCard(card.id);
  toast(card.title ? `Deleted the card “${card.title}”.` : "Deleted the card.", "info", { durationMs: 10000, action: { label: "Undo", run: undo } });
}

export function ColorSwatches({ value, onPick, none = "No color" }: { value: PlanColor | null; onPick: (c: PlanColor | null) => void; none?: string }) {
  return (
    <div className="wf-plan-swatches" role="group" aria-label="Color">
      <button type="button" className={`wf-plan-swatch none${value === null ? " on" : ""}`} title={none} aria-label={none} aria-pressed={value === null} onClick={() => onPick(null)} />
      {PLAN_COLORS.map((c) => (
        <button key={c} type="button" className={`wf-plan-swatch${value === c ? " on" : ""}`} style={tint(c)} title={COLOR_NAMES[c]} aria-label={COLOR_NAMES[c]} aria-pressed={value === c} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

/** Ticks for the cast and world entries a card (or an event) names. */
export function CastPicker({ env, chosen, onChange }: { env: PlanEnv; chosen: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = env.plan.cast.filter((e) => !q || e.name.toLowerCase().includes(q) || e.aka.some((a) => a.toLowerCase().includes(q)));
  const exact = env.plan.cast.some((e) => e.name.toLowerCase() === q);
  return (
    <Flyout title="Who and what is in it" label={chosen.length ? `Cast (${chosen.length})` : "Cast"} className="wf-plan-cast-pick" panelClass="wf-plan-cast-panel">
      {() => (
        <div className="wf-plan-cast-pickbox">
          <input type="search" placeholder="Find or add" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find or add a name" />
          <ul>
            {shown.map((e) => (
              <li key={e.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(e.id)}
                    onChange={(ev) => onChange(ev.target.checked ? [...chosen, e.id] : chosen.filter((id) => id !== e.id))}
                  />
                  <span className="wf-plan-dot" style={tint(e.color)} />
                  {e.name}
                </label>
              </li>
            ))}
          </ul>
          {!env.plan.cast.length && !q && <p className="wf-plan-dim">Add people, places and things on the Cast and world tab, or type a name here.</p>}
          {q && !exact && (
            <button
              type="button"
              className="wf-plan-row-button"
              onClick={() => {
                const made = env.ops.addEntry({ name: query.trim() });
                if (!made) {
                  toast("This plan holds as many entries as it can.", "info");
                  return;
                }
                onChange([...chosen, made.id]);
                setQuery("");
              }}
            >
              Add “{query.trim()}”
            </button>
          )}
        </div>
      )}
    </Flyout>
  );
}

/** A card being written: title, notes, plot line, color, cast. What is
 *  typed is kept 400 ms after typing stops, and when it closes. */
export function CardEditor({ env, card, fresh, onClose }: { env: PlanEnv; card: Card; fresh: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState(card);
  const pending = useRef<Card | null>(null);
  const timer = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const envRef = useRef(env);
  useLayoutEffect(() => {
    envRef.current = env;
  });

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (pending.current) envRef.current.ops.updateCard(pending.current);
    pending.current = null;
  }, []);
  const change = (next: Card, now = false) => {
    setDraft(next);
    pending.current = next;
    window.clearTimeout(timer.current);
    if (now) flush();
    else timer.current = window.setTimeout(flush, 400);
  };
  const close = () => {
    flush();
    // A new card left empty is not kept.
    if (fresh && !draft.title.trim() && !draft.text.trim()) envRef.current.ops.removeCard(card.id);
    onClose();
  };
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  });
  // What is waiting is kept when the editor goes.
  useEffect(() => () => flush(), [flush]);

  // A click anywhere else closes it (but not in its own menus).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || box.current?.contains(t) || t.closest(".wf-flyout, .wf-flyout-scrim, .wf-modal-backdrop")) return;
      closeRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  useLayoutEffect(() => {
    const t = text.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 360)}px`;
    }
  }, [draft.text]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div ref={box} className="wf-plan-card editing" style={tint(cardColor(draft, env.plan))} onKeyDown={onKeyDown} data-editing={card.id}>
      <span className="wf-plan-card-strip" />
      <input
        className="wf-plan-card-title-in"
        autoFocus
        placeholder="Title"
        aria-label="Card title"
        value={draft.title}
        maxLength={200}
        onChange={(e) => change({ ...draft, title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            text.current?.focus();
          }
        }}
      />
      <textarea
        ref={text}
        className="wf-plan-card-text-in"
        placeholder="What happens"
        aria-label="Card text"
        rows={3}
        value={draft.text}
        maxLength={2000}
        onChange={(e) => change({ ...draft, text: e.target.value })}
      />
      <div className="wf-plan-card-fields">
        <label>
          <span>Plot line</span>
          <select value={draft.line ?? ""} onChange={(e) => change({ ...draft, line: e.target.value || null }, true)}>
            <option value="">No plot line</option>
            {env.plan.lines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <CastPicker env={env} chosen={draft.cast} onChange={(cast) => change({ ...draft, cast }, true)} />
      </div>
      <div className="wf-plan-card-foot">
        <label className="wf-plan-check">
          <input type="checkbox" checked={draft.done} onChange={(e) => change({ ...draft, done: e.target.checked }, true)} /> Written
        </label>
        <span className="wf-statusbar-spacer" />
        <button type="button" className="wf-primary" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Where a card can be moved: a chapter (or none) and a plot line. */
function MoveTo({ env, card, close }: { env: PlanEnv; card: Card; close: () => void }) {
  const columns = env.columns?.columns ?? [];
  const [where, setWhere] = useState<string>(() => {
    const col = columns.find((c) => c.cid && c.cid === card.chapter);
    return col ? col.key : "";
  });
  const [line, setLine] = useState(card.line ?? "");
  return (
    <div className="wf-plan-moveto">
      {env.canLink && (
        <label>
          <span>{env.noun[0].toUpperCase() + env.noun.slice(1)}</span>
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="">Unassigned</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Plot line</span>
        <select value={line} onChange={(e) => setLine(e.target.value)}>
          <option value="">No plot line</option>
          {env.plan.lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="wf-primary"
        onClick={() => {
          const column = columns.find((c) => c.key === where);
          const chapter = column ? chapterOf(env, column) : null;
          if (column && !chapter) return;
          env.ops.moveCard(card.id, { line: line || null, chapter });
          close();
        }}
      >
        Move
      </button>
    </div>
  );
}

export function CardMenu({ env, card, onEdit, onTimeline }: { env: PlanEnv; card: Card; onEdit: () => void; onTimeline?: () => void }) {
  return (
    <Flyout title="Card" icon={<Ellipsis size={14} />} caret={false} className="wf-plan-card-more">
      {(close) => (
        <>
          <FlyoutItem
            onPick={() => {
              close();
              onEdit();
            }}
          >
            Edit
          </FlyoutItem>
          <Flyout title="Move to" label="Move to…" caret={false} className="wf-flyout-row">
            {(closeMove) => (
              <MoveTo
                env={env}
                card={card}
                close={() => {
                  closeMove();
                  close();
                }}
              />
            )}
          </Flyout>
          <FlyoutItem
            onPick={() => {
              close();
              env.ops.updateCard({ ...card, done: !card.done });
            }}
            checked={card.done}
          >
            Written
          </FlyoutItem>
          {onTimeline && (
            <FlyoutItem
              onPick={() => {
                close();
                onTimeline();
              }}
            >
              Put on the timeline
            </FlyoutItem>
          )}
          <FlyoutItem
            onPick={() => {
              close();
              deleteCard(env, card);
            }}
          >
            Delete
          </FlyoutItem>
        </>
      )}
    </Flyout>
  );
}

/** A card on the board. */
export function PlanCardView({
  env,
  card,
  focusable,
  dragging,
  onPointerDown,
  onEdit,
  onKeyDown,
  onOpenEntry,
  onTimeline,
  compact = false,
}: {
  env: PlanEnv;
  card: Card;
  focusable: boolean;
  dragging: boolean;
  onPointerDown?: (e: ReactPointerEvent, id: string) => void;
  onEdit: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onOpenEntry?: (id: string) => void;
  onTimeline?: () => void;
  compact?: boolean;
}) {
  const line = env.plan.lines.find((l) => l.id === card.line);
  const cast = card.cast.map((id) => env.plan.cast.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  const where = [line?.name, card.done ? "written" : ""].filter(Boolean).join(", ");
  return (
    <article
      className={`wf-plan-card${dragging ? " dragging" : ""}${card.done ? " done" : ""}${compact ? " compact" : ""}`}
      style={tint(cardColor(card, env.plan))}
      data-card={card.id}
      tabIndex={focusable ? 0 : -1}
      aria-roledescription="card"
      aria-label={`${card.title || "Untitled card"}${where ? `. ${where}` : ""}`}
      onPointerDown={onPointerDown ? (e) => onPointerDown(e, card.id) : undefined}
      onKeyDown={onKeyDown}
      onDoubleClick={env.readonly ? undefined : onEdit}
    >
      <span className="wf-plan-card-strip" />
      <div className="wf-plan-card-head">
        <strong>{card.title || <span className="wf-plan-dim">Untitled card</span>}</strong>
        {card.done && <Check size={13} className="wf-plan-done" aria-hidden="true" />}
        {!env.readonly && !compact && <CardMenu env={env} card={card} onEdit={onEdit} onTimeline={onTimeline} />}
      </div>
      {card.text && <p className="wf-plan-card-text">{card.text}</p>}
      {cast.length > 0 && (
        <div className="wf-plan-chips">
          {cast.map((e) => (
            <button key={e.id} type="button" className="wf-plan-chip" style={tint(e.color)} onClick={() => onOpenEntry?.(e.id)} title={`Open ${e.name} on the Cast and world tab`}>
              {e.name}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
