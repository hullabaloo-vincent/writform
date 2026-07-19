import { useEffect, useMemo, useRef, useState } from "react";

import { executeCommand, usePlatform } from "./registry";

/** Cmd/Ctrl+K command palette listing every registered command. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = usePlatform((s) => s.commands);
  const apps = usePlatform((s) => s.apps);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(commands);
    return q ? all.filter((c) => c.title.toLowerCase().includes(q) || c.id.includes(q)) : all;
  }, [commands, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery("");
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

  const run = (id: string) => {
    setOpen(false);
    void executeCommand(id);
  };

  return (
    <div className="wf-palette-backdrop" onClick={() => setOpen(false)}>
      <div className="wf-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a command…"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSelected((i) => Math.min(i + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && matches[selected]) run(matches[selected].id);
          }}
        />
        <ul>
          {matches.map((c, i) => (
            <li
              key={c.id}
              className={i === selected ? "selected" : ""}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(c.id)}
            >
              <span>{c.title}</span>
              <span className="wf-palette-app">{apps[c.appId]?.name ?? c.appId}</span>
            </li>
          ))}
          {matches.length === 0 && <li className="wf-palette-empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
