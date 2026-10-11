import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
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
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Paginate, reflowPagination, type PageLayoutResult, type PageMapFor, type PageSpec } from "../../editor/Paginate";
import { Toolbar } from "../../editor/RichEditor";
import { PasteFormat } from "../../editor/format/paste";
import { RunShortcuts } from "../../editor/format/run";
import { ViewingBar } from "../../editor/review/ChangesList";
import { Suggesting } from "../../editor/review/Suggesting";
import { useReview } from "../../editor/review/useReview";
import { canReadAloud, ReadAloudHighlight } from "../../editor/speech/readAloud";
import { ReadAloudBar } from "../../editor/speech/ReadAloudBar";
import { styleFonts } from "../../editor/styles/sheet";
import { useDocStyles } from "../../editor/styles/useDocStyles";
import { KeyboardDock } from "../../editor/ui/KeyboardDock";
import { LinkBubble } from "../../editor/ui/LinkBubble";
import { NotesList } from "../../editor/ui/NotesList";
import { PasteOptions } from "../../editor/ui/PasteOptions";
import { SelectionBubble } from "../../editor/ui/SelectionBubble";
import { Ribbon } from "../../editor/ui/Ribbon";
import type { FontInfo } from "../../fonts/css";
import { fontKey, noteDocFont, readDocFontTable, replaceDocFont } from "../../fonts/docFonts";
import { MissingFonts } from "../../fonts/ui/MissingFonts";
import { useDocFonts } from "../../fonts/ui/useDocFonts";
import { uploadToDevice } from "../../lib/upload";
import { docContentExtensions } from "../../editor/schema/content";
import { DOC_SCHEMA_LEVEL } from "../../editor/schema/levels";
import { quoteStyleFor, SmartPunctuation } from "../../editor/SmartPunctuation";
import { ManuscriptLabels, refreshManuscriptLabels } from "../../book/editor/manuscriptLabels";
import { ManuscriptPaste } from "../../book/editor/manuscriptPaste";
import { BookInspector } from "../../book/ui/BookInspector";
import { ConvertDialog } from "../../book/ui/ConvertDialog";
import { ExportBookDialog, type BookExportKind } from "../../book/ui/ExportBookDialog";
import { BookPreview } from "../../book/preview/BookPreview";
import { DockedPreview } from "../../book/preview/DockedPreview";
import { bookSource } from "../../book/preview/usePreviewLayout";
import { scriptedAsDocument } from "../../doclayout/scripted";
import { docSource, scriptSource } from "../../doclayout/useDocLayout";
import { exactPageView, usePageMap } from "../../doclayout/usePageMap";
import { scanStructure } from "../../book/model/structure";
import { toast } from "../../platform";
import { useLocalProfile } from "../../stores/localProfile";
import { useSession } from "../../stores/session";
import { useWhenConnected } from "../../stores/whenConnected";
import {
  onDocSettingsChange,
  pageSpecFor,
  readDocSettings,
  settingsVars,
  type DocSettings,
  updateDocSettings,
  type SetupSection,
} from "./docSettings";
import { sideFromFile } from "./compareFile";
import { CompareView, type CompareSide } from "./CompareView";
import { DocSettingsPanel } from "./DocSettingsPanel";
import { DocumentStats, ElementSelect, TitleEditor } from "./DocumentEditor";
import {
  FeedbackHighlights,
  resolveThreadRange,
  useFeedbackDecorations,
  useThreadClicks,
  type FeedbackTab,
  type ThreadFocus,
} from "./FeedbackPanel";
import { onLocalFeedbackChange, readLocalFeedback, type LocalThread } from "./feedbackLocal";
import { LocalFeedbackPanel } from "./LocalFeedbackPanel";
import { useFocusMode, useTypewriterScroll } from "./focus";
import { PageGuides } from "./PageGuides";
import { PrintDialog } from "./PrintDialog";
import { FindBar } from "./FindBar";
import { FORMAT_LABELS, FORMAT_SPECS } from "./formats/elements";
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
import { bookExportItems, canDockPreview, EDITOR_PROPS, inputRulesFor, manuscriptVars, pasteRulesFor, showBlock, useBook, selectedPhrase, useFindShortcut, type FindRequest, usePrintShortcut } from "./shell/hooks";
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
  /** The part of the inspector last asked for by name (the ribbon's
   *  "Custom margins…"); see DocSettingsPanel. */
  const [setupAt, setSetupAt] = useState<{ section: SetupSection; n: number } | null>(null);
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
  /** Publishing needs a server: not connected, it follows the connect sheet. */
  const publish = useWhenConnected(() => setShareOpen(true));
  const [error, setError] = useState<string | null>(null);
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
  // The document's fonts: kept on screen as they come into use, with a
  // note of any this device has to stand in for.
  const [fontTable, setFontTable] = useState(() => readDocFontTable(provider!.doc));
  useEffect(() => {
    if (!provider) return;
    const map = provider.doc.getMap("fonts");
    const onChange = () => setFontTable(readDocFontTable(provider.doc));
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [provider]);
  // Its paragraph styles, and the level of formatting it may use (a
  // document on this device: all of it).
  const docStyles = useDocStyles(provider!.doc, docSettings, DOC_SCHEMA_LEVEL, fontTable);
  const [pageLayout, setPageLayout] = useState<PageLayoutResult | null>(null);
  const specRef = useRef<PageSpec | null>(null);
  // Where the printed pages fall (the layout engine's answer), for page view.
  const pageMapRef = useRef<PageMapFor | "pending" | null>(null);
  const me = useSession((s) => s.session?.user);
  const { book, ref: bookRef } = useBook(provider!.doc, {
    title: meta.title,
    author: me ? (me.display_name ?? me.username) : undefined,
  });
  const format = meta.format;
  const meRef = useRef("Me");

  const extensions = useMemo(
    () => [
      ...docContentExtensions({
        history: false,
        textFormat: { shortcuts: format === "none", alignShortcuts: format === "manuscript" },
        resizeImages: true,
        linkPopup: true,
      }),
      Placeholder.configure({ placeholder: "Write…" }),
      ...(format === "none" || format === "manuscript" || format === "poetry"
        ? [SmartPunctuation.configure({ quotes: () => quoteStyleFor(bookRef.current.meta.language) })]
        : []),
      ...(format === "manuscript"
        ? [ManuscriptLabels.configure({ getDesign: () => bookRef.current.design }), ManuscriptPaste]
        : []),
      FeedbackHighlights,
      ReadAloudHighlight,
      Paginate.configure({ getSpec: () => specRef.current, getMap: () => pageMapRef.current, onLayout: setPageLayout }),
      formatKeymap(format),
      // Editing, Suggesting or Viewing (suggestions are made under the name
      // this device knows you by).
      Suggesting.configure({ author: () => meRef.current }),
      RunShortcuts.configure({ shortcuts: format === "none", context: () => docStyles.formatRef.current }),
      // Pastes from Word and the web are tidied into this document's terms.
      ...(format === "none" ? [PasteFormat.configure({ level: () => DOC_SCHEMA_LEVEL })] : []),
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

  // What the preview shows: a manuscript's book pages, a Document's own.
  // An on-device document is yours: the name this device knows you by,
  // unless a server is saying who you are.
  const localName = useLocalProfile((st) => st.name);
  const author = me?.display_name || me?.username || localName || undefined;
  useEffect(() => {
    meRef.current = author ?? "Me";
  }, [author]);
  // Review: your own mode, and the suggested changes in the text.
  const review = useReview(editor, { storeKey: `local:${meta.id}`, canSuggest: true, readonly: false });
  const [feedbackTab, setFeedbackTab] = useState<FeedbackTab>("comments");
  const [reading, setReading] = useState(false);
  const speaks = useMemo(() => canReadAloud(), []);
  const lang = (meta.format === "manuscript" && book.meta.language) || (typeof navigator !== "undefined" && navigator.language) || "en";
  const [compare, setCompare] = useState<{ before: CompareSide; after: CompareSide } | null>(null);
  const compareWith = (before: CompareSide) => {
    if (editor) setCompare({ before, after: { title: "This document now", doc: editor.getJSON() } });
  };
  const compareFileRef = useRef<HTMLInputElement>(null);
  const tracked = review.items.length > 0;
  const previewSource = useMemo(
    () =>
      meta.format === "manuscript"
        ? bookSource(meta.format, book)
        : meta.format === "none"
          ? docSource(meta.title, author, docSettings, docStyles.overrides)
          : scriptSource(meta.format, meta.title, author),
    [meta.format, book, meta.title, author, docSettings, docStyles.overrides],
  );
  // (Every format has pages to show: a book's, a document's, a script's.)
  const hasPreview = true;
  // Page view shows those same pages — unless this device asks for the
  // simple view (Settings ▸ Writing).
  usePageMap(
    editor,
    pageGuides && exactPageView(),
    (json) =>
      meta.format === "none"
        ? { doc: json, title: meta.title, author, settings: docSettings, styles: docStyles.overrides }
        : { ...scriptedAsDocument(json, meta.format, meta.title), title: meta.title, author },
    [meta.format, meta.title, author, docSettings, docStyles.overrides],
    pageMapRef,
  );
  // Pictures are kept beside the document, on this device.
  const imageUploader = useMemo(() => uploadToDevice(meta.id), [meta.id]);

  // ⌘P: a manuscript prints through its book exports; everything else here.
  const missingFonts = useDocFonts(editor, docSettings.bodyFont, meta.format === "none", styleFonts(docStyles.styles));
  const replaceFont = (from: string, to: string | null, info?: FontInfo) => {
    if (!editor || !provider) return;
    if (to) noteDocFont(provider.doc, to, info);
    replaceDocFont(editor, from, to);
    for (const [id, entry] of Object.entries(docStyles.overrides)) {
      if (entry.props.font === from) docStyles.save(id, { ...entry, props: { ...entry.props, font: to } });
    }
    if (docSettings.bodyFont === from) updateDocSettings(provider.doc, { bodyFont: to });
  };

  const [printOpen, setPrintOpen] = useState(false);
  const [showMarks, setShowMarks] = useState(() => localStorage.getItem("wf-doc-marks") === "on");
  const toggleMarks = () => {
    const next = !showMarks;
    setShowMarks(next);
    localStorage.setItem("wf-doc-marks", next ? "on" : "off");
  };
  const canPrint = meta.format !== "manuscript";
  const openPrint = useCallback(() => setPrintOpen(true), []);
  usePrintShortcut(canPrint && !!editor, openPrint);

  const exportItems: ExportItem[] = useMemo(() => {
    const run = (kind: "pdf" | "booklet" | "docx" | "docx-clean") => async () => {
      if (!editor) return;
      const { exportDocument } = await import("./export");
      await exportDocument(
        editor.getJSON(),
        meta.title,
        meta.format,
        kind,
        meta.format === "none" ? docSettings : undefined,
        docStyles.overrides,
      );
    };
    return [
      // A manuscript's PDFs come from the book typesetter (below).
      ...(meta.format === "manuscript"
        ? []
        : [
            { label: "Print…", title: "Print (⌘P)", run: async () => setPrintOpen(true) },
            { label: "Export PDF", run: run("pdf") },
            {
              label: "Export booklet PDF",
              title: "Pages imposed for saddle stitch: print two-sided (flip on the short edge), then fold in half",
              run: run("booklet"),
            },
          ]),
      { label: WORD_EXPORT, ...(tracked ? { title: "Suggested changes become Word's tracked changes" } : {}), run: run("docx") },
      ...(tracked ? [{ label: "Export Word (clean copy)", title: "The text as it would be with every suggestion accepted", run: run("docx-clean") }] : []),
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
  }, [editor, meta.title, meta.format, docSettings, docStyles.overrides, bookRef, tracked]);

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
    setFeedbackTab("comments");
    setPanel("feedback");
    setThreadFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  });
  const openThreads = threads.filter((t) => !t.resolved).length;
  const pending = openThreads + review.items.length;

  // Page view geometry (same contract as the server editor).
  useEffect(() => {
    specRef.current = pageGuides ? pageSpecFor(meta.format, docSettings) : null;
    if (editor) reflowPagination(editor);
  }, [editor, pageGuides, docSettings, docStyles.css, meta.format]);

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
          onClick={() => {
            // With only suggestions waiting, that is the list to open on.
            if (panel !== "feedback" && !openThreads && review.items.length) setFeedbackTab("changes");
            setPanel(panel === "feedback" ? "none" : "feedback");
          }}
        >
          <MessageSquare size={16} />
          {pending > 0 && (
            <span className="wf-doc-badge" title={`${openThreads} open ${openThreads === 1 ? "note" : "notes"}, ${review.items.length} suggested ${review.items.length === 1 ? "change" : "changes"}`}>
              {pending}
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
        {/* (A Document has this on its Review tab.) */}
        {speaks && meta.format !== "none" && (
          <button title="Read aloud from the caret" className={reading ? "active" : ""} disabled={!editor} onClick={() => setReading(!reading)}>
            <Volume2 size={16} />
          </button>
        )}
        {hasPreview && (
          <button
            title={
              meta.format === "manuscript"
                ? "Preview every page of the book as it will print"
                : "Preview every page as it will print"
            }
            className={panel === "preview" || previewOpen ? "active" : ""}
            disabled={!editor}
            onClick={() => {
              if (canDockPreview()) setPanel(panel === "preview" ? "none" : "preview");
              else setPreviewOpen(true);
            }}
          >
            <Eye size={16} />
          </button>
        )}
        {meta.format !== "manuscript" && (
          <button
            title="Page view: paginate the sheet into real pages"
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
            title="Book: details, design, print and ebook settings"
            className={panel === "book" ? "active" : ""}
            onClick={() => setPanel(panel === "book" ? "none" : "book")}
          >
            <BookOpen size={16} />
          </button>
        )}
        {meta.format === "none" && (
          <button
            title="Document settings: paper, margins, text"
            className={panel === "settings" ? "active" : ""}
            onClick={() => setPanel(panel === "settings" ? "none" : "settings")}
          >
            <SlidersHorizontal size={16} />
          </button>
        )}
        <button
          title={focus ? "Leave focus mode (Esc)" : "Focus mode: just you and the page"}
          className={focus ? "active" : ""}
          onClick={toggleFocus}
        >
          <FocusIcon size={16} />
        </button>
        {focus && (
          <button
            title="Typewriter scrolling: keep the line you're writing centred"
            className={typewriter ? "active" : ""}
            onClick={() => setTypewriter(!typewriter)}
          >
            <MoveVertical size={16} />
          </button>
        )}
        <ExportMenu items={exportItems} onError={(e) => setError(String(e))} />
        <button title="Publish to a server…" onClick={() => publish(null)}>
          <Share2 size={16} />
        </button>
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
          {review.mode === "view" ? (
            <ViewingBar
              review={review}
              trailing={
                speaks ? (
                  <button className="wf-icon" title="Read aloud from the caret" onClick={() => setReading(!reading)}>
                    <Volume2 size={15} />
                  </button>
                ) : undefined
              }
            />
          ) : (
            <KeyboardDock editor={editor}>
              {meta.format === "none" ? (
            <Ribbon
              editor={editor}
              settings={docSettings}
              onPatchSettings={(patch) => updateDocSettings(provider.doc, patch)}
              uploadImage={imageUploader}
              showMarks={showMarks}
              onToggleMarks={toggleMarks}
              fontTable={fontTable}
              onFontUsed={(id, info) => noteDocFont(provider.doc, id, info)}
              format={docStyles.format}
              onSaveStyle={docStyles.save}
              review={review}
              actions={{
                find: () => openFind(false, selectedPhrase(editor)),
                comments: () => {
                  setFeedbackTab("comments");
                  setPanel("feedback");
                },
                changes: () => {
                  setFeedbackTab("changes");
                  setPanel("feedback");
                },
                ...(speaks ? { readAloud: () => setReading(true) } : {}),
                compareFile: () => compareFileRef.current?.click(),
                history: () => setPanel("history"),
                pageSetup: (section) => {
                  // At the part asked for ("Custom margins…" → Margins).
                  if (section) setSetupAt((was) => ({ section, n: (was?.n ?? 0) + 1 }));
                  setPanel("settings");
                },
                preview: () => (canDockPreview() ? setPanel("preview") : setPreviewOpen(true)),
                print: openPrint,
              }}
              trailing={
                <DocumentStats
                  editor={editor}
                  format={meta.format}
                  goalKey={`local:${meta.id}`}
                  pagesExact={pageGuides ? (pageLayout?.pages ?? null) : null}
                />
              }
            />
          ) : (
            <Toolbar
              editor={editor}
              richBlocks={meta.format === "none"}
              typography={meta.format === "none"}
              manuscript={meta.format === "manuscript"}
              allowImages={false}
              leading={
                FORMAT_SPECS[meta.format] ? <ElementSelect editor={editor} format={meta.format} /> : undefined
              }
              trailing={
                <DocumentStats
                  editor={editor}
                  format={meta.format}
                  goalKey={`local:${meta.id}`}
                  pagesExact={pageGuides ? (pageLayout?.pages ?? null) : null}
                />
              }
            />
              )}
            </KeyboardDock>
          )}
          {meta.format === "none" && editor && (
            <MissingFonts
              missing={missingFonts}
              docFonts={[...new Set([...fontKey(editor).split("|").filter(Boolean), ...styleFonts(docStyles.styles)])]}
              docTable={fontTable}
              onReplace={replaceFont}
            />
          )}
        </div>
      )}

      {find && editor && <FindBar editor={editor} readonly={review.mode === "view"} request={find} onClose={() => setFind(null)} />}
      {editor && <LinkBubble editor={editor} />}
      {editor && <PasteOptions editor={editor} />}
      {editor && (
        <SelectionBubble
          editor={editor}
          format={meta.format === "none" ? docStyles.format : null}
          onComment={() => {
            setFeedbackTab("comments");
            setPanel("feedback");
          }}
        />
      )}
      {reading && editor && <ReadAloudBar editor={editor} lang={lang} onClose={() => setReading(false)} />}
      <input
        ref={compareFileRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void sideFromFile(file).then(compareWith).catch((err) => setError(`That file couldn't be read: ${String(err)}`));
        }}
      />

      <div className="wf-doc-body" {...panelSwipe}>
        <div className="wf-doc-scroll" ref={scrollRef}>
          <div
            className={`wf-page wf-fmt-${meta.format}${showMarks && meta.format === "none" ? " wf-show-marks" : ""}${review.mode === "view" ? " wf-rev-final" : ""}`}
            style={sheetStyle}
            data-paged={pageGuides ? "" : undefined}
            data-wfs={docStyles.scope}
          >
            {/* The styles this document has changed (see editor/styles/css.ts). */}
            {meta.format === "none" && docStyles.css && <style>{docStyles.css}</style>}
            {pageGuides && <PageGuides layout={pageLayout} />}
            <EditorContent className="wf-rich editable wf-doc-content" editor={editor} />
          </div>
          {/* Its footnotes and endnotes, where they can be seen and changed. */}
          {editor && <NotesList editor={editor} style={sheetStyle} />}
        </div>
        {panel === "settings" && (
          <DocSettingsPanel
            editor={editor}
            ydoc={provider.doc}
            settings={docSettings}
            readonly={false}
            format={docStyles.format}
            at={setupAt}
          />
        )}
        {panel === "feedback" && (
          <LocalFeedbackPanel
            focus={threadFocus}
            docId={meta.id}
            editor={editor}
            review={review}
            tab={feedbackTab}
            onTab={setFeedbackTab}
            highlightsOn={highlightsOn}
            onToggleHighlights={() => {
              const next = !highlightsOn;
              setHighlightsOn(next);
              localStorage.setItem("wf-doc-feedback-hl", next ? "on" : "off");
            }}
          />
        )}
        {panel === "preview" && hasPreview && editor && (
          <DockedPreview
            editor={editor}
            source={previewSource}
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
        {panel === "history" && <LocalHistoryPanel docId={meta.id} editor={editor} onCompare={compareWith} />}
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
      {previewOpen && editor && hasPreview && (
        <BookPreview
          editor={editor}
          source={previewSource}
          onClose={() => setPreviewOpen(false)}
          onShowSource={(src) => {
            setPreviewOpen(false);
            setPanel("none");
            showBlock(editor, src);
          }}
          onExport={() => {
            setPreviewOpen(false);
            if (meta.format === "manuscript") setBookExport("paperback");
            else void exportItems.find((item) => item.label === "Export PDF")?.run();
          }}
        />
      )}
      {printOpen && editor && canPrint && (
        <PrintDialog
          title={meta.title}
          build={async (booklet) => {
            const { buildPrintable } = await import("./export");
            return buildPrintable(
              editor.getJSON(),
              meta.title,
              meta.format,
              meta.format === "none" ? docSettings : undefined,
              booklet,
              docStyles.overrides,
            );
          }}
          onClose={() => setPrintOpen(false)}
        />
      )}
      {compare && <CompareView before={compare.before} after={compare.after} onClose={() => setCompare(null)} />}
      {shareOpen && <ShareLocalDialog meta={meta} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
