import type { Editor } from "@tiptap/core";
import { Clipboard, LayoutGrid, LayoutList, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type * as Y from "yjs";

import type { BookDesign } from "../../book/model/presets";
import { Flyout, FlyoutItem, useIsPhone } from "../../editor/ui/Flyout";
import { toast } from "../../platform/toast";
import { planToMarkdown } from "../markdown";
import { buildNameIndex, mentionsByColumn } from "../mentions";
import { cardMatches, foldSearch } from "../resolve";
import { CastPane } from "./CastPane";
import { PlanBoard } from "./PlanBoard";
import { TimelinePane } from "./TimelinePane";
import { count, usePlanEnv, type PlanEnv } from "./usePlan";
import type { Card } from "../model";

export type PlanTab = "board" | "cast" | "timeline";

const TABS: { id: PlanTab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "cast", label: "Cast and world" },
  { id: "timeline", label: "Timeline" },
];

const WIDTHS = { narrow: 200, medium: 248, wide: 320 } as const;
type Width = keyof typeof WIDTHS;

/** A person's own way of seeing the board, kept on this device. */
function useLocal<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // kept for this time only
      }
    },
  ];
}

export interface PlanViewProps {
  editor: Editor;
  ydoc: Y.Doc;
  format: string;
  design?: Pick<BookDesign, "chapterNumber" | "chapterLabel" | "restartNumbersInParts">;
  readonly: boolean;
  /** The level the document may hold here. */
  level: number;
  tab: PlanTab;
  onTab: (tab: PlanTab) => void;
  /** Something to show first. */
  at?: { column?: string; card?: string; entry?: string } | null;
  onClose: () => void;
  onShowInText: (pos: number) => void;
  onShowOnly: (pos: number) => void;
  /** Step through an entry's mentions in the text (in the side panel). */
  onShowMentions: (entryId: string) => void;
}

/** Who appears in each column, by the cast's names, while it is wanted. */
export function useMentions(env: PlanEnv, wanted: boolean) {
  const index = useMemo(() => buildNameIndex(env.plan.cast), [env.plan.cast]);
  const [found, setFound] = useState<ReturnType<typeof mentionsByColumn> | null>(null);
  useEffect(() => {
    if (!wanted || !env.columns) {
      setFound(null);
      return;
    }
    const run = () => {
      if (!env.editor.isDestroyed && env.columns) setFound(mentionsByColumn(env.editor.state.doc, env.columns.columns, index));
    };
    run();
    let timer = 0;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 400);
    };
    env.editor.on("update", onUpdate);
    return () => {
      window.clearTimeout(timer);
      env.editor.off("update", onUpdate);
    };
  }, [wanted, env.editor, env.columns, index]);
  return found;
}

export function PlanView(props: PlanViewProps) {
  const { editor, ydoc, format, design, readonly, level, tab, onTab, onClose } = props;
  const env = usePlanEnv(editor, ydoc, format, design, readonly, level);
  const phone = useIsPhone();
  const [layoutPick, setLayout] = useLocal<"grid" | "list">("wf-plan-layout", "grid", ["grid", "list"]);
  const [width, setWidth] = useLocal<Width>("wf-plan-colw", "medium", ["narrow", "medium", "wide"]);
  const [castShown, setCastShown] = useLocal<"on" | "off">("wf-plan-cast", "on", ["on", "off"]);
  const layout = phone ? "list" : layoutPick;
  const [query, setQuery] = useState("");
  const [entry, setEntry] = useState<string | null>(props.at?.entry ?? null);
  const [boardAt, setBoardAt] = useState(props.at ?? null);
  const search = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  // Focus comes back where it was when the plan closes.
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    box.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, []);

  const mentions = useMentions(env, tab === "cast" || (tab === "board" && castShown === "on" && env.plan.cast.length > 0));
  const castRow = useMemo(() => {
    if (!mentions || !env.columns || tab !== "board" || castShown !== "on" || !env.plan.cast.length) return null;
    const out = new Map<string, { id: string; n: number }[]>();
    env.columns.columns.forEach((c, i) => {
      const who: { id: string; n: number }[] = [];
      for (const [id, m] of mentions.byEntry) {
        const n = m.cols.get(i) ?? 0;
        if (n > 0) who.push({ id, n });
      }
      who.sort((a, b) => b.n - a.n);
      out.set(c.key, who);
    });
    return out;
  }, [mentions, env.columns, env.plan.cast.length, tab, castShown]);

  const total = tab === "board" ? env.plan.cards.length : tab === "cast" ? env.plan.cast.length : env.plan.events.length;
  const noun = tab === "board" ? "card" : tab === "cast" ? "entry" : "event";
  const matching = useMemo(() => {
    if (!query.trim()) return null;
    if (tab === "board") return env.plan.cards.filter((c) => cardMatches(c, query, env.plan)).length;
    const q = foldSearch(query);
    if (tab === "cast") return env.plan.cast.filter((e) => foldSearch(`${e.name} ${e.aka.join(" ")} ${e.note}`).includes(q)).length;
    return env.plan.events.filter((e) => foldSearch(`${e.title} ${e.text} ${e.when}`).includes(q)).length;
  }, [query, tab, env.plan]);

  const openEntry = (id: string) => {
    setEntry(id);
    onTab("cast");
  };
  const toTimeline = (card: Card) => {
    const made = env.ops.addEvent({ title: card.title, text: card.text, chapter: card.chapter, cast: card.cast, card: card.id });
    if (!made) {
      toast("This plan holds as many events as it can.", "info");
      return;
    }
    toast(`Put “${card.title || "the card"}” on the timeline.`, "info", {
      action: { label: "Show it", run: () => onTab("timeline") },
    });
  };
  const copyMarkdown = () => {
    const text = planToMarkdown(env, mentions);
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast("Copied the plan as Markdown.", "success"))
      .catch(() => toast("The plan couldn’t be copied.", "error"));
  };

  return (
    <div
      ref={box}
      className={`wf-plan-overlay${phone ? " phone" : ""}`}
      role="dialog"
      aria-label="Story plan"
      tabIndex={-1}
      style={{ "--wf-plan-col": `${WIDTHS[width]}px` } as CSSProperties}
      onKeyDown={(e) => {
        if (e.defaultPrevented) return;
        if (e.key === "Escape") {
          e.preventDefault();
          if (query) setQuery("");
          else onClose();
        } else if (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          search.current?.focus();
        }
      }}
    >
      <header className="wf-plan-bar">
        <button type="button" className="wf-plan-close" title="Close the plan" aria-label="Close the plan" onClick={onClose}>
          <X size={16} />
        </button>
        <h2>Plan</h2>
        <nav className="wf-plan-tabs" role="tablist" aria-label="Plan">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="wf-statusbar-spacer" />
        <label className="wf-plan-search">
          <input
            ref={search}
            type="search"
            value={query}
            placeholder={`Search ${count(total, noun, noun === "entry" ? "entries" : `${noun}s`)}`}
            aria-label={`Search the ${noun === "entry" ? "entries" : `${noun}s`}`}
            onChange={(e) => setQuery(e.target.value)}
          />
          {matching !== null && <span className="wf-plan-dim">{matching} of {total}</span>}
        </label>
        {tab === "board" && !phone && (
          <div className="wf-plan-layout" role="group" aria-label="Layout">
            <button type="button" title="Grid" aria-label="Grid" aria-pressed={layout === "grid"} className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")}>
              <LayoutGrid size={15} />
            </button>
            <button type="button" title="List" aria-label="List" aria-pressed={layout === "list"} className={layout === "list" ? "active" : ""} onClick={() => setLayout("list")}>
              <LayoutList size={15} />
            </button>
          </div>
        )}
        <Flyout title="View" icon={<SlidersHorizontal size={15} />} caret={false} className="wf-plan-viewmenu">
          {(close) => (
            <>
              {tab === "board" && !phone && (
                <>
                  <div className="wf-flyout-heading">Columns</div>
                  {(Object.keys(WIDTHS) as Width[]).map((w) => (
                    <FlyoutItem key={w} checked={width === w} onPick={() => setWidth(w)}>
                      {w === "narrow" ? "Narrow" : w === "medium" ? "Medium" : "Wide"}
                    </FlyoutItem>
                  ))}
                  <FlyoutItem checked={castShown === "on"} onPick={() => setCastShown(castShown === "on" ? "off" : "on")}>
                    Show who is in each {env.noun}
                  </FlyoutItem>
                </>
              )}
              <FlyoutItem
                onPick={() => {
                  close();
                  copyMarkdown();
                }}
              >
                <span className="wf-plan-iconrow">
                  <Clipboard size={14} aria-hidden="true" />
                  <span>Copy the plan as Markdown</span>
                </span>
              </FlyoutItem>
            </>
          )}
        </Flyout>
      </header>
      {readonly && <p className="wf-plan-note">You can read this plan. Changes are off.</p>}
      <div className="wf-plan-body">
        {tab === "board" && (
          <PlanBoard
            env={env}
            query={query}
            layout={layout}
            castRow={castRow}
            onShowInText={props.onShowInText}
            onShowOnly={props.onShowOnly}
            onOpenEntry={openEntry}
            onTimeline={toTimeline}
            at={boardAt}
          />
        )}
        {tab === "cast" && (
          <CastPane
            env={env}
            query={query}
            mentions={mentions}
            selected={entry}
            onSelect={setEntry}
            onShowMentions={props.onShowMentions}
            onOpenCard={(id) => {
              setBoardAt({ card: id });
              onTab("board");
            }}
          />
        )}
        {tab === "timeline" && <TimelinePane env={env} query={query} onShowInText={props.onShowInText} onOpenEntry={openEntry} />}
      </div>
    </div>
  );
}
