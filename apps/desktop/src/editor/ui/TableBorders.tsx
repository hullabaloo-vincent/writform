import type { Editor } from "@tiptap/core";
import { Grid2x2 } from "lucide-react";
import { useState } from "react";

import { setCellBorders, type BorderWhich } from "../tables/borders";
import { Flyout } from "./Flyout";

const WHICH: [BorderWhich, string][] = [
  ["all", "All"],
  ["outside", "Outside"],
  ["inside", "Inside"],
  ["top", "Top"],
  ["bottom", "Bottom"],
  ["left", "Left"],
  ["right", "Right"],
  ["none", "None"],
];
const WIDTHS = [0.5, 0.75, 1, 1.5, 2.25, 3];
const COLORS = ["#000000", "#595959", "#a6a6a6", "#c00000", "#2f5496", "#548235"];

/** Lines drawn on the selected cells' sides: which sides, how heavy, what
 *  colour (the Table tab). */
export function TableBorders({ editor }: { editor: Editor }) {
  const [width, setWidth] = useState(0.75);
  const [color, setColor] = useState("#000000");
  return (
    <Flyout title="Cell borders" icon={<Grid2x2 size={15} />} label="Borders" panelClass="wf-borders-flyout">
      {(close) => (
        <div className="wf-borders">
          <div className="wf-borders-sides" role="group" aria-label="Which sides">
            {WHICH.map(([which, label]) => (
              <button
                key={which}
                type="button"
                className={`wf-borders-side ${which}`}
                onClick={() => {
                  setCellBorders(editor, which, { w: width, color });
                  close();
                }}
              >
                <span aria-hidden className="wf-borders-icon" />
                {label}
              </button>
            ))}
          </div>
          <label className="wf-borders-row">
            <span>Weight</span>
            <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
              {WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {w} pt
                </option>
              ))}
            </select>
          </label>
          <div className="wf-borders-row" role="group" aria-label="Color">
            <span>Color</span>
            {COLORS.map((c) => (
              <button key={c} type="button" className={`wf-borders-color${c === color ? " on" : ""}`} style={{ background: c }} aria-label={c} aria-pressed={c === color} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      )}
    </Flyout>
  );
}
