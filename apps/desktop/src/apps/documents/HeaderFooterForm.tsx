import { useRef, useState } from "react";

import { SLOT_MAX, type DocSettings, type SlotKey } from "./docSettings";

type Variant = "" | "1" | "e";

const FIELDS: { token: string; label: string }[] = [
  { token: "{page}", label: "Page number" },
  { token: "{pages}", label: "Page count" },
  { token: "{title}", label: "Title" },
  { token: "{author}", label: "Author" },
  { token: "{date}", label: "Date" },
];

const SIDES = [
  ["L", "Left"],
  ["C", "Center"],
  ["R", "Right"],
] as const;

/**
 * Headers and footers: a left, centre and right slot each, holding text
 * with fields (page number, title…). The first page and even pages can
 * have their own. "Add a field" puts it where the cursor last was.
 */
export function HeaderFooterForm({
  settings,
  disabled,
  onPatch,
}: {
  settings: DocSettings;
  disabled: boolean;
  onPatch: (patch: Partial<DocSettings>) => void;
}) {
  const [variant, setVariant] = useState<Variant>("");
  // The slot a field goes into: the one last focused, and where in it.
  const target = useRef<{ key: SlotKey; start: number; end: number } | null>(null);
  const shown: Variant = (variant === "1" && !settings.hfFirst) || (variant === "e" && !settings.hfEven) ? "" : variant;

  const set = (key: SlotKey, value: string) => onPatch({ [key]: value.slice(0, SLOT_MAX) } as Partial<DocSettings>);

  const insert = (token: string) => {
    const t = target.current ?? { key: `f${shown}C` as SlotKey, start: Infinity, end: Infinity };
    // Only into a slot of the pages being edited.
    const key = t.key.slice(1, -1) === shown ? t.key : (`f${shown}C` as SlotKey);
    const cur = settings[key];
    const start = Math.min(t.start, cur.length);
    const end = Math.min(t.end, cur.length);
    set(key, cur.slice(0, start) + token + cur.slice(end));
    target.current = { key, start: start + token.length, end: start + token.length };
  };

  const band = (name: "h" | "f", title: string) => (
    <div className="wf-hf-band">
      <span className="wf-hf-band-title">{title}</span>
      <div className="wf-hf-slots">
        {SIDES.map(([side, label]) => {
          const key = `${name}${shown}${side}` as SlotKey;
          return (
            <input
              key={key}
              className={`wf-hf-slot wf-hf-${side}`}
              type="text"
              aria-label={`${title}, ${label.toLowerCase()}`}
              placeholder={label}
              disabled={disabled}
              value={settings[key]}
              maxLength={SLOT_MAX}
              onChange={(e) => set(key, e.target.value)}
              onSelect={(e) => {
                const el = e.currentTarget;
                target.current = { key, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
              }}
              onFocus={(e) => {
                const el = e.currentTarget;
                target.current = { key, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
              }}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="wf-hf">
      {(settings.hfFirst || settings.hfEven) && (
        <div className="wf-inspector-seg wf-hf-pages" role="tablist" aria-label="Which pages">
          <button role="tab" aria-selected={shown === ""} className={shown === "" ? "active" : ""} onClick={() => setVariant("")}>
            {settings.hfEven ? "Odd pages" : "All pages"}
          </button>
          {settings.hfFirst && (
            <button role="tab" aria-selected={shown === "1"} className={shown === "1" ? "active" : ""} onClick={() => setVariant("1")}>
              First page
            </button>
          )}
          {settings.hfEven && (
            <button role="tab" aria-selected={shown === "e"} className={shown === "e" ? "active" : ""} onClick={() => setVariant("e")}>
              Even pages
            </button>
          )}
        </div>
      )}
      {band("h", "Header")}
      {band("f", "Footer")}
      <div className="wf-hf-fields">
        <span>Add a field</span>
        {FIELDS.map((f) => (
          <button
            key={f.token}
            type="button"
            disabled={disabled}
            // Keep the slot's cursor: the button mustn't take the focus.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(f.token)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <label className="wf-inspector-check">
        <input type="checkbox" disabled={disabled} checked={settings.hfFirst} onChange={(e) => onPatch({ hfFirst: e.target.checked })} />
        <span>Different first page</span>
      </label>
      <label className="wf-inspector-check">
        <input type="checkbox" disabled={disabled} checked={settings.hfEven} onChange={(e) => onPatch({ hfEven: e.target.checked })} />
        <span>Different odd and even pages</span>
      </label>
    </div>
  );
}
