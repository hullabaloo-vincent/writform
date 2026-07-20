import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  CloudOff,
  History,
  MessageSquare,
  Presentation,
  Share2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isCmdError } from "../../lib/backend";
import { confirmDialog } from "../../platform";
import { Avatar } from "../../platform/Avatar";
import { useSession } from "../../stores/session";
import { Toolbar } from "../../editor/RichEditor";
import { documentsApi } from "./api";
import type { DocProvider } from "./collab";
import { DocElement } from "./formats/DocElement";
import { FORMAT_LABELS, FORMAT_SPECS } from "./formats/elements";
import { formatKeymap } from "./formats/FormatKeymap";
import { FeedbackPanel, useFeedbackDecorations, FeedbackHighlights } from "./FeedbackPanel";
import { SendToCanvasDialog } from "./SendToCanvasDialog";
import { activeProvider, useDocuments } from "./store";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { ShareDialog } from "./ShareDialog";

const CARET_COLORS = [
  "#c96f4a",
  "#5a9e6f",
  "#5d8fc9",
  "#a878c9",
  "#c9a44a",
  "#c96f9a",
  "#4aa8a0",
];

function caretColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CARET_COLORS[h % CARET_COLORS.length];
}

const AUTO_SNAPSHOT_MS = 60_000;

type Panel = "none" | "history" | "feedback";

export function DocumentEditor() {
  const meta = useDocuments((s) => s.meta);
  const myAccess = useDocuments((s) => s.myAccess);
  const threads = useDocuments((s) => s.threads);
  const closeDocument = useDocuments((s) => s.closeDocument);
  const me = useSession((s) => s.session?.user);
  const provider = activeProvider();

  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState<Panel>(() =>
    localStorage.getItem("wf-doc-feedback") === "on" ? "feedback" : "none",
  );
  const [shareOpen, setShareOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!meta || !provider) return <div className="wf-sessions-empty">Opening…</div>;
  return (
    <EditorInner
      key={`${meta.id}:${meta.format}`}
      provider={provider}
      format={meta.format}
      readonly={myAccess === "read"}
      state={{
        meta,
        myAccess: myAccess ?? "read",
        threads,
        me: me ? (me.display_name ?? me.username) : "me",
        pending,
        setPending,
        panel,
        setPanel,
        shareOpen,
        setShareOpen,
        canvasOpen,
        setCanvasOpen,
        error,
        setError,
        closeDocument,
      }}
    />
  );
}

interface EditorCtx {
  meta: NonNullable<ReturnType<typeof useDocuments.getState>["meta"]>;
  myAccess: string;
  threads: ReturnType<typeof useDocuments.getState>["threads"];
  me: string;
  pending: boolean;
  setPending: (p: boolean) => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  shareOpen: boolean;
  setShareOpen: (o: boolean) => void;
  canvasOpen: boolean;
  setCanvasOpen: (o: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;
  closeDocument: () => void;
}

function EditorInner({
  provider,
  format,
  readonly,
  state,
}: {
  provider: DocProvider;
  format: string;
  readonly: boolean;
  state: EditorCtx;
}) {
  const { meta, myAccess, panel, setPanel } = state;

  const extensions = useMemo(
    () => [
      StarterKit.configure({ undoRedo: false }),
      Image.configure({ allowBase64: false }),
      Placeholder.configure({ placeholder: "Write…" }),
      DocElement,
      formatKeymap(format),
      FeedbackHighlights,
      Collaboration.configure({ document: provider.doc }),
      CollaborationCaret.configure({
        provider: { awareness: provider.awareness },
        user: { name: state.me, color: caretColor(state.me) },
      }),
    ],
    // The `key` on EditorInner remounts on format change; these are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({ extensions, editable: !readonly });

  useEffect(() => {
    editor?.setEditable(!readonly);
  }, [editor, readonly]);

  // Offline chip.
  useEffect(() => {
    provider.onPending = state.setPending;
    return () => {
      provider.onPending = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useAutoSnapshot(editor, meta.id, readonly);
  useFeedbackDecorations(editor, provider, state.threads, panel === "feedback");

  return (
    <div className="wf-doc-room">
      <header className="wf-session-room-header wf-doc-header">
        <button onClick={state.closeDocument}>←</button>
        <TitleEditor
          title={meta.title}
          canEdit={!readonly}
          onRename={(title) =>
            documentsApi
              .update(meta.id, { title, format: null })
              .catch((e) => state.setError(isCmdError(e) ? e.message : String(e)))
          }
        />
        <select
          className="wf-doc-format"
          title="Writing format"
          value={format}
          disabled={readonly}
          onChange={(e) =>
            void documentsApi
              .update(meta.id, { title: null, format: e.target.value })
              .catch((err) => state.setError(isCmdError(err) ? err.message : String(err)))
          }
        >
          {Object.entries(FORMAT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {state.pending && (
          <span className="wf-doc-pending" title="Changes not yet saved to the server">
            <CloudOff size={14} /> pending
          </span>
        )}
        <span className="wf-statusbar-spacer" />
        <Peers provider={provider} />
        <button
          title="Feedback"
          className={panel === "feedback" ? "active" : ""}
          onClick={() => {
            const next = panel === "feedback" ? "none" : "feedback";
            setPanel(next);
            localStorage.setItem("wf-doc-feedback", next === "feedback" ? "on" : "off");
          }}
        >
          <MessageSquare size={16} />
          {state.threads.filter((t) => !t.resolved).length > 0 && (
            <span className="wf-doc-badge">
              {state.threads.filter((t) => !t.resolved).length}
            </span>
          )}
        </button>
        <button
          title="Version history"
          className={panel === "history" ? "active" : ""}
          onClick={() => setPanel(panel === "history" ? "none" : "history")}
        >
          <History size={16} />
        </button>
        <button title="Send to canvas" onClick={() => state.setCanvasOpen(true)}>
          <Presentation size={16} />
        </button>
        {myAccess === "owner" && (
          <button title="Share" onClick={() => state.setShareOpen(true)}>
            <Share2 size={16} />
          </button>
        )}
        {myAccess === "owner" && (
          <button
            title="Delete document"
            className="wf-danger"
            onClick={() =>
              void confirmDialog(
                "Delete this document for everyone? Version history is deleted too.",
                { title: "Delete document", confirmLabel: "Delete", danger: true },
              ).then((ok) => {
                if (!ok) return;
                documentsApi
                  .remove(meta.id)
                  .then(() => state.closeDocument())
                  .catch((e) => state.setError(isCmdError(e) ? e.message : String(e)));
              })
            }
          >
            <Trash2 size={16} />
          </button>
        )}
      </header>

      {state.error && (
        <p className="wf-connect-error" onClick={() => state.setError(null)}>
          {state.error}
        </p>
      )}

      {editor && !readonly && (
        <div className="wf-doc-toolbar">
          <Toolbar
            editor={editor}
            richBlocks={format === "none"}
            leading={
              <>
                <ElementSelect editor={editor} format={format} />
                {format === "screenplay" && (
                  <span className="wf-doc-shortcuts" title="Screenplay element shortcuts">
                    Tab cycles · ⌘1–6 selects
                  </span>
                )}
              </>
            }
            trailing={<DocumentStats editor={editor} format={format} />}
          />
        </div>
      )}

      <div className="wf-doc-body">
        <div className="wf-doc-scroll">
          <div className={`wf-page wf-fmt-${format}`}>
            <EditorContent className={`wf-rich editable wf-doc-content`} editor={editor} />
          </div>
        </div>
        {panel === "history" && <VersionHistoryPanel editor={editor} />}
        {panel === "feedback" && <FeedbackPanel editor={editor} provider={provider} />}
      </div>

      {state.shareOpen && <ShareDialog onClose={() => state.setShareOpen(false)} />}
      {state.canvasOpen && (
        <SendToCanvasDialog editor={editor} onClose={() => state.setCanvasOpen(false)} />
      )}
    </div>
  );
}

function TitleEditor({
  title,
  canEdit,
  onRename,
}: {
  title: string;
  canEdit: boolean;
  onRename: (title: string) => void;
}) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  if (!canEdit) return <h2>{title}</h2>;
  return (
    <input
      className="wf-doc-title"
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const t = draft.trim();
        if (t && t !== title) onRename(t);
        else setDraft(title);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(title);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Current paragraph's element type; changing it updates the paragraph. */
function ElementSelect({ editor, format }: { editor: Editor; format: string }) {
  const spec = FORMAT_SPECS[format];
  const [, bump] = useState(0);
  useEffect(() => {
    const update = () => bump((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);
  if (!spec) return <span className="wf-doc-mode-label">Rich text</span>;
  const current =
    (editor.getAttributes("paragraph").element as string | undefined) ?? spec.defaultElement;
  return (
    <label className="wf-doc-element-control">
      <span>Element</span>
      <select
        className="wf-doc-element"
        title="Paragraph element (Tab cycles)"
        value={current}
        onChange={(e) =>
          editor.chain().focus().updateAttributes("paragraph", { element: e.target.value }).run()
        }
      >
        {spec.elements.map((el) => (
          <option key={el.id} value={el.id}>
            {el.label}{el.shortcut ? `  ${el.shortcut}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function DocumentStats({ editor, format }: { editor: Editor; format: string }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const update = () => bump((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const text = editor.getText().trim();
  const words = text ? text.split(/\s+/).length : 0;
  const blocks = editor.state.doc.childCount;
  return (
    <span className="wf-doc-stats">
      {words.toLocaleString()} {words === 1 ? "word" : "words"}
      {format === "screenplay" && ` · ${blocks} elements`}
    </span>
  );
}

/** Live co-editor avatars from awareness states. */
function Peers({ provider }: { provider: DocProvider }) {
  const [peers, setPeers] = useState<{ name: string; color: string }[]>([]);
  useEffect(() => {
    const aw = provider.awareness;
    const update = () => {
      const others: { name: string; color: string }[] = [];
      for (const [clientId, s] of aw.getStates()) {
        if (clientId === aw.clientID) continue;
        const user = (s as { user?: { name?: string; color?: string } }).user;
        if (user?.name) others.push({ name: user.name, color: user.color ?? "#888" });
      }
      setPeers(others);
    };
    aw.on("change", update);
    update();
    return () => {
      aw.off("change", update);
    };
  }, [provider]);
  if (peers.length === 0) return null;
  return (
    <span className="wf-doc-peers" title={peers.map((p) => p.name).join(", ")}>
      {peers.slice(0, 5).map((p, i) => (
        <span key={i} style={{ borderColor: p.color }} className="wf-doc-peer">
          <Avatar name={p.name} size={20} />
        </span>
      ))}
      {peers.length > 5 && <span className="wf-doc-peer-more">+{peers.length - 5}</span>}
    </span>
  );
}

/** Debounced auto-snapshots for version history (server rate-limits/dedups). */
function useAutoSnapshot(editor: Editor | null, docId: number, readonly: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!editor || readonly) return;
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        documentsApi.snapshot(docId, JSON.stringify(editor.getJSON())).catch(() => {});
      }, AUTO_SNAPSHOT_MS);
    };
    editor.on("update", schedule);
    return () => {
      editor.off("update", schedule);
      if (timer.current) {
        clearTimeout(timer.current);
        // Final best-effort snapshot on close.
        try {
          documentsApi.snapshot(docId, JSON.stringify(editor.getJSON())).catch(() => {});
        } catch {
          // editor already destroyed
        }
      }
    };
  }, [editor, docId, readonly]);
}
