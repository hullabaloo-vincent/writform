import type { ReactNode } from "react";

import { toHexColor } from "../schema/sanitize";
import { Flyout } from "./Flyout";

export interface Swatch {
  color: string;
  name: string;
}

/** Text colours: Word's standard row, and a run of greys. */
export const TEXT_COLORS: Swatch[] = [
  { color: "#c00000", name: "Dark red" },
  { color: "#ff0000", name: "Red" },
  { color: "#ffc000", name: "Orange" },
  { color: "#ffff00", name: "Yellow" },
  { color: "#92d050", name: "Light green" },
  { color: "#00b050", name: "Green" },
  { color: "#00b0f0", name: "Light blue" },
  { color: "#0070c0", name: "Blue" },
  { color: "#002060", name: "Dark blue" },
  { color: "#7030a0", name: "Purple" },
  { color: "#000000", name: "Black" },
  { color: "#404040", name: "Dark grey" },
  { color: "#7f7f7f", name: "Grey" },
  { color: "#a6a6a6", name: "Light grey" },
  { color: "#ffffff", name: "White" },
];

/** Highlighters: Word's pens first (they stay pens in a Word file), then
 *  softer ones. */
export const HIGHLIGHT_COLORS: Swatch[] = [
  { color: "#ffff00", name: "Yellow" },
  { color: "#00ff00", name: "Bright green" },
  { color: "#00ffff", name: "Turquoise" },
  { color: "#ff00ff", name: "Pink" },
  { color: "#c0c0c0", name: "Grey" },
  { color: "#ffe699", name: "Soft yellow" },
  { color: "#c6e0b4", name: "Soft green" },
  { color: "#bdd7ee", name: "Soft blue" },
  { color: "#f8cbad", name: "Soft orange" },
  { color: "#e4c7f0", name: "Soft violet" },
];

/** Paragraph shading: pale tints text stays readable on. */
export const SHADE_COLORS: Swatch[] = [
  { color: "#f2f2f2", name: "Pale grey" },
  { color: "#d9d9d9", name: "Light grey" },
  { color: "#fff2cc", name: "Pale yellow" },
  { color: "#fce4d6", name: "Pale orange" },
  { color: "#e2efda", name: "Pale green" },
  { color: "#ddebf7", name: "Pale blue" },
  { color: "#ede2f6", name: "Pale violet" },
  { color: "#fde9ef", name: "Pale pink" },
];

/**
 * A colour button: a grid of swatches, "none", and any other colour from
 * the system's picker. `value` is the colour in force (null: none), shown
 * as a bar under the icon.
 */
export function ColorFlyout({
  title,
  icon,
  value,
  colors,
  noneLabel,
  disabled,
  onPick,
}: {
  title: string;
  icon: ReactNode;
  value: string | null;
  colors: Swatch[];
  /** What taking the colour off is called ("Automatic", "No highlight"). */
  noneLabel: string;
  disabled?: boolean;
  onPick: (color: string | null) => void;
}) {
  return (
    <Flyout
      title={title}
      disabled={disabled}
      panelClass="wf-colors"
      icon={
        <span className="wf-color-icon" style={{ ["--wf-swatch" as string]: value ?? "transparent" }}>
          {icon}
        </span>
      }
    >
      {(close) => (
        <>
          <button
            type="button"
            className={`wf-color-none${value === null ? " current" : ""}`}
            onClick={() => {
              onPick(null);
              close();
            }}
          >
            {noneLabel}
          </button>
          <div className="wf-color-grid" role="group" aria-label={title}>
            {colors.map((s) => (
              <button
                key={s.color}
                type="button"
                title={s.name}
                aria-label={s.name}
                aria-pressed={value === s.color}
                className={`wf-color-swatch${value === s.color ? " current" : ""}`}
                style={{ background: s.color }}
                onClick={() => {
                  onPick(s.color);
                  close();
                }}
              />
            ))}
          </div>
          <label className="wf-color-more">
            <span>Another colour…</span>
            <input
              type="color"
              value={value ?? "#000000"}
              onChange={(e) => {
                const hex = toHexColor(e.target.value);
                if (hex) onPick(hex);
              }}
            />
          </label>
        </>
      )}
    </Flyout>
  );
}
