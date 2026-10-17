import { Ellipsis, Plus } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Flyout, FlyoutItem } from "../../editor/ui/Flyout";
import { chooseDialog } from "../../platform/confirm";
import { toast } from "../../platform/toast";
import { moveTarget, nextFocus, type GridAt, type GridModel } from "../gridNav";
import type { Card, PlotLine } from "../model";
import { attachByTitle, cardMatches, cellKey, placeCards, type PlanColumn } from "../resolve";
import { insertHeadingAfter, renameHeading } from "../textOps";
import { CardEditor, ColorSwatches, deleteCard, PlanCardView, tint } from "./PlanCard";
import { useCardDrag, type DropAt } from "./useCardDrag";
import { chapterOf, count, type PlanEnv } from "./usePlan";

export interface BoardProps {
  env: PlanEnv;
  query: string;
  layout: "grid" | "list";
  /** Who is in each column, from the text (column key → entries). */
  castRow?: Map<string, { id: string; n: number }[]> | null;
  onShowInText: (pos: number) => void;
  onShowOnly: (pos: number) => void;
  onOpenEntry: (id: string) => void;
  onTimeline: (card: Card) => void;
  /** A column or card to show first. */
  at?: { column?: string; card?: string } | null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A name typed in place: Enter keeps it, Escape or an empty name leaves. */
function NameField({ value, label, onDone, className }: { value: string; label: string; onDone: (name: string | null) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name?.trim() ? name.trim() : null);
  };
  return (
    <input
      className={`wf-plan-name-in${className ? ` ${className}` : ""}`}
      autoFocus
      aria-label={label}
      placeholder={label}
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

export function PlanBoard({ env, query, layout, castRow, onShowInText, onShowOnly, onOpenEntry, onTimeline, at }: BoardProps) {
  const { plan, ops, readonly, noun } = env;
  const columns = env.columns?.columns ?? [];
  const bands = env.columns?.bands ?? [];
  const placed = env.columns ? placeCards(env.columns, plan) : null;
  const [editing, setEditing] = useState<{ id: string; fresh: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ after: string | null } | null>(null);
  const [renamingLine, setRenamingLine] = useState<string | null>(null);
  const [addingLine, setAddingLine] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const shown = (card: Card) => cardMatches(card, query, plan);
  const columnByKey = new Map(columns.map((c) => [c.key, c]));
  const rows = placed?.rows ?? [];

  // Someone else deleted the card being written. (A card just made isn't
  // in the plan read here yet: only one seen and then gone counts.)
  const seenEditing = useRef(false);
  useEffect(() => {
    if (!editing) {
      seenEditing.current = false;
      return;
    }
    if (plan.cards.some((c) => c.id === editing.id)) seenEditing.current = true;
    else if (seenEditing.current) {
      setEditing(null);
      toast("This card was deleted by someone else.", "info");
    }
  }, [plan.cards, editing]);

  // Show what was asked for.
  useEffect(() => {
    const el = at?.card ? root.current?.querySelector<HTMLElement>(`[data-card="${at.card}"]`) : at?.column ? root.current?.querySelector<HTMLElement>(`[data-column="${at.column}"]`) : null;
    if (el) {
      el.scrollIntoView({ block: "nearest", inline: "center" });
      if (at?.card) el.focus();
    }
  }, [at?.card, at?.column]);

  const dropTo = (id: string, to: DropAt) => {
    const card = plan.cards.find((c) => c.id === id);
    if (!card) return;
    if (to.zone === "loose") {
      ops.moveCard(id, { line: card.line, chapter: null }, to.before);
      setSaid("Moved to Unassigned");
      return;
    }
    const bar = to.zone.indexOf("|");
    const line = to.zone.slice(0, bar) || null;
    const column = columnByKey.get(to.zone.slice(bar + 1));
    if (!column) return;
    const chapter = chapterOf(env, column);
    if (!chapter) return;
    ops.moveCard(id, { line, chapter }, to.before);
    setSaid(`Moved to ${column.name}${line ? `, ${plan.lines.find((l) => l.id === line)?.name ?? ""}` : ""}`);
  };
  const drag = useCardDrag(root, scroller, {
    enabled: !readonly && !editing,
    onDrop: dropTo,
    onClick: (id) => {
      if (!readonly) setEditing({ id, fresh: false });
    },
  });

  const addCard = (line: string | null, column: PlanColumn | null) => {
    if (readonly) return;
    const chapter = column ? chapterOf(env, column) : null;
    if (column && !chapter) return;
    const made = ops.addCard({ line, chapter });
    if (!made) {
      toast("This plan holds as many cards as it can.", "info");
      return;
    }
    setEditing({ id: made.id, fresh: true });
  };

  // ---------------------------------------------------------- keyboard

  const model: GridModel = {
    cells: rows.map((row) => columns.map((col) => (placed?.cells.get(cellKey(row.line?.id ?? null, col.key)) ?? []).filter(shown).map((c) => c.id))),
  };
  const whereIs = (id: string): GridAt | null => {
    for (let r = 0; r < model.cells.length; r += 1)
      for (let c = 0; c < model.cells[r].length; c += 1) {
        const i = model.cells[r][c].indexOf(id);
        if (i >= 0) return { row: r, col: c, index: i };
      }
    return null;
  };
  const focusAt = (to: GridAt) => {
    const id = to.index >= 0 ? model.cells[to.row][to.col][to.index] : null;
    const sel = id ? `[data-card="${id}"]` : `[data-add="${cellKey(rows[to.row].line?.id ?? null, columns[to.col].key)}"]`;
    const el = root.current?.querySelector<HTMLElement>(sel);
    if (id) setFocused(id);
    el?.focus();
  };
  const onCardKey = (card: Card) => (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const where = whereIs(card.id);
    if (e.key === "Enter") {
      e.preventDefault();
      if (!readonly) setEditing({ id: card.id, fresh: false });
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !readonly) {
      e.preventDefault();
      const next = where ? (nextFocus(model, where, "ArrowDown") ?? nextFocus(model, where, "ArrowUp")) : null;
      deleteCard(env, card);
      if (next) window.setTimeout(() => focusAt(next));
      return;
    }
    if (!where) return;
    if (e.altKey && !readonly && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const to = moveTarget(model, where, e.key);
      if (!to) return;
      const row = rows[to.row];
      const column = columns[to.col];
      const chapter = chapterOf(env, column);
      if (!chapter) return;
      ops.moveCard(card.id, { line: row.line?.id ?? null, chapter }, to.before);
      setSaid(`Moved to ${column.name}${row.line ? `, ${row.line.name}` : ""}`);
      window.setTimeout(() => root.current?.querySelector<HTMLElement>(`[data-card="${card.id}"]`)?.focus(), 50);
      return;
    }
    const to = nextFocus(model, where, e.key);
    if (to) {
      e.preventDefault();
      focusAt(to);
    }
  };
  const firstFocusable = focused ?? model.cells.flat(2)[0] ?? placed?.loose[0]?.id ?? null;

  // ---------------------------------------------------------- pieces

  const cardView = (card: Card) =>
    editing?.id === card.id ? (
      <CardEditor key={card.id} env={env} card={card} fresh={editing.fresh} onClose={() => setEditing(null)} />
    ) : (
      <PlanCardView
        key={card.id}
        env={env}
        card={card}
        focusable={card.id === firstFocusable}
        dragging={drag.dragging?.id === card.id}
        onPointerDown={readonly ? undefined : drag.onPointerDown}
        onEdit={() => setEditing({ id: card.id, fresh: false })}
        onKeyDown={onCardKey(card)}
        onOpenEntry={onOpenEntry}
        onTimeline={() => onTimeline(card)}
      />
    );

  const caretAt = (zone: string, before: string | null) => drag.dragging && drag.over?.zone === zone && drag.over.before === before;
  const cellCards = (zone: string, cards: Card[]) => (
    <>
      {cards.map((card) => (
        <Fragment key={card.id}>
          {caretAt(zone, card.id) && <div className="wf-plan-caret" />}
          {cardView(card)}
        </Fragment>
      ))}
      {caretAt(zone, null) && <div className="wf-plan-caret" />}
    </>
  );

  const cell = (line: PlotLine | null, column: PlanColumn) => {
    const zone = cellKey(line?.id ?? null, column.key);
    const cards = (placed?.cells.get(zone) ?? []).filter(shown);
    return (
      <div key={zone} className={`wf-plan-cell${cards.length ? "" : " empty"}${drag.over?.zone === zone && drag.dragging ? " over" : ""}`} role="gridcell" data-drop={zone}>
        {cellCards(zone, cards)}
        {!readonly && (
          <button type="button" className="wf-plan-add" data-add={zone} title={`Add a card to ${column.name}${line ? `, ${line.name}` : ""}`} aria-label={`Add a card to ${column.name}${line ? `, ${line.name}` : ""}`} onClick={() => addCard(line?.id ?? null, column)}>
            <Plus size={16} />
          </button>
        )}
      </div>
    );
  };

  const columnMenu = (column: PlanColumn) => (
    <Flyout title={`${cap(noun)} menu`} icon={<Ellipsis size={14} />} caret={false} className="wf-plan-col-more">
      {(close) => (
        <>
          <FlyoutItem
            onPick={() => {
              close();
              onShowInText(column.pos);
            }}
          >
            Show in the text
          </FlyoutItem>
          <FlyoutItem
            onPick={() => {
              close();
              onShowOnly(column.pos);
            }}
          >
            Show only this {noun}
          </FlyoutItem>
          {!readonly && env.editor.isEditable && (
            <>
              <FlyoutItem
                onPick={() => {
                  close();
                  setRenaming(column.key);
                }}
              >
                Rename the {noun}
              </FlyoutItem>
              <FlyoutItem
                onPick={() => {
                  close();
                  setAdding({ after: column.key });
                }}
              >
                Add a {noun} after
              </FlyoutItem>
            </>
          )}
          {!readonly && (
            <FlyoutItem
              onPick={() => {
                close();
                addCard(plan.lines[0]?.id ?? null, column);
              }}
            >
              Add a card here
            </FlyoutItem>
          )}
        </>
      )}
    </Flyout>
  );

  const columnHead = (column: PlanColumn) => {
    const cards = placed?.perColumn.get(column.key) ?? 0;
    return (
      <div key={column.key} className="wf-plan-colhead" role="columnheader" data-column={column.key}>
        {renaming === column.key ? (
          <NameField
            value={column.title}
            label={`Name of the ${noun}`}
            onDone={(name) => {
              setRenaming(null);
              if (name) renameHeading(env.editor, column, name);
            }}
          />
        ) : (
          <>
            <div className="wf-plan-colhead-top">
              <span className="wf-plan-colhead-label">{column.label || cap(noun)}</span>
              {columnMenu(column)}
            </div>
            <button type="button" className="wf-plan-colhead-title" title="Show in the text" onClick={() => onShowInText(column.pos)}>
              {column.title || column.name}
            </button>
            <span className="wf-plan-colhead-meta">
              {count(column.words, "word")}
              {cards > 0 && ` · ${count(cards, "card")}`}
            </span>
          </>
        )}
      </div>
    );
  };

  const addColumnForm = (after: PlanColumn | null, key: string) => (
    <div key={key} className="wf-plan-colhead adding">
      <NameField
        value=""
        label={`Name of the new ${noun}`}
        onDone={(name) => {
          setAdding(null);
          if (name !== null) insertHeadingAfter(env.editor, env.format, after, name);
        }}
      />
    </div>
  );

  const lineMenu = (line: PlotLine, index: number) => (
    <Flyout title="Plot line menu" icon={<Ellipsis size={14} />} caret={false} className="wf-plan-line-more">
      {(close) => (
        <>
          <FlyoutItem
            onPick={() => {
              close();
              setRenamingLine(line.id);
            }}
          >
            Rename
          </FlyoutItem>
          <div className="wf-flyout-heading">Color</div>
          <ColorSwatches value={line.color} onPick={(c) => ops.updateLine({ ...line, color: c })} />
          <FlyoutItem
            disabled={index === 0}
            onPick={() => {
              close();
              ops.moveLine(line.id, index - 1);
            }}
          >
            Move up
          </FlyoutItem>
          <FlyoutItem
            disabled={index === plan.lines.length - 1}
            onPick={() => {
              close();
              ops.moveLine(line.id, index + 1);
            }}
          >
            Move down
          </FlyoutItem>
          <FlyoutItem
            onPick={() => {
              close();
              void removeLine(line);
            }}
          >
            Delete plot line…
          </FlyoutItem>
        </>
      )}
    </Flyout>
  );

  const removeLine = async (line: PlotLine) => {
    const cards = plan.cards.filter((c) => c.line === line.id).length;
    let keep = false;
    if (cards > 0) {
      const choice = await chooseDialog(
        `“${line.name}” has ${count(cards, "card")}.`,
        [
          { id: "keep", label: `Delete the line and keep its ${cards === 1 ? "card" : "cards"}` },
          { id: "all", label: `Delete the line and its ${count(cards, "card")}` },
        ],
        { title: "Delete plot line" },
      );
      if (!choice) return;
      keep = choice === "keep";
    }
    const undo = ops.removeLine(line.id, keep);
    toast(keep || !cards ? `Deleted the plot line “${line.name}”.` : `Deleted the plot line “${line.name}” and ${count(cards, "card")}.`, "info", { durationMs: 10000, action: { label: "Undo", run: undo } });
  };

  const lineHead = (line: PlotLine | null, index: number) => (
    <div key={`h${line?.id ?? ""}`} className="wf-plan-linehead" role="rowheader" style={tint(line?.color)}>
      {line && renamingLine === line.id ? (
        <NameField
          value={line.name}
          label="Name of the plot line"
          onDone={(name) => {
            setRenamingLine(null);
            if (name) ops.updateLine({ ...line, name });
          }}
        />
      ) : (
        <>
          <span className="wf-plan-linehead-name">{line ? line.name : "No plot line"}</span>
          {line && !readonly && lineMenu(line, index)}
        </>
      )}
    </div>
  );

  const addLineRow = () =>
    readonly ? null : addingLine ? (
      <div className="wf-plan-addline">
        <NameField
          value={plan.lines.length ? "" : "Main plot"}
          label="Name of the plot line"
          onDone={(name) => {
            setAddingLine(false);
            if (name && !ops.addLine(name)) toast("This plan holds as many plot lines as it can.", "info");
          }}
        />
      </div>
    ) : (
      <div className="wf-plan-addline">
        <button type="button" className="wf-plan-row-button" onClick={() => setAddingLine(true)}>
          <Plus size={14} /> Plot line
        </button>
      </div>
    );

  // ---------------------------------------------------------- the tray

  const loose = (placed?.loose ?? plan.cards.filter((c) => !c.chapter)).filter(shown);
  const lost = (placed?.lost ?? []).filter(shown);
  const backTo = env.columns && lost.length ? attachByTitle(env.columns, lost) : new Map<string, PlanColumn>();
  const tray = (
    <section className={`wf-plan-loose${drag.over?.zone === "loose" && drag.dragging ? " over" : ""}`} aria-label="Unassigned planning notes">
      <header>
        <h3>Unassigned planning notes{loose.length ? ` (${loose.length})` : ""}</h3>
        {!readonly && (
          <button type="button" className="wf-plan-row-button" onClick={() => addCard(null, null)}>
            <Plus size={14} /> Planning note
          </button>
        )}
      </header>
      <div className="wf-plan-loose-cards" data-drop="loose">
        {cellCards("loose", loose)}
        {!loose.length && !drag.dragging && <p className="wf-plan-dim">{query ? "No notes here match." : `Notes not yet in a ${noun} wait here, ready to be put in one.`}</p>}
      </div>
      {lost.length > 0 && (
        <div className="wf-plan-lost">
          <h4>Their {noun} was deleted</h4>
          <div className="wf-plan-loose-cards">
            {lost.map((card) => {
              const back = backTo.get(card.id);
              return (
                <div key={card.id} className="wf-plan-lost-card">
                  {cardView(card)}
                  <small>
                    {card.lostTitle ? `Was in “${card.lostTitle}”.` : `Its ${noun} is gone.`}{" "}
                    {back && !readonly && (
                      <button
                        type="button"
                        className="wf-plan-link"
                        onClick={() => {
                          const chapter = chapterOf(env, back);
                          if (chapter) ops.moveCard(card.id, { line: card.line, chapter });
                        }}
                      >
                        Put it back in “{back.title || back.name}”
                      </button>
                    )}
                  </small>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );

  const ghost = drag.dragging ? plan.cards.find((c) => c.id === drag.dragging?.id) : null;
  const ghostView = ghost && (
    <div className="wf-plan-ghost" style={{ left: drag.dragging!.x + 8, top: drag.dragging!.y + 8, ...tint(plan.lines.find((l) => l.id === ghost.line)?.color) }} aria-hidden="true">
      <strong>{ghost.title || "Untitled card"}</strong>
    </div>
  );
  const live = (
    <div className="wf-plan-sr" aria-live="polite">
      {said}
    </div>
  );

  // ---------------------------------------------------------- empty states

  if (!env.canLink) {
    return (
      <div className="wf-plan-board" ref={root}>
        <p className="wf-plan-note">Cards can be put in {noun}s once this server is updated. Until then they wait here.</p>
        {tray}
        {ghostView}
        {live}
      </div>
    );
  }

  if (!columns.length) {
    return (
      <div className="wf-plan-board" ref={root}>
        <div className="wf-plan-empty">
          <p>This {env.format === "none" ? "document has no headings" : `book has no ${noun}s`} yet.</p>
          {!readonly && env.editor.isEditable && (adding ? addColumnForm(null, "first") : (
            <button type="button" className="wf-primary" onClick={() => setAdding({ after: null })}>
              Add the first {noun}
            </button>
          ))}
        </div>
        {tray}
        {ghostView}
        {live}
      </div>
    );
  }

  // ---------------------------------------------------------- the list

  if (layout === "list") {
    return (
      <div className="wf-plan-board list" ref={root}>
        <div className="wf-plan-scroll" ref={scroller}>
          {columns.map((column, i) => (
            <Fragment key={column.key}>
              {column.band >= 0 && (i === 0 || columns[i - 1].band !== column.band) && <h3 className="wf-plan-list-band">{bands[column.band].name}</h3>}
              <section className="wf-plan-list-col">
                {columnHead(column)}
                {(rows.length ? rows : [{ line: null, key: "" }]).map((row) => (
                  <div key={row.key} className="wf-plan-list-row" style={tint(row.line?.color)}>
                    <span className="wf-plan-list-line">{row.line ? row.line.name : "No plot line"}</span>
                    {cell(row.line, column)}
                  </div>
                ))}
              </section>
              {adding?.after === column.key && addColumnForm(column, `add-${column.key}`)}
            </Fragment>
          ))}
          {addLineRow()}
          {tray}
        </div>
        {ghostView}
        {live}
      </div>
    );
  }

  // ---------------------------------------------------------- the grid

  const segments: { band: number; span: number; from: number }[] = [];
  columns.forEach((c, i) => {
    const last = segments[segments.length - 1];
    if (last && last.band === c.band) last.span += 1;
    else segments.push({ band: c.band, span: 1, from: i });
  });
  const addAt = adding?.after ?? null;
  const colCount = columns.length + (adding && addAt ? 1 : 0) + (readonly || !env.editor.isEditable ? 0 : 1);
  const headCells: ReactNode[] = [];
  columns.forEach((column) => {
    headCells.push(columnHead(column));
    if (addAt === column.key) headCells.push(addColumnForm(column, `add-${column.key}`));
  });
  const gap = (key: string) => (addAt ? <div key={key} className="wf-plan-cell gap" /> : null);

  return (
    <div className="wf-plan-board" ref={root}>
      <div className="wf-plan-scroll" ref={scroller}>
        <div className="wf-plan-grid" role="grid" aria-label={`Plot lines by ${noun}`} style={{ gridTemplateColumns: `var(--wf-plan-rowhead) repeat(${colCount}, var(--wf-plan-col))` }}>
          {bands.length > 0 && (
            <>
              <div className="wf-plan-corner band" />
              {segments.map((s) => (
                <div key={`band${s.from}`} className={`wf-plan-band${s.band < 0 ? " none" : ""}`} style={{ gridColumn: `span ${s.span + (addAt && columns.slice(s.from, s.from + s.span).some((c) => c.key === addAt) ? 1 : 0)}` }}>
                  {s.band >= 0 && (
                    <button type="button" className="wf-plan-band-name" onClick={() => onShowInText(bands[s.band].pos)}>
                      {bands[s.band].name}
                    </button>
                  )}
                </div>
              ))}
              {!readonly && env.editor.isEditable && <div className="wf-plan-band none" />}
            </>
          )}
          <div className={`wf-plan-corner${bands.length ? " under-band" : ""}`} />
          {headCells}
          {!readonly && env.editor.isEditable && (
            <div className="wf-plan-colhead add">
              <button type="button" className="wf-plan-row-button" onClick={() => setAdding({ after: columns[columns.length - 1].key })}>
                <Plus size={14} /> {cap(noun)}
              </button>
            </div>
          )}
          {castRow && (
            <>
              <div className="wf-plan-linehead cast" role="rowheader">
                <span className="wf-plan-linehead-name">Who is in it</span>
              </div>
              {columns.map((column) => {
                const who = castRow.get(column.key) ?? [];
                return (
                  <Fragment key={`cast${column.key}`}>
                    <div className="wf-plan-castcell">
                      {who.slice(0, 6).map((w) => {
                        const entry = plan.cast.find((e) => e.id === w.id);
                        return entry ? (
                          <button key={w.id} type="button" className="wf-plan-chip" style={tint(entry.color)} title={`${entry.name}: ${count(w.n, "mention")}`} onClick={() => onOpenEntry(entry.id)}>
                            {entry.name}
                          </button>
                        ) : null;
                      })}
                      {who.length > 6 && <span className="wf-plan-dim">+{who.length - 6}</span>}
                    </div>
                    {addAt === column.key && gap(`castgap${column.key}`)}
                  </Fragment>
                );
              })}
              {!readonly && env.editor.isEditable && <div className="wf-plan-castcell" />}
            </>
          )}
          {rows.map((row, r) => (
            <Fragment key={row.key}>
              {lineHead(row.line, r)}
              {columns.map((column) => (
                <Fragment key={column.key}>
                  {cell(row.line, column)}
                  {addAt === column.key && gap(`gap${row.key}${column.key}`)}
                </Fragment>
              ))}
              {!readonly && env.editor.isEditable && <div className="wf-plan-cell gap" />}
            </Fragment>
          ))}
          {!rows.length && !readonly && (
            <div className="wf-plan-nolines" style={{ gridColumn: `1 / span ${colCount + 1}` }}>
              <p>Plot lines are the stories that run through the book. Add one to put cards in its {noun}s.</p>
            </div>
          )}
          <div className="wf-plan-addline-cell" style={{ gridColumn: `1 / span ${colCount + 1}` }}>
            {addLineRow()}
          </div>
        </div>
      </div>
      {tray}
      {ghostView}
      {live}
    </div>
  );
}
