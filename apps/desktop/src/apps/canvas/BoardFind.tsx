import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { CanvasElement } from "../../bindings/proto/CanvasElement";

/**
 * Find and replace across a board's text. Kinds not listed here keep data in
 * `text` rather than prose — a link's URL, an image's attachment id, a
 * document card's JSON reference — and replacing inside them would break the
 * element, so they are never searched.
 */
const SEARCHABLE = new Set(["sticky", "text", "shape", "frame"]);

interface Hit {
  id: number;
  /** Offset of this occurrence within the element's text. */
  at: number;
}

function hitsFor(elements: CanvasElement[], query: string): Hit[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: Hit[] = [];
  const ordered = elements
    .filter((el) => SEARCHABLE.has(el.kind) && el.text)
    // Reading order down the board, so stepping through matches feels ordered.
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const el of ordered) {
    const hay = el.text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1 && hits.length < 500) {
      hits.push({ id: el.id, at });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return hits;
}

/** Case-insensitive replace-all done by scanning, so a query full of regex
 *  punctuation is just text. */
function replaceEvery(text: string, query: string, replacement: string): string {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return out + text.slice(from);
    out += text.slice(from, at) + replacement;
    from = at + needle.length;
  }
}

export function BoardFind({
  elements,
  onGo,
  onReplace,
  onClose,
}: {
  elements: CanvasElement[];
  /** Select and centre the element holding the current match. */
  onGo: (elementId: number) => void;
  /** Apply text edits as one undoable step. */
  onReplace: (edits: { id: number; text: string }[], label: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [current, setCurrent] = useState(0);

  const needle = query.trim();
  const hits = useMemo(() => hitsFor(elements, needle), [elements, needle]);
  const at = hits.length === 0 ? 0 : Math.min(current, hits.length - 1);

  useEffect(() => {
    const hit = hits[at];
    if (hit) onGo(hit.id);
    // Following the match is the whole point; onGo changes identity per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, at]);

  const step = (dir: 1 | -1) => {
    if (hits.length === 0) return;
    setCurrent((c) => (Math.min(c, hits.length - 1) + dir + hits.length) % hits.length);
  };

  const replaceCurrent = () => {
    const hit = hits[at];
    if (!hit || !needle) return;
    const el = elements.find((item) => item.id === hit.id);
    if (!el) return;
    const next = el.text.slice(0, hit.at) + replacement + el.text.slice(hit.at + needle.length);
    onReplace([{ id: el.id, text: next }], "Replace text");
  };

  const replaceAll = () => {
    if (!needle) return;
    const edits: { id: number; text: string }[] = [];
    for (const el of elements) {
      if (!SEARCHABLE.has(el.kind) || !el.text) continue;
      const next = replaceEvery(el.text, needle, replacement);
      if (next !== el.text) edits.push({ id: el.id, text: next });
    }
    if (edits.length === 0) return;
    onReplace(
      edits,
      edits.length === 1 ? "Replace text" : `Replace text in ${edits.length} elements`,
    );
  };

  return (
    <div className="wf-find-bar wf-board-find">
      <input
        autoFocus
        placeholder="Find on board…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCurrent(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="wf-find-count">
        {hits.length === 0 ? (needle ? "0" : "") : `${at + 1}/${hits.length}`}
      </span>
      <button className="wf-icon" title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
        <ChevronUp size={13} />
      </button>
      <button className="wf-icon" title="Next match (Enter)" onClick={() => step(1)}>
        <ChevronDown size={13} />
      </button>
      <input
        className="wf-board-find-replace"
        placeholder="Replace with…"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            replaceCurrent();
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <button disabled={hits.length === 0} onClick={replaceCurrent}>
        Replace
      </button>
      <button disabled={hits.length === 0} onClick={replaceAll}>
        All
      </button>
      <span className="wf-statusbar-spacer" />
      <button className="wf-icon" title="Close (Escape)" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
