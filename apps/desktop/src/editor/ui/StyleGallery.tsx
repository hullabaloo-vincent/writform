import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { createPortal } from "react-dom";

import type { FontInfo } from "../../fonts/css";
import { fontCssFamily } from "../../fonts/css";
import { toast } from "../../platform/toast";
import { applyStyle, capturedProps, clearCaptured, curStyle } from "../styles/apply";
import { newStyleId } from "../styles/docStyles";
import { NORMAL_STYLE, QUOTE_STYLE, type ResolvedStyles, type StyleEntry, type StyleLook } from "../styles/sheet";
import { Flyout } from "./Flyout";
import { StyleDialog } from "./StyleDialog";

type Editing = { kind: "modify"; id: string } | { kind: "new"; base: string; look: StyleLook };

/**
 * The styles button: the document's paragraph styles, each drawn in its own
 * look. Choosing one applies it; below the list, the style in force can be
 * changed, updated to match the selected paragraph, or a new style made
 * from it.
 */
export function StyleGallery({
  editor,
  styles,
  defaults,
  fonts,
  fontTable,
  onSave,
  onFontUsed,
  onBodyText,
}: {
  editor: Editor;
  styles: ResolvedStyles;
  /** The same styles with nothing changed (what "reset" goes back to). */
  defaults: ResolvedStyles;
  fonts: string[];
  fontTable: Record<string, FontInfo>;
  /** Absent: the document can't be changed (styles are only applied). */
  onSave?: (id: string, entry: StyleEntry | null) => void;
  onFontUsed?: (id: string, info?: FontInfo) => void;
  /** Normal is the document's body text: where that is set. */
  onBodyText?: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const current = curStyle(editor, styles);
  const info = styles.list.find((s) => s.id === current) ?? styles.list[0];

  const sample = (id: string): React.CSSProperties => {
    const look = styles.look(id);
    const family = look.font ? fontCssFamily(look.font, fontTable[look.font]) : null;
    return {
      ...(family ? { fontFamily: family } : {}),
      // The gallery shows the differences, not the true sizes.
      fontSize: `${Math.min(19, Math.max(11.5, look.size * 0.85))}px`,
      fontWeight: look.bold ? 700 : 400,
      fontStyle: look.italic ? "italic" : "normal",
      textDecoration: look.underline ? "underline" : "none",
      ...(look.color ? { color: look.color } : {}),
    };
  };

  const updateToMatch = () => {
    if (!onSave) return;
    const props = capturedProps(editor);
    if (Object.keys(props).length === 0) {
      toast(`This paragraph already looks like ${info.name}.`, "info");
      return;
    }
    const entry = styles.entry(current);
    onSave(current, { ...entry, props: { ...(entry?.props ?? {}), ...props } });
    if (props.font) onFontUsed?.(props.font, fontTable[props.font]);
    clearCaptured(editor);
  };

  const editable = !!onSave;
  // Normal is the body text; a quote's and a heading's style is what they are.
  const canMatch = editable && current !== NORMAL_STYLE;

  return (
    <>
      <Flyout title="Paragraph style" label={info.name} className="wf-ribbon-style" panelClass="wf-style-gallery">
        {(close) => (
          <>
            <div className="wf-style-list" role="group" aria-label="Styles">
              {styles.list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.id === current}
                  className={`wf-style-item${s.id === current ? " current" : ""}`}
                  onClick={() => {
                    applyStyle(editor, s.id, styles);
                    close();
                  }}
                >
                  <span style={sample(s.id)}>{s.name}</span>
                  {!s.builtin && <small>Yours</small>}
                </button>
              ))}
            </div>
            {editable && (
              <div className="wf-style-tools">
                <button
                  type="button"
                  onClick={() => {
                    close();
                    if (current === NORMAL_STYLE) onBodyText?.();
                    else setEditing({ kind: "modify", id: current });
                  }}
                >
                  {current === NORMAL_STYLE ? "Body text settings…" : `Modify ${info.name}…`}
                </button>
                <button
                  type="button"
                  disabled={!canMatch}
                  onClick={() => {
                    close();
                    updateToMatch();
                  }}
                >
                  Update {info.name} to match selection
                </button>
                <button
                  type="button"
                  // (A quote's style is the quote it sits in.)
                  disabled={current === QUOTE_STYLE}
                  onClick={() => {
                    close();
                    // The new style starts as this paragraph looks now.
                    const base = styles.look(current);
                    const props = capturedProps(editor);
                    setEditing({ kind: "new", base: current, look: { ...base, ...props, keepLines: false, outline: undefined } as StyleLook });
                  }}
                >
                  New style from selection…
                </button>
              </div>
            )}
          </>
        )}
      </Flyout>
      {editing?.kind === "modify" &&
        (() => {
          const id = editing.id;
          const entry = styles.entry(id);
          const meta = styles.list.find((s) => s.id === id);
          if (!meta) return null;
          const base = meta.builtin ? defaults.look(id) : styles.look(entry?.base ?? NORMAL_STYLE);
          // In the body, not the ribbon: the ribbon's own rules (compact
          // buttons, no text selection) aren't a dialog's.
          return createPortal(
            <StyleDialog
              title={`Modify ${meta.name}`}
              name={meta.builtin ? null : meta.name}
              look={styles.look(id)}
              base={base}
              fonts={fonts}
              fontTable={fontTable}
              onClose={() => setEditing(null)}
              onSave={(next, used) => {
                onSave?.(id, { ...next, ...(entry?.base ? { base: entry.base } : {}) });
                if (used.font) onFontUsed?.(used.font, fontTable[used.font]);
                setEditing(null);
              }}
              {...(meta.builtin
                ? meta.changed
                  ? {
                      resetLabel: "Reset to built-in",
                      onReset: () => {
                        onSave?.(id, null);
                        setEditing(null);
                      },
                    }
                  : {}
                : {
                    resetLabel: "Delete style",
                    onReset: () => {
                      // Its paragraphs fall back to body text.
                      onSave?.(id, null);
                      setEditing(null);
                    },
                  })}
            />,
            document.body,
          );
        })()}
      {editing?.kind === "new" &&
        createPortal(
          <StyleDialog
            title="New style"
            name="My style"
            look={editing.look}
            base={styles.look(editing.base)}
            fonts={fonts}
            fontTable={fontTable}
            onClose={() => setEditing(null)}
            onSave={(next, used) => {
              const id = newStyleId(styles.list.map((s) => s.id));
              onSave?.(id, { ...next, base: editing.base });
              if (used.font) onFontUsed?.(used.font, fontTable[used.font]);
              // The paragraph it came from takes the style, and gives up the
              // formatting the style now carries.
              clearCaptured(editor, id);
              setEditing(null);
            }}
          />,
          document.body,
        )}
    </>
  );
}
