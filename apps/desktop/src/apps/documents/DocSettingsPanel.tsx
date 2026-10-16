import { clearParagraphOwn, clearTextOwn, describeHere } from "../../editor/format/describe";
import type { Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Minus,
  Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { curRun, type FormatContext } from "../../editor/format/effective";
import { curParaFormat, setBlockAttrs, setLineHeight } from "../../editor/format/ParaFormat";
import { setRunFont, setRunSize } from "../../editor/format/run";
import { roundPt } from "../../editor/schema/sanitize";
import { SINGLE, styleFonts } from "../../editor/styles/sheet";
import {
  curTypography,
  DOC_FONT_SIZES,
  DOC_LINE_SPACINGS,
  DOC_PARA_SPACES,
  setDocAlign,
  setDocSpaceAbove,
  setDocSpaceBelow,
  setTypography,
  toggleDropCap,
} from "../../editor/TextFormat";
import type { FontInfo } from "../../fonts/css";
import { fontKey, noteDocFont, readDocFontTable } from "../../fonts/docFonts";
import { FontPicker } from "../../fonts/ui/FontPicker";
import { NumberField } from "../../editor/ui/NumberField";
import {
  CUSTOM_PAGE,
  DOC_INDENTS,
  DOC_PARA_DEFAULTS,
  KEYWORDS_MAX,
  MARGIN_MAX,
  MARGIN_MIN,
  PAGE_NUMBER_FORMATS,
  PAGE_SIZES,
  PAPER_MAX,
  PAPER_MIN,
  SUBJECT_MAX,
  pageDims,
  updateDocSettings,
  type DocSettings,
  type PageNumberFormat,
  type SetupSection,
} from "./docSettings";
import { languageChoices } from "../../lib/languages";
import { HeaderFooterForm } from "./HeaderFooterForm";

/**
 * The document inspector — Pages-style right panel with two tabs: Text
 * (styles the current selection through TextFormat attributes) and
 * Document (paper, margins, body-text defaults — the Y.Map-backed
 * per-document settings). Document format only; the scripted formats carry
 * their own fixed conventions.
 */
const tabOf = (section: SetupSection): "text" | "document" => (section === "indents" || section === "here" ? "text" : "document");

export function DocSettingsPanel({
  editor,
  ydoc,
  settings,
  readonly,
  format,
  at = null,
}: {
  editor: Editor | null;
  ydoc: Y.Doc;
  settings: DocSettings;
  readonly: boolean;
  /** The document's styles, and the schema level it may use here. */
  format: FormatContext;
  /** Show this part: its tab, scrolled to, its first control focused. `n`
   *  changes with every request, so asking for the same part twice works. */
  at?: { section: SetupSection; n: number } | null;
}) {
  const [tab, setTab] = useState<"text" | "document">(at ? tabOf(at.section) : readonly ? "document" : "text");
  const panelRef = useRef<HTMLElement>(null);
  const asked = at ? `${at.section}:${at.n}` : null;
  useEffect(() => {
    if (!at) return;
    setTab(tabOf(at.section));
    // Once that tab is on screen: bring the part into view and mark it for a
    // moment, so the eye finds what was asked for.
    const timer = setTimeout(() => {
      const part = panelRef.current?.querySelector<HTMLElement>(`[data-setup="${at.section}"]`);
      if (!part) return;
      part.scrollIntoView?.({ block: "start", behavior: "smooth" });
      part.classList.add("wf-inspector-asked");
      setTimeout(() => part.classList.remove("wf-inspector-asked"), 1600);
      // A field to type in, if the part has one; else its first control.
      const first =
        part.querySelector<HTMLElement>('input:not([disabled]):not([type="checkbox"]):not([type="radio"])') ??
        part.querySelector<HTMLElement>("select:not([disabled]), button:not([disabled])");
      first?.focus({ preventScroll: true });
    }, 30);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request, not the object
  }, [asked]);
  // What the document uses and knows about its fonts, for the pickers.
  const [table, setTable] = useState(() => readDocFontTable(ydoc));
  useEffect(() => {
    const map = ydoc.getMap("fonts");
    const onChange = () => setTable(readDocFontTable(ydoc));
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [ydoc]);
  const fonts: PanelFonts = {
    used: [
      ...(settings.bodyFont ? [settings.bodyFont] : []),
      ...styleFonts(format.styles),
      ...(editor ? fontKey(editor).split("|").filter(Boolean) : []),
    ],
    table,
    onUsed: (id, info) => noteDocFont(ydoc, id, info),
  };
  return (
    <aside className="wf-doc-panel wf-inspector" ref={panelRef}>
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
        <TextTab editor={editor} disabled={readonly || !editor} fonts={fonts} format={format} />
      ) : (
        <DocumentTab
          settings={settings}
          disabled={readonly}
          onPatch={(patch) => updateDocSettings(ydoc, patch)}
          fonts={fonts}
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

interface PanelFonts {
  used: string[];
  table: Record<string, FontInfo>;
  onUsed: (id: string, info?: FontInfo) => void;
}

function TextTab({
  editor,
  disabled,
  fonts,
  format,
}: {
  editor: Editor | null;
  disabled: boolean;
  fonts: PanelFonts;
  format: FormatContext;
}) {
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
  // What the selected text is set in (its own, its paragraph's, its style's).
  const run = editor ? curRun(editor, format) : null;
  const para = editor ? curParaFormat(editor) : null;
  const rich = format.level >= 2;
  const inches = (pt: number | null | undefined) => Math.round(((pt ?? 0) / 72) * 1000) / 1000;
  const first = para?.indF ?? 0;
  // The menus' choices, plus the value in force when it isn't one of them
  // (a size that came in from a Word file).
  const ptOptions = (list: readonly number[], current: number | null | undefined = null) =>
    withCurrent(list, current ?? null).map((v) => (
      <option key={v} value={v}>
        {v} pt
      </option>
    ));

  const here = editor ? describeHere(editor, format) : null;

  return (
    <div className="wf-inspector-body">
      {editor && here && (
        <section className="wf-format-here" data-setup="here">
          <h4>Formatting here</h4>
          <p className="wf-format-here-line">
            <span>Style</span>
            <strong>{here.style}</strong>
          </p>
          <p className="wf-format-here-line">
            <span>The paragraph&rsquo;s own</span>
            <em>{here.paragraph.length ? here.paragraph.join(". ") : "Nothing but its style"}</em>
            <button type="button" className="wf-link-button" disabled={disabled || !here.paragraph.length} onClick={() => clearParagraphOwn(editor)}>
              Clear
            </button>
          </p>
          <p className="wf-format-here-line">
            <span>The words&rsquo; own</span>
            <em>{here.text.length ? here.text.join(". ") : "Nothing of their own"}</em>
            <button type="button" className="wf-link-button" disabled={disabled || !here.text.length} onClick={() => clearTextOwn(editor)}>
              Clear
            </button>
          </p>
        </section>
      )}
      <section>
        <h4>Font</h4>
        <div className="wf-inspector-row">
          <span>Family</span>
          <FontPicker
            value={run && !run.mixed.font ? run.font : null}
            docFonts={fonts.used}
            docTable={fonts.table}
            defaultLabel={run?.mixed.font ? "Mixed" : "Body font"}
            title={rich ? "Font" : "Paragraph font"}
            disabled={disabled}
            className="wf-inspector-font"
            onPick={(id, info) => {
              if (!editor) return;
              setRunFont(editor, id, format.level);
              if (id) fonts.onUsed(id, info);
            }}
          />
        </div>
        <div className="wf-inspector-row">
          <span>Size</span>
          <span className="wf-inspector-unit">
            <NumberField
              value={run?.size ?? 12}
              min={4}
              max={200}
              step={0.5}
              disabled={disabled}
              onCommit={(v) => editor && v !== null && setRunSize(editor, Math.round(v * 2) / 2, format.level)}
            />
            pt
          </span>
        </div>
        {!rich && <p className="wf-inspector-hint">This server is on an older version: font and size apply to whole paragraphs.</p>}
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
            value={para?.lineRule ?? cur?.line ?? ""}
            onChange={(e) => {
              if (!editor) return;
              const v = e.target.value;
              if (v === "exact" || v === "atLeast") {
                // Start from what single spacing is at this size.
                setLineHeight(editor, { rule: v, at: para?.lineAt ?? roundPt((run?.size ?? 12) * SINGLE) });
              } else if (rich) setLineHeight(editor, { multiple: v ? Number(v) : null });
              else setTypography(editor, { line: v ? Number(v) : null });
            }}
          >
            <option value="">Default</option>
            {withCurrent(DOC_LINE_SPACINGS, cur?.line ?? null).map((v) => (
              <option key={v} value={v}>
                {LINE_LABELS[String(v)] ?? String(v)}
              </option>
            ))}
            {rich && <option value="exact">Exactly…</option>}
            {rich && <option value="atLeast">At least…</option>}
          </select>
        </label>
        {rich && para?.lineRule && (
          <div className="wf-inspector-row">
            <span>{para.lineRule === "exact" ? "Exactly" : "At least"}</span>
            <span className="wf-inspector-unit">
              <NumberField
                value={para.lineAt ?? 14}
                min={4}
                max={400}
                step={1}
                disabled={disabled}
                onCommit={(v) => editor && v !== null && setLineHeight(editor, { rule: para.lineRule!, at: roundPt(v) })}
              />
              pt
            </span>
          </div>
        )}
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
            {ptOptions(DOC_PARA_SPACES, cur?.sa)}
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
            {ptOptions(DOC_PARA_SPACES, cur?.sb)}
          </select>
        </label>
      </section>

      {rich && (
        <section data-setup="indents">
          <h4>Indents</h4>
          <div className="wf-inspector-row">
            <span>Left</span>
            <span className="wf-inspector-unit">
              <NumberField
                value={inches(para?.indL)}
                min={0}
                max={10}
                step={0.125}
                disabled={disabled}
                onCommit={(v) => editor && v !== null && setBlockAttrs(editor, { indL: v ? roundPt(v * 72) : null })}
              />
              in
            </span>
          </div>
          <div className="wf-inspector-row">
            <span>Right</span>
            <span className="wf-inspector-unit">
              <NumberField
                value={inches(para?.indR)}
                min={0}
                max={10}
                step={0.125}
                disabled={disabled}
                onCommit={(v) => editor && v !== null && setBlockAttrs(editor, { indR: v ? roundPt(v * 72) : null })}
              />
              in
            </span>
          </div>
          <label className="wf-inspector-row">
            <span>First line</span>
            <select
              disabled={disabled}
              value={para?.indF === null || para?.indF === undefined ? "" : first === 0 ? "none" : first < 0 ? "hanging" : "first"}
              onChange={(e) => {
                if (!editor) return;
                const by = Math.abs(first) || 36;
                const v = e.target.value;
                setBlockAttrs(editor, { indF: v === "" ? null : v === "none" ? 0 : v === "hanging" ? -by : by });
              }}
            >
              <option value="">As the style</option>
              <option value="none">None</option>
              <option value="first">Indented</option>
              <option value="hanging">Hanging</option>
            </select>
          </label>
          {first !== 0 && (
            <div className="wf-inspector-row">
              <span>By</span>
              <span className="wf-inspector-unit">
                <NumberField
                  value={inches(Math.abs(first))}
                  min={0.05}
                  max={10}
                  step={0.125}
                  disabled={disabled}
                  onCommit={(v) => editor && v !== null && setBlockAttrs(editor, { indF: roundPt((first < 0 ? -v : v) * 72) })}
                />
                in
              </span>
            </div>
          )}
        </section>
      )}

      <section>
        <h4>Paragraph</h4>
        {rich && (
          <label className="wf-inspector-check">
            <span>
              Keep with next
              <small>Never the last thing on a page</small>
            </span>
            <input
              type="checkbox"
              disabled={disabled}
              checked={para?.keepNext === true}
              onChange={() => editor && setBlockAttrs(editor, { keepNext: para?.keepNext ? null : true })}
            />
          </label>
        )}
        {rich && (
          <label className="wf-inspector-check">
            <span>
              Keep lines together
              <small>Never split across two pages</small>
            </span>
            <input
              type="checkbox"
              disabled={disabled}
              checked={para?.keepLines === true}
              onChange={() => editor && setBlockAttrs(editor, { keepLines: para?.keepLines ? null : true })}
            />
          </label>
        )}
        <label className="wf-inspector-check">
          <span>
            Drop cap
            <small>An oversized first letter set into the opening lines</small>
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

const PN_LABELS: Record<PageNumberFormat, string> = {
  "1": "1, 2, 3",
  i: "i, ii, iii",
  I: "I, II, III",
  a: "a, b, c",
  A: "A, B, C",
};

function DocumentTab({
  settings,
  disabled,
  onPatch,
  fonts,
}: {
  settings: DocSettings;
  disabled: boolean;
  onPatch: (patch: Partial<DocSettings>) => void;
  fonts: PanelFonts;
}) {
  const page = pageDims(settings);
  const custom = settings.pageSize === CUSTOM_PAGE;
  const landscape = custom ? settings.pw > settings.ph : settings.landscape;
  const turn = (wantLandscape: boolean) => {
    if (wantLandscape === landscape) return;
    // A custom paper is turned by swapping its sides.
    onPatch(custom ? { pw: settings.ph, ph: settings.pw } : { landscape: wantLandscape });
  };
  const sizes = withCurrent(DOC_FONT_SIZES, settings.bodySize);
  const lines = withCurrent(DOC_LINE_SPACINGS, settings.bodyLine);
  const spaces = withCurrent(DOC_PARA_DEFAULTS, settings.paraSpacing);
  const indents = withCurrent(DOC_INDENTS, settings.firstIndent);
  return (
    <div className="wf-inspector-body">
      <section data-setup="paper">
        <h4>Paper</h4>
        <label className="wf-inspector-row">
          <span>Size</span>
          <select
            disabled={disabled}
            value={settings.pageSize}
            onChange={(e) => {
              const next = e.target.value;
              // Start a custom paper from the one it replaces.
              if (next === CUSTOM_PAGE) onPatch({ pageSize: next, pw: page.w, ph: page.h });
              else onPatch({ pageSize: next });
            }}
          >
            {PAGE_SIZES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM_PAGE}>Custom…</option>
          </select>
        </label>
        {custom && (
          <div className="wf-inspector-grid">
            <InchStepper label="Width" value={settings.pw} min={PAPER_MIN} max={PAPER_MAX} step={0.125} disabled={disabled} onChange={(pw) => onPatch({ pw })} />
            <InchStepper label="Height" value={settings.ph} min={PAPER_MIN} max={PAPER_MAX} step={0.125} disabled={disabled} onChange={(ph) => onPatch({ ph })} />
          </div>
        )}
        <div className="wf-inspector-row">
          <span>Orientation</span>
          <div className="wf-inspector-seg">
            <button disabled={disabled} className={landscape ? "" : "active"} onClick={() => turn(false)}>
              Portrait
            </button>
            <button disabled={disabled} className={landscape ? "active" : ""} onClick={() => turn(true)}>
              Landscape
            </button>
          </div>
        </div>
        <p className="wf-inspector-dim">
          {trim(page.w)} × {trim(page.h)} inches
        </p>
      </section>

      <section data-setup="margins">
        <h4>Margins</h4>
        <div className="wf-inspector-grid">
          <InchStepper label="Top" value={settings.mt} disabled={disabled} onChange={(mt) => onPatch({ mt })} />
          <InchStepper label="Bottom" value={settings.mb} disabled={disabled} onChange={(mb) => onPatch({ mb })} />
          <InchStepper label={settings.mirror ? "Inside" : "Left"} value={settings.ml} disabled={disabled} onChange={(ml) => onPatch({ ml })} />
          <InchStepper label={settings.mirror ? "Outside" : "Right"} value={settings.mr} disabled={disabled} onChange={(mr) => onPatch({ mr })} />
          <InchStepper label="Gutter" value={settings.gutter} min={0} max={2} step={0.125} disabled={disabled} onChange={(gutter) => onPatch({ gutter })} />
        </div>
        <label className="wf-inspector-check">
          <input type="checkbox" disabled={disabled} checked={settings.mirror} onChange={(e) => onPatch({ mirror: e.target.checked })} />
          <span>Facing pages (mirror the margins)</span>
        </label>
      </section>

      <section>
        <h4>Columns</h4>
        <div className="wf-inspector-row">
          <span>Columns</span>
          <div className="wf-inspector-seg">
            {[1, 2, 3].map((n) => (
              <button key={n} disabled={disabled} className={settings.cols === n ? "active" : ""} onClick={() => onPatch({ cols: n })}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {settings.cols > 1 && (
          <div className="wf-inspector-grid">
            <InchStepper label="Space between" value={settings.colGap} min={0.125} max={2} step={0.125} disabled={disabled} onChange={(colGap) => onPatch({ colGap })} />
          </div>
        )}
      </section>

      <section data-setup="header">
        <h4>Header and footer</h4>
        <HeaderFooterForm settings={settings} disabled={disabled} onPatch={onPatch} />
        <div className="wf-inspector-grid">
          <InchStepper label="Header from top" value={settings.hd} min={0.125} max={2} step={0.125} disabled={disabled} onChange={(hd) => onPatch({ hd })} />
          <InchStepper label="Footer from bottom" value={settings.fd} min={0.125} max={2} step={0.125} disabled={disabled} onChange={(fd) => onPatch({ fd })} />
        </div>
      </section>

      <section>
        <h4>Page numbers</h4>
        <label className="wf-inspector-row">
          <span>Style</span>
          <select disabled={disabled} value={settings.pnFormat} onChange={(e) => onPatch({ pnFormat: e.target.value as PageNumberFormat })}>
            {PAGE_NUMBER_FORMATS.map((f) => (
              <option key={f} value={f}>
                {PN_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="wf-inspector-row">
          <span>Start at</span>
          <NumberField value={settings.pnStart} min={0} max={99999} step={1} disabled={disabled} onCommit={(pnStart) => onPatch({ pnStart: Math.round(pnStart ?? 1) })} />
        </label>
      </section>

      <section data-setup="body">
        <h4>Body text</h4>
        <div className="wf-inspector-row">
          <span>Font</span>
          <FontPicker
            value={settings.bodyFont}
            docFonts={fonts.used}
            docTable={fonts.table}
            defaultLabel="Georgia"
            title="Body font"
            disabled={disabled}
            className="wf-inspector-font"
            onPick={(id, info) => {
              onPatch({ bodyFont: id });
              if (id) fonts.onUsed(id, info);
            }}
          />
        </div>
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
            {sizes.map((v) => (
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
            {lines.map((v) => (
              <option key={v} value={v}>
                {LINE_LABELS[String(v)] ?? String(v)}
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
            {spaces.map((v) => (
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
            {indents.map((v) => (
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

      <section>
        <h4>Print</h4>
        <label className="wf-inspector-check">
          <input type="checkbox" disabled={disabled} checked={settings.hyphenate} onChange={(e) => onPatch({ hyphenate: e.target.checked })} />
          <span>Hyphenate words at line ends</span>
        </label>
        <label className="wf-inspector-check">
          <input type="checkbox" disabled={disabled} checked={settings.lineNumbers} onChange={(e) => onPatch({ lineNumbers: e.target.checked })} />
          <span>Number the lines</span>
        </label>
        <p className="wf-inspector-dim">
          Headers, footers, columns and line numbers show in Preview, in print and in the PDF.
        </p>
      </section>

      <section data-setup="details">
        <h4>Details</h4>
        <DocDetails settings={settings} disabled={disabled} onPatch={onPatch} />
        <p className="wf-inspector-dim">Written into the PDF and Word files you export, where search and screen readers look for them.</p>
      </section>

      <p className="wf-inspector-dim wf-inspector-foot">
        Saved with the document, so everyone who opens it sees the same layout.
      </p>
    </div>
  );
}

/**
 * What a file says about itself: what it is about, the words to find it
 * by, the language it is written in. Also shown when a PDF is exported,
 * and the first two on the document's card (card.ts).
 */
export function DocDetails({ settings, disabled, onPatch }: { settings: DocSettings; disabled: boolean; onPatch: (patch: Partial<DocSettings>) => void }) {
  return (
    <div className="wf-doc-details">
      <label>
        <span>Subject</span>
        <input type="text" disabled={disabled} value={settings.subject} maxLength={SUBJECT_MAX} placeholder="What it is about" onChange={(e) => onPatch({ subject: e.target.value })} />
      </label>
      <label>
        <span>Keywords</span>
        <input type="text" disabled={disabled} value={settings.keywords} maxLength={KEYWORDS_MAX} placeholder="Words to find it by, with commas between" onChange={(e) => onPatch({ keywords: e.target.value })} />
      </label>
      <label>
        <span>Language</span>
        <select disabled={disabled} value={settings.lang} onChange={(e) => onPatch({ lang: e.target.value })}>
          <option value="">Not said</option>
          {languageChoices(settings.lang).map(([tag, name]) => (
            <option key={tag} value={tag}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="wf-doc-details-note">The subject and keywords also show on the document's card in Documents.</p>
    </div>
  );
}

const trim = (n: number) => String(Math.round(n * 100) / 100);

/** The choices, plus the value in force when it isn't one of them (a size
 *  that came in from a Word file). */
function withCurrent(options: readonly number[], current: number | null): number[] {
  if (current === null || options.includes(current)) return [...options];
  return [...options, current].sort((a, b) => a - b);
}

/** A number typed in, committed on Enter or on leaving the field. */
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
  // The figure can be typed too (a margin of 1.1 in is on no step): kept as
  // typed until Enter or leaving the field, then held to the range.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    // "0,75" and "2 in" are numbers too; "wide" is not (and not zero).
    const figure = draft.replace(",", ".").replace(/[^0-9.+-]/g, "");
    const n = Number(figure);
    setDraft(null);
    if (!figure || !Number.isFinite(n)) return;
    const next = Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000;
    if (next !== value) onChange(next);
  };
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
        <label className="wf-inspector-stepper-value">
          <input
            type="text"
            inputMode="decimal"
            aria-label={`${label}, inches`}
            disabled={disabled}
            value={draft ?? String(shown)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setDraft(null);
                e.currentTarget.blur();
              } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                setDraft(null);
                move(e.key === "ArrowUp" ? 1 : -1);
              }
            }}
          />
          <span>in</span>
        </label>
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
