import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BookOpen,
  Search,
  Eye,
  MessageSquare,
  Focus as FocusIcon,
  HardDrive,
  History,
  ListTree,
  MoveVertical,
  Share2,
  SlidersHorizontal,
  SquareSplitVertical,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { toast } from "../../platform";
import { useSession } from "../../stores/session";
import {
  onDocSettingsChange,
  pageSpecFor,
  readDocSettings,
  settingsVars,
  type DocSettings,
} from "./docSettings";
import { DocSettingsPanel } from "./DocSettingsPanel";
import { DocumentStats, ElementSelect, TitleEditor } from "./DocumentEditor";
import {
  FeedbackHighlights,
  resolveThreadRange,
  useFeedbackDecorations,
  useThreadClicks,
  type ThreadFocus,
} from "./FeedbackPanel";
import { onLocalFeedbackChange, readLocalFeedback, type LocalThread } from "./feedbackLocal";
import { LocalFeedbackPanel } from "./LocalFeedbackPanel";
import { useFocusMode, useTypewriterScroll } from "./focus";
import { PageGuides } from "./PageGuides";
import { FindBar } from "./FindBar";
import { DocElement } from "./formats/DocElement";
import { FORMAT_LABELS } from "./formats/elements";
import { formatKeymap } from "./formats/FormatKeymap";
import { useAutoRevisions, saveLocalVersion } from "./history";
import { useSwipe } from "../../lib/useSwipe";
import { activeLocalProvider, useLocalDocs, type LocalSaveState } from "./local";
import { LocalHistoryPanel } from "./LocalHistoryPanel";
import { openLocalDoc } from "./navigation";
import { OutlinePanel } from "./OutlinePanel";
import { ShareLocalDialog } from "./ShareLocalDialog";
import { countDocWords } from "./stats";
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
} from "./shell/hooks";
import { useReopenPosition } from "./shell/position";
import { SyncStatus, type SaveIndicator } from "./shell/SyncStatus";

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
  const [panel, setPanel] = useState<
    "none" | "history" | "outline" | "feedback" | "settings" | "book" | "preview"
  >("none");
  const [threads, setThreads] = useState<LocalThread[]>([]);
  const [highlightsOn, setHighlightsOn] = useState(
    () => localStorage.getItem("wf-doc-feedback-hl") !== "off",
  );
  const [find, setFind] = useState<FindRequest | null>(null);
  const openFind = useCallback(
    (replace: boolean, prefill: string) => setFind((f) => ({ n: (f?.n ?? 0) + 1, replace, prefill })),
    [],
  );
  const [converting, setConverting] = useState<null | "convert" | "tidy">(null);
  const [bookExport, setBookExport] = useState<BookExportKind | null>(null);
  const [pageViewOn, setPageGuides] = useState(
    () => localStorage.getItem("wf-doc-pageguides") === "on",
  );
  // A manuscript previews as a book instead (Preview book).
  const pageGuides = pageViewOn && meta.format !== "manuscript";
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = useSession((s) => s.phase === "offline");
  // Same as the server editor: swipe right dismisses an open panel.
  const panelSwipe = useSwipe({ onRight: () => setPanel("none") });

  // Settings live in the local Y.Doc's map — persisted inside the full-state
  // save, and carried along when the doc is published to a server.
  const [docSettings, setDocSettings] = useState<DocSettings>(() =>
    readDocSettings(provider!.doc),
  );
  useEffect(() => {
    if (!provider) return;
    return onDocSettingsChange(provider.doc, () =>
      setDocSettings(readDocSettings(provider.doc)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed remount per doc
  }, []);
  const [pageLayout, setPageLayout] = useState<PageLayoutResult | null>(null);
  const specRef = useRef<PageSpec | null>(null);
  const me = useSession((s) => s.session?.user);
  const { book, ref: bookRef } = useBook(provider!.doc, {
    title: meta.title,
    author: me ? (me.display_name ?? me.username) : undefined,
  });
  const format = meta.format;

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
      ...(format === "none" || format === "manuscript" || format === "poetry"
        ? [SmartPunctuation.configure({ quotes: () => quoteStyleFor(bookRef.current.meta.language) })]
        : []),
      ...(format === "manuscript"
        ? [ManuscriptLabels.configure({ getDesign: () => bookRef.current.design }), ManuscriptPaste]
        : []),
      FeedbackHighlights,
      Paginate.configure({ getSpec: () => specRef.current, onLayout: setPageLayout }),
      formatKeymap(format),
      Collaboration.configure({ document: provider!.doc }),
    ],
    // Keyed remount on id/format change; provider is stable while mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    editable: true,
    editorProps: EDITOR_PROPS,
    enableInputRules: inputRulesFor(format),
    enablePasteRules: pasteRulesFor(format),
  });

  const { chapterNumber, chapterLabel, restartNumbersInParts } = book.design;
  useEffect(() => {
    if (format === "manuscript") refreshManuscriptLabels(editor);
  }, [editor, format, chapterNumber, chapterLabel, restartNumbersInParts]);

  // The save indicator: on-device saves report their own state.
  const [saveState, setSaveState] = useState<LocalSaveState>(
    () => provider?.getStatus() ?? { kind: "synced" },
  );
  useEffect(() => {
    if (!provider) return;
    setSaveState(provider.getStatus());
    return provider.subscribe(setSaveState);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed remount per doc
  }, []);
  const indicator: SaveIndicator =
    saveState.kind === "error" ? { kind: "error", message: saveState.message } : saveState;

  const exportItems: ExportItem[] = useMemo(() => {
    const run = (kind: "pdf" | "booklet" | "docx") => async () => {
      if (!editor) return;
      const { exportDocument } = await import("./export");
      await exportDocument(
        editor.getJSON(),
        meta.title,
        meta.format,
        kind,
        meta.format === "none" ? docSettings : undefined,
      );
    };
    return [
      // A manuscript's PDFs come from the book typesetter (below).
      ...(meta.format === "manuscript"
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
      ...(meta.format === "manuscript" && editor
        ? bookExportItems(setBookExport, async () => {
            const { exportSubmissionDocx } = await import("../../book/exportBook");
            await exportSubmissionDocx(editor.getJSON(), "manuscript", bookRef.current);
          })
        : []),
      ...(meta.format === "none"
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
  }, [editor, meta.title, meta.format, docSettings, bookRef]);

  useAutoRevisions(editor, (json) => saveLocalVersion(meta.id, json));

  // Notes-to-self: sidecar threads + the same anchored highlights server
  // docs get. Highlights stay visible outside the panel unless toggled off.
  useEffect(() => {
    const reload = () => void readLocalFeedback(meta.id).then(setThreads);
    reload();
    return onLocalFeedbackChange(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed remount per doc
  }, []);
  // Gated on the toggle alone — the panel-open OR made the highlighter
  // button do nothing visible in the only place it exists.
  useFeedbackDecorations(editor, provider!, threads, highlightsOn);
  // Clicking a highlighted passage opens its note.
  const [threadFocus, setThreadFocus] = useState<ThreadFocus | null>(null);
  useThreadClicks(editor, (id) => {
    setPanel("feedback");
    setThreadFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  });

  // Page view geometry (same contract as the server editor).
  useEffect(() => {
    specRef.current = pageGuides ? pageSpecFor(meta.format, docSettings) : null;
    if (editor) reflowPagination(editor);
  }, [editor, pageGuides, docSettings, meta.format]);

  const sheetStyle = useMemo(() => {
    const vars: Record<string, string> =
      meta.format === "none"
        ? settingsVars(docSettings)
        : meta.format === "manuscript"
          ? manuscriptVars(book)
          : {};
    if (pageGuides && pageLayout) vars["--wfd-fill"] = `${pageLayout.fill}px`;
    return vars as React.CSSProperties;
  }, [meta.format, docSettings, book, pageGuides, pageLayout]);

  // Honor "open with this panel" from the list's Version history entry.
  useEffect(() => {
    const requested = useLocalDocs.getState().pendingPanel;
    if (requested) {
      setPanel(requested);
      useLocalDocs.setState({ pendingPanel: null });
    }
  }, []);

  useFindShortcut(editor, openFind);

  // Reopen where you left off.
  const scrollRef = useRef<HTMLDivElement>(null);
  useReopenPosition(editor, `l:${meta.id}`, scrollRef);
  const { focus, setFocus, typewriter, setTypewriter } = useFocusMode();
  useTypewriterScroll(editor, focus && typewriter);
  const toggleFocus = () => {
    if (!focus) {
      setPanel("none");
      setFind(null);
    }
    setFocus(!focus);
  };

  if (!provider) return null;
  return (
    <div className={`wf-doc-room ${focus ? "focusing" : ""}`}>
      <header className="wf-session-room-header wf-doc-header">
        <button title="Back to documents" onClick={close}>
          ←
        </button>
        <TitleEditor
          title={meta.title}
          canEdit
          onRename={(title) => void rename(meta.id, title)}
        />
        <select
          className="wf-doc-format"
          title="Writing format"
          value={meta.format}
          onChange={(e) => {
            if (meta.format === "none" && e.target.value === "manuscript" && editor) {
              setConverting("convert");
              return;
            }
            void setFormat(meta.id, e.target.value);
          }}
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
        <SyncStatus
          state={indicator}
          where="device"
          actions={[
            { label: "Try Again", primary: true, run: () => void provider.retry() },
            {
              label: "Export a Copy",
              run: () =>
                void exportItems
                  .find((i) => i.label === WORD_EXPORT)
                  ?.run()
                  .catch((e) => setError(String(e))),
            },
          ]}
        />
        <span className="wf-statusbar-spacer" />
        <button
          title="Notes to self"
          className={panel === "feedback" ? "active" : ""}
          onClick={() => setPanel(panel === "feedback" ? "none" : "feedback")}
        >
          <MessageSquare size={16} />
          {threads.filter((t) => !t.resolved).length > 0 && (
            <span className="wf-doc-badge">{threads.filter((t) => !t.resolved).length}</span>
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
        {meta.format === "manuscript" ? (
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
        {meta.format === "manuscript" && (
          <button
            title="Book — details, design, print and ebook settings"
            className={panel === "book" ? "active" : ""}
            onClick={() => setPanel(panel === "book" ? "none" : "book")}
          >
            <BookOpen size={16} />
          </button>
        )}
        {meta.format === "none" && (
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
        <ExportMenu items={exportItems} onError={(e) => setError(String(e))} />
        {!offline && (
          <button title="Share to server…" onClick={() => setShareOpen(true)}>
            <Share2 size={16} />
          </button>
        )}
        <button
          title="Delete (to Recently Deleted)"
          className="wf-danger"
          onClick={() => {
            // To Recently Deleted on this device, with Undo.
            const { id, title } = meta;
            void remove(id)
              .then(() =>
                toast(`Moved “${title}” to Recently Deleted.`, "info", {
                  durationMs: 8000,
                  action: {
                    label: "Undo",
                    run: () =>
                      void useLocalDocs
                        .getState()
                        .restore(id)
                        .then(() => openLocalDoc(id))
                        .catch(() => {}),
                  },
                }),
              )
              .catch((e) => setError(String(e)));
          }}
        >
          <Trash2 size={16} />
        </button>
      </header>

      {error && (
        <p className="wf-connect-error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {focus && (
        <SyncStatus
          state={indicator}
          where="device"
          floating
          actions={[{ label: "Try Again", primary: true, run: () => void provider.retry() }]}
        />
      )}

      {editor && (
        <div className="wf-doc-toolbar">
          <Toolbar
            editor={editor}
            richBlocks={meta.format === "none"}
            typography={meta.format === "none"}
            manuscript={meta.format === "manuscript"}
            allowImages={false}
            leading={<ElementSelect editor={editor} format={meta.format} />}
            trailing={
              <DocumentStats
                editor={editor}
                format={meta.format}
                goalKey={`local:${meta.id}`}
                pagesExact={pageGuides ? (pageLayout?.pages ?? null) : null}
              />
            }
          />
        </div>
      )}

      {find && editor && <FindBar editor={editor} readonly={false} request={find} onClose={() => setFind(null)} />}

      <div className="wf-doc-body" {...panelSwipe}>
        <div className="wf-doc-scroll" ref={scrollRef}>
          <div
            className={`wf-page wf-fmt-${meta.format}`}
            style={sheetStyle}
            data-paged={pageGuides ? "" : undefined}
          >
            {pageGuides && <PageGuides layout={pageLayout} />}
            <EditorContent className="wf-rich editable wf-doc-content" editor={editor} />
          </div>
        </div>
        {panel === "settings" && (
          <DocSettingsPanel
            editor={editor}
            ydoc={provider.doc}
            settings={docSettings}
            readonly={false}
          />
        )}
        {panel === "feedback" && (
          <LocalFeedbackPanel
            focus={threadFocus}
            docId={meta.id}
            editor={editor}
            highlightsOn={highlightsOn}
            onToggleHighlights={() => {
              const next = !highlightsOn;
              setHighlightsOn(next);
              localStorage.setItem("wf-doc-feedback-hl", next ? "on" : "off");
            }}
          />
        )}
        {panel === "preview" && meta.format === "manuscript" && editor && (
          <DockedPreview
            editor={editor}
            format={meta.format}
            book={book}
            onExpand={() => setPreviewOpen(true)}
            onClose={() => setPanel("none")}
            onShowSource={(src) => showBlock(editor, src)}
          />
        )}
        {panel === "book" && meta.format === "manuscript" && editor && (
          <BookInspector
            ydoc={provider.doc}
            book={book}
            readonly={false}
            words={countDocWords(editor.state.doc)}
            chapters={
              scanStructure(editor.state.doc, "manuscript", book.design).entries.filter(
                (e) => e.kind === "chapter",
              ).length
            }
          />
        )}
        {panel === "history" && <LocalHistoryPanel docId={meta.id} editor={editor} />}
        {panel === "outline" && editor && (
          <OutlinePanel
            editor={editor}
            format={meta.format}
            design={book.design}
            commentRanges={() =>
              threads
                .map((t) => resolveThreadRange(editor, t))
                .filter((r): r is { from: number; to: number } => r !== null)
            }
            onNavigate={() => setPanel("none")}
            onTidy={() => setConverting("tidy")}
          />
        )}
      </div>

      {converting && editor && (
        <ConvertDialog
          editor={editor}
          ydoc={provider.doc}
          mode={converting}
          onSwitchFormat={() => setFormat(meta.id, "manuscript")}
          onClose={() => setConverting(null)}
        />
      )}
      {bookExport && editor && (
        <ExportBookDialog
          kind={bookExport}
          editor={editor}
          ydoc={provider.doc}
          book={book}
          format={meta.format}
          readonly={false}
          onShowSource={(src) => {
            setBookExport(null);
            showBlock(editor, src);
          }}
          onClose={() => setBookExport(null)}
        />
      )}
      {previewOpen && editor && meta.format === "manuscript" && (
        <BookPreview
          editor={editor}
          format={meta.format}
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
      {shareOpen && <ShareLocalDialog meta={meta} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
