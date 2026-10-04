import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BookOpen,
  Search,
  Eye,
  Focus as FocusIcon,
  History,
  ListTree,
  MessageSquare,
  MoveVertical,
  Presentation,
  Share2,
  SlidersHorizontal,
  SquareSplitVertical,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { isCmdError, isWeb } from "../../lib/backend";
import { useSwipe } from "../../lib/useSwipe";
import { readingTime } from "../../lib/wordCount";
import { loadGoal, noteGoalProgress, saveGoal } from "../../lib/writingGoals";
import { confirmDialog, toast } from "../../platform";
import { Avatar } from "../../platform/Avatar";
import { useSession } from "../../stores/session";
import { Paginate, reflowPagination, type PageLayoutResult, type PageSpec } from "../../editor/Paginate";
import { Toolbar, WfImage } from "../../editor/RichEditor";
import { quoteStyleFor, SmartPunctuation } from "../../editor/SmartPunctuation";
import { TextFormat } from "../../editor/TextFormat";
import { ManuscriptLabels, refreshManuscriptLabels } from "../../book/editor/manuscriptLabels";
import { ManuscriptPaste } from "../../book/editor/manuscriptPaste";
import { BookInspector } from "../../book/ui/BookInspector";
import { ConvertDialog } from "../../book/ui/ConvertDialog";
import { ExportBookDialog, type BookExportKind } from "../../book/ui/ExportBookDialog";
import { BookPreview } from "../../book/preview/BookPreview";
import { DockedPreview } from "../../book/preview/DockedPreview";
import { scanStructure } from "../../book/model/structure";
import { documentsApi } from "./api";
import { b64encode, type DocProvider } from "./collab";
import {
  onDocSettingsChange,
  pageSpecFor,
  readDocSettings,
  settingsVars,
  type DocSettings,
} from "./docSettings";
import { DocSettingsPanel } from "./DocSettingsPanel";
import { DocElement } from "./formats/DocElement";
import { FORMAT_LABELS, FORMAT_SPECS, type ElementSpec } from "./formats/elements";
import { formatKeymap } from "./formats/FormatKeymap";
import {
  FeedbackPanel,
  FeedbackHighlights,
  resolveThreadRange,
  useFeedbackDecorations,
  useThreadClicks,
  type ThreadFocus,
} from "./FeedbackPanel";
import { useFocusMode, useTypewriterScroll } from "./focus";
import { PageGuides } from "./PageGuides";
import { useAutoRevisions } from "./history";
import { FindBar } from "./FindBar";
import { useLocalDocs } from "./local";
import { OutlinePanel } from "./OutlinePanel";
import { SendToCanvasDialog } from "./SendToCanvasDialog";
import { countDocWords, countRangeWords } from "./stats";
import { ExportMenu, WORD_EXPORT, type ExportItem } from "./shell/ExportMenu";
import {
  bookExportItems,
  canDockPreview,
  EDITOR_PROPS,
  inputRulesFor,
  manuscriptVars,
  pasteRulesFor,
  showBlock,
  useBook,
  selectedPhrase,
  useFindShortcut,
  type FindRequest,
  useServerSyncState,
} from "./shell/hooks";
import { useReopenPosition } from "./shell/position";
import { SyncStatus, type SaveAction } from "./shell/SyncStatus";
import { openServerDoc } from "./navigation";
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

type Panel = "none" | "history" | "feedback" | "outline" | "settings" | "book" | "preview";

export function DocumentEditor() {
  const meta = useDocuments((s) => s.meta);
  const myAccess = useDocuments((s) => s.myAccess);
  const threads = useDocuments((s) => s.threads);
  const closeDocument = useDocuments((s) => s.closeDocument);
  const me = useSession((s) => s.session?.user);
  const provider = activeProvider();

  const [panel, setPanel] = useState<Panel>(() =>
    localStorage.getItem("wf-doc-feedback") === "on" ? "feedback" : "none",
  );
  const [shareOpen, setShareOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Honor "open with this panel" requests from the list (e.g. Version history).
  const metaId = meta?.id;
  useEffect(() => {
    if (metaId === undefined) return;
    const requested = useDocuments.getState().pendingPanel;
    if (requested) {
      setPanel(requested);
      useDocuments.setState({ pendingPanel: null });
    }
  }, [metaId]);

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
  panel: Panel;
  setPanel: (p: Panel) => void;
  shareOpen: boolean;
  setShareOpen: (o: boolean) => void;
  canvasOpen: boolean;
  setCanvasOpen: (o: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;
  closeDocument: (opts?: { discard?: boolean }) => void;
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
  const [find, setFind] = useState<FindRequest | null>(null);
  const openFind = useCallback(
    (replace: boolean, prefill: string) => setFind((f) => ({ n: (f?.n ?? 0) + 1, replace, prefill })),
    [],
  );
  const [converting, setConverting] = useState<null | "convert" | "tidy">(null);
  const [bookExport, setBookExport] = useState<BookExportKind | null>(null);
  const switchFormat = (next: string) =>
    documentsApi
      .update(meta.id, { title: null, format: next })
      .then(() => {})
      .catch((err) => state.setError(isCmdError(err) ? err.message : String(err)));
  const [highlightsOn, setHighlightsOn] = useState(
    () => localStorage.getItem("wf-doc-feedback-hl") !== "off",
  );
  const [pageViewOn, setPageGuides] = useState(
    () => localStorage.getItem("wf-doc-pageguides") === "on",
  );
  // A manuscript previews as a book instead (Preview book).
  const pageGuides = pageViewOn && format !== "manuscript";
  const [previewOpen, setPreviewOpen] = useState(false);
  // Phones show panels as overlays over the page — swipe right pushes the
  // open one away. Starts inside the editor text never trigger (editable).
  const panelSwipe = useSwipe({ onRight: () => setPanel("none") });

  // Per-document settings live in the doc's own Y.Map — they sync to every
  // collaborator through the ordinary update stream.
  const [docSettings, setDocSettings] = useState<DocSettings>(() =>
    readDocSettings(provider.doc),
  );
  useEffect(
    () => onDocSettingsChange(provider.doc, () => setDocSettings(readDocSettings(provider.doc))),
    [provider],
  );
  const [pageLayout, setPageLayout] = useState<PageLayoutResult | null>(null);
  const specRef = useRef<PageSpec | null>(null);
  // The book's details and design (Y.Map "book"): the manuscript view's
  // fonts, ornaments and chapter labels come from it.
  const { book, ref: bookRef } = useBook(provider.doc, { title: meta.title, author: state.me });

  const extensions = useMemo(
    () => [
      StarterKit.configure({ undoRedo: false }),
      WfImage,
      Placeholder.configure({ placeholder: "Write…" }),
      DocElement,
      TextFormat.configure({
        shortcuts: format === "none",
        alignShortcuts: format === "manuscript",
      }),
      formatKeymap(format),
      ...(format === "none" || format === "manuscript" || format === "poetry"
        ? [SmartPunctuation.configure({ quotes: () => quoteStyleFor(bookRef.current.meta.language) })]
        : []),
      ...(format === "manuscript"
        ? [ManuscriptLabels.configure({ getDesign: () => bookRef.current.design }), ManuscriptPaste]
        : []),
      FeedbackHighlights,
      Paginate.configure({ getSpec: () => specRef.current, onLayout: setPageLayout }),
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

  const editor = useEditor({
    extensions,
    editable: !readonly,
    editorProps: EDITOR_PROPS,
    enableInputRules: inputRulesFor(format),
    enablePasteRules: pasteRulesFor(format),
  });

  // A change of numbering style or label word re-labels the chapters.
  const { chapterNumber, chapterLabel, restartNumbersInParts } = book.design;
  useEffect(() => {
    if (format === "manuscript") refreshManuscriptLabels(editor);
  }, [editor, format, chapterNumber, chapterLabel, restartNumbersInParts]);

  useEffect(() => {
    editor?.setEditable(!readonly);
  }, [editor, readonly]);

  const sync = useServerSyncState(provider);
  const syncActions: SaveAction[] = [
    { label: "Try Again", run: () => provider.retry() },
    isWeb
      ? {
          label: "Download a Copy",
          primary: true,
          run: () =>
            void import("./export")
              .then(({ exportDocument }) =>
                editor ? exportDocument(editor.getJSON(), meta.title, format, "docx") : null,
              )
              .catch((e) => state.setError(String(e))),
        }
      : {
          label: "Save a Copy to This Device",
          primary: true,
          run: () =>
            void useLocalDocs
              .getState()
              .create(`${meta.title} (copy)`, format, b64encode(Y.encodeStateAsUpdate(provider.doc)))
              .then(() => toast("Saved a copy to this device.", "success"))
              .catch((e) => state.setError(isCmdError(e) ? e.message : String(e))),
        },
  ];

  useAutoRevisions(editor, (json) => documentsApi.snapshot(meta.id, json), !readonly);
  // Gated on the toggle alone: the panel-open OR made the highlighter
  // button a no-op in the only place it exists (the open panel).
  useFeedbackDecorations(editor, provider, state.threads, highlightsOn);
  // Clicking a highlighted passage opens its thread.
  const [threadFocus, setThreadFocus] = useState<ThreadFocus | null>(null);
  useThreadClicks(editor, (id) => {
    setPanel("feedback");
    setThreadFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  });

  // Page view geometry: recompute whenever settings, format, or the toggle
  // change; the plugin re-measures on its own for edits and resizes.
  useEffect(() => {
    specRef.current = pageGuides ? pageSpecFor(format, docSettings) : null;
    if (editor) reflowPagination(editor);
  }, [editor, pageGuides, docSettings, format]);

  const sheetStyle = useMemo(() => {
    const vars: Record<string, string> =
      format === "none"
        ? settingsVars(docSettings)
        : format === "manuscript"
          ? manuscriptVars(book)
          : {};
    if (pageGuides && pageLayout) vars["--wfd-fill"] = `${pageLayout.fill}px`;
    return vars as React.CSSProperties;
  }, [format, docSettings, book, pageGuides, pageLayout]);

  // Cmd/Ctrl+F opens find-in-document while the editor view is up.
  useFindShortcut(editor, openFind);

  const exportItems: ExportItem[] = useMemo(() => {
    const run = (kind: "pdf" | "booklet" | "docx") => async () => {
      if (!editor) return;
      const { exportDocument } = await import("./export");
      await exportDocument(
        editor.getJSON(),
        meta.title,
        format,
        kind,
        format === "none" ? docSettings : undefined,
      );
    };
    return [
      // A manuscript's PDFs come from the book typesetter (below).
      ...(format === "manuscript"
        ? []
        : [
            { label: "Export PDF", run: run("pdf") },
            {
              label: "Export booklet PDF",
              title: "Pages imposed for saddle stitch — print two-sided (flip on the short edge), fold in half",
              run: run("booklet"),
            },
          ]),
      { label: WORD_EXPORT, run: run("docx") },
      ...(format === "manuscript" && editor
        ? bookExportItems(setBookExport, async () => {
            const { exportSubmissionDocx } = await import("../../book/exportBook");
            await exportSubmissionDocx(editor.getJSON(), "manuscript", bookRef.current);
          })
        : []),
      ...(format === "none" && !readonly
        ? [
            {
              label: "Make it a book manuscript…",
              title: "Turn chapters and scene breaks into book elements for print and ebook export",
              separatorBefore: true,
              run: async () => setConverting("convert"),
            },
          ]
        : []),
    ];
  }, [editor, meta.title, format, docSettings, readonly, bookRef]);

  /** Delete: to Recently Deleted with Undo (servers that predate it delete
   *  for good, so they still ask first). Unsent edits go out first, so the
   *  restored document has them. */
  const deleteThis = async () => {
    const supported = useDocuments.getState().trashSupported;
    if (supported === false) {
      const ok = await confirmDialog("Delete this document for everyone? This server deletes documents permanently.", {
        title: "Delete document",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await provider.flush(2000);
      await documentsApi.remove(meta.id);
      // Nothing is left to send to a deleted document.
      state.closeDocument({ discard: true });
      if (supported !== false) {
        const id = meta.id;
        const title = meta.title;
        toast(`Moved “${title}” to Recently Deleted.`, "info", {
          durationMs: 8000,
          action: {
            label: "Undo",
            run: () =>
              void documentsApi
                .restore(id)
                .then(() => openServerDoc(id))
                .catch((e) => state.setError(isCmdError(e) ? e.message : String(e))),
          },
        });
      }
    } catch (e) {
      state.setError(isCmdError(e) ? e.message : String(e));
    }
  };

  const { focus, setFocus, typewriter, setTypewriter } = useFocusMode();
  useTypewriterScroll(editor, focus && typewriter);
  // Word goals are per-device; the key carries the server so ids don't mix.
  const addr = useSession((s) => s.session?.addr);
  const goalKey = `${addr ?? "server"}:${meta.id}`;
  // Reopen where you left off.
  const scrollRef = useRef<HTMLDivElement>(null);
  useReopenPosition(editor, `s:${goalKey}`, scrollRef);
  const toggleFocus = () => {
    if (!focus) {
      setPanel("none");
      setFind(null);
    }
    setFocus(!focus);
  };

  return (
    <div className={`wf-doc-room ${focus ? "focusing" : ""}`}>
      <header className="wf-session-room-header wf-doc-header">
        <button title="Back to documents" onClick={() => state.closeDocument()}>
          ←
        </button>
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
          onChange={(e) => {
            // Plain → Manuscript offers to turn the text's structure into
            // book elements first.
            if (format === "none" && e.target.value === "manuscript" && editor) {
              setConverting("convert");
              return;
            }
            void switchFormat(e.target.value);
          }}
        >
          {Object.entries(FORMAT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {!readonly && <SyncStatus state={sync} where="server" actions={syncActions} />}
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
          title="Document history"
          className={panel === "history" ? "active" : ""}
          onClick={() => setPanel(panel === "history" ? "none" : "history")}
        >
          <History size={16} />
        </button>
        <button
          title="Find and replace (⌘F)"
          className={find ? "active" : ""}
          disabled={!editor}
          onClick={() => (find ? setFind(null) : openFind(false, selectedPhrase(editor)))}
        >
          <Search size={16} />
        </button>
        <button
          title="Outline"
          className={panel === "outline" ? "active" : ""}
          onClick={() => setPanel(panel === "outline" ? "none" : "outline")}
        >
          <ListTree size={16} />
        </button>
        {format === "manuscript" ? (
          <button
            title="Preview the book — every page as it will print"
            className={panel === "preview" || previewOpen ? "active" : ""}
            disabled={!editor}
            onClick={() => {
              if (canDockPreview()) setPanel(panel === "preview" ? "none" : "preview");
              else setPreviewOpen(true);
            }}
          >
            <Eye size={16} />
          </button>
        ) : (
          <button
            title="Page view — paginate the sheet into real pages"
            className={pageGuides ? "active" : ""}
            onClick={() => {
              const next = !pageViewOn;
              setPageGuides(next);
              localStorage.setItem("wf-doc-pageguides", next ? "on" : "off");
            }}
          >
            <SquareSplitVertical size={16} />
          </button>
        )}
        {format === "manuscript" && (
          <button
            title="Book — details, design, print and ebook settings"
            className={panel === "book" ? "active" : ""}
            onClick={() => setPanel(panel === "book" ? "none" : "book")}
          >
            <BookOpen size={16} />
          </button>
        )}
        {format === "none" && (
          <button
            title="Document settings — paper, margins, text"
            className={panel === "settings" ? "active" : ""}
            onClick={() => setPanel(panel === "settings" ? "none" : "settings")}
          >
            <SlidersHorizontal size={16} />
          </button>
        )}
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
        <ExportMenu
          items={exportItems}
          onError={(e) => state.setError(isCmdError(e) ? e.message : String(e))}
        />
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
            onClick={() => void deleteThis()}
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

      {/* The header fades in focus mode; trouble stays legible in a corner. */}
      {focus && !readonly && (
        <SyncStatus state={sync} where="server" actions={syncActions} floating />
      )}

      {editor && !readonly && (
        <div className="wf-doc-toolbar">
          <Toolbar
            editor={editor}
            richBlocks={format === "none"}
            typography={format === "none"}
            manuscript={format === "manuscript"}
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
            trailing={
              <DocumentStats
                editor={editor}
                format={format}
                goalKey={goalKey}
                pagesExact={pageGuides ? (pageLayout?.pages ?? null) : null}
              />
            }
          />
        </div>
      )}

      {find && editor && <FindBar editor={editor} readonly={readonly} request={find} onClose={() => setFind(null)} />}

      <div className="wf-doc-body" {...panelSwipe}>
        <div className="wf-doc-scroll" ref={scrollRef}>
          <div
            className={`wf-page wf-fmt-${format}`}
            style={sheetStyle}
            data-paged={pageGuides ? "" : undefined}
          >
            {pageGuides && <PageGuides layout={pageLayout} />}
            <EditorContent className={`wf-rich editable wf-doc-content`} editor={editor} />
          </div>
        </div>
        {/* Panel state lives above the format-keyed remount, so a format
            switch could otherwise leave a stale inspector open. */}
        {panel === "settings" && format === "none" && (
          <DocSettingsPanel
            editor={editor}
            ydoc={provider.doc}
            settings={docSettings}
            readonly={readonly}
          />
        )}
        {panel === "preview" && format === "manuscript" && editor && (
          <DockedPreview
            editor={editor}
            format={format}
            book={book}
            onExpand={() => setPreviewOpen(true)}
            onClose={() => setPanel("none")}
            onShowSource={(src) => showBlock(editor, src)}
          />
        )}
        {panel === "book" && format === "manuscript" && editor && (
          <BookInspector
            ydoc={provider.doc}
            book={book}
            readonly={readonly}
            words={countDocWords(editor.state.doc)}
            chapters={
              scanStructure(editor.state.doc, "manuscript", book.design).entries.filter(
                (e) => e.kind === "chapter",
              ).length
            }
          />
        )}
        {panel === "history" && <VersionHistoryPanel editor={editor} />}
        {panel === "feedback" && (
          <FeedbackPanel
            focus={threadFocus}
            editor={editor}
            provider={provider}
            highlightsOn={highlightsOn}
            onToggleHighlights={() => {
              const next = !highlightsOn;
              setHighlightsOn(next);
              localStorage.setItem("wf-doc-feedback-hl", next ? "on" : "off");
            }}
          />
        )}
        {panel === "outline" && (
          <OutlinePanel
            editor={editor}
            format={format}
            design={book.design}
            commentRanges={() =>
              editor
                ? state.threads
                    .map((t) => resolveThreadRange(editor, t))
                    .filter((r): r is { from: number; to: number } => r !== null)
                : []
            }
            onNavigate={() => setPanel("none")}
            onTidy={readonly ? undefined : () => setConverting("tidy")}
          />
        )}
      </div>

      {converting && editor && (
        <ConvertDialog
          editor={editor}
          ydoc={provider.doc}
          mode={converting}
          onSwitchFormat={() => switchFormat("manuscript")}
          onClose={() => setConverting(null)}
        />
      )}
      {bookExport && editor && (
        <ExportBookDialog
          kind={bookExport}
          editor={editor}
          ydoc={provider.doc}
          book={book}
          format={format}
          readonly={readonly}
          onShowSource={(src) => {
            setBookExport(null);
            showBlock(editor, src);
          }}
          onClose={() => setBookExport(null)}
        />
      )}
      {previewOpen && editor && format === "manuscript" && (
        <BookPreview
          editor={editor}
          format={format}
          book={book}
          onClose={() => setPreviewOpen(false)}
          onShowSource={(src) => {
            setPreviewOpen(false);
            setPanel("none");
            showBlock(editor, src);
          }}
          onExport={() => {
            setPreviewOpen(false);
            setBookExport("paperback");
          }}
        />
      )}
      {state.shareOpen && <ShareDialog onClose={() => state.setShareOpen(false)} />}
      {state.canvasOpen && (
        <SendToCanvasDialog editor={editor} onClose={() => state.setCanvasOpen(false)} />
      )}
    </div>
  );
}

export function TitleEditor({
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
export function ElementSelect({ editor, format }: { editor: Editor; format: string }) {
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
        title={
          spec.tabOnText === "cycle"
            ? "Paragraph element (Tab cycles)"
            : "Paragraph element (Tab on an empty line cycles)"
        }
        value={spec.elements.some((el) => el.id === current) ? current : spec.defaultElement}
        onChange={(e) =>
          editor.chain().focus().updateAttributes("paragraph", { element: e.target.value }).run()
        }
      >
        {groupElements(spec.elements).map(([group, els]) =>
          group ? (
            <optgroup key={group} label={group}>
              {els.map(elementOption)}
            </optgroup>
          ) : (
            els.map(elementOption)
          ),
        )}
      </select>
    </label>
  );
}

const elementOption = (el: ElementSpec) => (
  <option key={el.id} value={el.id} title={el.hint}>
    {el.label}
    {el.shortcut ? `  ${el.shortcut}` : ""}
  </option>
);

/** Elements in display groups (in first-appearance order), ungrouped first. */
function groupElements(elements: ElementSpec[]): [string, ElementSpec[]][] {
  const groups = new Map<string, ElementSpec[]>();
  for (const el of elements) {
    const key = el.group ?? "";
    const list = groups.get(key) ?? [];
    list.push(el);
    groups.set(key, list);
  }
  const order = ["", "Text", "Headings", "Special"];
  return [...groups.entries()].sort(
    ([a], [b]) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99,
  );
}

export function DocumentStats({
  editor,
  format,
  goalKey,
  pagesExact,
}: {
  editor: Editor;
  format: string;
  /** When set, the count is clickable and carries a word-count goal. */
  goalKey?: string;
  /** Page-view count from the paginator; null falls back to the estimate. */
  pagesExact?: number | null;
}) {
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState<number | null>(() => (goalKey ? loadGoal(goalKey) : null));
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => setGoal(goalKey ? loadGoal(goalKey) : null), [goalKey]);

  // Counting is cached per paragraph (stats.ts) and runs only when the text
  // changed — debounced, but at least every 1.5s while typing — instead of
  // re-reading the whole book (and forcing a layout) on every transaction.
  const measure = useCallback(
    () => ({
      words: countDocWords(editor.state.doc),
      blocks: editor.state.doc.childCount,
      height: editor.view.dom.offsetHeight,
    }),
    [editor],
  );
  const [counts, setCounts] = useState(measure);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstPendingAt = 0;
    const run = () => {
      timer = null;
      firstPendingAt = 0;
      setCounts(measure());
    };
    const onUpdate = () => {
      const now = Date.now();
      if (!firstPendingAt) firstPendingAt = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, now - firstPendingAt > 1250 ? 0 : 250);
    };
    const onSelection = () => {
      const { from, to } = editor.state.selection;
      setSelected(countRangeWords(editor.state.doc, from, to));
    };
    setCounts(measure());
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelection);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, measure]);

  const { words, blocks } = counts;
  useEffect(() => {
    if (goalKey && goal !== null) noteGoalProgress(goalKey, words, goal);
  }, [goalKey, goal, words]);

  // Page view reports an exact block-level count; otherwise estimate from
  // the sheet (CSS inches, so 96px/in maps exactly).
  const pages = pagesExact ?? Math.max(1, Math.ceil(counts.height / (11 * 96)));

  const body = (
    <>
      {selected !== null && selected > 0 && `${selected.toLocaleString()} of `}
      {words.toLocaleString()}
      {goal !== null && ` / ${goal.toLocaleString()}`} {words === 1 && goal === null ? "word" : "words"}
      {/* Phones keep just the count. */}
      <span className="wf-doc-stats-more">
        {format !== "screenplay" && words > 0 && ` · ${readingTime(words)}`}
        {format === "screenplay" && ` · ${blocks} elements`}
        {words > 0 && (
          <span title="On-screen pages — export pagination may differ">
            {` · ${pagesExact === null || pagesExact === undefined ? "~" : ""}${pages} page${pages === 1 ? "" : "s"}`}
          </span>
        )}
      </span>
    </>
  );
  if (!goalKey) return <span className="wf-doc-stats">{body}</span>;
  // The popover is position:fixed, anchored from the trigger's rect at open —
  // the toolbar is an overflow-x scroll row that would clip anything absolute.
  const anchor = goalOpen ? wrapRef.current?.getBoundingClientRect() : undefined;
  return (
    <span className="wf-doc-stats wf-doc-goal-wrap" ref={wrapRef}>
      <button
        className="wf-doc-stats-btn"
        title={goal !== null ? "Word-count goal — click to change" : "Set a word-count goal"}
        onClick={() => setGoalOpen((v) => !v)}
      >
        {body}
        {goal !== null && (
          <span className="wf-goal-bar" aria-hidden>
            <span style={{ width: `${Math.min(100, Math.round((words / goal) * 100))}%` }} />
          </span>
        )}
      </button>
      {goalOpen && anchor && (
        <GoalPopover
          style={{
            top: anchor.bottom + 8,
            right: Math.max(8, window.innerWidth - anchor.right),
          }}
          current={goal}
          onPick={(n) => {
            saveGoal(goalKey, n);
            setGoal(n);
            setGoalOpen(false);
          }}
          onClose={() => setGoalOpen(false)}
        />
      )}
    </span>
  );
}

function GoalPopover({
  current,
  onPick,
  onClose,
  style,
}: {
  current: number | null;
  onPick: (n: number | null) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(current === null ? "" : String(current));
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Deferred so the click that opened the popover doesn't close it.
    const t = setTimeout(() => window.addEventListener("pointerdown", close), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close);
    };
  }, [onClose]);
  const commit = () => {
    const n = Math.floor(Number(draft));
    onPick(Number.isFinite(n) && n > 0 ? n : null);
  };
  return (
    <span className="wf-goal-pop" ref={ref} style={style}>
      <label>
        Word goal
        <input
          type="number"
          min={1}
          step={50}
          placeholder="e.g. 1500"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onClose();
          }}
        />
      </label>
      <button className="wf-primary" onClick={commit}>
        Set
      </button>
      {current !== null && <button onClick={() => onPick(null)}>Clear</button>}
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
