import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Download,
  Focus as FocusIcon,
  HardDrive,
  History,
  ListTree,
  MoveVertical,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Toolbar, WfImage } from "../../editor/RichEditor";
import { confirmDialog } from "../../platform";
import { useSession } from "../../stores/session";
import { DocumentStats, ElementSelect, TitleEditor } from "./DocumentEditor";
import { useFocusMode, useTypewriterScroll } from "./focus";
import { exportDocument } from "./export";
import { FindBar } from "./FindBar";
import { DocElement } from "./formats/DocElement";
import { FORMAT_LABELS } from "./formats/elements";
import { formatKeymap } from "./formats/FormatKeymap";
import { useAutoRevisions, saveLocalVersion } from "./history";
import { useSwipe } from "../../lib/useSwipe";
import { activeLocalProvider, useLocalDocs } from "./local";
import { LocalHistoryPanel } from "./LocalHistoryPanel";
import { OutlinePanel } from "./OutlinePanel";
import { ShareLocalDialog } from "./ShareLocalDialog";

/** Editor for a document stored on this device: same page, formats, outline,
 *  find, and export as server documents — no collaboration surfaces (history,
 *  threads, shares, peers), no image insertion (image refs are server
 *  attachments), and every edit saves locally. */
export function LocalDocumentEditor() {
  const items = useLocalDocs((s) => s.items);
  const activeLocalId = useLocalDocs((s) => s.activeLocalId);
  const meta = items.find((d) => d.id === activeLocalId);
  const provider = activeLocalProvider();
  if (!meta || !provider) return <div className="wf-sessions-empty">Opening…</div>;
  return <LocalEditorInner key={`${meta.id}:${meta.format}`} meta={meta} />;
}

function LocalEditorInner({
  meta,
}: {
  meta: { id: string; title: string; format: string };
}) {
  const provider = activeLocalProvider();
  const close = useLocalDocs((s) => s.close);
  const rename = useLocalDocs((s) => s.rename);
  const setFormat = useLocalDocs((s) => s.setFormat);
  const remove = useLocalDocs((s) => s.remove);
  const [panel, setPanel] = useState<"none" | "history" | "outline">("none");
  const [exportOpen, setExportOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = useSession((s) => s.phase === "offline");
  // Same as the server editor: swipe right dismisses an open panel.
  const panelSwipe = useSwipe({ onRight: () => setPanel("none") });

  const extensions = useMemo(
    () => [
      StarterKit.configure({ undoRedo: false }),
      WfImage,
      Placeholder.configure({ placeholder: "Write…" }),
      DocElement,
      formatKeymap(meta.format),
      Collaboration.configure({ document: provider!.doc }),
    ],
    // Keyed remount on id/format change; provider is stable while mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    editable: true,
    editorProps: { attributes: { spellcheck: "true" } },
  });

  useAutoRevisions(editor, (json) => saveLocalVersion(meta.id, json));

  // Honor "open with this panel" from the list's Version history entry.
  useEffect(() => {
    const requested = useLocalDocs.getState().pendingPanel;
    if (requested) {
      setPanel(requested);
      useLocalDocs.setState({ pendingPanel: null });
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { focus, setFocus, typewriter, setTypewriter } = useFocusMode();
  useTypewriterScroll(editor, focus && typewriter);
  const toggleFocus = () => {
    if (!focus) {
      setPanel("none");
      setFinding(false);
    }
    setFocus(!focus);
  };

  if (!provider) return null;
  return (
    <div className={`wf-doc-room ${focus ? "focusing" : ""}`}>
      <header className="wf-session-room-header wf-doc-header">
        <button onClick={close}>←</button>
        <TitleEditor
          title={meta.title}
          canEdit
          onRename={(title) => void rename(meta.id, title)}
        />
        <select
          className="wf-doc-format"
          title="Writing format"
          value={meta.format}
          onChange={(e) => void setFormat(meta.id, e.target.value)}
        >
          {Object.entries(FORMAT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="wf-doc-local-chip" title="Stored on this device only">
          <HardDrive size={13} /> on this device
        </span>
        <span className="wf-statusbar-spacer" />
        <button
          title="Document history"
          className={panel === "history" ? "active" : ""}
          onClick={() => setPanel(panel === "history" ? "none" : "history")}
        >
          <History size={16} />
        </button>
        <button
          title="Outline"
          className={panel === "outline" ? "active" : ""}
          onClick={() => setPanel(panel === "outline" ? "none" : "outline")}
        >
          <ListTree size={16} />
        </button>
        <button
          title={focus ? "Leave focus mode (Esc)" : "Focus mode — just you and the page"}
          className={focus ? "active" : ""}
          onClick={toggleFocus}
        >
          <FocusIcon size={16} />
        </button>
        {focus && (
          <button
            title="Typewriter scrolling — keep the line you're writing centred"
            className={typewriter ? "active" : ""}
            onClick={() => setTypewriter(!typewriter)}
          >
            <MoveVertical size={16} />
          </button>
        )}
        <div className="wf-doc-export-wrap">
          <button
            title="Export document"
            className={exportOpen ? "active" : ""}
            onClick={() => setExportOpen((open) => !open)}
          >
            <Download size={16} />
          </button>
          {exportOpen && editor && (
            <div className="wf-doc-export-menu">
              <button
                onClick={() => {
                  setExportOpen(false);
                  void exportDocument(editor.getJSON(), meta.title, meta.format, "pdf").catch(
                    (e) => setError(String(e)),
                  );
                }}
              >
                Export PDF
              </button>
              <button
                onClick={() => {
                  setExportOpen(false);
                  void exportDocument(editor.getJSON(), meta.title, meta.format, "docx").catch(
                    (e) => setError(String(e)),
                  );
                }}
              >
                Export Word (.docx)
              </button>
            </div>
          )}
        </div>
        {!offline && (
          <button title="Share to server…" onClick={() => setShareOpen(true)}>
            <Share2 size={16} />
          </button>
        )}
        <button
          title="Delete local document"
          className="wf-danger"
          onClick={() =>
            void confirmDialog(
              `Delete "${meta.title}" from this device? It exists nowhere else.`,
              { title: "Delete local document", confirmLabel: "Delete", danger: true },
            ).then((ok) => {
              if (ok) void remove(meta.id);
            })
          }
        >
          <Trash2 size={16} />
        </button>
      </header>

      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {editor && (
        <div className="wf-doc-toolbar">
          <Toolbar
            editor={editor}
            richBlocks={meta.format === "none"}
            allowImages={false}
            leading={<ElementSelect editor={editor} format={meta.format} />}
            trailing={
              <DocumentStats editor={editor} format={meta.format} goalKey={`local:${meta.id}`} />
            }
          />
        </div>
      )}

      {finding && editor && <FindBar editor={editor} onClose={() => setFinding(false)} />}

      <div className="wf-doc-body" {...panelSwipe}>
        <div className="wf-doc-scroll">
          <div className={`wf-page wf-fmt-${meta.format}`}>
            <EditorContent className="wf-rich editable wf-doc-content" editor={editor} />
          </div>
        </div>
        {panel === "history" && <LocalHistoryPanel docId={meta.id} editor={editor} />}
        {panel === "outline" && editor && <OutlinePanel editor={editor} />}
      </div>

      {shareOpen && <ShareLocalDialog meta={meta} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
