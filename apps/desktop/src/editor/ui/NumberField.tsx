import { useState } from "react";

/** A number box that commits on Enter or on leaving it (so a half-typed
 *  value never reaches the document), clamped to its range. */
export function NumberField({
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === "" || !Number.isFinite(n)) return;
    onCommit(Math.min(max, Math.max(min, n)));
  };
  return (
    <input
      className="wf-inspector-number"
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(null);
        }
      }}
    />
  );
}
