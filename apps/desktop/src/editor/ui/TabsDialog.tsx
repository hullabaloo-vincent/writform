import type { Editor } from "@tiptap/core";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import type { DocSettings } from "../../apps/documents/docSettings";
import { fromUnit, regionUnit, toUnit } from "../../lib/units";
import { curParaFormat, setBlockAttrs } from "../format/ParaFormat";
import { encodeTabs, parseTabs, TAB_POS_MAX, type TabKind, type TabLeader, type TabStop } from "../schema/sanitize";
import { NumberField } from "./NumberField";

const KINDS: [TabKind, string][] = [
  ["l", "Left"],
  ["c", "Center"],
  ["r", "Right"],
  ["d", "Decimal"],
];
const LEADERS: [TabLeader | "", string][] = [
  ["", "No leader"],
  ["dot", "Dots"],
  ["dash", "Dashes"],
  ["line", "A line"],
];

/**
 * The tab stops of the selected paragraphs (their own, set on them), and
 * how far apart the document's other stops are. Shown in the ribbon's
 * Layout tab at format level 4.
 */
export function TabsPanel({ editor, settings, onPatchSettings }: { editor: Editor; settings: DocSettings; onPatchSettings: (patch: Partial<DocSettings>) => void }) {
  const unit = regionUnit();
  const own = parseTabs(curParaFormat(editor).tabs);
  const stops: TabStop[] = Array.isArray(own) ? own : [];
  const [at, setAt] = useState<number | null>(null);
  const [kind, setKind] = useState<TabKind>("l");
  const [leader, setLeader] = useState<TabLeader | "">("");
  const write = (next: TabStop[]) => setBlockAttrs(editor, { tabs: encodeTabs(next) }, false);
  const max = toUnit(TAB_POS_MAX, unit);
  const step = unit === "in" ? 0.25 : 0.5;

  return (
    <div className="wf-tabs-panel">
      <p className="wf-flyout-heading">Tab stops of the selected paragraphs</p>
      {stops.length === 0 && <p className="wf-tabs-none">None of their own. A tab goes to the next of the stops every {toUnit(settings.tabStop * 72, unit)} {unit}.</p>}
      {stops.map((s, i) => (
        <div key={s.pt} className="wf-tabs-row">
          <NumberField value={toUnit(s.pt, unit)} min={0.01} max={max} step={step} disabled={false} onCommit={(v) => v !== null && write(stops.map((x, j) => (j === i ? { ...x, pt: fromUnit(v, unit) } : x)))} />
          <span className="wf-tabs-unit">{unit}</span>
          <select aria-label="Kind of stop" value={s.kind} onChange={(e) => write(stops.map((x, j) => (j === i ? { ...x, kind: e.target.value as TabKind } : x)))}>
            {KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select aria-label="Leader" value={s.leader ?? ""} onChange={(e) => write(stops.map((x, j) => (j === i ? { ...x, leader: (e.target.value || null) as TabLeader | null } : x)))}>
            {LEADERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <button type="button" className="wf-icon" title="Remove this stop" aria-label="Remove this stop" onClick={() => write(stops.filter((_, j) => j !== i))}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="wf-tabs-row add">
        <NumberField value={at ?? toUnit((stops.length ? stops[stops.length - 1].pt : 0) + settings.tabStop * 72, unit)} min={0.01} max={max} step={step} disabled={false} onCommit={(v) => setAt(v)} />
        <span className="wf-tabs-unit">{unit}</span>
        <select aria-label="Kind of stop" value={kind} onChange={(e) => setKind(e.target.value as TabKind)}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="Leader" value={leader} onChange={(e) => setLeader(e.target.value as TabLeader | "")}>
          {LEADERS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const place = at ?? toUnit((stops.length ? stops[stops.length - 1].pt : 0) + settings.tabStop * 72, unit);
            write([...stops, { pt: fromUnit(place, unit), kind, leader: leader || null }]);
            setAt(null);
          }}
        >
          Add
        </button>
      </div>
      {stops.length > 0 && (
        <button type="button" className="wf-link wf-tabs-clear" onClick={() => write([])}>
          Clear their stops
        </button>
      )}
      <label className="wf-tabs-every">
        <span>Other stops every</span>
        <NumberField value={toUnit(settings.tabStop * 72, unit)} min={toUnit(7.2, unit)} max={toUnit(144, unit)} step={step} disabled={false} onCommit={(v) => v !== null && onPatchSettings({ tabStop: Math.round((fromUnit(v, unit) / 72) * 1000) / 1000 })} />
        <span className="wf-tabs-unit">{unit}</span>
      </label>
    </div>
  );
}
