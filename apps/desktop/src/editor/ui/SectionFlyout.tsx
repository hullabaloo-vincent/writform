import type { Editor } from "@tiptap/react";
import { FilePlus2 } from "lucide-react";

import { PAGE_SIZES, type DocSettings } from "../../apps/documents/docSettings";
import { sectionAt, setSection } from "../format/ParaFormat";
import type { SectionProps } from "../schema/sanitize";
import { Flyout } from "./Flyout";
import { NumberField } from "./NumberField";

/**
 * Layout ▸ Section. A section starts a new page and may have a sheet,
 * margins, columns and page numbering of its own; anything it doesn't set
 * is as the document. The first section is the document's own page setup.
 */
export function SectionFlyout({ editor, settings }: { editor: Editor; settings: DocSettings }) {
  const here = sectionAt(editor);
  const { $from } = editor.state.selection;
  // A section begins with a paragraph of the text itself (not one inside a
  // list, a quote or a table).
  const top = $from.depth === 1 && ($from.parent.type.name === "paragraph" || $from.parent.type.name === "heading");
  const startsHere = !!here && $from.depth >= 1 && here.pos === $from.before(1);
  const props = here?.props ?? {};
  const set = (patch: Partial<SectionProps>) => {
    if (!here) return;
    const next: SectionProps = { ...props, ...patch };
    for (const key of Object.keys(next) as (keyof SectionProps)[]) if (next[key] === undefined) delete next[key];
    setSection(editor, next, here.pos);
  };
  const ownMargins = props.mt !== undefined || props.mr !== undefined || props.mb !== undefined || props.ml !== undefined;
  return (
    <Flyout title="Section: a part of the document with its own page setup" icon={<FilePlus2 size={15} />} label="Section" active={!!here} panelClass="wf-section">
      {(close) => (
        <>
          {!startsHere && (
            <button
              type="button"
              className="wf-section-start"
              disabled={!top}
              onClick={() => {
                setSection(editor, {});
                close();
              }}
            >
              Start a new section at this paragraph
            </button>
          )}
          {!top && !startsHere && <p className="wf-section-hint">Put the caret in a paragraph of the text itself (not in a list or a table).</p>}
          {!here ? (
            <p className="wf-section-hint">This is the document’s first section: its page setup is the document’s own.</p>
          ) : (
            <div className="wf-section-form">
              <h4>This section</h4>
              <label className="wf-inspector-row">
                <span>Paper</span>
                <select value={props.size ?? ""} onChange={(e) => set({ size: e.target.value || undefined })}>
                  <option value="">As the document</option>
                  {PAGE_SIZES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wf-inspector-row">
                <span>Orientation</span>
                <select
                  value={props.landscape === undefined ? "" : props.landscape ? "land" : "port"}
                  onChange={(e) => set({ landscape: e.target.value === "" ? undefined : e.target.value === "land" })}
                >
                  <option value="">As the document</option>
                  <option value="port">Portrait</option>
                  <option value="land">Landscape</option>
                </select>
              </label>
              <label className="wf-inspector-row">
                <span>Columns</span>
                <select value={props.cols ?? ""} onChange={(e) => set({ cols: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">As the document</option>
                  <option value="1">One</option>
                  <option value="2">Two</option>
                  <option value="3">Three</option>
                </select>
              </label>
              <label className="wf-inspector-row">
                <span>Margins</span>
                <select
                  value={ownMargins ? "own" : ""}
                  onChange={(e) =>
                    set(
                      e.target.value
                        ? { mt: settings.mt, mr: settings.mr, mb: settings.mb, ml: settings.ml }
                        : { mt: undefined, mr: undefined, mb: undefined, ml: undefined },
                    )
                  }
                >
                  <option value="">As the document</option>
                  <option value="own">Its own</option>
                </select>
              </label>
              {ownMargins && (
                <div className="wf-section-margins">
                  {(
                    [
                      ["mt", "Top"],
                      ["mb", "Bottom"],
                      ["ml", "Left"],
                      ["mr", "Right"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <NumberField value={props[key] ?? settings[key]} min={0} max={3} step={0.25} disabled={false} onCommit={(v) => v !== null && set({ [key]: Math.round(v * 1000) / 1000 })} />
                    </label>
                  ))}
                </div>
              )}
              <label className="wf-inspector-row">
                <span>Page numbers</span>
                <select value={props.pn === undefined ? "" : "restart"} onChange={(e) => set({ pn: e.target.value ? 1 : undefined })}>
                  <option value="">Continue</option>
                  <option value="restart">Start again at…</option>
                </select>
              </label>
              {props.pn !== undefined && (
                <div className="wf-inspector-row">
                  <span>First number</span>
                  <NumberField value={props.pn} min={0} max={9999} step={1} disabled={false} onCommit={(v) => v !== null && set({ pn: Math.round(v) })} />
                </div>
              )}
              <button
                type="button"
                className="wf-section-remove"
                onClick={() => {
                  setSection(editor, null, here.pos);
                  close();
                }}
              >
                Remove this section break
              </button>
            </div>
          )}
        </>
      )}
    </Flyout>
  );
}
