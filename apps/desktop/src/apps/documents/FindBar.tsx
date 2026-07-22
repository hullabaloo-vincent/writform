import { TextSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Find-in-document (Cmd/Ctrl+F): highlights matches via a decoration plugin,
 * Enter / Shift+Enter cycle, Escape closes. Case-insensitive.
 */

interface Match {
  from: number;
  to: number;
}

const findKey = new PluginKey("wf-find");

/** Mutable state the plugin reads; updated by the bar, refreshed via a meta tx. */
interface FindState {
  matches: Match[];
  current: number;
}

function findMatches(editor: Editor, query: string): Match[] {
  const matches: Match[] = [];
  if (!query) return matches;
  const needle = query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = node.text.toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1 && matches.length < 500) {
      matches.push({ from: pos + idx, to: pos + idx + needle.length });
      idx = haystack.indexOf(needle, idx + needle.length);
    }
  });
  return matches;
}

export function FindBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [matches, setMatches] = useState<Match[]>([]);
  const stateRef = useRef<FindState>({ matches: [], current: 0 });

  // One decoration plugin for the bar's lifetime.
  useEffect(() => {
    const plugin = new Plugin({
      key: findKey,
      props: {
        decorations: (state) => {
          const { matches: ms, current: cur } = stateRef.current;
          if (ms.length === 0) return DecorationSet.empty;
          return DecorationSet.create(
            state.doc,
            ms.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: `wf-find-hit${i === cur ? " current" : ""}`,
              }),
            ),
          );
        },
      },
    });
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(findKey);
    };
  }, [editor]);

  // Recompute on query change or edits; refresh decorations with a no-op tx.
  useEffect(() => {
    const recompute = () => {
      const ms = findMatches(editor, query.trim());
      setMatches(ms);
      setCurrent((c) => Math.min(c, Math.max(0, ms.length - 1)));
    };
    recompute();
    editor.on("update", recompute);
    return () => {
      editor.off("update", recompute);
    };
  }, [editor, query]);

  useEffect(() => {
    stateRef.current = { matches, current };
    editor.view.dispatch(editor.state.tr.setMeta(findKey, "refresh"));
    const m = matches[current];
    if (m) {
      // Move the selection so scrollIntoView lands on the match.
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)),
      );
      editor.commands.scrollIntoView();
    }
  }, [editor, matches, current]);

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    setCurrent((c) => (c + dir + matches.length) % matches.length);
  };

  return (
    <div className="wf-find-bar">
      <input
        autoFocus
        placeholder="Find in document…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="wf-find-count">
        {matches.length === 0 ? (query ? "0" : "") : `${current + 1}/${matches.length}`}
      </span>
      <button className="wf-icon" title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
        <ChevronUp size={13} />
      </button>
      <button className="wf-icon" title="Next match (Enter)" onClick={() => step(1)}>
        <ChevronDown size={13} />
      </button>
      <button className="wf-icon" title="Close (Escape)" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
