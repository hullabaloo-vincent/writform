import Collaboration from "@tiptap/extension-collaboration";
import { NoteNumbers, numberingOf, refreshNoteNumbers } from "../../editor/nodes/NoteNumbers";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  BookOpen,
  Search,
  Eye,
  Focus as FocusIcon,
  History,
  LayoutGrid,
  ListTree,
  MessageSquare,
  MoveVertical,
  Presentation,
  Share2,
  SlidersHorizontal,
  SpellCheck,
  SquareSplitVertical,
  Trash2,
  Volume2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { isCmdError, isWeb } from "../../lib/backend";
import { useSwipe } from "../../lib/useSwipe";
import { readingTime } from "../../lib/wordCount";
import { loadGoal, noteGoalProgress, saveGoal } from "../../lib/writingGoals";
import { confirmDialog, toast } from "../../platform";
import { Avatar } from "../../platform/Avatar";
import { useSession } from "../../stores/session";
import { Paginate, reflowPagination, type PageMapFor, type PageSpec } from "../../editor/Paginate";
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
import { SERVER_PICTURE_BYTES, uploadToServer } from "../../lib/upload";
import { docContentExtensions } from "../../editor/schema/content";
import { SchemaGuard } from "../../editor/schema/guard";
import { quoteStyleFor, SmartPunctuation } from "../../editor/SmartPunctuation";
import { ManuscriptLabels, refreshManuscriptLabels } from "../../book/editor/manuscriptLabels";
import { ManuscriptPaste } from "../../book/editor/manuscriptPaste";
import { chapterArtSource } from "../../book/editor/chapterArt";
import { BookInspector } from "../../book/ui/BookInspector";
import type { CoverPictures } from "../../book/ui/Cover";
import { pagesKey, usePrintedPages } from "../../book/ui/printedPages";
import { chapterFocus, focusEntry } from "../../editor/ChapterFocus";
import { ChapterIdGuard } from "../../editor/nodes/ChapterId";
import { showRange } from "../../editor/ui/reveal";
import { knowsChapter } from "../../plan/planMap";
import { hasPlan } from "../../plan/resolve";
import type { PlanTab } from "../../plan/ui/PlanView";
import { CoverEditor } from "../../book/ui/CoverEditor";
import { ConvertDialog } from "../../book/ui/ConvertDialog";
import { ExportBookDialog, type BookExportKind } from "../../book/ui/ExportBookDialog";
import { BookPreview } from "../../book/preview/BookPreview";
import { DockedPreview } from "../../book/preview/DockedPreview";
import { bookSource } from "../../book/preview/usePreviewLayout";
import { scriptedAsDocument } from "../../doclayout/scripted";
import { docSource, scriptSource } from "../../doclayout/useDocLayout";
import { exactPageView, usePageMap } from "../../doclayout/usePageMap";
import type { Book } from "../../book/model/bookMap";
import { scanStructure } from "../../book/model/structure";
import { estimatePages } from "../../book/model/trims";
import { documentsApi } from "./api";
import { b64encode, type DocProvider } from "./collab";
import { sideFromFile } from "./compareFile";
import { CompareView, type CompareSide } from "./CompareView";
import {
  onDocSettingsChange,
  pageSpecFor,
  readDocSettings,
  settingsVars,
  type DocSettings,
  updateDocSettings,
  type SetupSection,
} from "./docSettings";
import { DocSettingsPanel } from "./DocSettingsPanel";
import { FORMAT_LABELS, FORMAT_SPECS, type ElementSpec } from "./formats/elements";
import { formatKeymap } from "./formats/FormatKeymap";
import {
  FeedbackPanel,
  FeedbackHighlights,
  resolveThreadRange,
  useFeedbackDecorations,
  useThreadClicks,
  type FeedbackTab,
  type ThreadFocus,
} from "./FeedbackPanel";
import { useFocusMode, useTypewriterScroll } from "./focus";
import { useAutoRevisions } from "./history";
import { useDocCard } from "./useDocCard";
import { FindBar } from "./FindBar";
import { ExportPdfDialog } from "./ExportPdfDialog";
import { PrintDialog } from "./PrintDialog";
import { useLocalDocs } from "./local";
import { OutlinePanel } from "./OutlinePanel";
import { SendToCanvasDialog } from "./SendToCanvasDialog";
import { countDocWords, countRangeWords } from "./stats";
import { ExportMenu, WORD_EXPORT, type ExportItem } from "./shell/ExportMenu";
import { CommandKeys } from "../../editor/commands/CommandKeys";
import type { CommandCtx, ShellActions } from "../../editor/commands/run";
import { useEditorCommands } from "../../editor/commands/useEditorCommands";
import { autoCorrect } from "../../editor/autocorrect/AutoCorrect";
import { capitalsHere } from "../../editor/autocorrect/where";
import { EditPlaces } from "../../editor/EditPlaces";
import { refreshTabStops, styleTabStops, TabStops } from "../../editor/format/TabStops";
import { ChapterFocus } from "../../editor/ChapterFocus";
import { ChapterBar, useChapterFocus } from "./ChapterBar";
import { Ruler, useRulerShown } from "../../editor/ui/Ruler";
import { useIsPhone } from "../../editor/ui/Flyout";
import { HeaderTools } from "./shell/HeaderTools";
import { useFillsPhone } from "../../platform/registry";
import { FormatMarks, refreshFormatMarks } from "../../editor/FormatMarks";
import { useDarkPaper, useDarkPaperCss } from "../../editor/ui/darkPaper";
import { ListStarts } from "../../editor/format/listStarts";
import { WordMarks } from "../../editor/format/wordMark";
import { GoToBox } from "./GoToBox";
import type { PageSource } from "./goTo";
import { ZoomControl } from "./shell/ZoomControl";
import { ZoomFrame } from "./shell/ZoomFrame";
import { bookExportItems, canDockPreview, EDITOR_PROPS, inputRulesFor, manuscriptVars, pasteRulesFor, showBlock, textLanguage, useBook, selectedPhrase, useCheckShortcut, useFindShortcut, type FindRequest, useServerSyncState, usePrintShortcut } from "./shell/hooks";
import { useReopenPosition } from "./shell/position";
import { SyncStatus, type SaveAction } from "./shell/SyncStatus";
import { openServerDoc } from "./navigation";
import { activeProvider, useDocuments } from "./store";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { ShareDialog } from "./ShareDialog";
import { withKeys, keyLabel } from "../../editor/commands/catalog";

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

// The checker and its word lists are fetched when its panel first opens.
const ProofPanel = lazy(() => import("../../proof/ui/ProofPanel").then((m) => ({ default: m.ProofPanel })));
// So is the story plan, when it is first opened.
const PlanView = lazy(() => import("../../plan/ui/PlanView").then((m) => ({ default: m.PlanView })));
const PlanPanel = lazy(() => import("../../plan/ui/PlanPanel").then((m) => ({ default: m.PlanPanel })));

type Panel = "none" | "history" | "feedback" | "outline" | "settings" | "book" | "preview" | "check" | "plan";

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
  /** The part of the inspector last asked for by name (the ribbon's
   *  "Custom margins…"); see DocSettingsPanel. */
  const [setupAt, setSetupAt] = useState<{ section: SetupSection; n: number } | null>(null);
  const openFind = useCallback(
    (replace: boolean, prefill: string) => setFind((f) => ({ n: (f?.n ?? 0) + 1, replace, prefill })),
    [],
  );
  const [converting, setConverting] = useState<null | "convert" | "tidy">(null);
  const [bookExport, setBookExport] = useState<BookExportKind | null>(null);
  const [coverOpen, setCoverOpen] = useState(false);
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
  // The document's fonts: kept on screen as they come into use, with a
  // note of any this device has to stand in for.
  const [fontTable, setFontTable] = useState(() => readDocFontTable(provider.doc));
  useEffect(() => {
    const map = provider.doc.getMap("fonts");
    const onChange = () => setFontTable(readDocFontTable(provider.doc));
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [provider]);
  // Its paragraph styles, and the level of formatting it may use (the
  // lower of this app's and its server's).
  const docStyles = useDocStyles(provider.doc, docSettings, provider.level, fontTable);
  // How many pages page view shows. (The gaps between them are the
  // paginator's own drawing, on the sheet: nothing here is rendered again
  // as the text moves across them.)
  const [pagesExact, setPagesExact] = useState<number | null>(null);
  const specRef = useRef<PageSpec | null>(null);
  // Where the printed pages fall (the layout engine's answer), for page view.
  const pageMapRef = useRef<PageMapFor | "pending" | null>(null);
  // The book's details and design (Y.Map "book"): the manuscript view's
  // fonts, ornaments and chapter labels come from it.
  const { book, ref: bookRef } = useBook(provider.doc, { title: meta.title, author: state.me });
  // Whose suggestions this person's are.
  const meRef = useRef(state.me);
  useEffect(() => {
    meRef.current = state.me;
  }, [state.me]);
  // The language of the text (see `textLanguage`): the spell checker, the
  // quote marks typed, the Check panel and reading aloud all go by it.
  const lang = textLanguage(format, book, docSettings);
  const langRef = useRef(lang);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);
  // How far apart the tab stops a paragraph doesn't set are (points).
  const tabEveryRef = useRef(docSettings.tabStop * 72);
  tabEveryRef.current = docSettings.tabStop * 72;

  // The document as the editor's commands find it (set further down, once
  // everything they need is known).
  const commandCtxRef = useRef<CommandCtx | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  // Whether formatting marks are shown (the switch is further down).
  const marksOnRef = useRef(localStorage.getItem("wf-doc-marks") === "on");
  const darkPaper = useDarkPaper((st) => st.dark);

  const extensions = useMemo(
    () => [
      ...docContentExtensions({
        history: false,
        textFormat: { shortcuts: format === "none", alignShortcuts: format === "manuscript" },
        resizeImages: true,
        linkPopup: true,
      }),
      Placeholder.configure({ placeholder: "Write…" }),
      formatKeymap(format),
      ...(format === "none" || format === "manuscript" || format === "poetry"
        ? [SmartPunctuation.configure({ quotes: () => quoteStyleFor(langRef.current) })]
        : []),
      ...(format === "manuscript"
        ? [ManuscriptLabels.configure({ getDesign: () => bookRef.current.design }), ManuscriptPaste]
        : []),
      // Where the text was last changed, to go back to.
      EditPlaces,
      // One chapter shown on its own, when asked for.
      ChapterFocus.configure({
        format: () => format,
        design: () => (format === "manuscript" ? bookRef.current.design : undefined),
        onLost: () => toast("The heading of the chapter shown is gone. Showing the whole text.", "info"),
      }),
      // Tab stops: each tab given the width that takes it to its stop.
      ...(format === "none" ? [TabStops.configure({ every: () => tabEveryRef.current, lang: () => langRef.current, styleStops: (node) => styleTabStops(node, docStyles.formatRef.current?.styles) })] : []),
      // A sign over each space, tab and line break, while marks are shown.
      ...(format === "none" ? [FormatMarks.configure({ on: () => marksOnRef.current })] : []),
      // Bold, italic and underline act on the word the caret is in.
      WordMarks,
      // Slips set right and sentences given their capital, as a word is finished.
      ...autoCorrect({
        lang: () => langRef.current,
        capitals: (block) => capitalsHere(format, block),
        raise: () => format === "none" && (docStyles.formatRef.current?.level ?? 1) >= 2,
      }),
      // "1) ", "a. " and "i. " start a numbered list, as "1. " does.
      ...(format === "none" ? [ListStarts] : []),
      // The keys the command list binds itself (moving a paragraph, …).
      CommandKeys.configure({ ctx: () => commandCtxRef.current }),
      NoteNumbers.configure({
        numbering: () => numberingOf(commandCtxRef.current?.settings),
        pageLabels: () => {
          const map = pageMapRef.current;
          return map && map !== "pending" ? (map.notes ?? null) : null;
        },
      }),
      FeedbackHighlights,
      ReadAloudHighlight,
      Paginate.configure({ getSpec: () => specRef.current, getMap: () => pageMapRef.current, onLayout: (layout) => setPagesExact(layout ? layout.pages : null) }),
      // Hold edits to what this server can store (a paste from a newer
      // document is down-converted).
      SchemaGuard.configure({ level: () => provider.level }),
      // One heading per chapter id (the story plan's tie to a chapter).
      ChapterIdGuard.configure({ known: (cid) => knowsChapter(provider.doc, cid) }),
      // Editing, Suggesting or Viewing — this person's own choice.
      Suggesting.configure({ author: () => meRef.current }),
      RunShortcuts.configure({ shortcuts: format === "none", context: () => docStyles.formatRef.current }),
      // Pastes from Word and the web are tidied into this document's terms.
      ...(format === "none" ? [PasteFormat.configure({ level: () => provider.level })] : []),
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

  // Word goals are per-device; the key carries the server so ids don't mix.
  const addr = useSession((s) => s.session?.addr);
  const goalKey = `${addr ?? "server"}:${meta.id}`;
  // Review: this person's mode (it also says whether the text can be
  // edited at all) and the suggested changes. Suggesting needs a server
  // that can store them.
  const review = useReview(editor, { storeKey: goalKey, canSuggest: docStyles.format.level >= 2, readonly });
  const [feedbackTab, setFeedbackTab] = useState<FeedbackTab>("comments");
  const [reading, setReading] = useState(false);
  const speaks = useMemo(() => canReadAloud(), []);
  const [compare, setCompare] = useState<{ before: CompareSide; after: CompareSide } | null>(null);
  // The story plan: the whole of it over the page, and whose mentions the
  // side panel steps through.
  const [planOpen, setPlanOpen] = useState<{ tab: PlanTab; at?: { column?: string; card?: string; entry?: string } } | null>(null);
  const [planMentions, setPlanMentions] = useState<string | null>(null);
  const planned = hasPlan(format);
  const compareWith = (before: CompareSide) => {
    if (editor) setCompare({ before, after: { title: "This document now", doc: editor.getJSON() } });
  };
  const compareFileRef = useRef<HTMLInputElement>(null);
  const openThreads = state.threads.filter((t) => !t.resolved).length;
  const pending = openThreads + review.items.length;
  const tracked = review.items.length > 0;

  // A change of numbering style or label word re-labels the chapters.
  const { chapterNumber, chapterLabel, restartNumbersInParts } = book.design;
  useEffect(() => {
    if (format === "manuscript") refreshManuscriptLabels(editor);
  }, [editor, format, chapterNumber, chapterLabel, restartNumbersInParts]);

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
  useDocCard({
    doc: provider.doc,
    format,
    canWrite: !readonly,
    upload: uploadToServer,
    send: (card, media) => documentsApi.setCard(meta.id, card, media),
  });
  const phone = useIsPhone();
  // Gated on the toggle alone: the panel-open OR made the highlighter
  // button a no-op in the only place it exists (the open panel).
  useFeedbackDecorations(editor, provider, state.threads, highlightsOn);
  // Clicking a highlighted passage opens its thread.
  const [threadFocus, setThreadFocus] = useState<ThreadFocus | null>(null);
  useThreadClicks(editor, (id) => {
    setFeedbackTab("comments");
    setPanel("feedback");
    setThreadFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  });

  // Page view geometry: recompute whenever settings, format, or the toggle
  // change; the plugin re-measures on its own for edits and resizes.
  useEffect(() => {
    specRef.current = pageGuides ? pageSpecFor(format, docSettings) : null;
    if (editor) reflowPagination(editor);
  }, [editor, pageGuides, docSettings, docStyles.css, format]);

  const sheetStyle = useMemo(() => {
    const vars: Record<string, string> =
      format === "none"
        ? settingsVars(docSettings)
        : format === "manuscript"
          ? manuscriptVars(book)
          : {};
    return vars as React.CSSProperties;
  }, [format, docSettings, book]);

  // Cmd/Ctrl+F opens find-in-document while the editor view is up.
  useFindShortcut(editor, openFind);
  // F7 opens the Check panel, and closes it.
  useCheckShortcut(() => setPanel(panel === "check" ? "none" : "check"));

  // What the preview shows: a manuscript's book pages, a Document's own.
  const author = useSession((st) => st.session?.user.display_name || st.session?.user.username || undefined);
  const previewSource = useMemo(
    () =>
      format === "manuscript"
        ? bookSource(format, book)
        : format === "none"
          ? docSource(meta.title, author, docSettings, docStyles.overrides)
          : scriptSource(format, meta.title, author),
    [format, book, meta.title, author, docSettings, docStyles.overrides],
  );
  // (Every format has pages to show: a book's, a document's, a script's.)
  const hasPreview = true;
  // Page view shows those same pages — unless this device asks for the
  // simple view (Settings ▸ Writing).
  usePageMap(
    editor,
    pageGuides && exactPageView(),
    (json) =>
      format === "none"
        ? { doc: json, title: meta.title, author, settings: docSettings, styles: docStyles.overrides }
        : { ...scriptedAsDocument(json, format, meta.title), title: meta.title, author },
    [format, meta.title, author, docSettings, docStyles.overrides],
    pageMapRef,
  );

  // A book's cover artwork is kept where its pictures are, and its cover
  // sheet is sized for the pages the layout engine counts.
  const coverPictures = useMemo<CoverPictures>(() => ({ upload: uploadToServer, limit: SERVER_PICTURE_BYTES }), []);
  const countBookPages = useCallback(async () => {
    if (!editor) return null;
    const { countBookPages: count } = await import("../../book/cover/files");
    return count(editor.getJSON(), "manuscript", bookRef.current);
  }, [editor, bookRef]);
  // (The toolbar counts on a channel of its own, so the two never overtake each other.)
  const countStatsPages = useCallback(async () => {
    if (!editor) return null;
    const { countBookPages: count } = await import("../../book/cover/files");
    return count(editor.getJSON(), "manuscript", bookRef.current, "stats-pages");
  }, [editor, bookRef]);
  // ⌘P: a manuscript prints through its book exports; everything else here.
  const missingFonts = useDocFonts(editor, docSettings.bodyFont, format === "none", styleFonts(docStyles.styles));
  const replaceFont = (from: string, to: string | null, info?: FontInfo) => {
    if (!editor) return;
    if (to) noteDocFont(provider.doc, to, info);
    replaceDocFont(editor, from, to);
    for (const [id, entry] of Object.entries(docStyles.overrides)) {
      if (entry.props.font === from) docStyles.save(id, { ...entry, props: { ...entry.props, font: to } });
    }
    if (docSettings.bodyFont === from) updateDocSettings(provider.doc, { bodyFont: to });
  };

  const [printOpen, setPrintOpen] = useState(false);
  const [pdfExport, setPdfExport] = useState(false);
  const [showMarks, setShowMarks] = useState(() => localStorage.getItem("wf-doc-marks") === "on");
  const toggleMarks = () => {
    const next = !showMarks;
    setShowMarks(next);
    localStorage.setItem("wf-doc-marks", next ? "on" : "off");
    marksOnRef.current = next;
    refreshFormatMarks(editor);
  };
  const canPrint = format !== "manuscript";
  const openPrint = useCallback(() => setPrintOpen(true), []);
  usePrintShortcut(canPrint && !!editor, openPrint);

  const exportItems: ExportItem[] = useMemo(() => {
    const run = (kind: "pdf" | "booklet" | "docx" | "docx-clean") => async () => {
      if (!editor) return;
      const { exportDocument } = await import("./export");
      await exportDocument(
        editor.getJSON(),
        meta.title,
        format,
        kind,
        format === "none" ? docSettings : undefined,
        docStyles.overrides,
      );
    };
    return [
      // A manuscript's PDFs come from the book typesetter (below).
      ...(format === "manuscript"
        ? []
        : [
            { label: "Print…", title: withKeys("Print", "Mod-p"), run: async () => setPrintOpen(true) },
            { label: "Export PDF…", title: "Choose what goes into the file, then save it", run: async () => setPdfExport(true) },
            {
              label: "Export booklet PDF",
              title: "Pages imposed for saddle stitch: print two-sided (flip on the short edge), then fold in half",
              run: run("booklet"),
            },
          ]),
      { label: WORD_EXPORT, ...(tracked ? { title: "Suggested changes become Word's tracked changes" } : {}), run: run("docx") },
      ...(tracked ? [{ label: "Export Word (clean copy)", title: "The text as it would be with every suggestion accepted", run: run("docx-clean") }] : []),
      ...(format === "manuscript" && editor
        ? bookExportItems(setBookExport, async () => {
            const { exportSubmissionDocx } = await import("../../book/exportBook");
            await exportSubmissionDocx(editor.getJSON(), "manuscript", bookRef.current);
          }, () => setCoverOpen(true))
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
  }, [editor, meta.title, format, docSettings, docStyles.overrides, readonly, bookRef, tracked]);

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
  // On a phone the document has the whole screen.
  useFillsPhone();
  useTypewriterScroll(editor, focus && typewriter);
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

  // What this room can do when asked by name: the editor's commands are in
  // the command palette (⌘K) for as long as the document is open.
  const shellActions: ShellActions = {
    find: (replace) => {
      if (editor) openFind(replace, selectedPhrase(editor));
    },
    comments: () => {
      setFeedbackTab("comments");
      setPanel("feedback");
    },
    changes: () => {
      setFeedbackTab("changes");
      setPanel("feedback");
    },
    check: () => setPanel("check"),
    history: () => setPanel("history"),
    ...(planned
      ? {
          plan: (tab: PlanTab = "board") => setPlanOpen({ tab }),
          planPanel: () => setPanel("plan"),
        }
      : {}),
    toggleFocus,
    goTo: () => setGoToOpen(true),
    ...(speaks ? { readAloud: () => setReading(true) } : {}),
    ...(hasPreview ? { preview: () => (canDockPreview() ? setPanel("preview") : setPreviewOpen(true)) } : {}),
    ...(canPrint ? { print: openPrint } : {}),
    ...(format !== "manuscript"
      ? {
          togglePageView: () => {
            const next = !pageViewOn;
            setPageGuides(next);
            localStorage.setItem("wf-doc-pageguides", next ? "on" : "off");
          },
        }
      : {}),
    ...(format === "none"
      ? {
          toggleMarks,
          compareFile: () => compareFileRef.current?.click(),
          pageSetup: (section?: SetupSection) => {
            if (section) setSetupAt((was) => ({ section, n: (was?.n ?? 0) + 1 }));
            setPanel("settings");
          },
        }
      : {}),
  };
  // Go to: a document's and a script's pages are worked out on asking when
  // page view is not showing them. A book's are its own (see its preview).
  const askPages: PageSource | null =
    format === "manuscript"
      ? null
      : async (json) => {
          const { docPageMap } = await import("../../doclayout/exportDoc");
          const map = await docPageMap(
            format === "none"
              ? { doc: json, title: meta.title, author, settings: docSettings, styles: docStyles.overrides }
              : { ...scriptedAsDocument(json, format, meta.title), title: meta.title, author },
            "goto",
          );
          return map ? { pages: map.pages, starts: map.starts } : null;
        };
  const paperCss = useDarkPaperCss(editor, darkPaper);
  const commandCtx: CommandCtx = {
    format: format,
    rich: format === "none" ? docStyles.format : null,
    editable: !!editor && editor.isEditable,
    lang,
    settings: docSettings,
    patchSettings: (patch) => updateDocSettings(provider.doc, patch),
    review,
    shell: shellActions,
  };
  useEffect(() => {
    commandCtxRef.current = commandCtx;
  });
  useEditorCommands(editor, commandCtx);
  // Notes numbered as the document says, once it says so.
  useEffect(() => refreshNoteNumbers(editor), [editor, docSettings.fnFormat, docSettings.enFormat, docSettings.fnRestart]);
  // The stops every so often moved: the tabs are measured again.
  useEffect(() => {
    if (editor && !editor.isDestroyed) refreshTabStops(editor.view);
  }, [editor, docSettings.tabStop]);
  const chapterShown = useChapterFocus(editor);
  // The ruler over the page (desktop, Documents, when asked for).
  const rulerOn = useRulerShown((st) => st.on);
  const rulerPhone = useIsPhone();

  const formatSelect = (
    <select
      className="wf-doc-format"
      title="Writing format"
      value={format}
      disabled={readonly}
      onChange={(e) => {
        // Document → Manuscript offers to turn the text's structure into
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
  );

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
        {!phone && formatSelect}
        {!readonly && <SyncStatus state={sync} where="server" actions={syncActions} />}
        <span className="wf-statusbar-spacer" />
        <Peers provider={provider} />
        <HeaderTools
          lead={
            phone ? (
              <label className="wf-head-format">
                <span>Format</span>
                {formatSelect}
              </label>
            ) : null
          }
        >
          <button
            title="Feedback" data-label="Feedback"
            className={panel === "feedback" ? "active" : ""}
            onClick={() => {
              const next = panel === "feedback" ? "none" : "feedback";
              // With only suggestions waiting, that is the list to open on.
              if (next === "feedback" && !openThreads && review.items.length) setFeedbackTab("changes");
              setPanel(next);
              localStorage.setItem("wf-doc-feedback", next === "feedback" ? "on" : "off");
            }}
          >
            <MessageSquare size={16} />
            {pending > 0 && (
              <span className="wf-doc-badge" title={`${openThreads} open ${openThreads === 1 ? "comment" : "comments"}, ${review.items.length} suggested ${review.items.length === 1 ? "change" : "changes"}`}>
                {pending}
              </span>
            )}
          </button>
          <button
            title="Document history" data-label="History"
            className={panel === "history" ? "active" : ""}
            onClick={() => setPanel(panel === "history" ? "none" : "history")}
          >
            <History size={16} />
          </button>
          <button
            title={withKeys("Find and replace", "Mod-f")} data-label="Find and replace"
            className={find ? "active" : ""}
            disabled={!editor}
            onClick={() => (find ? setFind(null) : openFind(false, selectedPhrase(editor)))}
          >
            <Search size={16} />
          </button>
          <button
            title="Outline" data-label="Outline"
            className={panel === "outline" ? "active" : ""}
            onClick={() => setPanel(panel === "outline" ? "none" : "outline")}
          >
            <ListTree size={16} />
          </button>
          {planned && (
            <button
              title={withKeys("Story plan", "Alt-Mod-p")} data-label="Plan"
              className={panel === "plan" || planOpen ? "active" : ""}
              disabled={!editor}
              onClick={() => (phone ? setPlanOpen({ tab: "board" }) : setPanel(panel === "plan" ? "none" : "plan"))}
            >
              <LayoutGrid size={16} />
            </button>
          )}
          <button
            title="Check the text for slips and for things written two ways (F7)" data-label="Check"
            className={panel === "check" ? "active" : ""}
            disabled={!editor}
            onClick={() => setPanel(panel === "check" ? "none" : "check")}
          >
            <SpellCheck size={16} />
          </button>
          {/* (A Document has this on its Review tab.) */}
          {speaks && format !== "none" && (
            <button title="Read aloud from the caret" data-label="Read aloud" className={reading ? "active" : ""} disabled={!editor} onClick={() => setReading(!reading)}>
              <Volume2 size={16} />
            </button>
          )}
          {hasPreview && (
            <button
              title={
                format === "manuscript"
                  ? "Preview every page of the book as it will print"
                  : "Preview every page as it will print"
              }
              className={panel === "preview" || previewOpen ? "active" : ""}
              data-label="Preview"
              disabled={!editor}
              onClick={() => {
                if (canDockPreview()) setPanel(panel === "preview" ? "none" : "preview");
                else setPreviewOpen(true);
              }}
            >
              <Eye size={16} />
            </button>
          )}
          {format !== "manuscript" && (
            <button
              title="Page view: paginate the sheet into real pages" data-label="Page view"
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
              title="Book: details, design, print and ebook settings" data-label="Book"
              className={panel === "book" ? "active" : ""}
              onClick={() => setPanel(panel === "book" ? "none" : "book")}
            >
              <BookOpen size={16} />
            </button>
          )}
          {format === "none" && (
            <button
              title="Document settings: paper, margins, text" data-label="Document settings"
              className={panel === "settings" ? "active" : ""}
              onClick={() => setPanel(panel === "settings" ? "none" : "settings")}
            >
              <SlidersHorizontal size={16} />
            </button>
          )}
          <button
            title={focus ? "Leave focus mode (Esc)" : "Focus mode: just you and the page"}
              data-label={focus ? "Leave focus mode" : "Focus mode"}
            className={focus ? "active" : ""}
            onClick={toggleFocus}
          >
            <FocusIcon size={16} />
          </button>
          {focus && (
            <button
              title="Typewriter scrolling: keep the line you're writing centered" data-label="Typewriter scrolling"
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
          <button title="Send to canvas" data-label="Send to canvas" onClick={() => state.setCanvasOpen(true)}>
            <Presentation size={16} />
          </button>
          {myAccess === "owner" && (
            <button title="Share" data-label="Share" onClick={() => state.setShareOpen(true)}>
              <Share2 size={16} />
            </button>
          )}
          {myAccess === "owner" && (
            <button
              title="Delete document" data-label="Delete"
              className="wf-danger"
              onClick={() => void deleteThis()}
            >
              <Trash2 size={16} />
            </button>
          )}
        </HeaderTools>
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
              {format === "none" ? (
            <Ribbon
              editor={editor}
              settings={docSettings}
              onPatchSettings={(patch) => updateDocSettings(provider.doc, patch)}
              uploadImage={uploadToServer}
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
                check: () => setPanel("check"),
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
                <>
                <ZoomControl ruler />
                <DocumentStats
                  editor={editor}
                  format={format}
                  goalKey={goalKey}
                  pagesExact={pageGuides ? pagesExact : null}
                  pageInches={pageSpecFor(format, docSettings).h}
                  onGoTo={() => setGoToOpen(true)}
                />
                </>
              }
            />
          ) : (
            <Toolbar
              editor={editor}
              richBlocks={format === "none"}
              typography={format === "none"}
              manuscript={format === "manuscript"}
              leading={
                FORMAT_SPECS[format] ? (
                  <>
                    <ElementSelect editor={editor} format={format} />
                    {format === "screenplay" && (
                      <span className="wf-doc-shortcuts" title="Screenplay element shortcuts">
                        Tab cycles · {keyLabel("Mod-1")}–6 selects
                      </span>
                    )}
                  </>
                ) : undefined
              }
              trailing={
                <>
                <ZoomControl />
                <DocumentStats
                  editor={editor}
                  format={format}
                  goalKey={goalKey}
                  pagesExact={pageGuides ? pagesExact : null}
                  pageInches={pageSpecFor(format, docSettings).h}
                  book={format === "manuscript" ? book : undefined}
                  countPages={countStatsPages}
                  onGoTo={() => setGoToOpen(true)}
                />
                </>
              }
            />
              )}
            </KeyboardDock>
          )}
          {format === "none" && editor && (
            <MissingFonts
              missing={missingFonts}
              docFonts={[...new Set([...fontKey(editor).split("|").filter(Boolean), ...styleFonts(docStyles.styles)])]}
              docTable={fontTable}
              onReplace={replaceFont}
            />
          )}
        </div>
      )}

      {find && editor && <FindBar editor={editor} readonly={readonly || review.mode === "view"} request={find} onClose={() => setFind(null)} />}
      {editor && <LinkBubble editor={editor} />}
      {editor && <PasteOptions editor={editor} />}
      {editor && (
        <SelectionBubble
          editor={editor}
          format={format === "none" ? docStyles.format : null}
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
          if (file) void sideFromFile(file).then(compareWith).catch((err) => state.setError(isCmdError(err) ? err.message : `That file couldn't be read: ${String(err)}`));
        }}
      />

      {goToOpen && editor && (
        <GoToBox
          editor={editor}
          format={format}
          shown={() => {
            const map = pageMapRef.current;
            return map && map !== "pending" && map.doc === editor.state.doc ? map : null;
          }}
          ask={askPages}
          onClose={() => setGoToOpen(false)}
        />
      )}

      <div className="wf-doc-body" {...panelSwipe}>
        <div className={`wf-doc-scroll${darkPaper ? " wf-paper-dark" : ""}${chapterShown ? " wf-chapter-only" : ""}`} ref={scrollRef} lang={lang}>
          <div className="wf-doc-top">
            {editor && chapterShown && <ChapterBar editor={editor} focus={chapterShown} noun={format === "manuscript" ? "chapter" : "section"} />}
            {editor && format === "none" && rulerOn && !rulerPhone && (
              <Ruler editor={editor} ydoc={provider.doc} settings={docSettings} styleStops={(node) => styleTabStops(node, docStyles.formatRef.current?.styles)} />
            )}
          </div>
          <ZoomFrame scroller={scrollRef} paper={pageSpecFor(format, docSettings)}>
          <div
            className={`wf-page wf-fmt-${format}${showMarks && format === "none" ? " wf-show-marks" : ""}${review.mode === "view" ? " wf-rev-final" : ""}`}
            style={sheetStyle}
            data-paged={pageGuides ? "" : undefined}
            data-wfs={docStyles.scope}
          >
            {/* The styles this document has changed (see editor/styles/css.ts). */}
            {format === "none" && docStyles.css && <style>{docStyles.css}</style>}
            {paperCss && <style>{paperCss}</style>}
            <EditorContent className={`wf-rich editable wf-doc-content`} editor={editor} />
          </div>
          {/* Its footnotes and endnotes, where they can be seen and changed. */}
          {editor && <NotesList editor={editor} style={sheetStyle} />}
          </ZoomFrame>
        </div>
        {/* Panel state lives above the format-keyed remount, so a format
            switch could otherwise leave a stale inspector open. */}
        {panel === "settings" && format === "none" && (
          <DocSettingsPanel
            editor={editor}
            ydoc={provider.doc}
            settings={docSettings}
            readonly={readonly}
            format={docStyles.format}
            at={setupAt}
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
            pictures={coverPictures}
            countPages={countBookPages}
            onOpenCover={() => setCoverOpen(true)}
            chapterArt={chapterArtSource(editor, book.design, provider.level)}
          />
        )}
        {panel === "history" && <VersionHistoryPanel editor={editor} onCompare={compareWith} />}
        {panel === "feedback" && (
          <FeedbackPanel
            focus={threadFocus}
            editor={editor}
            provider={provider}
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
            onOpenPlan={planned ? () => setPlanOpen({ tab: "board" }) : undefined}
          />
        )}
        {panel === "plan" && planned && editor && (
          <Suspense fallback={null}>
            <PlanPanel
              editor={editor}
              ydoc={provider.doc}
              format={format}
              design={format === "manuscript" ? book.design : undefined}
              readonly={readonly}
              level={provider.level}
              mentionsOf={planMentions}
              onMentions={setPlanMentions}
              onOpenFull={(at) => setPlanOpen({ tab: at?.entry ? "cast" : "board", at })}
              onClose={() => setPanel("none")}
            />
          </Suspense>
        )}
        {panel === "check" && editor && (
          <Suspense fallback={null}>
            <ProofPanel
              editor={editor}
              format={format}
              lang={lang}
              ydoc={provider.doc}
              canWrite={!readonly}
              title={meta.title}
              comments={openThreads}
              changes={review.items.length}
              onOpenComments={() => {
                setFeedbackTab("comments");
                setPanel("feedback");
              }}
              onOpenChanges={() => {
                setFeedbackTab("changes");
                setPanel("feedback");
              }}
              onClose={() => setPanel("none")}
            />
          </Suspense>
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
      {coverOpen && editor && (
        <CoverEditor
          ydoc={provider.doc}
          book={book}
          readonly={readonly}
          pictures={coverPictures}
          words={countDocWords(editor.state.doc)}
          chapters={scanStructure(editor.state.doc, "manuscript", book.design).entries.filter((e) => e.kind === "chapter").length}
          countPages={countBookPages}
          onClose={() => setCoverOpen(false)}
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
            if (format === "manuscript") setBookExport("paperback");
            else setPdfExport(true);
          }}
        />
      )}
      {pdfExport && editor && canPrint && (
        <ExportPdfDialog
          title={meta.title}
          details={format === "none" ? { settings: docSettings, readonly: readonly, onPatch: (patch) => updateDocSettings(provider.doc, patch) } : null}
          build={async (options, onProgress) => {
            const [{ buildExportPdf }, { snapshotDocMaps }] = await Promise.all([import("./export"), import("./docMaps")]);
            return buildExportPdf(editor.getJSON(), meta.title, format, format === "none" ? docSettings : undefined, docStyles.overrides, () => snapshotDocMaps(provider.doc), options, onProgress);
          }}
          onClose={() => setPdfExport(false)}
        />
      )}
      {printOpen && editor && canPrint && (
        <PrintDialog
          title={meta.title}
          build={async (booklet) => {
            const { buildPrintable } = await import("./export");
            return buildPrintable(editor.getJSON(), meta.title, format, format === "none" ? docSettings : undefined, booklet, docStyles.overrides);
          }}
          onClose={() => setPrintOpen(false)}
        />
      )}
      {compare && <CompareView before={compare.before} after={compare.after} onClose={() => setCompare(null)} />}
      {planOpen && planned && editor && (
        <Suspense fallback={null}>
          <PlanView
            editor={editor}
            ydoc={provider.doc}
            format={format}
            design={format === "manuscript" ? book.design : undefined}
            readonly={readonly}
            level={provider.level}
            tab={planOpen.tab}
            at={planOpen.at}
            onTab={(tab) => setPlanOpen({ tab })}
            onClose={() => setPlanOpen(null)}
            onShowInText={(pos) => {
              setPlanOpen(null);
              showRange(editor.view, pos + 1, pos + 1, true);
            }}
            onShowOnly={(pos) => {
              setPlanOpen(null);
              focusEntry(editor, pos);
            }}
            onShowMentions={(entry) => {
              setPlanOpen(null);
              setPlanMentions(entry);
              setPanel("plan");
            }}
          />
        </Suspense>
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
  if (!spec) return null;
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
    {el.shortcut ? `  ${keyLabel(el.shortcut)}` : ""}
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

/** The words of the chapter shown, or null when the whole text is. */
function shownWords(editor: Editor): number | null {
  const focus = chapterFocus(editor.state);
  return focus ? countRangeWords(editor.state.doc, focus.from, focus.to) : null;
}

export function DocumentStats({
  editor,
  format,
  goalKey,
  pagesExact,
  pageInches = 11,
  book,
  countPages,
  onGoTo,
}: {
  editor: Editor;
  format: string;
  /** When set, the count is clickable and carries a word-count goal. */
  goalKey?: string;
  /** Page-view count from the paginator; null falls back to the estimate. */
  pagesExact?: number | null;
  /** How tall the document's paper is, for that estimate. */
  pageInches?: number;
  /** A manuscript's book: its pages are the paperback's, counted by the
   *  layout engine (`countPages`) and estimated from its design until then. */
  book?: Book;
  countPages?: () => Promise<number | null>;
  /** When set, the page count is a button that opens Go to. */
  onGoTo?: () => void;
}) {
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState<number | null>(() => (goalKey ? loadGoal(goalKey) : null));
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => setGoal(goalKey ? loadGoal(goalKey) : null), [goalKey]);

  // Counting is cached per paragraph (stats.ts) and runs only when the text
  // changed — debounced, but at least every 1.5s while typing — instead of
  // re-reading the whole book (and forcing a layout) on every transaction.
  const designRef = useRef(book?.design);
  designRef.current = book?.design;
  const measure = useCallback(
    () => ({
      words: countDocWords(editor.state.doc),
      blocks: editor.state.doc.childCount,
      height: editor.view.dom.offsetHeight,
      chapters: designRef.current ? scanStructure(editor.state.doc, "manuscript", designRef.current).entries.filter((e) => e.kind === "chapter").length : 0,
      // While one chapter is shown, its own words are the ones counted.
      shown: shownWords(editor),
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
    // (Showing one chapter, or the whole text again, counts again.)
    let focus = chapterFocus(editor.state)?.from ?? null;
    const onTransaction = () => {
      const now = chapterFocus(editor.state)?.from ?? null;
      if (now === focus) return;
      focus = now;
      setCounts(measure());
    };
    setCounts(measure());
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelection);
    editor.on("transaction", onTransaction);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onSelection);
      editor.off("transaction", onTransaction);
    };
  }, [editor, measure]);

  const { words, blocks, shown } = counts;
  useEffect(() => {
    if (goalKey && goal !== null) noteGoalProgress(goalKey, words, goal);
  }, [goalKey, goal, words]);

  // A book counts the paperback's pages. Otherwise page view reports an
  // exact count, or the sheet gives an estimate (CSS inches, so 96px/in
  // maps exactly).
  const printed = usePrintedPages(
    book ? countPages : undefined,
    book ? estimatePages(words, counts.chapters, book.print, book.design) : 0,
    book ? pagesKey(book, words) : "",
  );
  const exact = book ? printed.exact : pagesExact !== null && pagesExact !== undefined;
  const pages = book ? printed.pages : (pagesExact ?? Math.max(1, Math.ceil(counts.height / (pageInches * 96))));

  // (One span: in the goal button, the words are one line over its bar.)
  const body = (
    <span className="wf-doc-stats-line">
      {selected !== null && selected > 0 && `${selected.toLocaleString()} of `}
      {(shown ?? words).toLocaleString()}
      {goal !== null && shown === null && ` / ${goal.toLocaleString()}`} {(shown ?? words) === 1 && (goal === null || shown !== null) ? "word" : "words"}
      {shown !== null && " in this chapter"}
      {/* Phones keep just the count. */}
      <span className="wf-doc-stats-more">
        {format !== "screenplay" && (shown ?? words) > 0 && ` · ${readingTime(shown ?? words)}`}
        {format === "screenplay" && ` · ${blocks} elements`}
      </span>
    </span>
  );
  // How many pages, and (where there is somewhere to go) a way to one.
  const count = `${exact ? "" : "~"}${pages} page${pages === 1 ? "" : "s"}`;
  const about = book ? "Pages in the typeset paperback, with its front matter." : "On-screen pages (export pagination may differ)";
  const pageCount =
    words > 0 ? (
      <span className="wf-doc-stats-more">
        {" · "}
        {onGoTo ? (
          <button type="button" className="wf-doc-stats-btn wf-doc-pages-btn" title={book ? `${about} Click to go to a chapter.` : "Go to a page or a heading"} onClick={onGoTo}>
            {count}
          </button>
        ) : (
          <span title={about}>{count}</span>
        )}
      </span>
    ) : null;
  if (!goalKey)
    return (
      <span className="wf-doc-stats">
        {body}
        {pageCount}
      </span>
    );
  // The popover is position:fixed, anchored from the trigger's rect at open —
  // the toolbar is an overflow-x scroll row that would clip anything absolute.
  const anchor = goalOpen ? wrapRef.current?.getBoundingClientRect() : undefined;
  return (
    <span className="wf-doc-stats wf-doc-goal-wrap" ref={wrapRef}>
      <button
        className="wf-doc-stats-btn"
        title={goal !== null ? "Word-count goal (click to change)" : "Set a word-count goal"}
        onClick={() => setGoalOpen((v) => !v)}
      >
        {body}
        {goal !== null && (
          <span className="wf-goal-bar" aria-hidden>
            <span style={{ width: `${Math.min(100, Math.round((words / goal) * 100))}%` }} />
          </span>
        )}
      </button>
      {pageCount}
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
