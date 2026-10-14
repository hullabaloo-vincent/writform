import { useMemo, useState } from "react";

import { Modal } from "../../platform/Modal";
import { builtIn, useAutoCorrect } from "./store";

/**
 * The writer's own corrections: what is set right as they type. The
 * built-in entries and their own in one list (any of them can be taken
 * out), a place to add one, and the two lists of exceptions.
 */
export default function AutoCorrectDialog({ onClose }: { onClose: () => void }) {
  const state = useAutoCorrect();
  const [filter, setFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");

  const rows = useMemo(() => {
    const mine = Object.entries(state.add).map(([typed, becomes]) => ({ typed, becomes, own: true }));
    const theirs = [...builtIn()].filter(([typed]) => !(typed in state.add) && !state.drop.includes(typed)).map(([typed, becomes]) => ({ typed, becomes, own: false }));
    const all = [...mine.sort((a, b) => a.typed.localeCompare(b.typed)), ...theirs.sort((a, b) => a.typed.localeCompare(b.typed))];
    const q = filter.trim().toLowerCase();
    return q ? all.filter((row) => row.typed.includes(q) || row.becomes.toLowerCase().includes(q)) : all;
  }, [state.add, state.drop, filter]);

  const add = () => {
    if (state.put(from, to)) {
      setFrom("");
      setTo("");
      setNote("");
    } else {
      setNote("Give one word to type (no spaces) and what it should become.");
    }
  };
  const lines = (text: string) => text.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean);

  return (
    <Modal onClose={onClose} className="wf-autocorrect">
      <h3>Your corrections</h3>
      <p className="wf-session-meta">
        What is typed on the left is changed to what is on the right when the word is finished. The built-in words are
        English and apply to English text. Your own apply in every language. On this device only.
      </p>
      <form
        className="wf-autocorrect-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={from} aria-label="What is typed" placeholder="What is typed" maxLength={40} onChange={(e) => setFrom(e.target.value)} />
        <span aria-hidden="true">→</span>
        <input value={to} aria-label="What it becomes" placeholder="What it becomes" maxLength={200} onChange={(e) => setTo(e.target.value)} />
        <button type="submit" disabled={!from.trim() || !to.trim()}>
          Add
        </button>
      </form>
      {note && <p className="wf-connect-error">{note}</p>}
      <input className="wf-autocorrect-filter" value={filter} aria-label="Find a correction" placeholder="Find a correction" onChange={(e) => setFilter(e.target.value)} />
      <ul className="wf-autocorrect-list">
        {rows.map((row) => (
          <li key={row.typed}>
            <span className="wf-autocorrect-typed">{row.typed}</span>
            <span aria-hidden="true">→</span>
            <span className="wf-autocorrect-becomes">{row.becomes}</span>
            {row.own && <span className="wf-autocorrect-own">yours</span>}
            <button type="button" className="wf-link-button" onClick={() => state.remove(row.typed)}>
              Remove
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="wf-autocorrect-none">Nothing matches.</li>}
      </ul>
      {state.drop.length > 0 && (
        <p className="wf-session-meta">
          Taken out:{" "}
          {state.drop.map((typed) => (
            <button key={typed} type="button" className="wf-link-button wf-autocorrect-back" title="Bring it back" onClick={() => state.restore(typed)}>
              {typed}
            </button>
          ))}
        </p>
      )}
      <label className="wf-autocorrect-field">
        <span>No capital after these shortenings (one a line)</span>
        <textarea rows={2} defaultValue={state.noCapAfter.join("\n")} placeholder="approx" onBlur={(e) => state.setExceptions("noCapAfter", lines(e.target.value))} />
      </label>
      <label className="wf-autocorrect-field">
        <span>Words to leave exactly as typed (one a line)</span>
        <textarea rows={2} defaultValue={state.keepCaps.join("\n")} placeholder="McCOY" onBlur={(e) => state.setExceptions("keepCaps", lines(e.target.value))} />
      </label>
      <div className="wf-connect-row">
        <button type="button" onClick={state.reset}>
          Back to the built-in list
        </button>
        <button type="button" className="wf-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
