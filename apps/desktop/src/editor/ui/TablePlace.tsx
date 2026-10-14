import type { Editor } from "@tiptap/react";

import { fromUnit, regionUnit, toUnit } from "../../lib/units";
import { ROW_H_MAX, TABLE_IND_MAX, type CellVAlign, type TableAlign } from "../schema/sanitize";
import { curTable, distributeColumns, distributeRows, setCellVAlign, setRowAttrs, setTableAttrs } from "../tables/Table";
import { FlyoutItem } from "./Flyout";
import { NumberField } from "./NumberField";

const VALIGNS: [CellVAlign | null, string][] = [
  [null, "At the top"],
  ["middle", "In the middle"],
  ["bottom", "At the foot"],
];

const PLACES: [TableAlign | null, string][] = [
  [null, "At the left"],
  ["center", "In the middle"],
  ["right", "At the right"],
];

/**
 * The rows' least height and keeping, where the cells' words sit, and where
 * the table sits: the Table tab's "Size and place", at format level 4.
 */
export function TablePlacePanel({ editor }: { editor: Editor }) {
  const now = curTable(editor);
  if (!now) return null;
  const unit = regionUnit();
  const step = unit === "in" ? 0.05 : 0.1;
  const round = (v: number) => Math.round(v * 100) / 100;

  return (
    <div className="wf-tplace">
      <p className="wf-flyout-heading">Rows</p>
      <label className="wf-tplace-row">
        <span>At least</span>
        <NumberField value={now.rowH ? round(toUnit(now.rowH, unit)) : 0} min={0} max={round(toUnit(ROW_H_MAX, unit))} step={step} disabled={false} onCommit={(v) => v !== null && setRowAttrs(editor, { h: v > 0 ? fromUnit(v, unit) : null })} />
        <span className="wf-tplace-unit">{unit}</span>
      </label>
      <p className="wf-tplace-note">At 0 a row is as tall as its words.</p>
      <FlyoutItem checked={now.keep} onPick={() => setRowAttrs(editor, { keep: now.keep ? null : true })}>
        Keep each row whole on one page
      </FlyoutItem>
      <FlyoutItem onPick={() => distributeRows(editor)}>Make the rows the same height</FlyoutItem>
      <FlyoutItem disabled={!now.sized} hint={now.sized ? undefined : "they are already"} onPick={() => distributeColumns(editor)}>
        Make the columns the same width
      </FlyoutItem>

      <p className="wf-flyout-heading">Words in the cells</p>
      {VALIGNS.map(([va, label]) => (
        <FlyoutItem key={label} checked={now.va === va} onPick={() => setCellVAlign(editor, va)}>
          {label}
        </FlyoutItem>
      ))}

      <p className="wf-flyout-heading">The table on the page</p>
      {PLACES.map(([align, label]) => (
        <FlyoutItem key={label} checked={now.align === align} onPick={() => setTableAttrs(editor, { align, ...(align ? { ind: null } : {}) })}>
          {label}
        </FlyoutItem>
      ))}
      {!now.align && (
        <label className="wf-tplace-row">
          <span>In from the left</span>
          <NumberField value={now.ind ? round(toUnit(now.ind, unit)) : 0} min={0} max={round(toUnit(TABLE_IND_MAX, unit))} step={step} disabled={false} onCommit={(v) => v !== null && setTableAttrs(editor, { ind: v > 0 ? Math.round(fromUnit(v, unit) * 10) / 10 : null })} />
          <span className="wf-tplace-unit">{unit}</span>
        </label>
      )}
    </div>
  );
}
