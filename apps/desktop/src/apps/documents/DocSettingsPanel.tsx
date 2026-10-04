import type { Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Minus,
  Plus,
} from "lucide-react";
import { useEffect, useState } from "react";
import type * as Y from "yjs";

import {
  curTypography,
  DOC_FONT_SIZES,
  DOC_FONTS,
  DOC_LINE_SPACINGS,
  DOC_PARA_SPACES,
  setDocAlign,
  setDocFont,
  setDocFontSize,
  setDocLineSpacing,
  setDocSpaceAbove,
  setDocSpaceBelow,
  setTypography,
  toggleDropCap,
} from "../../editor/TextFormat";
import {
  DOC_INDENTS,
  DOC_PARA_DEFAULTS,
  MARGIN_MAX,
  MARGIN_MIN,
  PAGE_SIZES,
  pageSizeDef,
  updateDocSettings,
  type DocSettings,
} from "./docSettings";

/**
 * The document inspector — Pages-style right panel with two tabs: Text
 * (styles the current selection through TextFormat attributes) and
 * Document (paper, margins, body-text defaults — the Y.Map-backed
 * per-document settings). Plain format only; the scripted formats carry
 * their own fixed conventions.
 */
export function DocSettingsPanel({
  editor,
  ydoc,
  settings,
  readonly,
}: {
  editor: Editor | null;
  ydoc: Y.Doc;
  settings: DocSettings;
  readonly: boolean;
}) {
  const [tab, setTab] = useState<"text" | "document">(readonly ? "document" : "text");
  return (
    <aside className="wf-doc-panel wf-inspector">
      <header className="wf-doc-panel-header wf-inspector-tabs">
        <button className={tab === "text" ? "active" : ""} onClick={() => setTab("text")}>
          Text
        </button>
        <button
          className={tab === "document" ? "active" : ""}
          onClick={() => setTab("document")}
        >
          Document
        </button>
      </header>
      {tab === "text" ? (
        <TextTab editor={editor} disabled={readonly || !editor} />
      ) : (
        <DocumentTab
          settings={settings}
          disabled={readonly}
          onPatch={(patch) => updateDocSettings(ydoc, patch)}
        />
      )}
    </aside>
  );
}

const LINE_LABELS: Record<string, string> = {
  "1": "Single",
  "1.15": "1.15",
  "1.3": "1.3",
  "1.5": "1.5",
  "2": "Double",
};

function TextTab({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  // Track the caret so the controls always show the selection's values.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => bump((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const cur = editor ? curTypography(editor) : null;
  const ptOptions = (list: readonly number[]) =>
    list.map((v) => (
      <option key={v} value={v}>
        {v} pt
      </option>
    ));

  return (
    <div className="wf-inspector-body">
      <section>
        <h4>Font</h4>
        <label className="wf-inspector-row">
          <span>Family</span>
          <select
            disabled={disabled}
            value={cur?.font ?? ""}
            onChange={(e) => editor && setDocFont(editor, e.target.value || null)}
          >
            <option value="">Default</option>
            {DOC_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>Size</span>
          <select
            disabled={disabled}
            value={cur?.size ?? ""}
            onChange={(e) =>
              editor && setDocFontSize(editor, e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Default</option>
            {ptOptions(DOC_FONT_SIZES)}
          </select>
        </label>
      </section>

      <section>
        <h4>Alignment</h4>
        <div className="wf-inspector-seg" role="group" aria-label="Alignment">
          {(
            [
              ["left", "Align left (⌘⇧L)", <AlignLeft key="l" size={15} />, cur?.align === null],
              ["center", "Center (⌘⇧E)", <AlignCenter key="c" size={15} />, cur?.align === "center"],
              ["right", "Align right (⌘⇧R)", <AlignRight key="r" size={15} />, cur?.align === "right"],
              ["justify", "Justify (⌘⇧J)", <AlignJustify key="j" size={15} />, cur?.align === "justify"],
            ] as const
          ).map(([value, title, icon, active]) => (
            <button
              key={value}
              title={title}
              disabled={disabled}
              className={active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the editor selection
                if (editor) setDocAlign(editor, value);
              }}
            >
              {icon}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h4>Spacing</h4>
        <label className="wf-inspector-row">
          <span>Line spacing</span>
          <select
            disabled={disabled}
            value={cur?.line ?? ""}
            onChange={(e) =>
              editor && setDocLineSpacing(editor, e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Default</option>
            {DOC_LINE_SPACINGS.map((v) => (
              <option key={v} value={v}>
                {LINE_LABELS[String(v)]}
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>Before paragraph</span>
          <select
            disabled={disabled}
            value={cur?.sa ?? ""}
            onChange={(e) =>
              editor &&
              setDocSpaceAbove(editor, e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">Default</option>
            {ptOptions(DOC_PARA_SPACES)}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>After paragraph</span>
          <select
            disabled={disabled}
            value={cur?.sb ?? ""}
            onChange={(e) =>
              editor &&
              setDocSpaceBelow(editor, e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">Default</option>
            {ptOptions(DOC_PARA_SPACES)}
          </select>
        </label>
      </section>

      <section>
        <h4>Paragraph</h4>
        <label className="wf-inspector-check">
          <span>
            Drop cap
            <small>Oversized first letter, set into the opening lines</small>
          </span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={cur?.dropCap === true}
            onChange={() => editor && toggleDropCap(editor)}
          />
        </label>
        <label className="wf-inspector-check">
          <span>
            Start on a new page
            <small>Page break before this paragraph (⌘↩ inserts one)</small>
          </span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={cur?.pageBreakBefore === true}
            onChange={() =>
              editor && setTypography(editor, { pageBreakBefore: cur?.pageBreakBefore ? null : true })
            }
          />
        </label>
      </section>
    </div>
  );
}

function DocumentTab({
  settings,
  disabled,
  onPatch,
}: {
  settings: DocSettings;
  disabled: boolean;
  onPatch: (patch: Partial<DocSettings>) => void;
}) {
  const page = pageSizeDef(settings.pageSize);
  return (
    <div className="wf-inspector-body">
      <section>
        <h4>Paper</h4>
        <label className="wf-inspector-row">
          <span>Size</span>
          <select
            disabled={disabled}
            value={settings.pageSize}
            onChange={(e) => onPatch({ pageSize: e.target.value })}
          >
            {PAGE_SIZES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <p className="wf-inspector-dim">
          {page.w} × {page.h} inches
        </p>
      </section>

      <section>
        <h4>Margins</h4>
        <div className="wf-inspector-grid">
          <InchStepper
            label="Top"
            value={settings.mt}
            disabled={disabled}
            onChange={(mt) => onPatch({ mt })}
          />
          <InchStepper
            label="Bottom"
            value={settings.mb}
            disabled={disabled}
            onChange={(mb) => onPatch({ mb })}
          />
          <InchStepper
            label="Left"
            value={settings.ml}
            disabled={disabled}
            onChange={(ml) => onPatch({ ml })}
          />
          <InchStepper
            label="Right"
            value={settings.mr}
            disabled={disabled}
            onChange={(mr) => onPatch({ mr })}
          />
        </div>
      </section>

      <section>
        <h4>Body text</h4>
        <label className="wf-inspector-row">
          <span>Font</span>
          <select
            disabled={disabled}
            value={settings.bodyFont ?? ""}
            onChange={(e) => onPatch({ bodyFont: e.target.value || null })}
          >
            <option value="">Georgia (default)</option>
            {DOC_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>Size</span>
          <select
            disabled={disabled}
            value={settings.bodySize ?? ""}
            onChange={(e) =>
              onPatch({ bodySize: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">12 pt (default)</option>
            {DOC_FONT_SIZES.map((v) => (
              <option key={v} value={v}>
                {v} pt
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>Line spacing</span>
          <select
            disabled={disabled}
            value={settings.bodyLine ?? ""}
            onChange={(e) =>
              onPatch({ bodyLine: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Default</option>
            {DOC_LINE_SPACINGS.map((v) => (
              <option key={v} value={v}>
                {LINE_LABELS[String(v)]}
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>Paragraph spacing</span>
          <select
            disabled={disabled}
            value={settings.paraSpacing ?? ""}
            onChange={(e) =>
              onPatch({ paraSpacing: e.target.value === "" ? null : Number(e.target.value) })
            }
          >
            <option value="">Default</option>
            {DOC_PARA_DEFAULTS.map((v) => (
              <option key={v} value={v}>
                {v} pt
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>First-line indent</span>
          <select
            disabled={disabled}
            value={settings.firstIndent ?? ""}
            onChange={(e) =>
              onPatch({ firstIndent: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">None</option>
            {DOC_INDENTS.map((v) => (
              <option key={v} value={v}>
                {v}″
              </option>
            ))}
          </select>
        </label>
        <p className="wf-inspector-dim">
          Book body text: pick an indent and set paragraph spacing to 0 pt.
        </p>
      </section>

      <p className="wf-inspector-dim wf-inspector-foot">
        Saved with the document — everyone who opens it sees the same layout.
      </p>
    </div>
  );
}

/** A ¼-inch stepper (margins, trim sizes). Exported for the book inspector. */
export function InchStepper({
  label,
  value,
  disabled,
  onChange,
  min = MARGIN_MIN,
  max = MARGIN_MAX,
  step = 0.25,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  // Steps snap onto the grid even from off-grid values (the default top
  // margin is 0.86in): up goes to the next multiple, down to the previous.
  const k = 1 / step;
  const move = (dir: 1 | -1) => {
    const units = dir === 1 ? Math.floor(value * k + 1e-9) + 1 : Math.ceil(value * k - 1e-9) - 1;
    onChange(Math.min(max, Math.max(min, units / k)));
  };
  const shown = parseFloat(value.toFixed(3));
  return (
    <div className="wf-inspector-stepper">
      <span className="wf-inspector-stepper-label">{label}</span>
      <div className="wf-inspector-stepper-controls">
        <button
          type="button"
          title={`${label} −`}
          disabled={disabled || value <= min}
          onClick={() => move(-1)}
        >
          <Minus size={12} />
        </button>
        <span>{shown} in</span>
        <button
          type="button"
          title={`${label} +`}
          disabled={disabled || value >= max}
          onClick={() => move(1)}
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}
