import type { Editor } from "@tiptap/react";
import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  Asterisk,
  Baseline,
  Bold,
  CalendarDays,
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Columns2,
  Columns3,
  Eye,
  FileCog,
  GitCompareArrows,
  Highlighter,
  History,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Omega,
  PaintBucket,
  Paintbrush,
  PanelTop,
  Pilcrow,
  Printer,
  Quote,
  Redo2,
  RemoveFormatting,
  Rows3,
  Search,
  SeparatorHorizontal,
  Square,
  SquareCode,
  Strikethrough,
  Subscript,
  Superscript,
  TableCellsMerge,
  TableCellsSplit,
  TableOfContents,
  Trash2,
  Underline,
  Undo2,
  UnfoldVertical,
  Volume2,
  WrapText,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  bodyLook,
  CUSTOM_PAGE,
  pageDims,
  PAGE_SIZES,
  type DocSettings,
} from "../../apps/documents/docSettings";
import type { FontInfo } from "../../fonts/css";
import { fontKey } from "../../fonts/docFonts";
import { FontPicker } from "../../fonts/ui/FontPicker";
import { isCmdError } from "../../lib/backend";
import type { ImageUploader } from "../../lib/upload";
import { toastError } from "../../platform/toast";
import { changeCase, clearFormatting, insertDate, setListStart, setNumbering, sortBlocks, type CaseKind } from "../format/commands";
import { curRun, type FormatContext } from "../format/effective";
import { paintFormat, pickUpFormat, type Paint } from "../format/painter";
import { curParaFormat, setBorder, setLineHeight, setSection, setShade, stepIndent, toggleColumnBreak } from "../format/ParaFormat";
import { setHighlight, setRunColor, setRunFont, setRunSize, stepRunSize, toggleScript } from "../format/run";
import { insertNote } from "../nodes/Footnote";
import { imageAlign, selectedImage, setImageAttrs, type ImageAlign } from "../nodes/Image";
import { setBulletMarker, toggleChecklist } from "../nodes/TaskList";
import { insertToc } from "../nodes/Toc";
import { resolveAll, resolveInEditor, selectedChanges, stepChange, type ReviewMode } from "../review/Suggesting";
import type { ReviewState } from "../review/useReview";
import { curTable, isInTable, setTableAttrs, stepColumn, tableCommands, type TableLines } from "../tables/Table";
import { BULLET_MARKERS, MARKER_GLYPH, parseBorder, type BulletMarker } from "../schema/sanitize";
import { LEGAL, resolveStyles, styleFonts, type StyleEntry } from "../styles/sheet";
import { curTypography, insertPageBreak, setDocAlign, setTypography, SIZE_LADDER } from "../TextFormat";
import { CaptionFlyout } from "./CaptionFlyout";
import { ColorFlyout, HIGHLIGHT_COLORS, SHADE_COLORS, TEXT_COLORS } from "./ColorFlyout";
import { Flyout, FlyoutItem, useIsPhone } from "./Flyout";
import { LinkFlyout } from "./LinkFlyout";
import { SectionFlyout } from "./SectionFlyout";
import { StyleGallery } from "./StyleGallery";
import { TableFlyout } from "./TableFlyout";
import { SYMBOL_GROUPS } from "./symbols";

export type RibbonTab = "home" | "insert" | "layout" | "review" | "table" | "picture";

const TABS: { id: RibbonTab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "insert", label: "Insert" },
  { id: "layout", label: "Layout" },
  { id: "review", label: "Review" },
];
/** Tabs that are there while there is something for them to act on. */
const TABLE_TAB = { id: "table" as const, label: "Table" };
const PICTURE_TAB = { id: "picture" as const, label: "Picture" };

const TABLE_LINES_NAMES: [TableLines, string][] = [
  ["all", "All lines"],
  ["rows", "Lines between rows"],
  ["box", "A box around it"],
  ["none", "No lines"],
];

export interface RibbonActions {
  find?: () => void;
  comments?: () => void;
  /** Open the list of suggested changes. */
  changes?: () => void;
  history?: () => void;
  pageSetup?: () => void;
  preview?: () => void;
  print?: () => void;
  readAloud?: () => void;
  /** Compare with a Word file. */
  compareFile?: () => void;
}

interface Group {
  id: string;
  /** What the group is called in the "more" menu. */
  label: string;
  content: ReactNode;
}

const MARGINS: { label: string; hint: string; patch: Partial<DocSettings> }[] = [
  { label: "Normal", hint: "1″ all round", patch: { mt: 1, mb: 1, ml: 1, mr: 1 } },
  { label: "Narrow", hint: "0.5″ all round", patch: { mt: 0.5, mb: 0.5, ml: 0.5, mr: 0.5 } },
  { label: "Moderate", hint: "1″ top and bottom, 0.75″ sides", patch: { mt: 1, mb: 1, ml: 0.75, mr: 0.75 } },
  { label: "Wide", hint: "1″ top and bottom, 2″ sides", patch: { mt: 1, mb: 1, ml: 2, mr: 2 } },
  { label: "Writing sheet", hint: "the app's own: a wide left margin", patch: { mt: 0.86, mb: 1, ml: 1.5, mr: 1 } },
];

const CASES: { kind: CaseKind; label: string }[] = [
  { kind: "sentence", label: "Sentence case." },
  { kind: "lower", label: "lowercase" },
  { kind: "upper", label: "UPPERCASE" },
  { kind: "title", label: "Capitalize Each Word" },
  { kind: "toggle", label: "tOGGLE cASE" },
];

const NUMBERINGS: { type: string | null; label: string }[] = [
  { type: null, label: "1.  2.  3." },
  { type: "a", label: "a.  b.  c." },
  { type: "A", label: "A.  B.  C." },
  { type: "i", label: "i.  ii.  iii." },
  { type: "I", label: "I.  II.  III." },
  { type: LEGAL, label: "1.  1.1.  1.1.1." },
];

const MARKER_NAMES: Record<BulletMarker, string> = {
  disc: "Bullet",
  circle: "Hollow bullet",
  square: "Square",
  dash: "Dash",
  arrow: "Arrow",
  check: "Tick",
};

const BORDERS: { sides: string; label: string }[] = [
  { sides: "tblr", label: "Box" },
  { sides: "b", label: "Line below" },
  { sides: "t", label: "Line above" },
  { sides: "tb", label: "Lines above and below" },
  { sides: "l", label: "Bar at the left" },
];

const LINES = [1, 1.15, 1.5, 2];

/**
 * The Document format's ribbon: Home, Insert, Layout and Review, each a row
 * of groups. Groups that don't fit move into a "more" menu, last first; on
 * a phone the row scrolls instead and menus open as sheets.
 *
 * Formatting on part of a paragraph, colours, indents, borders and
 * checklists are schema level 2: where the document is held to level 1 (its
 * server hasn't been updated) those controls aren't shown, and typeface and
 * size apply to whole paragraphs as they always did.
 */
export function Ribbon({
  editor,
  settings,
  onPatchSettings,
  uploadImage,
  actions,
  showMarks,
  onToggleMarks,
  fontTable = {},
  onFontUsed,
  format,
  onSaveStyle,
  review,
  trailing,
}: {
  editor: Editor;
  settings: DocSettings;
  onPatchSettings: (patch: Partial<DocSettings>) => void;
  /** Where a picture goes when one is added (a server's attachments, or
   *  beside the document on this device). Absent: no Picture button. */
  uploadImage?: ImageUploader;
  actions: RibbonActions;
  showMarks: boolean;
  onToggleMarks: () => void;
  /** What the document knows about the fonts it uses (names, kinds). */
  fontTable?: Record<string, FontInfo>;
  /** A font was applied: record it with the document. */
  onFontUsed?: (id: string, info?: FontInfo) => void;
  /** The document's styles, and the schema level it may use here. */
  format: FormatContext;
  /** Change one of the document's styles (absent: it can't be edited). */
  onSaveStyle?: (id: string, entry: StyleEntry | null) => void;
  /** Editing / Suggesting / Viewing, and the suggested changes. */
  review?: ReviewState;
  trailing?: ReactNode;
}) {
  const [tab, setTab] = useState<RibbonTab>("home");
  // A picture selected brings its tab up — until another tab is chosen
  // while it's still selected.
  const [pictureAside, setPictureAside] = useState(false);
  const phone = useIsPhone();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // Re-render on selection/content changes so active states track the cursor.
  const [, bump] = useState(0);
  useEffect(() => {
    const update = () => bump((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  // ⌘⇧K: the link form, wherever the ribbon is.
  const [linkSignal, setLinkSignal] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.code === "KeyK" || e.key.toLowerCase() === "k";
      if (!k || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      e.preventDefault();
      setTab("insert");
      setLinkSignal((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The format painter: armed with what it picked up, it paints the next
  // selection made in the text (Escape puts it down).
  const [paint, setPaint] = useState<Paint | null>(null);
  useEffect(() => {
    if (!paint) return;
    const dom = editor.view.dom;
    dom.classList.add("wf-painting");
    const apply = () => {
      // After the browser has settled the selection the pointer made.
      setTimeout(() => {
        paintFormat(editor, paint);
        setPaint(null);
      }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaint(null);
    };
    dom.addEventListener("pointerup", apply);
    window.addEventListener("keydown", onKey);
    return () => {
      dom.classList.remove("wf-painting");
      dom.removeEventListener("pointerup", apply);
      window.removeEventListener("keydown", onKey);
    };
  }, [paint, editor]);

  const chain = () => editor.chain().focus();
  const cur = curTypography(editor);
  const rich = format.level >= 2;
  const inTable = rich && isInTable(editor.state);
  const tableNow = inTable ? curTable(editor) : null;
  const picture = rich ? selectedImage(editor) : null;
  const hasPicture = !!picture;
  useEffect(() => {
    if (!hasPicture) setPictureAside(false);
  }, [hasPicture]);
  const tabs = [...TABS, ...(inTable ? [TABLE_TAB] : []), ...(hasPicture ? [PICTURE_TAB] : [])];
  const shown: RibbonTab = hasPicture && !pictureAside ? "picture" : tab === "table" && !inTable ? "home" : tab === "picture" ? "home" : tab;
  const pickTab = (id: RibbonTab) => {
    setPictureAside(hasPicture && id !== "picture");
    if (id !== "picture") setTab(id);
  };
  const run = curRun(editor, format);
  const para = curParaFormat(editor);
  const border = parseBorder(para.bdr);

  const allowImages = !!uploadImage;
  const insertImage = async (file: File) => {
    if (!uploadImage) return;
    setUploading(true);
    try {
      chain().setImage({ src: await uploadImage(file) }).run();
    } catch (e) {
      toastError(isCmdError(e) ? e.message : "That picture couldn’t be added.");
    } finally {
      setUploading(false);
    }
  };

  const btn = (title: string, icon: ReactNode, run: () => void, active = false, disabled = false, label?: string) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`${active ? "active" : ""}${label ? " labelled" : ""}`}
      disabled={disabled}
      // Mousedown only keeps the editor's focus; the action runs on click,
      // so the keyboard (Enter/Space on a focused button) works too.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );

  const sizes = [...new Set([...SIZE_LADDER, ...(run.mixed.size ? [] : [run.size])])].sort((a, b) => a - b);
  const item = editor.isActive("taskItem") ? "taskItem" : editor.isActive("listItem") ? "listItem" : null;
  const inOrdered = editor.isActive("orderedList");
  const usedFonts = [
    ...(settings.bodyFont ? [settings.bodyFont] : []),
    ...styleFonts(format.styles),
    ...fontKey(editor).split("|").filter(Boolean),
  ];
  const defaults = resolveStyles(bodyLook(settings));

  const home: Group[] = [
    {
      id: "history",
      label: "Undo",
      content: (
        <>
          {btn("Undo (⌘Z)", <Undo2 size={15} />, () => chain().undo().run(), false, !editor.can().undo())}
          {btn("Redo (⌘⇧Z)", <Redo2 size={15} />, () => chain().redo().run(), false, !editor.can().redo())}
          {btn(
            paint ? "Painting — select the text to format (Esc to stop)" : "Format painter — copy this formatting to other text",
            <Paintbrush size={15} />,
            () => setPaint(paint ? null : pickUpFormat(editor, format.level)),
            !!paint,
          )}
        </>
      ),
    },
    {
      id: "style",
      label: "Style",
      content: (
        <StyleGallery
          editor={editor}
          styles={format.styles}
          defaults={defaults}
          fonts={usedFonts}
          fontTable={fontTable}
          onSave={onSaveStyle}
          onFontUsed={onFontUsed}
          onBodyText={actions.pageSetup}
        />
      ),
    },
    {
      id: "font",
      label: "Font",
      content: (
        <>
          <FontPicker
            value={run.mixed.font ? null : run.font}
            docFonts={usedFonts}
            docTable={fontTable}
            defaultLabel={run.mixed.font ? "Mixed" : "Body font"}
            title={rich ? "Font" : "Paragraph font"}
            className="wf-ribbon-font"
            onPick={(id, info) => {
              setRunFont(editor, id, format.level);
              if (id) onFontUsed?.(id, info);
            }}
          />
          <select
            className="wf-ribbon-select wf-ribbon-size"
            title={rich ? "Size" : "Paragraph size"}
            aria-label="Size"
            value={run.mixed.size ? "" : run.size}
            onChange={(e) => {
              if (e.target.value) setRunSize(editor, Number(e.target.value), format.level);
            }}
          >
            {run.mixed.size && <option value="">–</option>}
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {btn("Larger (⌘⇧.)", <AArrowUp size={16} />, () => stepRunSize(editor, 1, format))}
          {btn("Smaller (⌘⇧,)", <AArrowDown size={16} />, () => stepRunSize(editor, -1, format))}
        </>
      ),
    },
    {
      id: "character",
      label: "Text",
      content: (
        <>
          {btn("Bold (⌘B)", <Bold size={15} />, () => chain().toggleBold().run(), editor.isActive("bold"))}
          {btn("Italic (⌘I)", <Italic size={15} />, () => chain().toggleItalic().run(), editor.isActive("italic"))}
          {btn("Underline (⌘U)", <Underline size={15} />, () => chain().toggleUnderline().run(), editor.isActive("underline"))}
          {btn("Strikethrough", <Strikethrough size={15} />, () => chain().toggleStrike().run(), editor.isActive("strike"))}
          {rich && btn("Subscript (⌘=)", <Subscript size={15} />, () => toggleScript(editor, "sub"), run.vscript === "sub")}
          {rich && btn("Superscript (⌘⇧=)", <Superscript size={15} />, () => toggleScript(editor, "super"), run.vscript === "super")}
          {rich && (
            <ColorFlyout
              title="Text colour"
              icon={<Baseline size={15} />}
              value={run.mixed.color ? null : run.color}
              colors={TEXT_COLORS}
              noneLabel="Automatic"
              onPick={(c) => setRunColor(editor, c)}
            />
          )}
          {rich && (
            <ColorFlyout
              title="Highlight"
              icon={<Highlighter size={15} />}
              value={run.mixed.highlight ? null : run.highlight}
              colors={HIGHLIGHT_COLORS}
              noneLabel="No highlight"
              onPick={(c) => setHighlight(editor, c)}
            />
          )}
          {btn("Inline code", <Code size={15} />, () => chain().toggleCode().run(), editor.isActive("code"))}
          <Flyout title="Change case" icon={<CaseSensitive size={16} />} disabled={editor.state.selection.empty}>
            {(close) =>
              CASES.map((c) => (
                <FlyoutItem
                  key={c.kind}
                  onPick={() => {
                    changeCase(editor, c.kind);
                    close();
                  }}
                >
                  {c.label}
                </FlyoutItem>
              ))
            }
          </Flyout>
          {btn("Clear formatting", <RemoveFormatting size={15} />, () => clearFormatting(editor))}
        </>
      ),
    },
    {
      id: "lists",
      label: "Lists",
      content: (
        <>
          {btn("Bulleted list", <List size={15} />, () => chain().toggleBulletList().run(), editor.isActive("bulletList"))}
          {rich && (
            <Flyout title="Bullet style" className="wf-ribbon-narrow">
              {(close) =>
                BULLET_MARKERS.map((m) => (
                  <FlyoutItem
                    key={m}
                    checked={editor.isActive("bulletList") && (editor.getAttributes("bulletList").marker ?? "disc") === m}
                    onPick={() => {
                      setBulletMarker(editor, m === "disc" ? null : m);
                      close();
                    }}
                  >
                    <span className="wf-marker-sample">{MARKER_GLYPH[m]}</span> {MARKER_NAMES[m]}
                  </FlyoutItem>
                ))
              }
            </Flyout>
          )}
          {btn("Numbered list", <ListOrdered size={15} />, () => chain().toggleOrderedList().run(), inOrdered)}
          <Flyout title="Numbering" className="wf-ribbon-narrow">
            {(close) => (
              <>
                {NUMBERINGS.map((n) => (
                  <FlyoutItem
                    key={n.label}
                    checked={inOrdered && (editor.getAttributes("orderedList").type ?? null) === n.type}
                    onPick={() => {
                      setNumbering(editor, n.type);
                      close();
                    }}
                  >
                    {n.label}
                  </FlyoutItem>
                ))}
                <hr />
                <FlyoutItem
                  disabled={!inOrdered}
                  onPick={() => {
                    setListStart(editor, "restart");
                    close();
                  }}
                >
                  Restart at 1
                </FlyoutItem>
                <FlyoutItem
                  disabled={!inOrdered}
                  onPick={() => {
                    setListStart(editor, "continue");
                    close();
                  }}
                >
                  Continue the list before
                </FlyoutItem>
              </>
            )}
          </Flyout>
          {rich && btn("Checklist (⌘⇧9)", <ListChecks size={15} />, () => toggleChecklist(editor), editor.isActive("taskList"))}
          {btn(
            "Decrease indent (⇧Tab)",
            <IndentDecrease size={15} />,
            () => (item ? chain().liftListItem(item).run() : stepIndent(editor, -1)),
            false,
            !item && (!rich || !para.indL),
          )}
          {btn(
            "Increase indent (Tab)",
            <IndentIncrease size={15} />,
            () => (item ? chain().sinkListItem(item).run() : stepIndent(editor, 1)),
            false,
            !item && !rich,
          )}
        </>
      ),
    },
    {
      id: "paragraph",
      label: "Paragraph",
      content: (
        <>
          {btn("Align left (⌘⇧L)", <AlignLeft size={15} />, () => setDocAlign(editor, "left"), cur.align === null)}
          {btn("Centre (⌘⇧E)", <AlignCenter size={15} />, () => setDocAlign(editor, "center"), cur.align === "center")}
          {btn("Align right (⌘⇧R)", <AlignRight size={15} />, () => setDocAlign(editor, "right"), cur.align === "right")}
          {btn("Justify (⌘⇧J)", <AlignJustify size={15} />, () => setDocAlign(editor, "justify"), cur.align === "justify")}
          <Flyout title="Line and paragraph spacing" icon={<UnfoldVertical size={15} />}>
            {(close) => (
              <>
                {LINES.map((v) => (
                  <FlyoutItem
                    key={v}
                    checked={cur.line === v && !para.lineRule}
                    onPick={() => {
                      if (rich) setLineHeight(editor, { multiple: v });
                      else setTypography(editor, { line: v });
                      close();
                    }}
                  >
                    {v === 1 ? "Single" : v === 2 ? "Double" : String(v)}
                  </FlyoutItem>
                ))}
                <FlyoutItem
                  checked={cur.line === null && !para.lineRule}
                  onPick={() => {
                    if (rich) setLineHeight(editor, { multiple: null });
                    else setTypography(editor, { line: null });
                    close();
                  }}
                >
                  As the style
                </FlyoutItem>
                <hr />
                <FlyoutItem
                  onPick={() => {
                    setTypography(editor, { sa: cur.sa ? null : 12 });
                    close();
                  }}
                >
                  {cur.sa ? "Remove space before paragraph" : "Add space before paragraph"}
                </FlyoutItem>
                <FlyoutItem
                  onPick={() => {
                    setTypography(editor, { sb: cur.sb === 0 ? null : 0 });
                    close();
                  }}
                >
                  {cur.sb === 0 ? "Restore space after paragraph" : "Remove space after paragraph"}
                </FlyoutItem>
                {actions.pageSetup && (
                  <>
                    <hr />
                    <FlyoutItem
                      onPick={() => {
                        close();
                        actions.pageSetup?.();
                      }}
                    >
                      Indents and spacing…
                    </FlyoutItem>
                  </>
                )}
              </>
            )}
          </Flyout>
          {rich && (
            <ColorFlyout
              title="Shading"
              icon={<PaintBucket size={15} />}
              value={para.shade}
              colors={SHADE_COLORS}
              noneLabel="No shading"
              onPick={(c) => setShade(editor, c)}
            />
          )}
          {rich && (
            <Flyout title="Borders" icon={<Square size={15} />} active={!!border}>
              {(close) => (
                <>
                  <FlyoutItem
                    checked={!border}
                    onPick={() => {
                      setBorder(editor, null);
                      close();
                    }}
                  >
                    No border
                  </FlyoutItem>
                  {BORDERS.map((b) => (
                    <FlyoutItem
                      key={b.sides}
                      checked={border?.sides === b.sides}
                      onPick={() => {
                        setBorder(editor, { sides: b.sides, width: border?.width ?? 0.75, color: border?.color ?? "#000000" });
                        close();
                      }}
                    >
                      {b.label}
                    </FlyoutItem>
                  ))}
                  <hr />
                  {[0.5, 0.75, 1.5, 2.25].map((w) => (
                    <FlyoutItem
                      key={w}
                      disabled={!border}
                      checked={!!border && border.width === w}
                      onPick={() => {
                        if (border) setBorder(editor, { ...border, width: w });
                        close();
                      }}
                    >
                      {w} pt
                    </FlyoutItem>
                  ))}
                </>
              )}
            </Flyout>
          )}
          {btn("Sort A to Z", <ArrowDownAZ size={15} />, () => sortBlocks(editor))}
          {btn("Show paragraph marks", <Pilcrow size={15} />, onToggleMarks, showMarks)}
        </>
      ),
    },
  ];

  const topLevel = editor.state.selection.$from.depth === 1;
  const insert: Group[] = [
    {
      id: "pages",
      label: "Breaks",
      content: (
        <>
          {btn("Page break (⌘↩)", <SeparatorHorizontal size={15} />, () => insertPageBreak(editor), false, false, "Page break")}
          {rich && (
            <Flyout title="More breaks" className="wf-ribbon-narrow">
              {(close) => (
                <>
                  <FlyoutItem
                    checked={para.colBreak === true}
                    hint="to the top of the next column"
                    onPick={() => {
                      toggleColumnBreak(editor);
                      close();
                    }}
                  >
                    Column break
                  </FlyoutItem>
                  <FlyoutItem
                    disabled={!topLevel}
                    checked={!!para.sect}
                    hint="a new page, with its own page setup"
                    onPick={() => {
                      setSection(editor, para.sect ? null : {});
                      close();
                    }}
                  >
                    Section break
                  </FlyoutItem>
                </>
              )}
            </Flyout>
          )}
        </>
      ),
    },
    {
      id: "table",
      label: "Table",
      content: rich ? <TableFlyout editor={editor} /> : null,
    },
    {
      id: "link",
      label: "Link",
      content: (
        <>
          <LinkFlyout editor={editor} openSignal={linkSignal} />
          {allowImages && btn(uploading ? "Uploading…" : "Picture", <ImagePlus size={15} />, () => fileRef.current?.click(), false, uploading)}
        </>
      ),
    },
    {
      id: "blocks",
      label: "Blocks",
      content: (
        <>
          {btn("Quote", <Quote size={15} />, () => chain().toggleBlockquote().run(), editor.isActive("blockquote"))}
          {btn("Code block", <SquareCode size={15} />, () => chain().toggleCodeBlock().run(), editor.isActive("codeBlock"))}
          {btn("Divider line", <Minus size={15} />, () => chain().setHorizontalRule().run())}
          {btn("Line break (⇧↩)", <WrapText size={15} />, () => chain().setHardBreak().run())}
        </>
      ),
    },
    {
      id: "notes",
      label: "Notes",
      content: rich ? (
        <>
          {btn("Footnote — a note at the foot of the page", <Asterisk size={15} />, () => insertNote(editor, "foot"), false, false, "Footnote")}
          {btn("Endnote — a note at the end of the document", null, () => insertNote(editor, "end"), false, false, "Endnote")}
          {btn("Table of contents — the headings, kept up to date", <TableOfContents size={15} />, () => insertToc(editor), false, !topLevel, "Contents")}
        </>
      ) : null,
    },
    {
      id: "symbols",
      label: "Symbols",
      content: (
        <>
          <Flyout title="Symbol" icon={<Omega size={15} />} panelClass="wf-symbols">
            {() =>
              SYMBOL_GROUPS.map((group) => (
                <div key={group.label} className="wf-symbol-group">
                  <span>{group.label}</span>
                  <div>
                    {group.symbols.map((s) => (
                      <button key={s} type="button" title={s} onClick={() => chain().insertContent(s).run()}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            }
          </Flyout>
          {btn("Today's date", <CalendarDays size={15} />, () => insertDate(editor))}
        </>
      ),
    },
  ];

  const landscape = settings.pageSize === CUSTOM_PAGE ? settings.pw > settings.ph : settings.landscape;
  const turn = (want: boolean) => {
    if (want === landscape) return;
    onPatchSettings(settings.pageSize === CUSTOM_PAGE ? { pw: settings.ph, ph: settings.pw } : { landscape: want });
  };
  const marginsNow = MARGINS.find((m) => Object.entries(m.patch).every(([k, v]) => settings[k as keyof DocSettings] === v));

  const layout: Group[] = [
    {
      id: "margins",
      label: "Margins",
      content: (
        <Flyout title="Margins" icon={<PanelTop size={15} />} label="Margins">
          {(close) => (
            <>
              {MARGINS.map((m) => (
                <FlyoutItem
                  key={m.label}
                  checked={marginsNow === m}
                  hint={m.hint}
                  onPick={() => {
                    onPatchSettings(m.patch);
                    close();
                  }}
                >
                  {m.label}
                </FlyoutItem>
              ))}
              {actions.pageSetup && (
                <>
                  <hr />
                  <FlyoutItem
                    onPick={() => {
                      close();
                      actions.pageSetup?.();
                    }}
                  >
                    Custom margins…
                  </FlyoutItem>
                </>
              )}
            </>
          )}
        </Flyout>
      ),
    },
    {
      id: "paper",
      label: "Paper",
      content: (
        <>
          <select className="wf-ribbon-select" title="Paper size" value={settings.pageSize} onChange={(e) => onPatchSettings({ pageSize: e.target.value })}>
            {PAGE_SIZES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {settings.pageSize === CUSTOM_PAGE && <option value={CUSTOM_PAGE}>Custom</option>}
          </select>
          <div className="wf-ribbon-seg" role="group" aria-label="Orientation">
            <button type="button" className={landscape ? "" : "active"} aria-pressed={!landscape} onClick={() => turn(false)}>
              Portrait
            </button>
            <button type="button" className={landscape ? "active" : ""} aria-pressed={landscape} onClick={() => turn(true)}>
              Landscape
            </button>
          </div>
        </>
      ),
    },
    {
      id: "columns",
      label: "Columns",
      content: (
        <Flyout title="Columns" icon={<Columns2 size={15} />} label="Columns">
          {(close) =>
            [1, 2, 3].map((n) => (
              <FlyoutItem
                key={n}
                checked={settings.cols === n}
                onPick={() => {
                  onPatchSettings({ cols: n });
                  close();
                }}
              >
                {n === 1 ? "One" : n === 2 ? "Two" : "Three"}
              </FlyoutItem>
            ))
          }
        </Flyout>
      ),
    },
    {
      id: "section",
      label: "Section",
      content: rich ? <SectionFlyout editor={editor} settings={settings} /> : null,
    },
    {
      id: "print-options",
      label: "Options",
      content: (
        <>
          {btn("Hyphenate words at line ends", null, () => onPatchSettings({ hyphenate: !settings.hyphenate }), settings.hyphenate, false, "Hyphenation")}
          {btn("Number the lines", null, () => onPatchSettings({ lineNumbers: !settings.lineNumbers }), settings.lineNumbers, false, "Line numbers")}
        </>
      ),
    },
    {
      id: "setup",
      label: "Page setup",
      content: (
        <>
          {actions.pageSetup && btn("Headers, footers, page numbers and more", <FileCog size={15} />, actions.pageSetup, false, false, "Header & footer")}
        </>
      ),
    },
  ];

  const pending = review?.items.length ?? 0;
  // Accept or reject what the selection is on; with nothing there, go to
  // the next change so the next click decides it.
  const decide = (verdict: "accept" | "reject") => {
    const here = selectedChanges(editor);
    if (here.length) resolveInEditor(editor, here, verdict);
    stepChange(editor, 1);
  };
  const reviewTab: Group[] = [
    {
      id: "tracking",
      label: "Changes",
      content: review ? (
        <>
          <select
            className="wf-ribbon-select wf-ribbon-mode"
            title="Editing changes the text; Suggesting proposes changes; Viewing shows the text with them accepted"
            aria-label="Mode"
            value={review.mode}
            onChange={(e) => review.setMode(e.target.value as ReviewMode)}
          >
            <option value="edit">Editing</option>
            {review.canSuggest && <option value="suggest">Suggesting</option>}
            <option value="view">Viewing</option>
          </select>
          {btn("Previous change", <ChevronUp size={15} />, () => stepChange(editor, -1), false, !pending)}
          {btn("Next change", <ChevronDown size={15} />, () => stepChange(editor, 1), false, !pending)}
          {btn("Accept this change", <Check size={15} />, () => decide("accept"), false, !pending, "Accept")}
          {btn("Reject this change", <X size={15} />, () => decide("reject"), false, !pending, "Reject")}
          <Flyout title="All changes" className="wf-ribbon-narrow" disabled={!pending}>
            {(close) => (
              <>
                <FlyoutItem
                  onPick={() => {
                    resolveAll(editor, "accept");
                    close();
                  }}
                >
                  Accept all changes
                </FlyoutItem>
                <FlyoutItem
                  onPick={() => {
                    resolveAll(editor, "reject");
                    close();
                  }}
                >
                  Reject all changes
                </FlyoutItem>
              </>
            )}
          </Flyout>
          {actions.changes && btn("The list of suggested changes", null, actions.changes, false, false, pending ? `Changes (${pending})` : "Changes")}
        </>
      ) : null,
    },
    {
      id: "feedback",
      label: "Comments",
      content: (
        <>
          {actions.comments && btn("Comments", <MessageSquare size={15} />, actions.comments, false, false, "Comments")}
          {actions.history && btn("Version history — and comparing a version with now", <History size={15} />, actions.history, false, false, "History")}
          {actions.compareFile && btn("Compare with a Word file, side by side", <GitCompareArrows size={15} />, actions.compareFile, false, false, "Compare")}
        </>
      ),
    },
    {
      id: "find",
      label: "Find",
      content: (
        <>
          {actions.find && btn("Find and replace (⌘F)", <Search size={15} />, actions.find, false, false, "Find")}
          {actions.readAloud && btn("Read aloud, from the caret", <Volume2 size={15} />, actions.readAloud, false, false, "Read aloud")}
        </>
      ),
    },
    {
      id: "output",
      label: "Print",
      content: (
        <>
          {actions.preview && btn("Preview — every page as it will print", <Eye size={15} />, actions.preview, false, false, "Preview")}
          {actions.print && btn("Print (⌘P)", <Printer size={15} />, actions.print, false, false, "Print")}
        </>
      ),
    },
  ];

  const dims = pageDims(settings);
  const textWidth = (dims.w - settings.ml - settings.mr - settings.gutter) * 72;
  const table: Group[] = [
    {
      id: "rows",
      label: "Rows",
      content: (
        <>
          {btn("Insert a row above", <Rows3 size={15} />, () => tableCommands.rowAbove(editor), false, false, "Row above")}
          {btn("Insert a row below", null, () => tableCommands.rowBelow(editor), false, false, "Row below")}
        </>
      ),
    },
    {
      id: "columns",
      label: "Columns",
      content: (
        <>
          {btn("Insert a column to the left", <Columns3 size={15} />, () => tableCommands.columnLeft(editor), false, false, "Column left")}
          {btn("Insert a column to the right", null, () => tableCommands.columnRight(editor), false, false, "Column right")}
        </>
      ),
    },
    {
      id: "delete",
      label: "Delete",
      content: (
        <Flyout title="Delete" icon={<Trash2 size={15} />} label="Delete">
          {(close) => (
            <>
              <FlyoutItem
                onPick={() => {
                  tableCommands.deleteRow(editor);
                  close();
                }}
              >
                Delete row
              </FlyoutItem>
              <FlyoutItem
                onPick={() => {
                  tableCommands.deleteColumn(editor);
                  close();
                }}
              >
                Delete column
              </FlyoutItem>
              <hr />
              <FlyoutItem
                onPick={() => {
                  tableCommands.deleteTable(editor);
                  close();
                }}
              >
                Delete table
              </FlyoutItem>
            </>
          )}
        </Flyout>
      ),
    },
    {
      id: "merge",
      label: "Merge",
      content: (
        <>
          {btn("Merge the selected cells into one", <TableCellsMerge size={15} />, () => tableCommands.merge(editor), false, !inTable || !tableCommands.canMerge(editor), "Merge")}
          {btn("Split a merged cell", <TableCellsSplit size={15} />, () => tableCommands.split(editor), false, !inTable || !tableCommands.canSplit(editor), "Split")}
        </>
      ),
    },
    {
      id: "look",
      label: "Look",
      content: (
        <>
          {btn("Header row — the first row, repeated when the table runs over a page", null, () => setTableAttrs(editor, { head: tableNow?.head ? null : true }), !!tableNow?.head, false, "Header row")}
          <Flyout title="Lines" icon={<Square size={15} />} label="Lines">
            {(close) =>
              TABLE_LINES_NAMES.map(([value, label]) => (
                <FlyoutItem
                  key={value}
                  checked={(tableNow?.lines ?? "all") === value}
                  onPick={() => {
                    setTableAttrs(editor, { lines: value });
                    close();
                  }}
                >
                  {label}
                </FlyoutItem>
              ))
            }
          </Flyout>
          <ColorFlyout title="Cell shading" icon={<PaintBucket size={15} />} value={tableNow?.bg ?? null} colors={SHADE_COLORS} noneLabel="No shading" onPick={(c) => tableCommands.shade(editor, c)} />
        </>
      ),
    },
    {
      id: "widths",
      label: "Widths",
      content: (
        <>
          {btn("Make this column narrower", null, () => stepColumn(editor, -1, textWidth), false, false, "Narrower")}
          {btn("Make this column wider", null, () => stepColumn(editor, 1, textWidth), false, false, "Wider")}
          {btn("Share the width of the text equally between the columns", null, () => setTableAttrs(editor, { cols: null }), false, !tableNow?.sized, "Even widths")}
        </>
      ),
    },
  ];

  const sits = imageAlign(picture?.node.attrs.align);
  const place = (side: ImageAlign) => setImageAttrs(editor, { align: sits === side ? null : side });
  const pictureTab: Group[] = [
    {
      id: "place",
      label: "Position",
      content: (
        <>
          {btn("At the left", <AlignLeft size={15} />, () => place("left"), sits === "left" || sits === null)}
          {btn("In the middle", <AlignCenter size={15} />, () => place("center"), sits === "center")}
          {btn("At the right", <AlignRight size={15} />, () => place("right"), sits === "right")}
        </>
      ),
    },
    {
      id: "caption",
      label: "Caption",
      content: <CaptionFlyout editor={editor} />,
    },
  ];

  const groups =
    shown === "home" ? home : shown === "insert" ? insert : shown === "layout" ? layout : shown === "table" ? table : shown === "picture" ? pictureTab : reviewTab;
  // Suggesting is easy to forget about on another tab: it says so on all.
  const suggestingChip =
    review?.mode === "suggest" ? (
      <button type="button" className="wf-ribbon-suggesting" title="Your edits are suggestions. Click for the Review tab." onMouseDown={(e) => e.preventDefault()} onClick={() => pickTab("review")}>
        Suggesting
      </button>
    ) : null;

  return (
    <div className="wf-ribbon" data-phone={phone ? "" : undefined}>
      {/* Outside the groups: they're drawn twice (once to be measured). */}
      {allowImages && (
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void insertImage(file);
            e.target.value = "";
          }}
        />
      )}
      {!phone && (
        <div className="wf-ribbon-tabs" role="tablist" aria-label="Ribbon">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={shown === t.id}
              className={`${shown === t.id ? "active" : ""}${t.id === "table" || t.id === "picture" ? " contextual" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          {suggestingChip}
          {trailing && <span className="wf-ribbon-tail">{trailing}</span>}
        </div>
      )}
      <GroupRow
        key={shown}
        groups={groups}
        scroll={phone}
        leading={
          phone ? (
            <>
            {suggestingChip}
            <Flyout title="Ribbon tab" label={tabs.find((t) => t.id === shown)?.label} className="wf-ribbon-tabpick">
              {(close) =>
                tabs.map((t) => (
                  <FlyoutItem
                    key={t.id}
                    checked={shown === t.id}
                    onPick={() => {
                      pickTab(t.id);
                      close();
                    }}
                  >
                    {t.label}
                  </FlyoutItem>
                ))
              }
            </Flyout>
            </>
          ) : null
        }
        trailing={phone ? trailing : null}
      />
    </div>
  );
}

/**
 * A row of groups. When the row is too narrow, whole groups move into a
 * "more" menu — last first, so what's kept is what's used most. Widths are
 * read from a hidden copy of the row, so showing and hiding never feeds
 * back into the measurement.
 */
function GroupRow({ groups, scroll, leading, trailing }: { groups: Group[]; scroll: boolean; leading: ReactNode; trailing: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(groups.length);
  const shown = groups.filter((g) => g.content !== null);

  useLayoutEffect(() => {
    if (scroll) {
      setFit(shown.length);
      return;
    }
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const compute = () => {
      const widths = [...measure.children].map((el) => (el as HTMLElement).offsetWidth);
      const available = row.clientWidth;
      const MORE = 44;
      let used = 0;
      let count = 0;
      for (let i = 0; i < widths.length; i += 1) {
        const rest = i === widths.length - 1 ? 0 : MORE;
        if (used + widths[i] + rest > available) break;
        used += widths[i];
        count += 1;
      }
      setFit(Math.max(1, count));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [scroll, shown.length]);

  const visible = scroll ? shown : shown.slice(0, fit);
  const hidden = scroll ? [] : shown.slice(fit);

  return (
    <div className={`wf-ribbon-row${scroll ? " scroll" : ""}`} ref={rowRef}>
      {leading}
      {visible.map((g) => (
        <div key={g.id} className="wf-ribbon-group" data-group={g.id}>
          {g.content}
        </div>
      ))}
      {hidden.length > 0 && (
        <Flyout title="More" icon={<MoreHorizontal size={16} />} caret={false} panelClass="wf-ribbon-more">
          {() =>
            hidden.map((g) => (
              <div key={g.id} className="wf-ribbon-more-group">
                <span>{g.label}</span>
                <div className="wf-ribbon-group">{g.content}</div>
              </div>
            ))
          }
        </Flyout>
      )}
      {trailing && <span className="wf-ribbon-tail">{trailing}</span>}
      {!scroll && (
        <div className="wf-ribbon-measure" ref={measureRef} aria-hidden="true">
          {shown.map((g) => (
            <div key={g.id} className="wf-ribbon-group" inert>
              {g.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
