import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Quote, WholeWord, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "../../platform/toast";
import { findInDoc, replaceAll, replaceOne, type FindOptions, type Match } from "./find/findInDoc";
import type { FindRequest } from "./shell/hooks";

/**
 * Find and replace (⌘F, ⌥⌘F / Ctrl+H). Highlights every match; Enter /
 * Shift+Enter, ⌘G / ⇧⌘G and F3 step through them. Phrases are found across
 * italics and bold, curly and straight quotes match unless "Exact" is on,
 * and options persist on this device. Replace keeps the formatting;
 * Replace All is one undo. Editing never moves the selection to a match —
 * only the writer's own stepping does.
 */

const findKey = new PluginKey("wf-find");
const OPTS_KEY = "wf-find-opts";

function loadOpts(): FindOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}") as FindOptions;
    return { caseSensitive: !!raw.caseSensitive, wholeWord: !!raw.wholeWord, exact: !!raw.exact };
  } catch {
    return {};
  }
}

function saveOpts(opts: FindOptions) {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
  } catch {
    // A convenience only.
  }
}

export function FindBar({
  editor,
  readonly,
  request,
  onClose,
}: {
  editor: Editor;
  readonly: boolean;
  /** Each new request (⌘F again, the search button) refocuses the field,
   *  fills in the selected words, or shows Replace. */
  request: FindRequest;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(request.prefill);
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(request.replace && !readonly);
  const [opts, setOptsState] = useState<FindOptions>(loadOpts);
  const [matches, setMatches] = useState<Match[]>([]);
  const [capped, setCapped] = useState(false);
  const [current, setCurrent] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const paint = useRef<{ matches: Match[]; current: number }>({ matches: [], current: 0 });
  const live = useRef({ matches, current });
  live.current = { matches, current };

  const setOpts = (next: FindOptions) => {
    setOptsState(next);
    saveOpts(next);
  };

  // One decoration plugin for the bar's lifetime. Highlights live in plugin
  // state: rebuilt on a "refresh", otherwise mapped through each edit.
  useEffect(() => {
    const build = (doc: Parameters<typeof DecorationSet.create>[0]) => {
      const { matches: ms, current: cur } = paint.current;
      if (ms.length === 0) return DecorationSet.empty;
      return DecorationSet.create(
        doc,
        ms
          .filter((m) => m.to <= doc.content.size)
          .map((m, i) => Decoration.inline(m.from, m.to, { class: `wf-find-hit${i === cur ? " current" : ""}` })),
      );
    };
    const plugin = new Plugin<DecorationSet>({
      key: findKey,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, set) => {
          if (tr.getMeta(findKey) === "refresh") return build(tr.doc);
          return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
        },
      },
      props: {
        decorations: (state) => findKey.getState(state) as DecorationSet | undefined,
      },
    });
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(findKey);
    };
  }, [editor]);

  // A new request: focus (and fill in, and maybe open Replace).
  useEffect(() => {
    if (request.prefill) setQuery(request.prefill);
    if (request.replace && !readonly) setShowReplace(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }, [request.n, request.prefill, request.replace, readonly]);

  /** Select a match and scroll to it — only ever on the writer's say-so. */
  const goTo = useCallback(
    (m: Match | undefined) => {
      if (!m || m.to > editor.state.doc.content.size) return;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)).scrollIntoView());
    },
    [editor],
  );

  // A new query or new options jump to the first match at or after the cursor.
  useEffect(() => {
    const r = findInDoc(editor.state.doc, query, opts);
    setMatches(r.matches);
    setCapped(r.capped);
    const from = editor.state.selection.from;
    const at = Math.max(0, r.matches.findIndex((m) => m.from >= from));
    setCurrent(at);
    goTo(r.matches[at]);
  }, [editor, query, opts, goTo]);

  // Edits (yours or a collaborator's) refresh the highlights but NEVER move
  // the selection: re-selecting the match after each change used to put the
  // next keystroke on top of it and overwrite the text.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const recompute = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const r = findInDoc(editor.state.doc, query, opts);
        setMatches(r.matches);
        setCapped(r.capped);
        setCurrent((c) => Math.min(c, Math.max(0, r.matches.length - 1)));
      }, 150);
    };
    editor.on("update", recompute);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", recompute);
    };
  }, [editor, query, opts]);

  // Repaint the highlights (a no-op transaction the plugin reads).
  useEffect(() => {
    paint.current = { matches, current };
    editor.view.dispatch(editor.state.tr.setMeta(findKey, "refresh"));
  }, [editor, matches, current]);

  const step = useCallback(
    (dir: 1 | -1) => {
      const { matches: ms, current: cur } = live.current;
      if (ms.length === 0) return;
      const next = (cur + dir + ms.length) % ms.length;
      setCurrent(next);
      goTo(ms[next]);
    },
    [goTo],
  );

  // ⌘G / ⇧⌘G (and F3 / Shift+F3) step through matches while the bar is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "g") || e.key === "F3") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const close = () => {
    onClose();
    // Back to the text, at the match the writer was looking at.
    editor.commands.focus();
  };

  /** Replace the current match (if it's still there), then go to the next. */
  const replaceCurrent = () => {
    if (readonly) return;
    const m = live.current.matches[live.current.current];
    const fresh = findInDoc(editor.state.doc, query, opts).matches.find((f) => m && f.from === m.from && f.to === m.to);
    if (fresh) editor.view.dispatch(replaceOne(editor.state.tr, fresh, replacement));
    const after = findInDoc(editor.state.doc, query, opts);
    setMatches(after.matches);
    setCapped(after.capped);
    const pos = fresh ? fresh.from + replacement.length : (m?.from ?? 0);
    const next = Math.max(0, after.matches.findIndex((f) => f.from >= pos));
    setCurrent(next);
    goTo(after.matches[next]);
  };

  const replaceEvery = () => {
    if (readonly) return;
    const all = findInDoc(editor.state.doc, query, opts, Infinity).matches;
    if (!all.length) return;
    editor.view.dispatch(replaceAll(editor.state.tr, all, replacement));
    toast(`Replaced ${all.length.toLocaleString()} match${all.length === 1 ? "" : "es"}.`, "success");
    setMatches([]);
    setCurrent(0);
  };

  const count =
    matches.length === 0
      ? query
        ? "No matches"
        : ""
      : `${current + 1} of ${capped ? "10,000+" : matches.length.toLocaleString()}`;

  const toggle = (key: keyof FindOptions, title: string, icon: React.ReactNode) => (
    <button
      className={`wf-icon wf-find-opt${opts[key] ? " active" : ""}`}
      title={title}
      aria-pressed={!!opts[key]}
      onClick={() => setOpts({ ...opts, [key]: !opts[key] })}
    >
      {icon}
    </button>
  );

  return (
    <div className={`wf-find-bar wf-doc-find${showReplace ? " with-replace" : ""}`} role="search">
      <div className="wf-find-row">
        {!readonly && (
          <button
            className="wf-icon"
            title={showReplace ? "Hide replace" : "Replace (⌥⌘F / Ctrl+H)"}
            aria-expanded={showReplace}
            onClick={() => {
              setShowReplace(!showReplace);
              if (!showReplace) requestAnimationFrame(() => replaceRef.current?.focus());
            }}
          >
            {showReplace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <input
          ref={findRef}
          placeholder="Find in document…"
          aria-label="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              close();
            }
          }}
        />
        <span className="wf-find-count" aria-live="polite">
          {count}
        </span>
        {toggle("caseSensitive", "Match case", <CaseSensitive size={15} />)}
        {toggle("wholeWord", "Whole words", <WholeWord size={15} />)}
        {toggle("exact", "Exact quotes and spaces (otherwise ’ matches ', “ matches \")", <Quote size={13} />)}
        <button className="wf-icon" title="Previous (⇧↵, ⇧⌘G)" onClick={() => step(-1)}>
          <ChevronUp size={13} />
        </button>
        <button className="wf-icon" title="Next (↵, ⌘G)" onClick={() => step(1)}>
          <ChevronDown size={13} />
        </button>
        <button className="wf-icon" title="Close (Esc)" onClick={close}>
          <X size={13} />
        </button>
      </div>
      {showReplace && !readonly && (
        <div className="wf-find-row">
          <input
            ref={replaceRef}
            placeholder="Replace with…"
            aria-label="Replace with"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) replaceEvery();
                else replaceCurrent();
              } else if (e.key === "Escape") {
                close();
              }
            }}
          />
          <button disabled={!matches.length} onClick={replaceCurrent} title="Replace this match (↵)">
            Replace
          </button>
          <button disabled={!matches.length} onClick={replaceEvery} title="Replace every match (⌘↵) — one undo">
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
