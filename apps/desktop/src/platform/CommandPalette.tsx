import { useEffect, useMemo, useRef, useState } from "react";

import type { PaletteItem } from "./types";
import { executeCommand, usePlatform } from "./registry";

interface JumpEntry {
  item: PaletteItem;
  appId: string;
}

/** Cmd/Ctrl+K palette: jump to a channel, document, board, or note by name,
 *  or run any registered command — one box for "take me to" and "do". */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [jumps, setJumps] = useState<JumpEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const commands = usePlatform((s) => s.commands);
  const sources = usePlatform((s) => s.paletteSources);
  const apps = usePlatform((s) => s.apps);

  // Ask every registered source, debounced; a stale query's answers are
  // dropped rather than raced into the list.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setJumps([]);
      return;
    }
    const mySeq = ++seq.current;
    const t = setTimeout(() => {
      void Promise.all(
        Object.values(sources).map((src) =>
          src.search(q).then(
            (items) => items.slice(0, 8).map((item) => ({ item, appId: src.appId })),
            () => [] as JumpEntry[],
          ),
        ),
      ).then((groups) => {
        if (seq.current !== mySeq) return;
        setJumps(groups.flat());
        setSelected(0);
      });
    }, 120);
    return () => clearTimeout(t);
  }, [open, query, sources]);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const places = jumps.map(({ item, appId }) => ({
      key: `jump:${appId}:${item.id}`,
      title: item.title,
      hint: item.subtitle ?? apps[appId]?.name ?? appId,
      run: item.run,
    }));
    const cmds = Object.values(commands)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.id.includes(q))
      .map((c) => ({
        key: `cmd:${c.id}`,
        title: c.title,
        hint: apps[c.appId]?.name ?? c.appId,
        run: () => executeCommand(c.id),
      }));
    const shortcuts = {
      key: "builtin:shortcuts",
      title: "Keyboard shortcuts",
      hint: "Help",
      run: () => usePlatform.getState().setShortcutsOpen(true),
    };
    const builtin = !q || shortcuts.title.toLowerCase().includes(q) ? [shortcuts] : [];
    return [...places, ...cmds, ...builtin];
  }, [commands, apps, query, jumps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
        setJumps([]);
        setSelected(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const run = (entry: (typeof entries)[number]) => {
    setOpen(false);
    void entry.run();
  };

  return (
    <div className="wf-palette-backdrop" onClick={() => setOpen(false)}>
      <div className="wf-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Jump to a place, or run a command…"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSelected((i) => Math.min(i + 1, entries.length - 1));
            else if (e.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && entries[selected]) run(entries[selected]);
          }}
        />
        <ul>
          {entries.map((entry, i) => (
            <li
              key={entry.key}
              className={i === selected ? "selected" : ""}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(entry)}
            >
              <span>{entry.title}</span>
              <span className="wf-palette-app">{entry.hint}</span>
            </li>
          ))}
          {entries.length === 0 && <li className="wf-palette-empty">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
