import Collaboration from "@tiptap/extension-collaboration";
import { NoteNumbers, numberingOf, refreshNoteNumbers } from "../../editor/nodes/NoteNumbers";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  BookOpen,
  Search,
  SpellCheck,
  Eye,
  MessageSquare,
  Focus as FocusIcon,
  HardDrive,
  History,
  LayoutGrid,
  ListTree,
  MoveVertical,
  Share2,
  SlidersHorizontal,
  SquareSplitVertical,
  Trash2,
  Volume2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { DEVICE_PICTURE_BYTES, uploadToDevice } from "../../lib/upload";
import { docContentExtensions } from "../../editor/schema/content";
import { DOC_SCHEMA_LEVEL } from "../../editor/schema/levels";
import { quoteStyleFor, SmartPunctuation } from "../../editor/SmartPunctuation";
import { ManuscriptLabels, refreshManuscriptLabels } from "../../book/editor/manuscriptLabels";
import { ManuscriptPaste } from "../../book/editor/manuscriptPaste";
import { chapterArtSource } from "../../book/editor/chapterArt";
import { BookInspector } from "../../book/ui/BookInspector";
import type { CoverPictures } from "../../book/ui/Cover";
import { CoverEditor } from "../../book/ui/CoverEditor";
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
import { ExportPdfDialog } from "./ExportPdfDialog";
import { PrintDialog } from "./PrintDialog";
import { FindBar } from "./FindBar";
import { FORMAT_LABELS, FORMAT_SPECS } from "./formats/elements";
import { formatKeymap } from "./formats/FormatKeymap";
import { useAutoRevisions, saveLocalVersion } from "./history";
import { useDocCard } from "./useDocCard";
import { useSwipe } from "../../lib/useSwipe";
import { activeLocalProvider, useLocalDocs, type LocalSaveState } from "./local";
import { LocalHistoryPanel } from "./LocalHistoryPanel";
import { openLocalDoc } from "./navigation";
import { OutlinePanel } from "./OutlinePanel";
import { ShareLocalDialog } from "./ShareLocalDialog";
import { countDocWords } from "./stats";
import { ExportMenu, WORD_EXPORT, type ExportItem } from "./shell/ExportMenu";
import { CommandKeys } from "../../editor/commands/CommandKeys";
import type { CommandCtx, ShellActions } from "../../editor/commands/run";
import { useEditorCommands } from "../../editor/commands/useEditorCommands";
import { autoCorrect } from "../../editor/autocorrect/AutoCorrect";
import { capitalsHere } from "../../editor/autocorrect/where";
import { EditPlaces } from "../../editor/EditPlaces";
import { refreshTabStops, styleTabStops, TabStops } from "../../editor/format/TabStops";
import { ChapterFocus, focusEntry } from "../../editor/ChapterFocus";
import { ChapterIdGuard } from "../../editor/nodes/ChapterId";
import { showRange } from "../../editor/ui/reveal";
import { knowsChapter } from "../../plan/planMap";
import { hasPlan } from "../../plan/resolve";
import type { PlanTab } from "../../plan/ui/PlanView";
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
import { bookExportItems, canDockPreview, EDITOR_PROPS, inputRulesFor, manuscriptVars, pasteRulesFor, showBlock, textLanguage, useBook, selectedPhrase, useCheckShortcut, useFindShortcut, type FindRequest, usePrintShortcut } from "./shell/hooks";
import { useReopenPosition } from "./shell/position";
import { SyncStatus, type SaveIndicator } from "./shell/SyncStatus";
import { withKeys } from "../../editor/commands/catalog";

/** Editor for a document stored on this device: same page, formats, outline,
 *  find, and export as server documents — no collaboration surfaces (history,
 *  threads, shares, peers), no image insertion (image refs are server
 *  attachments), and every edit saves locally. */
// The checker and its word lists are fetched when its panel first opens.
const ProofPanel = lazy(() => import("../../proof/ui/ProofPanel").then((m) => ({ default: m.ProofPanel })));
// So is the story plan, when it is first opened.
const PlanView = lazy(() => import("../../plan/ui/PlanView").then((m) => ({ default: m.PlanView })));
const PlanPanel = lazy(() => import("../../plan/ui/PlanPanel").then((m) => ({ default: m.PlanPanel })));

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
    "none" | "history" | "outline" | "feedback" | "settings" | "book" | "preview" | "check" | "plan"
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
  const [coverOpen, setCoverOpen] = useState(false);
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
  // How many pages page view shows. (The gaps between them are the
  // paginator's own drawing, on the sheet: nothing here is rendered again
  // as the text moves across them.)
  const [pagesExact, setPagesExact] = useState<number | null>(null);
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
      formatKeymap(format),
      // One heading per chapter id (the story plan's tie to a chapter).
      ChapterIdGuard.configure({ known: (cid) => !!provider && knowsChapter(provider.doc, cid) }),
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

  // A book's cover artwork is kept where its pictures are, and its cover
  // sheet is sized for the pages the layout engine counts.
  const coverPictures = useMemo<CoverPictures>(() => ({ upload: imageUploader, limit: DEVICE_PICTURE_BYTES }), [imageUploader]);
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
  const [pdfExport, setPdfExport] = useState(false);
  const [showMarks, setShowMarks] = useState(() => localStorage.getItem("wf-doc-marks") === "on");
  const toggleMarks = () => {
    const next = !showMarks;
    setShowMarks(next);
    localStorage.setItem("wf-doc-marks", next ? "on" : "off");
    marksOnRef.current = next;
    refreshFormatMarks(editor);
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
      ...(meta.format === "manuscript" && editor
        ? bookExportItems(setBookExport, async () => {
            const { exportSubmissionDocx } = await import("../../book/exportBook");
            await exportSubmissionDocx(editor.getJSON(), "manuscript", bookRef.current);
          }, () => setCoverOpen(true))
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
  useDocCard({ doc: provider!.doc, format, canWrite: true, upload: imageUploader, send: null });
  const phone = useIsPhone();

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
    return vars as React.CSSProperties;
  }, [meta.format, docSettings, book]);

  // Honor "open with this panel" from the list's Version history entry.
  useEffect(() => {
    const requested = useLocalDocs.getState().pendingPanel;
    if (requested) {
      setPanel(requested);
      useLocalDocs.setState({ pendingPanel: null });
    }
  }, []);

  useFindShortcut(editor, openFind);
  // F7 opens the Check panel, and closes it.
  useCheckShortcut(() => setPanel(panel === "check" ? "none" : "check"));

  // Reopen where you left off.
  const scrollRef = useRef<HTMLDivElement>(null);
  useReopenPosition(editor, `l:${meta.id}`, scrollRef);
  const { focus, setFocus, typewriter, setTypewriter } = useFocusMode();
  // On a phone the document has the whole screen.
  useFillsPhone();
  useTypewriterScroll(editor, focus && typewriter);
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
    ...(meta.format !== "manuscript"
      ? {
          togglePageView: () => {
            const next = !pageViewOn;
            setPageGuides(next);
            localStorage.setItem("wf-doc-pageguides", next ? "on" : "off");
          },
        }
      : {}),
    ...(meta.format === "none"
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
    format: meta.format,
    rich: meta.format === "none" ? docStyles.format : null,
    editable: !!editor && editor.isEditable,
    lang,
    settings: docSettings,
    patchSettings: (patch) => {
      if (provider) updateDocSettings(provider.doc, patch);
    },
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

  if (!provider) return null;
  const formatSelect = (
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
  );

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
        {!phone && formatSelect}
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
            title="Notes to self" data-label="Notes to self"
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
          {speaks && meta.format !== "none" && (
            <button title="Read aloud from the caret" data-label="Read aloud" className={reading ? "active" : ""} disabled={!editor} onClick={() => setReading(!reading)}>
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
          {meta.format !== "manuscript" && (
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
          {meta.format === "manuscript" && (
            <button
              title="Book: details, design, print and ebook settings" data-label="Book"
              className={panel === "book" ? "active" : ""}
              onClick={() => setPanel(panel === "book" ? "none" : "book")}
            >
              <BookOpen size={16} />
            </button>
          )}
          {meta.format === "none" && (
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
          <ExportMenu items={exportItems} onError={(e) => setError(String(e))} />
          <button title="Publish to a server…" data-label="Publish to a server" onClick={() => publish(null)}>
            <Share2 size={16} />
          </button>
          <button
            title="Delete (to Recently Deleted)" data-label="Delete"
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
        </HeaderTools>
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
                  format={meta.format}
                  goalKey={`local:${meta.id}`}
                  pagesExact={pageGuides ? pagesExact : null}
                  pageInches={pageSpecFor(meta.format, docSettings).h}
                  onGoTo={() => setGoToOpen(true)}
                />
                </>
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
                <>
                <ZoomControl />
                <DocumentStats
                  editor={editor}
                  format={meta.format}
                  goalKey={`local:${meta.id}`}
                  pagesExact={pageGuides ? pagesExact : null}
                  pageInches={pageSpecFor(meta.format, docSettings).h}
                  book={meta.format === "manuscript" ? book : undefined}
                  countPages={countStatsPages}
                  onGoTo={() => setGoToOpen(true)}
                />
                </>
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
            {editor && chapterShown && <ChapterBar editor={editor} focus={chapterShown} noun={meta.format === "manuscript" ? "chapter" : "section"} />}
            {editor && meta.format === "none" && rulerOn && !rulerPhone && (
              <Ruler editor={editor} ydoc={provider.doc} settings={docSettings} styleStops={(node) => styleTabStops(node, docStyles.formatRef.current?.styles)} />
            )}
          </div>
          <ZoomFrame scroller={scrollRef} paper={pageSpecFor(meta.format, docSettings)}>
          <div
            className={`wf-page wf-fmt-${meta.format}${showMarks && meta.format === "none" ? " wf-show-marks" : ""}${review.mode === "view" ? " wf-rev-final" : ""}`}
            style={sheetStyle}
            data-paged={pageGuides ? "" : undefined}
            data-wfs={docStyles.scope}
          >
            {/* The styles this document has changed (see editor/styles/css.ts). */}
            {meta.format === "none" && docStyles.css && <style>{docStyles.css}</style>}
            {paperCss && <style>{paperCss}</style>}
            <EditorContent className="wf-rich editable wf-doc-content" editor={editor} />
          </div>
          {/* Its footnotes and endnotes, where they can be seen and changed. */}
          {editor && <NotesList editor={editor} style={sheetStyle} />}
          </ZoomFrame>
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
            pictures={coverPictures}
            countPages={countBookPages}
            onOpenCover={() => setCoverOpen(true)}
            chapterArt={chapterArtSource(editor, book.design, DOC_SCHEMA_LEVEL)}
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
              readonly={false}
              level={DOC_SCHEMA_LEVEL}
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
              format={meta.format}
              lang={lang}
              ydoc={provider.doc}
              canWrite
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
          onSwitchFormat={() => setFormat(meta.id, "manuscript")}
          onClose={() => setConverting(null)}
        />
      )}
      {coverOpen && editor && (
        <CoverEditor
          ydoc={provider.doc}
          book={book}
          readonly={false}
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
            else setPdfExport(true);
          }}
        />
      )}
      {pdfExport && editor && canPrint && (
        <ExportPdfDialog
          title={meta.title}
          details={meta.format === "none" ? { settings: docSettings, readonly: false, onPatch: (patch) => updateDocSettings(provider.doc, patch) } : null}
          build={async (options, onProgress) => {
            const [{ buildExportPdf }, { snapshotDocMaps }] = await Promise.all([import("./export"), import("./docMaps")]);
            return buildExportPdf(editor.getJSON(), meta.title, meta.format, meta.format === "none" ? docSettings : undefined, docStyles.overrides, () => snapshotDocMaps(provider.doc), options, onProgress);
          }}
          onClose={() => setPdfExport(false)}
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
      {planOpen && planned && editor && (
        <Suspense fallback={null}>
          <PlanView
            editor={editor}
            ydoc={provider.doc}
            format={format}
            design={format === "manuscript" ? book.design : undefined}
            readonly={false}
            level={DOC_SCHEMA_LEVEL}
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
      {shareOpen && <ShareLocalDialog meta={meta} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
