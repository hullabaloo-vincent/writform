import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Underline } from "lucide-react";
import { useState } from "react";

import type { FontInfo } from "../../fonts/css";
import { fontCssFamily } from "../../fonts/css";
import { FontPicker } from "../../fonts/ui/FontPicker";
import { Modal } from "../../platform/Modal";
import { toHexColor } from "../schema/sanitize";
import { lineCss, STYLE_NAME_MAX, type StyleAlign, type StyleEntry, type StyleLook, type StyleProps } from "../styles/sheet";
import { TEXT_COLORS } from "./ColorFlyout";
import { NumberField } from "./NumberField";

const LINES: [number, string][] = [
  [1, "Single"],
  [1.15, "1.15"],
  [1.5, "1.5"],
  [2, "Double"],
];

/** The keys of a look a style can state. */
const KEYS: (keyof StyleProps)[] = [
  "font",
  "size",
  "bold",
  "italic",
  "underline",
  "color",
  "align",
  "line",
  "before",
  "after",
  "indL",
  "indR",
  "indF",
  "keepNext",
];

const round = (v: number, places: number) => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

/**
 * Change what a style looks like (or name and shape a new one). The form
 * shows the whole look; what's saved is only how it differs from the style
 * it starts from, so a heading that was merely recoloured still follows
 * the document's body size.
 */
export function StyleDialog({
  title,
  name,
  look,
  base,
  fonts,
  fontTable,
  onSave,
  onReset,
  resetLabel,
  onClose,
}: {
  title: string;
  /** A style of the document's own has a name to edit; null for a built-in. */
  name: string | null;
  /** How the style looks now. */
  look: StyleLook;
  /** How it looks with nothing changed (the built-in, or the style a
   *  custom one is based on). */
  base: StyleLook;
  /** Font ids the document uses, for the picker. */
  fonts: string[];
  fontTable: Record<string, FontInfo>;
  onSave: (entry: StyleEntry, used: { font: string | null }) => void;
  /** Back to the built-in look, or (a custom style) delete it. */
  onReset?: () => void;
  resetLabel?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<StyleLook>(look);
  const [label, setLabel] = useState(name ?? "");
  const set = (patch: Partial<StyleLook>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    const props: StyleProps = {};
    for (const key of KEYS) {
      if (draft[key] !== base[key]) (props as Record<string, unknown>)[key] = draft[key];
    }
    onSave({ ...(name !== null ? { name: label.trim().slice(0, STYLE_NAME_MAX) || "My style" } : {}), props }, { font: draft.font });
  };

  const hanging = draft.indF < 0;
  const family = draft.font ? fontCssFamily(draft.font, fontTable[draft.font]) : null;
  const lineOptions = LINES.some(([v]) => v === draft.line) ? LINES : [...LINES, [draft.line, String(round(draft.line, 2))] as [number, string]];

  return (
    <Modal onClose={onClose} className="wf-style-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h3>{title}</h3>
        {name !== null && (
          <label className="wf-inspector-row">
            <span>Name</span>
            <input value={label} maxLength={STYLE_NAME_MAX} autoFocus onChange={(e) => setLabel(e.target.value)} />
          </label>
        )}

        <p
          className="wf-style-sample"
          style={{
            ...(family ? { fontFamily: family } : {}),
            fontSize: `${Math.min(28, Math.max(9, draft.size))}pt`,
            fontWeight: draft.bold ? 700 : 400,
            fontStyle: draft.italic ? "italic" : "normal",
            textDecoration: draft.underline ? "underline" : "none",
            color: draft.color ?? undefined,
            textAlign: draft.align,
            lineHeight: lineCss(draft.line),
          }}
        >
          The quick brown fox jumps over the lazy dog.
        </p>

        <div className="wf-style-fields">
          <div className="wf-inspector-row">
            <span>Font</span>
            <FontPicker
              value={draft.font}
              docFonts={fonts}
              docTable={fontTable}
              defaultLabel="Body font"
              className="wf-inspector-font"
              onPick={(id) => set({ font: id })}
            />
          </div>
          <label className="wf-inspector-row">
            <span>Size</span>
            <span className="wf-style-unit">
              <NumberField value={draft.size} min={4} max={200} step={0.5} disabled={false} onCommit={(v) => v !== null && set({ size: round(v, 1) })} />
              pt
            </span>
          </label>
          <div className="wf-inspector-row">
            <span>Style</span>
            <div className="wf-inspector-seg" role="group" aria-label="Style">
              <button type="button" title="Bold" aria-pressed={draft.bold} className={draft.bold ? "active" : ""} onClick={() => set({ bold: !draft.bold })}>
                <Bold size={15} />
              </button>
              <button type="button" title="Italic" aria-pressed={draft.italic} className={draft.italic ? "active" : ""} onClick={() => set({ italic: !draft.italic })}>
                <Italic size={15} />
              </button>
              <button type="button" title="Underline" aria-pressed={draft.underline} className={draft.underline ? "active" : ""} onClick={() => set({ underline: !draft.underline })}>
                <Underline size={15} />
              </button>
            </div>
          </div>
          <div className="wf-inspector-row">
            <span>Colour</span>
            <div className="wf-style-colors">
              <button type="button" className={`wf-color-none${draft.color === null ? " current" : ""}`} onClick={() => set({ color: null })}>
                Automatic
              </button>
              {TEXT_COLORS.slice(0, 10).map((s) => (
                <button
                  key={s.color}
                  type="button"
                  title={s.name}
                  aria-label={s.name}
                  className={`wf-color-swatch${draft.color === s.color ? " current" : ""}`}
                  style={{ background: s.color }}
                  onClick={() => set({ color: s.color })}
                />
              ))}
              <input
                type="color"
                aria-label="Another colour"
                value={draft.color ?? "#000000"}
                onChange={(e) => {
                  const hex = toHexColor(e.target.value);
                  if (hex) set({ color: hex });
                }}
              />
            </div>
          </div>
          <div className="wf-inspector-row">
            <span>Alignment</span>
            <div className="wf-inspector-seg" role="group" aria-label="Alignment">
              {(
                [
                  ["left", "Left", <AlignLeft key="l" size={15} />],
                  ["center", "Centre", <AlignCenter key="c" size={15} />],
                  ["right", "Right", <AlignRight key="r" size={15} />],
                  ["justify", "Justified", <AlignJustify key="j" size={15} />],
                ] as [StyleAlign, string, React.ReactNode][]
              ).map(([value, text, icon]) => (
                <button key={value} type="button" title={text} aria-pressed={draft.align === value} className={draft.align === value ? "active" : ""} onClick={() => set({ align: value })}>
                  {icon}
                </button>
              ))}
            </div>
          </div>
          <label className="wf-inspector-row">
            <span>Line spacing</span>
            <select value={draft.line} onChange={(e) => set({ line: Number(e.target.value) })}>
              {lineOptions.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="wf-inspector-row">
            <span>Space before</span>
            <span className="wf-style-unit">
              <NumberField value={draft.before} min={0} max={200} step={1} disabled={false} onCommit={(v) => v !== null && set({ before: round(v, 1) })} />
              pt
            </span>
          </label>
          <label className="wf-inspector-row">
            <span>Space after</span>
            <span className="wf-style-unit">
              <NumberField value={draft.after} min={0} max={200} step={1} disabled={false} onCommit={(v) => v !== null && set({ after: round(v, 1) })} />
              pt
            </span>
          </label>
          <label className="wf-inspector-row">
            <span>Indent left</span>
            <span className="wf-style-unit">
              <NumberField value={round(draft.indL / 72, 3)} min={0} max={10} step={0.125} disabled={false} onCommit={(v) => v !== null && set({ indL: round(v * 72, 1) })} />
              in
            </span>
          </label>
          <label className="wf-inspector-row">
            <span>Indent right</span>
            <span className="wf-style-unit">
              <NumberField value={round(draft.indR / 72, 3)} min={0} max={10} step={0.125} disabled={false} onCommit={(v) => v !== null && set({ indR: round(v * 72, 1) })} />
              in
            </span>
          </label>
          <div className="wf-inspector-row">
            <span>First line</span>
            <span className="wf-style-unit">
              <select
                value={draft.indF === 0 ? "none" : hanging ? "hanging" : "first"}
                onChange={(e) => {
                  const by = Math.abs(draft.indF) || 36;
                  set({ indF: e.target.value === "none" ? 0 : e.target.value === "hanging" ? -by : by });
                }}
              >
                <option value="none">None</option>
                <option value="first">Indented</option>
                <option value="hanging">Hanging</option>
              </select>
              {draft.indF !== 0 && (
                <>
                  <NumberField
                    value={round(Math.abs(draft.indF) / 72, 3)}
                    min={0.05}
                    max={10}
                    step={0.125}
                    disabled={false}
                    onCommit={(v) => v !== null && set({ indF: round((hanging ? -v : v) * 72, 1) })}
                  />
                  in
                </>
              )}
            </span>
          </div>
          <label className="wf-inspector-check">
            <span>
              Keep with next
              <small>Never the last thing on a page (for headings)</small>
            </span>
            <input type="checkbox" checked={draft.keepNext} onChange={() => set({ keepNext: !draft.keepNext })} />
          </label>
        </div>

        <div className="wf-connect-row wf-style-actions">
          {onReset && (
            <button type="button" className="wf-danger" onClick={onReset}>
              {resetLabel ?? "Reset"}
            </button>
          )}
          <span className="wf-style-spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wf-primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
