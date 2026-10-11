import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { Baseline, Bold, Code, Highlighter, Italic, MessageSquarePlus, RemoveFormatting, SlidersHorizontal, Strikethrough, Subscript, Superscript, Underline } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { toast } from "../../platform/toast";
import { clearFormatting } from "../format/commands";
import { curRun, type FormatContext } from "../format/effective";
import { setHighlight, setRunColor, toggleScript } from "../format/run";
import { placeOver, textWindow } from "./bubblePlace";
import { ColorFlyout, HIGHLIGHT_COLORS, TEXT_COLORS } from "./ColorFlyout";
import { Flyout, FlyoutItem } from "./Flyout";
import { LinkFlyout } from "./LinkFlyout";
import { SELECTION_TOOLS, useSelectionMenu, type SelectionTool } from "./selectionMenu";

/** A finger's selection has the system's own menu over it (Copy, Look Up…);
 *  a second one there would only fight it — and the toolbar is in reach. */
const coarse = (): boolean => (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) || false;

/** Where focus is, when it isn't in the text: in this menu or in a panel
 *  opened from it (a colour picker, the link form)? */
const inMenus = (): boolean => !!(document.activeElement as Element | null)?.closest?.(".wf-selection-bubble, .wf-flyout");

/**
 * The few things most often done to selected words, right where they were
 * selected: to begin with bold, italic, underline; colour and highlight; a
 * link; a comment; and "clear formatting" for when it has all gone too far.
 * Which tools it holds is each writer's own choice (its last button, or
 * Settings ▸ Writing — see selectionMenu.ts); everything else stays in the
 * ribbon.
 *
 * It appears once a selection is finished (not while the mouse is still
 * dragging), sits above it — below when there's no room — follows it as
 * the page scrolls, and is gone once the selection has scrolled out of
 * view. It never takes the caret out of the text. Escape, or clicking
 * anywhere, puts it away.
 *
 * `format` is the document's styles and level when it has the Document
 * format's formatting; without it (a manuscript, a script) the menu is the
 * three emphasis buttons and the comment.
 */
export function SelectionBubble({ editor, format, onComment }: { editor: Editor; format?: FormatContext | null; onComment?: () => void }) {
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [tick, setTick] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const key = range ? `${range.from}:${range.to}` : null;
  const prefs = useSelectionMenu();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      if (editor.isDestroyed) return;
      // Choosing a colour or typing an address: the selection it is for stays.
      if (!editor.isFocused && inMenus()) return;
      const sel = editor.state.selection;
      const words = editor.isEditable && editor.isFocused && sel instanceof TextSelection && !sel.empty;
      setRange(words ? { from: sel.from, to: sel.to } : null);
      setTick((n) => n + 1);
    };
    const sync = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (editor.isDestroyed) return;
      if (editor.isFocused) read();
      // Focus is on its way somewhere — perhaps into this menu: look once
      // it has landed.
      else timer = setTimeout(read, 0);
    };
    sync();
    editor.on("selectionUpdate", sync);
    editor.on("transaction", sync);
    editor.on("focus", sync);
    editor.on("blur", sync);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("selectionUpdate", sync);
      editor.off("transaction", sync);
      editor.off("focus", sync);
      editor.off("blur", sync);
    };
  }, [editor]);

  // Not while the selection is still being made; and Escape puts it away.
  useEffect(() => {
    let dom: HTMLElement;
    try {
      dom = editor.view.dom;
    } catch {
      return; // not mounted
    }
    const down = (e: MouseEvent) => {
      if (e.button === 0) setDragging(true);
    };
    const up = () => setDragging(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const sel = editor.state.selection;
      setDismissed(`${sel.from}:${sel.to}`);
    };
    dom.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    dom.addEventListener("keydown", onKey);
    return () => {
      dom.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      dom.removeEventListener("keydown", onKey);
    };
  }, [editor]);

  // Another selection: whatever was put away comes back for it.
  useEffect(() => {
    setDismissed((was) => (was === key ? was : null));
    if (!key) setPlace(null);
  }, [key]);

  const shown = !!range && !dragging && key !== dismissed && !coarse() && !prefs.off;

  useEffect(() => {
    if (!shown) return;
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  }, [shown]);

  // Above the selection, centred on it when it is one line; below when
  // the top of the window is in the way.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!shown || !range || !box || editor.isDestroyed) return;
    try {
      const start = editor.view.coordsAtPos(range.from);
      const end = editor.view.coordsAtPos(range.to, -1);
      const size = box.getBoundingClientRect();
      const oneLine = Math.abs(start.top - end.top) < 4;
      const middle = oneLine ? (start.left + end.right) / 2 : start.left + size.width / 2;
      // Null once the selection has scrolled out of the page's view: the
      // menu goes with it rather than floating on over the toolbar.
      setPlace(placeOver({ top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom), middle }, size, textWindow(editor.view.dom)));
    } catch {
      // Not laid out yet: next time.
    }
  }, [shown, range, tick, editor, prefs.tools]);

  if (!shown || !range) return null;

  const rich = !!format && format.level >= 2;
  const run = rich ? curRun(editor, format) : null;
  const chain = () => editor.chain().focus();
  const btn = (title: string, icon: ReactNode, onClick: () => void, active = false) => (
    <button
      key={title}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={active ? "active" : ""}
      // The selection (and the caret's focus) stay where they are.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  /** What can be in the menu here at all (colours need the Document
   *  format; a comment needs somewhere to go). */
  const possible = (tool: { id: SelectionTool; rich?: boolean }) => (!tool.rich || rich) && (tool.id !== "comment" || !!onComment);
  const draw: Record<SelectionTool, () => ReactNode> = {
    bold: () => btn("Bold (⌘B)", <Bold size={15} />, () => chain().toggleBold().run(), editor.isActive("bold")),
    italic: () => btn("Italic (⌘I)", <Italic size={15} />, () => chain().toggleItalic().run(), editor.isActive("italic")),
    underline: () => btn("Underline (⌘U)", <Underline size={15} />, () => chain().toggleUnderline().run(), editor.isActive("underline")),
    strike: () => btn("Strikethrough", <Strikethrough size={15} />, () => chain().toggleStrike().run(), editor.isActive("strike")),
    sub: () => btn("Subscript (⌘=)", <Subscript size={15} />, () => toggleScript(editor, "sub"), run?.vscript === "sub"),
    super: () => btn("Superscript (⌘⇧=)", <Superscript size={15} />, () => toggleScript(editor, "super"), run?.vscript === "super"),
    code: () => btn("Inline code", <Code size={15} />, () => chain().toggleCode().run(), editor.isActive("code")),
    color: () =>
      run && (
        <ColorFlyout key="color" title="Text colour" icon={<Baseline size={15} />} value={run.mixed.color ? null : run.color} colors={TEXT_COLORS} noneLabel="Automatic" onPick={(c) => setRunColor(editor, c)} />
      ),
    highlight: () =>
      run && (
        <ColorFlyout
          key="highlight"
          title="Highlight"
          icon={<Highlighter size={15} />}
          value={run.mixed.highlight ? null : run.highlight}
          colors={HIGHLIGHT_COLORS}
          noneLabel="No highlight"
          onPick={(c) => setHighlight(editor, c)}
        />
      ),
    link: () => <LinkFlyout key="link" editor={editor} />,
    comment: () => (onComment ? btn("Comment on this", <MessageSquarePlus size={15} />, onComment) : null),
    clear: () => btn("Clear formatting", <RemoveFormatting size={15} />, () => clearFormatting(editor)),
  };
  // In runs that belong together, a hairline between them.
  const GROUPS: SelectionTool[][] = [["bold", "italic", "underline", "strike", "sub", "super", "code"], ["color", "highlight"], ["link", "comment"], ["clear"]];
  const groups = GROUPS.map((ids) => ids.filter((id) => prefs.tools.includes(id) && possible(SELECTION_TOOLS.find((t) => t.id === id)!))).filter((ids) => ids.length > 0);

  return createPortal(
    <div ref={boxRef} role="toolbar" aria-label="Format the selection" className="wf-selection-bubble" style={{ left: place?.left ?? -9999, top: place?.top ?? 0 }}>
      {groups.map((ids, i) => (
        <span key={ids[0]} className="wf-bubble-group">
          {i > 0 && <span className="wf-bubble-sep" aria-hidden="true" />}
          {ids.map((id) => draw[id]())}
        </span>
      ))}
      {groups.length > 0 && <span className="wf-bubble-sep" aria-hidden="true" />}
      <Flyout title="Customise this menu" icon={<SlidersHorizontal size={14} />} caret={false} className="wf-bubble-custom">
        {(close) => (
          <>
            <div className="wf-flyout-heading">Show in this menu</div>
            {/* (Ticking several is the usual case: it stays open.) */}
            {SELECTION_TOOLS.filter(possible).map((tool) => (
              <FlyoutItem key={tool.id} checked={prefs.tools.includes(tool.id)} onPick={() => prefs.toggle(tool.id)}>
                {tool.label}
              </FlyoutItem>
            ))}
            <hr />
            <FlyoutItem onPick={prefs.reset}>Back to the usual set</FlyoutItem>
            <FlyoutItem
              onPick={() => {
                close();
                prefs.setOff(true);
                toast("The selection menu is off. It can be turned back on in Settings ▸ Writing.", "info", {
                  durationMs: 9000,
                  action: { label: "Undo", run: () => prefs.setOff(false) },
                });
              }}
            >
              Don’t show this menu
            </FlyoutItem>
          </>
        )}
      </Flyout>
    </div>,
    document.body,
  );
}
